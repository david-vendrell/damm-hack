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

# ----------------------------------------------------------------- compat
# Hard line-format compatibility per Damm (confirmed verbally 2026-05-23):
#   L14 — produces 1/2 (50 cl) and 1/3 (33 cl)
#   L17 — produces 1/3 (33 cl) only
#   L19 — produces 1/2 (50 cl), 1/3 (33 cl), and 2/5 (44 cl)
# Any (sku, línea) whose `estado_volumen` is not in the line's allowed set
# is physically infeasible regardless of historical runs.
LINE_FORMAT_COMPAT: dict[int, set[str]] = {
    14: {"1/2", "1/3"},
    17: {"1/3"},
    19: {"1/2", "1/3", "2/5"},
}


def line_supports_format(linea: int, estado_volumen: str | None) -> bool:
    if estado_volumen is None or pd.isna(estado_volumen):
        return False
    return str(estado_volumen) in LINE_FORMAT_COMPAT.get(int(linea), set())


def infer_estado_volumen_from_sku(sku: str) -> str | None:
    """Best-effort estado_volumen inference from a Damm SKU code.

    Damm's standard naming has the format digits at positions 2-3:
      ED13LTW → 1/3   (Estrella Damm 1/3)
      ED12LTW → 1/2   (Estrella Damm 1/2)
      VI25... → 2/5   (Victoria 2/5)
    SKUs that don't follow the convention (e.g. internal codes like 3BN...)
    return None and the platform falls back to dim_sku or skips the check.
    """
    if not sku:
        return None
    s = str(sku).upper()
    # Look for explicit format digit pairs in positions 2-4
    m = re.search(r"(?<![0-9])(13|12|25)(?![0-9])", s[:6])
    if not m:
        return None
    return {"13": "1/3", "12": "1/2", "25": "2/5"}[m.group(1)]


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
    # Each day-block has 11 metric columns + a separator. The first metric
    # in each block is the "Programa Prod." HL number; the regex must be
    # ANCHORED to the start of the header text so it doesn't also match
    # "Artículos Programa Prod." (which would double-detect every day).
    days: list[tuple[str, int]] = []  # (date_str, starting_col_idx)
    for j, h in enumerate(headers_row):
        if h is None:
            continue
        s = str(h).strip()
        m = re.match(r"^Programa Prod\.?\s*\n?\s*(\d{1,2}/\d{1,2}/\d{4})", s)
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
def _attach_feasibility(
    blocks: pd.DataFrame,
    feasibility_parquet: str | Path,
    dim_sku_parquet: str | Path | None = None,
) -> pd.DataFrame:
    """Annotate every block with two feasibility judgements:

    1. **`format_ok`** — HARD rule: the SKU's `estado_volumen` must be in
       the line's `LINE_FORMAT_COMPAT` allow-list. This is Damm's official
       physical capability constraint. Failing this = block REFUSED.
    2. **`has_history`** — SOFT rule: at least `MIN_HISTORICAL_RUNS_FOR_FEASIBILITY`
       past OFs on this (sku, línea) pair. Failing this means low confidence
       (we still predict, but flag the prediction).

    A block's overall `feasible` flag = `format_ok` only.
    """
    feas = pd.read_parquet(feasibility_parquet)
    n_hist = (
        feas.groupby(["sku", "linea"])["n_historical_runs"].sum()
        .rename("n_historical_runs").reset_index()
    )
    n_hist_map = {(str(r["sku"]), int(r["linea"])): int(r["n_historical_runs"])
                  for _, r in n_hist.iterrows()}
    sku_seen = set(str(s) for s in n_hist["sku"].unique())

    # estado_volumen per SKU: prefer dim_sku, fall back to a parse of tipo_envase
    sku_to_state: dict[str, str | None] = {}
    if dim_sku_parquet is not None and Path(dim_sku_parquet).exists():
        dim = pd.read_parquet(dim_sku_parquet)
        if "estado_volumen" in dim.columns:
            for _, r in dim.iterrows():
                sku_to_state[str(r["sku"])] = (
                    None if pd.isna(r["estado_volumen"]) else str(r["estado_volumen"])
                )

    def _state_for(sku: str) -> tuple[str | None, str]:
        """Returns (estado_volumen, source) where source is 'dim_sku' | 'inferred' | 'unknown'."""
        if sku in sku_to_state and sku_to_state[sku] is not None:
            return sku_to_state[sku], "dim_sku"
        inferred = infer_estado_volumen_from_sku(sku)
        if inferred is not None:
            return inferred, "inferred"
        return None, "unknown"

    def judge(sku: str, linea: int) -> tuple[bool, bool, str | None]:
        sku = str(sku); linea = int(linea)
        state, src = _state_for(sku)
        allowed = sorted(LINE_FORMAT_COMPAT.get(linea, set()))
        n_h = n_hist_map.get((sku, linea), 0)
        has_history = n_h >= MIN_HISTORICAL_RUNS_FOR_FEASIBILITY

        # Format check — HARD only when we KNOW the format and it doesn't fit.
        # Unknown formats get benefit of the doubt (and a warning via has_history).
        if state is not None and state not in LINE_FORMAT_COMPAT.get(linea, set()):
            return False, has_history, (
                f"Format incompatibility: SKU '{sku}' is {state} "
                f"({'from dim_sku' if src == 'dim_sku' else 'inferred from SKU code'}); "
                f"L{linea} only produces {allowed}."
            )

        if not has_history:
            if sku not in sku_seen:
                return True, False, (
                    f"Low confidence: SKU '{sku}' has no historical runs on any line "
                    f"(format {state or 'unknown'} assumed compatible with L{linea})."
                )
            return True, False, (
                f"Low confidence: only {n_h} historical run(s) on L{linea} "
                f"(threshold = {MIN_HISTORICAL_RUNS_FOR_FEASIBILITY})."
            )
        return True, True, None

    flags = [judge(s, l) for s, l in zip(blocks["sku"], blocks["linea"])]
    blocks["feasible"]    = [f[0] for f in flags]
    blocks["has_history"] = [f[1] for f in flags]
    blocks["feas_reason"] = [f[2] for f in flags]
    return blocks


# ---------------------------------------------------------------- public API
def parse_planning_excel(
    xlsx_path: str | Path,
    feasibility_parquet: str | Path,
    dim_sku_parquet: str | Path | None = None,
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

    # Default the SKU master to the lookups/dim_sku.parquet next to feasibility
    if dim_sku_parquet is None:
        candidate = Path(feasibility_parquet).parent / "dim_sku.parquet"
        if candidate.exists():
            dim_sku_parquet = candidate

    blocks = _attach_feasibility(blocks, feasibility_parquet, dim_sku_parquet)
    meta["n_blocks"]            = int(len(blocks))
    meta["n_infeasible"]        = int((~blocks["feasible"]).sum())
    meta["n_low_confidence"]    = int((blocks["feasible"] & ~blocks["has_history"]).sum())
    meta["line_format_compat"]  = {k: sorted(v) for k, v in LINE_FORMAT_COMPAT.items()}
    return blocks, meta
