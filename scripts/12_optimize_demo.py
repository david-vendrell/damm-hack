"""LineWise — backend demo of the optimizer.

Takes an uploaded planning Excel, runs the optimizer, and dumps the full result
as JSON (and a concise console summary). This is the backend contract the
frontend / API consumers can rely on.

Usage:
    python3 scripts/12_optimize_demo.py [path/to/file.xlsx]

Defaults to Repte operacions/Diario Hl_Planif.xlsx if no path given.

Output:
    reports/optimizer/<basename>.json   (full result, JSON-serialisable)
    + concise console summary
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))  # so `from engine import ...` works

from engine import parse_planning_excel, optimize_plan, optimizer_result_to_json

LOOKUPS = ROOT / "lookups"
MODELS = ROOT / "models"
FEAS = LOOKUPS / "sku_line_feasibility.parquet"
OUT_DIR = ROOT / "reports" / "optimizer"
OUT_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_FILE = ROOT / "Repte operacions" / "Diario Hl_Planif.xlsx"


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_FILE
    print(f"==> Source: {src}")
    if not src.exists():
        raise FileNotFoundError(src)

    blocks, parse_meta = parse_planning_excel(src, FEAS)
    print(f"==> Parsed {len(blocks)} blocks  (format={parse_meta['source']}, "
          f"infeasible={parse_meta['n_infeasible']})")

    result = optimize_plan(
        blocks,
        lookups_dir=str(LOOKUPS),
        models_dir=str(MODELS),
        max_iter=10,
        enable_cross_line=True,
        time_budget_sec=90,
    )

    # ---- console summary
    print(f"\n==> Optimizer summary")
    print(f"    baseline OEE (HL-weighted p50)  : {result['baseline_score']*100:6.2f}%")
    print(f"    optimized OEE (HL-weighted p50) : {result['optimized_score']*100:6.2f}%")
    print(f"    Δ                                : {result['delta_oee_pts']:+.2f} OEE pts")
    print(f"    swaps applied                   : {result['n_iterations']}")
    print(f"    elapsed                         : {result['elapsed_sec']:.1f} s"
          f"{'  (truncated)' if result['truncated'] else ''}")

    print(f"\n    per-line breakdown:")
    for ln in sorted(result["per_line"].keys()):
        v = result["per_line"][ln]
        print(f"      L{ln}: {v['baseline']*100:5.2f}%  →  {v['optimized']*100:5.2f}%  "
              f"({v['delta_pts']:+.2f} pts)")

    if result["swap_log"]:
        print(f"\n    swap log:")
        for s in result["swap_log"]:
            print(f"      [iter {s['iteration']:>2}] {s.get('description', '')}  "
                  f"→ {s['delta_pts_global']:+.3f} pts")

    # ---- JSON dump (the contract the frontend / API will consume)
    payload = optimizer_result_to_json(result)
    payload["parse_meta"] = parse_meta
    out_path = OUT_DIR / f"{src.stem}.json"
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False, default=str))
    print(f"\n==> JSON written to: {out_path}")
    print(f"    Contains the keys: {list(payload.keys())}")


if __name__ == "__main__":
    main()
