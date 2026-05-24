"""Build interactive-3d/plan_data.js from a Damm 'Planificado' Excel.

Reads the planificado producciones spreadsheet (lines 14 / 17 / 19) via the
existing engine.parse_planning_excel parser, joins per-(sku, línea) historical
OEE from db/linewise.duckdb, derives a wall-clock end time for each block from
its sequence neighbour (last block falls back to a nominal Hl/h rate), and
writes a single JS file the 3D HTML loads as `window.__LINEWISE_PLAN__`.

Run from the repo root:
    source .venv/bin/activate
    python scripts/build_plan_simulation.py \\
        "/Users/davidvendrell/Downloads/Planificado - producciones 14 - 17 - 19.xlsx"
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

import duckdb
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from engine.parse_planning_excel import parse_planning_excel  # noqa: E402

DEFAULT_XLSX = ROOT / "Repte operacions" / "Planificado - producciones 14 - 17 - 19.xlsx"
DUCKDB_PATH = ROOT / "db" / "linewise.duckdb"
FEAS_PARQUET = ROOT / "lookups" / "sku_line_feasibility.parquet"
DIM_SKU_PARQUET = ROOT / "lookups" / "dim_sku.parquet"
OUT_PATH = ROOT / "interactive-3d" / "plan_data.js"

LINES = (14, 17, 19)
LINE_KEY = {14: "L14", 17: "L17", 19: "L19"}
FORMAT_LABEL = {"1/2": "50cl", "1/3": "33cl", "2/5": "44cl"}

# 1 simulated day per ~700ms wall-time. The HTML reads this from meta.tickSeconds
# (in seconds of simulated time per 16ms render tick) and advances the playhead.
SIM_SECONDS_PER_RENDER_TICK = 86400 / (700 / 16)  # ≈ 1975 sim-sec per ~16ms frame

# Fallback nominal speed if a line has zero fact_runs (shouldn't happen for 14/17/19).
DEFAULT_HL_PER_HOUR = 150.0

# Brand → hex color. Drives the can-top material and the in-scene SKU sprite.
# Picked so adjacent lines reading different SKUs are visually distinguishable.
BRAND_COLORS: dict[str, str] = {
    "Estrella Damm":       "#2563eb",
    "Estrella NA":         "#93c5fd",
    "Voll-Damm":           "#b08d57",
    "Victoria":            "#b91c1c",
    "Free Damm":           "#19c37d",
    "Damm Lemon":          "#f2c200",
    "Inedit":              "#d4a017",
    "Xibeca":              "#cbd5e1",
    "Keler":               "#ea580c",
    "Estrella Levante":    "#38bdf8",
    "Skol":                "#fbbf24",
    "Turia":               "#a3621f",
    "Resto":               "#94a3b8",
}

# Fallback brand inference from the SKU code prefix, used when fact_runs has
# no history for a freshly-launched SKU. Longest prefix wins.
SKU_PREFIX_TO_BRAND: list[tuple[str, str]] = [
    ("FDT", "Free Damm"),
    ("FDL", "Free Damm"),
    ("FD",  "Free Damm"),
    ("ENB", "Estrella NA"),
    ("EN",  "Estrella NA"),
    ("ED",  "Estrella Damm"),
    ("EX",  "Estrella Damm"),
    ("VO",  "Voll-Damm"),
    ("VI",  "Victoria"),
    ("DL",  "Damm Lemon"),
    ("ID",  "Inedit"),
    ("IN",  "Inedit"),
    ("XI",  "Xibeca"),
    ("KE",  "Keler"),
    ("LC",  "Estrella Levante"),
    ("SK",  "Skol"),
    ("TUP", "Turia"),
    ("TU",  "Turia"),
    ("3BN", "Resto"),
]

# fact_runs.marca strings → canonical display brand. Multiple SKU brands roll
# up into the same visual identity (e.g. "ESTRELLA NON-ALCOHOLIC" → Estrella NA).
MARCA_TO_BRAND: dict[str, str] = {
    "ESTRELLA DAMM":          "Estrella Damm",
    "ESTRELLA NON-ALCOHOLIC": "Estrella NA",
    "VOLL-DAMM":              "Voll-Damm",
    "VICTORIA":               "Victoria",
    "FREE DAMM":              "Free Damm",
    "FREE DAMM LIMON":        "Free Damm",
    "FREE DAMM TOSTADA":      "Free Damm",
    "DAMM LEMON":             "Damm Lemon",
    "INEDIT":                 "Inedit",
    "XIBECA":                 "Xibeca",
    "KELER":                  "Keler",
    "ESTRELLA LEVANTE":       "Estrella Levante",
    "SKOL":                   "Skol",
    "TURIA":                  "Turia",
    "TURIA MARZEN":           "Turia",
    "TURIA STARK":            "Turia",
    "LA FRÍA":                "Resto",
}

CHANGEOVER_STATIONS: dict[str, list[str]] = {
    "brand":  ["cod"],
    "format": ["ctn", "pal"],
    "other":  ["fill"],
}


def historical_oee_lookup(con: duckdb.DuckDBPyConnection) -> dict[tuple[int, str], float]:
    """Median historical OEE per (línea, sku) over fact_runs."""
    rows = con.execute(
        """
        SELECT linea, sku, MEDIAN(oee) AS oee, COUNT(*) AS n
        FROM fact_runs
        WHERE linea IN (14, 17, 19) AND oee IS NOT NULL
        GROUP BY linea, sku
        """
    ).fetchall()
    return {(int(l), str(s)): float(o) for l, s, o, _n in rows if o is not None}


def line_oee_fallback(con: duckdb.DuckDBPyConnection) -> dict[int, float]:
    rows = con.execute(
        """
        SELECT linea, MEDIAN(oee) AS oee
        FROM fact_runs WHERE linea IN (14, 17, 19) AND oee IS NOT NULL
        GROUP BY linea
        """
    ).fetchall()
    return {int(l): float(o or 0.7) for l, o in rows}


def line_nominal_hl_per_hour(con: duckdb.DuckDBPyConnection) -> dict[int, float]:
    rows = con.execute(
        """
        SELECT linea, MEDIAN(hl / NULLIF(horas_marcha, 0)) AS hl_per_h
        FROM fact_runs
        WHERE linea IN (14, 17, 19) AND horas_marcha > 0
        GROUP BY linea
        """
    ).fetchall()
    out = {int(l): float(v) for l, v in rows if v is not None and v > 0}
    for l in LINES:
        out.setdefault(l, DEFAULT_HL_PER_HOUR)
    return out


def sku_brand_lookup(con: duckdb.DuckDBPyConnection) -> dict[str, str]:
    """SKU → dominant fact_runs.marca (highest Hl). Empty for SKUs with no history."""
    rows = con.execute(
        """
        SELECT sku, arg_max(marca, hl) AS marca
        FROM fact_runs WHERE sku IS NOT NULL AND marca IS NOT NULL
        GROUP BY sku
        """
    ).fetchall()
    return {str(sku): str(marca) for sku, marca in rows if marca}


def resolve_brand(sku: str, marca: str | None) -> str:
    """Pick a canonical brand label for an SKU, falling back to the prefix table."""
    if marca:
        b = MARCA_TO_BRAND.get(marca.strip().upper())
        if b:
            return b
    s = (sku or "").upper()
    for prefix, brand in SKU_PREFIX_TO_BRAND:
        if s.startswith(prefix):
            return brand
    return "Resto"


def sku_format_lookup(con: duckdb.DuckDBPyConnection) -> dict[str, str]:
    """SKU → human format label (33cl / 50cl / 44cl), via dim_sku."""
    rows = con.execute(
        """
        SELECT sku, any_value(estado_volumen) AS ev
        FROM fact_runs WHERE sku IS NOT NULL
        GROUP BY sku
        """
    ).fetchall()
    return {str(sku): FORMAT_LABEL.get(ev, ev) for sku, ev in rows if ev}


def build(xlsx_path: Path) -> dict:
    blocks, meta = parse_planning_excel(
        xlsx_path,
        feasibility_parquet=FEAS_PARQUET,
        dim_sku_parquet=DIM_SKU_PARQUET,
    )
    if blocks.empty:
        raise SystemExit(f"No blocks parsed from {xlsx_path}")

    con = duckdb.connect(str(DUCKDB_PATH), read_only=True)
    try:
        oee_map = historical_oee_lookup(con)
        line_fallback = line_oee_fallback(con)
        hl_per_h = line_nominal_hl_per_hour(con)
        sku_fmt = sku_format_lookup(con)
        sku_brand = sku_brand_lookup(con)
    finally:
        con.close()

    blocks = blocks.sort_values(["linea", "start_ts", "secuencia"], na_position="last")

    lines_out: dict[str, dict] = {}
    t_min: pd.Timestamp | None = None
    t_max: pd.Timestamp | None = None

    for linea in LINES:
        line_blocks = blocks[blocks["linea"] == linea].reset_index(drop=True)
        if line_blocks.empty:
            lines_out[LINE_KEY[linea]] = {"blocks": []}
            continue

        rate = hl_per_h[linea]
        out_blocks: list[dict] = []
        prev_brand: str | None = None
        prev_format: str | None = None
        prev_sku: str | None = None
        for i, row in line_blocks.iterrows():
            start_ts = pd.Timestamp(row["start_ts"])
            if i + 1 < len(line_blocks):
                end_ts = pd.Timestamp(line_blocks.loc[i + 1, "start_ts"])
                if end_ts <= start_ts:
                    end_ts = start_ts + timedelta(hours=8)
            else:
                hl_val = float(row.get("hl") or 0)
                hours = max(hl_val / rate, 4.0) if hl_val > 0 else 8.0
                end_ts = start_ts + timedelta(hours=hours)

            sku = str(row["sku"])
            oee = oee_map.get((linea, sku))
            if oee is None:
                oee = line_fallback.get(linea, 0.7)

            brand = resolve_brand(sku, sku_brand.get(sku))
            brand_color = BRAND_COLORS.get(brand, BRAND_COLORS["Resto"])
            fmt = sku_fmt.get(sku)

            if prev_sku is None or sku == prev_sku:
                changeover_type = None  # first block of the line, or same SKU continuing
            elif brand != prev_brand:
                changeover_type = "brand"
            elif fmt and prev_format and fmt != prev_format:
                changeover_type = "format"
            else:
                changeover_type = "other"
            changeover_stations = CHANGEOVER_STATIONS.get(changeover_type or "", [])

            out_blocks.append({
                "blockId": str(row["block_id"]),
                "sku": sku,
                "format": fmt,
                "brand": brand,
                "brandColor": brand_color,
                "changeoverType": changeover_type,
                "changeoverStations": changeover_stations,
                "startIso": start_ts.isoformat(),
                "endIso": end_ts.isoformat(),
                "hl": round(float(row.get("hl") or 0), 1),
                "cntdPlan": (
                    None if pd.isna(row.get("cntd_plan"))
                    else round(float(row["cntd_plan"]), 1)
                ),
                "turno": (None if pd.isna(row.get("turno")) else str(row["turno"])),
                "secuencia": (
                    None if pd.isna(row.get("secuencia"))
                    else int(row["secuencia"])
                ),
                "oee": round(float(oee), 3),
                "feasible": bool(row["feasible"]),
                "feasReason": (
                    None if pd.isna(row.get("feas_reason"))
                    else str(row["feas_reason"])
                ),
            })

            prev_brand = brand
            prev_format = fmt
            prev_sku = sku

            if t_min is None or start_ts < t_min:
                t_min = start_ts
            if t_max is None or end_ts > t_max:
                t_max = end_ts

        lines_out[LINE_KEY[linea]] = {"blocks": out_blocks}

    if t_min is None or t_max is None:
        raise SystemExit("No timestamps in plan — cannot build simulation.")

    snapshot = {
        "meta": {
            "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "sourceXlsx": str(xlsx_path),
            "weekStart": t_min.date().isoformat(),
            "weekEnd": t_max.date().isoformat(),
            "tMinIso": t_min.isoformat(),
            "tMaxIso": t_max.isoformat(),
            "simSecondsPerTick": round(SIM_SECONDS_PER_RENDER_TICK, 2),
            "parser": {
                "source": meta.get("source"),
                "nBlocks": meta.get("n_blocks"),
                "nInfeasible": meta.get("n_infeasible"),
                "warnings": meta.get("warnings", []),
            },
        },
        "lines": lines_out,
    }
    return snapshot


def main():
    xlsx = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else DEFAULT_XLSX
    if not xlsx.exists():
        raise SystemExit(f"Excel not found: {xlsx}")

    snapshot = build(xlsx)
    OUT_PATH.write_text(
        "window.__LINEWISE_PLAN__ = "
        + json.dumps(snapshot, indent=2, ensure_ascii=False)
        + ";\n",
        encoding="utf-8",
    )

    total_blocks = sum(len(v["blocks"]) for v in snapshot["lines"].values())
    print(f"Wrote {OUT_PATH.relative_to(ROOT)}  ({total_blocks} blocks)")
    print(f"  window: {snapshot['meta']['tMinIso']}  →  {snapshot['meta']['tMaxIso']}")
    for k, v in snapshot["lines"].items():
        n_infeas = sum(1 for b in v["blocks"] if not b["feasible"])
        print(f"  {k}: {len(v['blocks'])} blocks ({n_infeas} infeasible)")


if __name__ == "__main__":
    main()
