"""Auto-detect the uploaded Damm planning Excel format (Planificado vs Diario Hl)
and normalise it to a list of plan blocks.

Output schema (one row per block):
    block_id    str          unique within the upload
    linea       int          14 / 17 / 19
    sku         str
    fecha       date         start date
    turno       str | None   T / N / M  (None for Diario Hl explosion fallback)
    start_ts    timestamp    used for ordering blocks within a line
    hl          float        planned hectolitres (Diario Hl) or derived
    cntd_plan   float | None planned quantity (Planificado)
    cntd_jda    float | None JDA suggestion (Planificado)
    secuencia   int   | None sequence position (Planificado)
    source      str          "planificado" | "diario_hl"
    feasible    bool         True if (sku, linea) has >= MIN historical runs
    feas_reason str | None   reason if infeasible
"""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path
from typing import Literal

import pandas as pd

MIN_HISTORICAL_RUNS_FOR_FEASIBILITY = 3


# ---------------------------------------------------------------- detection
def detect_format(xlsx_path: str | Path) -> Literal["planificado", "diario_hl", "unknown"]:
    """Sniff the Excel file's first sheet columns to identify the format."""
    xl = pd.ExcelFile(xlsx_path)
    sheet = xl.sheet_names[0]
    df = pd.read_excel(xl, sheet_name=sheet, nrows=2)
    cols = [str(c) for c in df.columns]

    if "Material" in cols and "Definición de turno" in cols:
        return "planificado"
    if any("Diario Hl" in c for c in cols) and any("Programa Prod." in c for c in cols):
        return "diario_hl"
    # Some Diario Hl exports use "Programa Prod" without the dot
    if any("Diario" in c for c in cols) and any("Programa" in c for c in cols):
        return "diario_hl"
    return "unknown"


# ---------------------------------------------------------------- helpers
def _norm_text(s) -> str:
    if s is None:
        return ""
    return str(s).strip()


def _slug(name: str) -> str:
    s = unicodedata.normalize("NFKD", str(name)).encode("ascii", "ignore").decode()
    s = s.lower().strip()
    s = re.sub(r"[^\w]+", "_", s)
    return re.sub(r"_+", "_", s).strip("_") or "col"


# ---------------------------------------------------------------- parsers
def _parse_planificado(xlsx_path: str | Path) -> pd.DataFrame:
    """Planificado producciones: one row per (línea × sku × shift × date)."""
    df = pd.read_excel(xlsx_path, sheet_name=0)
    df.columns = [_slug(c) for c in df.columns]

    rename = {
        "material": "sku",
        "tren": "linea",
        "fecha_ini": "fecha",
        "definicion_de_turno": "turno",
        "cntd_plan": "cntd_plan",
        "cntd_jda": "cntd_jda",
    }
    df = df.rename(columns=rename)

    df["linea"] = pd.to_numeric(df["linea"], errors="coerce").astype("Int64")
    df["fecha"] = pd.to_datetime(df["fecha"], errors="coerce")
    df["cntd_plan"] = pd.to_numeric(df.get("cntd_plan"), errors="coerce")
    df["cntd_jda"]  = pd.to_numeric(df.get("cntd_jda"),  errors="coerce")
    df["secuencia"] = pd.to_numeric(df.get("secuencia"), errors="coerce")

    # build start_ts from fecha + hora_ini
    def _combine(row):
        if pd.isna(row["fecha"]):
            return pd.NaT
        h = row.get("hora_ini")
        if pd.isna(h):
            return row["fecha"]
        try:
            if hasattr(h, "hour"):
                return row["fecha"].replace(hour=int(h.hour), minute=int(h.minute), second=int(h.second))
            return pd.to_datetime(f"{row['fecha'].date()} {h}", errors="coerce")
        except Exception:
            return row["fecha"]
    df["start_ts"] = df.apply(_combine, axis=1)

    # convert cntd_plan (often in CAJ) to HL via dim_sku later — for now use cntd_plan as proxy
    df["hl"] = df["cntd_plan"]  # treat as quantity proxy; UI will display original units

    df["source"] = "planificado"
    df["block_id"] = df.apply(
        lambda r: f"plan_{r['linea']}_{r['fecha'].date() if pd.notna(r['fecha']) else 'unknown'}_{r.get('turno') or 'NA'}_{r['sku']}_{int(r.name)}",
        axis=1,
    )
    return df[[
        "block_id", "linea", "sku", "fecha", "turno", "start_ts",
        "hl", "cntd_plan", "cntd_jda", "secuencia", "source",
    ]]


