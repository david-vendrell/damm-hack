"""Build a synthetic Planificado-format Excel from a real low-OEE 2025 week.

The optimizer's value is hard to show on already-good plans. This script pulls
the WORST-performing week from history (HL-weighted OEE), re-formats those
real OFs into a `Planificado producciones` Excel so they can be uploaded to
the HF Space exactly like a fresh weekly plan. The user then sees:

  1. Predicción      — the model says the predicted OEE for this arrangement
                       is ~X%, with a p90 ceiling of ~Y%.
  2. Optimizar plan  — V2 searches for a better arrangement and reports
                       Δ pts of recoverable OEE.

Usage:
    python3 scripts/14_build_bad_plan_demo.py [--week N --year YYYY] [--out path.xlsx]

Default picks 2025-W14 (HL-weighted OEE = 48.7%).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import duckdb
import pandas as pd


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--week", type=int, default=14)
    ap.add_argument("--year", type=int, default=2025)
    ap.add_argument("--out", type=str,
                    default=str(Path.home() / "Downloads" /
                                "Planificado - DEMO bad week.xlsx"))
    args = ap.parse_args()

    con = duckdb.connect(str(ROOT / "db" / "linewise.duckdb"), read_only=True)

    # ----- pull all OFs from the chosen week
    of_rows = con.execute(f"""
        SELECT
            r.of, r.linea, r.fecha_fin AS fecha, r.sku, r.hl, r.uds, r.oee
        FROM fact_runs r
        WHERE r.anyo = {args.year}
          AND r.semana = {args.week}
          AND NOT r.outlier
          AND r.oee BETWEEN 0 AND 1
        ORDER BY r.linea, r.fecha_fin, r.of
    """).fetchdf()

    if of_rows.empty:
        raise SystemExit(f"No OFs found for {args.year}-W{args.week}")

    hl_weighted_oee = (of_rows["oee"] * of_rows["hl"]).sum() / max(of_rows["hl"].sum(), 1)
    print(f"==> Source: {args.year}-W{args.week}")
    print(f"    OFs:     {len(of_rows)}")
    print(f"    Lines:   {sorted(of_rows['linea'].unique().tolist())}")
    print(f"    HL:      {of_rows['hl'].sum():,.0f}")
    print(f"    OEE-HL:  {hl_weighted_oee*100:.2f}%")
    print(f"    Range:   {of_rows['fecha'].min().date()} → {of_rows['fecha'].max().date()}")

    # ----- assign turno by position within (línea, día); T → N → M cycle
    of_rows["pos_in_day"] = of_rows.groupby(["linea",
                                             of_rows["fecha"].dt.date]).cumcount()
    turno_cycle = ["T", "N", "M"]
    of_rows["turno"] = of_rows["pos_in_day"].apply(lambda i: turno_cycle[i % 3])

    hora_per_turno = {"T": "08:00:00", "N": "16:00:00", "M": "00:00:00"}
    of_rows["hora_ini"] = of_rows["turno"].map(hora_per_turno)

    # ----- denominacion: use a lightweight lookup from dim_sku
    dim_sku = con.execute("SELECT sku, mat_precio FROM dim_sku").fetchdf()
    sku_to_name = dict(zip(dim_sku["sku"], dim_sku["mat_precio"]))
    of_rows["denominacion"] = of_rows["sku"].map(sku_to_name).fillna(of_rows["sku"])

    # ----- assemble Planificado-format columns (must match the parser)
    planificado = pd.DataFrame({
        "Material":                of_rows["sku"],
        "Denominación":            of_rows["denominacion"],
        "Centro":                  99,
        "Tren":                    of_rows["linea"].astype(int),
        "Fecha ini.":              of_rows["fecha"].dt.strftime("%Y-%m-%d"),
        "Hora ini.":               of_rows["hora_ini"],
        "Definición de turno":     of_rows["turno"],
        # Use the real produced UDS as the "planned quantity"; the parser maps
        # `Cntd plan` → hl for HL-weighting, so the relative weighting is
        # preserved even though the unit label is CAJ
        "Cntd JDA":                of_rows["uds"].round(0).astype("Int64"),
        "Cntd plan":               of_rows["uds"].round(0).astype("Int64"),
        "Pndt. Env":               0,
        "Unidad medida base":      "CAJ",
        "Versión producción":      "V014",
        "Fecha fin":               of_rows["fecha"].dt.strftime("%Y-%m-%d"),
        "Secuencia":               of_rows.groupby(["linea", of_rows["fecha"].dt.date]).cumcount() + 1,
        "No PAC":                  "X",
        "Manual":                  "",
        "Entrada en tabla":        0,
    })

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with pd.ExcelWriter(out_path, engine="openpyxl") as xw:
        planificado.to_excel(xw, sheet_name="Sheet1", index=False)
    print(f"\n==> Planificado written to: {out_path}")
    print(f"    {len(planificado)} OFs across L{sorted(planificado['Tren'].unique().tolist())}")

    # ----- per-line summary
    print(f"\n    Per-line OEE in source data:")
    g = of_rows.groupby("linea").agg(
        n=("of", "size"),
        hl=("hl", "sum"),
        oee_w=("oee", lambda s: (s * of_rows.loc[s.index, "hl"]).sum() /
                                  max(of_rows.loc[s.index, "hl"].sum(), 1)),
    ).reset_index()
    for _, r in g.iterrows():
        print(f"      L{int(r['linea'])}: {int(r['n'])} OFs · {r['hl']:>8.0f} HL · "
              f"OEE-weighted = {r['oee_w']*100:.2f}%")

    print("\n==> Upload this file to the HF Space and click 'Optimizar plan' "
          "(check 'Modo agresivo' for p90 ceiling).")


if __name__ == "__main__":
    main()
