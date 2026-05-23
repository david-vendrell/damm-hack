"""LineWise — Step 11: Backtest the model on the Q4 2025 holdout for the pitch slide.

Computes:
  - Holdout actual mean OEE (per line + global)
  - Model p50 vs actual (calibration)
  - Model p90 ceiling — the achievable upper bound the optimizer would target
  - Controllable gap = p90 - actual (upper bound for LineWise lift)
  - Expected lift under several "gap-capture" assumptions (10 %, 30 %, 50 %)
  - Translated into HL and approximate units

Output: reports/backtest/backtest_summary.json + a console slide.
"""

from __future__ import annotations

import json
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
PRED_CSV = ROOT / "reports" / "model_eval" / "predictions_test.csv"
DB_PATH = ROOT / "db" / "linewise.duckdb"
OUT_DIR = ROOT / "reports" / "backtest"
OUT_DIR.mkdir(parents=True, exist_ok=True)


def main() -> None:
    if not PRED_CSV.exists():
        raise FileNotFoundError("Run scripts/08_evaluate_oee_quantile.py first.")
    pred = pd.read_csv(PRED_CSV)
    pred["fecha"] = pd.to_datetime(pred["fecha"])
    pred["controllable_gap"] = (pred["p90"] - pred["oee"]).clip(lower=0)

    # ============================================================ Pull HL
    con = duckdb.connect(str(DB_PATH), read_only=True)
    hl = con.execute("SELECT of, hl FROM fact_runs").fetchdf()
    pred = pred.merge(hl, on="of", how="left")
    pred["hl"] = pred["hl"].fillna(0)
    con.close()

    # ============================================================ Overall metrics
    total_hl   = float(pred["hl"].sum())
    actual_avg = float((pred["oee"] * pred["hl"]).sum() / max(total_hl, 1.0))
    p50_avg    = float((pred["p50"] * pred["hl"]).sum() / max(total_hl, 1.0))
    p90_avg    = float((pred["p90"] * pred["hl"]).sum() / max(total_hl, 1.0))
    gap_avg    = float((pred["controllable_gap"] * pred["hl"]).sum() / max(total_hl, 1.0))

    # ============================================================ Per-line
    def per_line(df: pd.DataFrame) -> pd.DataFrame:
        g = df.groupby("linea").apply(lambda d: pd.Series({
            "n_ofs": len(d),
            "hl_total": d["hl"].sum(),
            "actual_oee_weighted": (d["oee"] * d["hl"]).sum() / max(d["hl"].sum(), 1.0),
            "p50_weighted":        (d["p50"] * d["hl"]).sum() / max(d["hl"].sum(), 1.0),
            "p90_weighted":        (d["p90"] * d["hl"]).sum() / max(d["hl"].sum(), 1.0),
            "controllable_gap_weighted": (d["controllable_gap"] * d["hl"]).sum() / max(d["hl"].sum(), 1.0),
        }))
        return g.reset_index()

    per_line_df = per_line(pred)

    # ============================================================ Scenarios
    scenarios = []
    for capture in (0.10, 0.30, 0.50):
        oee_lift_pts = gap_avg * capture * 100  # in OEE percentage points
        scenarios.append({
            "gap_capture_pct": int(capture * 100),
            "oee_lift_pts": round(oee_lift_pts, 2),
            # "extra HL" proxy: if real OEE is X and we lift it to X + lift, on the same HL plan
            "extra_hl_proxy": round(total_hl * (gap_avg * capture / max(actual_avg, 0.01)), 0),
        })

    # ============================================================ Summary
    print("=" * 75)
    print("  LineWise Q4 2025 holdout backtest — pitch slide")
    print("=" * 75)
    print(f"  Holdout window:  {pred['fecha'].min().date()} → {pred['fecha'].max().date()}")
    print(f"  N OFs:           {len(pred)}")
    print(f"  Total HL:        {total_hl:,.0f}")
    print()
    print(f"  Actual OEE (HL-weighted):   {actual_avg*100:6.2f}%")
    print(f"  Model p50 (HL-weighted):    {p50_avg*100:6.2f}%   (calibration vs actual)")
    print(f"  Model p90 (HL-weighted):    {p90_avg*100:6.2f}%   (achievable ceiling)")
    print(f"  Controllable gap (p90-act): {gap_avg*100:6.2f} pts")
    print()
    print("  Lift scenarios (assumes optimizer captures X% of the controllable gap):")
    for s in scenarios:
        print(f"    • {s['gap_capture_pct']:>2}% capture → +{s['oee_lift_pts']:.2f} OEE pts  ·  ~{int(s['extra_hl_proxy']):,} extra HL")
    print()
    print("  Per line (HL-weighted):")
    print(per_line_df.assign(
        actual=(per_line_df["actual_oee_weighted"]*100).round(2),
        p50=(per_line_df["p50_weighted"]*100).round(2),
        p90=(per_line_df["p90_weighted"]*100).round(2),
        gap_pts=(per_line_df["controllable_gap_weighted"]*100).round(2),
    )[["linea","n_ofs","hl_total","actual","p50","p90","gap_pts"]].to_string(index=False))

    # ============================================================ Save
    out = {
        "holdout_start": pred["fecha"].min().date().isoformat(),
        "holdout_end":   pred["fecha"].max().date().isoformat(),
        "n_ofs": int(len(pred)),
        "total_hl": total_hl,
        "actual_oee_weighted":      actual_avg,
        "model_p50_weighted":       p50_avg,
        "model_p90_weighted":       p90_avg,
        "controllable_gap_weighted_pts": gap_avg * 100,
        "scenarios": scenarios,
        "per_line": per_line_df.to_dict(orient="records"),
    }
    (OUT_DIR / "backtest_summary.json").write_text(json.dumps(out, indent=2, ensure_ascii=False, default=str))
    print(f"\n==> Saved → {OUT_DIR}/backtest_summary.json")


if __name__ == "__main__":
    main()