def _parse_diario_hl(xlsx_path: str | Path) -> pd.DataFrame:
    """Diario Hl_Planif wide cross-tab. Walk it with a (centro, tren) context tracker."""
    raw = pd.read_excel(xlsx_path, sheet_name=0, header=None)
    raw = raw.where(pd.notna(raw), None)

    headers_row = raw.iloc[0].tolist()
    # Each day-block has 11 metric columns + a separator. Find day labels from headers.
    days: list[tuple[str, int]] = []  # (date_str, starting_col_idx)
    for j, h in enumerate(headers_row):
        if h is None:
            continue
        s = str(h)
        m = re.search(r"Programa Prod\.?\s*\n?\s*(\d{1,2}/\d{1,2}/\d{4})", s)
        if m:
            try:
                d = pd.to_datetime(m.group(1), dayfirst=True).date()
                days.append((d.isoformat(), j))
            except Exception:
                pass

    if not days:
        raise ValueError("No day columns identified in Diario Hl_Planif")

    metric_offset = {
        "programa_prod_hl":       0,
        "programa_acordado_hl":   1,
        "inclusion_formatos":     2,
        "exclusion_formato":      3,
        "total_modif_formato":    4,
        "aumento_cantidad":       5,
        "disminucion_cantidad":   6,
        "total_modif_cantidad":   7,
        "n_total_cambios":        8,
        "articulos_programa_prod":  9,
        "articulos_programa_acord": 10,
    }

    rows: list[dict] = []
    current_linea: int | None = None
    for i in range(1, len(raw)):
        label = _norm_text(raw.iat[i, 0])
        if not label:
            continue

        m = re.search(r"Tren\s*:\s*Tren\s*(\d+)", label, flags=re.IGNORECASE)
        if m:
            current_linea = int(m.group(1))
            continue
        m = re.search(r"Centro\s*:", label, flags=re.IGNORECASE)
        if m:
            continue
        if label.startswith("Total") or label.startswith("-"):
            continue
        if current_linea is None:
            continue

        sku = label
        for fecha_iso, base_col in days:
            metrics: dict[str, float] = {}
            for metric, offset in metric_offset.items():
                v = raw.iat[i, base_col + offset]
                try:
                    metrics[metric] = float(v) if v is not None else float("nan")
                except (TypeError, ValueError):
                    metrics[metric] = float("nan")
            if pd.isna(metrics.get("programa_prod_hl")) and pd.isna(metrics.get("programa_acordado_hl")):
                continue
            rows.append({
                "linea": current_linea,
                "sku": sku,
                "fecha": pd.to_datetime(fecha_iso),
                "hl": metrics["programa_acordado_hl"] if pd.notna(metrics["programa_acordado_hl"])
                      else metrics["programa_prod_hl"],
                **{k: metrics[k] for k in metric_offset},
            })

    daily = pd.DataFrame(rows)
    if daily.empty:
        return daily

    # Explode each daily row into 3 shift blocks (T / N / M) with equal weights
    shifts = pd.DataFrame({"turno": ["T", "N", "M"], "shift_weight": [1/3, 1/3, 1/3]})
    daily["__key"] = 1
    shifts["__key"] = 1
    exploded = daily.merge(shifts, on="__key").drop(columns="__key")
    exploded["hl"] = exploded["hl"] * exploded["shift_weight"]

    # synthetic start_ts so blocks have a stable order within a (line, day):
    # T = 08:00, N = 16:00, M = 00:00 (next day still ordered after N within day)
    shift_hours = {"T": 8, "N": 16, "M": 0}
    exploded["start_ts"] = exploded.apply(
        lambda r: r["fecha"].replace(hour=shift_hours.get(r["turno"], 0)),
        axis=1,
    )
    exploded["cntd_plan"] = exploded["hl"]
    exploded["cntd_jda"]  = pd.NA
    exploded["secuencia"] = pd.NA
    exploded["source"] = "diario_hl"
    exploded["linea"] = exploded["linea"].astype("Int64")
    exploded["block_id"] = exploded.apply(
        lambda r: f"diario_{r['linea']}_{r['fecha'].date()}_{r['turno']}_{r['sku']}",
        axis=1,
    )

    return exploded[[
        "block_id", "linea", "sku", "fecha", "turno", "start_ts",
        "hl", "cntd_plan", "cntd_jda", "secuencia", "source",
    ]]


# ---------------------------------------------------------------- feasibility
def _attach_feasibility(blocks: pd.DataFrame, feasibility_parquet: str | Path) -> pd.DataFrame:
    feas = pd.read_parquet(feasibility_parquet)
    feas = feas[feas["n_historical_runs"] >= MIN_HISTORICAL_RUNS_FOR_FEASIBILITY]
    feas_keys = set(zip(feas["sku"].astype(str), feas["linea"].astype(int)))
    sku_seen = set(feas["sku"].astype(str).unique())

    def reason(sku: str, linea: int) -> tuple[bool, str | None]:
        if (sku, int(linea)) in feas_keys:
            return True, None
        if sku not in sku_seen:
            return False, f"SKU '{sku}' has no historical runs on any line"
        return False, f"SKU '{sku}' has fewer than {MIN_HISTORICAL_RUNS_FOR_FEASIBILITY} historical runs on L{linea}"

    flags = [reason(str(s), int(l)) for s, l in zip(blocks["sku"], blocks["linea"])]
    blocks["feasible"] = [f[0] for f in flags]
    blocks["feas_reason"] = [f[1] for f in flags]
    return blocks


# ---------------------------------------------------------------- public API
def parse_planning_excel(
    xlsx_path: str | Path,
    feasibility_parquet: str | Path,
) -> tuple[pd.DataFrame, dict]:
    """Parse an uploaded Damm planning Excel and return (blocks, meta).

    `meta` carries: `source` ("planificado" | "diario_hl"), `n_blocks`,
    `n_infeasible`, and any parser warnings.
    """
    fmt = detect_format(xlsx_path)
    meta: dict = {"source": fmt, "warnings": []}

    if fmt == "planificado":
        blocks = _parse_planificado(xlsx_path)
    elif fmt == "diario_hl":
        blocks = _parse_diario_hl(xlsx_path)
        meta["warnings"].append(
            "Diario Hl format detected — shifts and sequence have been inferred. "
            "Predictions improve if you upload the per-shift Planificado file instead."
        )
    else:
        raise ValueError(f"Unknown planning Excel format for: {xlsx_path}")

    blocks = blocks.dropna(subset=["linea", "sku", "fecha"]).reset_index(drop=True)
    blocks["linea"] = blocks["linea"].astype(int)
    blocks = blocks.sort_values(["linea", "start_ts", "secuencia"], na_position="last").reset_index(drop=True)

    blocks = _attach_feasibility(blocks, feasibility_parquet)
    meta["n_blocks"] = int(len(blocks))
    meta["n_infeasible"] = int((~blocks["feasible"]).sum())
    return blocks, meta
