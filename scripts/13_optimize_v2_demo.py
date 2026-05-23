"""LineWise — backend demo of the V2 optimizer (relaxed-constraints scheduler).

Usage:
    python3 scripts/13_optimize_v2_demo.py [path/to/file.xlsx] [p50|p90]

Defaults to Repte operacions/Diario Hl_Planif.xlsx and p50.

Output:
    reports/optimizer_v2/<basename>__<objective>.json   (JSON payload)
    + concise console summary
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from engine import parse_planning_excel, optimize_plan_v2, optimizer_v2_result_to_json  # noqa: E402

LOOKUPS = ROOT / "lookups"
MODELS = ROOT / "models"
FEAS = LOOKUPS / "sku_line_feasibility.parquet"
OUT_DIR = ROOT / "reports" / "optimizer_v2"
OUT_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_FILE = ROOT / "Repte operacions" / "Diario Hl_Planif.xlsx"


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_FILE
    objective = sys.argv[2] if len(sys.argv) > 2 else "p50"
    if objective not in {"p50", "p90"}:
        raise SystemExit(f"objective must be 'p50' or 'p90', got: {objective}")

    print(f"==> Source: {src}")
    print(f"==> Objective: {objective}")

    blocks, parse_meta = parse_planning_excel(src, FEAS)
    print(f"==> Parsed {len(blocks)} blocks (format={parse_meta['source']})")

    result = optimize_plan_v2(
        blocks,
        lookups_dir=str(LOOKUPS),
        models_dir=str(MODELS),
        objective=objective,
        time_budget_sec=90,
        max_local_search_iter=40,
    )

    print(f"\n==> Summary")
    print(f"    baseline  ({objective}): {result['baseline_score']*100:6.2f}%")
    print(f"    optimized ({objective}): {result['optimized_score']*100:6.2f}%")
    print(f"    Δ                       : {result['delta_oee_pts']:+.2f} OEE pts")
    print(f"    moves applied            : {result['n_changes']}")
    print(f"    elapsed                  : {result['elapsed_sec']:.1f} s")
    print(f"    audit ok                 : {result['audit']['all_ok']}")
    print(f"    fallback to baseline     : {result.get('fallback_to_baseline', False)}")

    print(f"\n    per-line ({objective}, HL-weighted):")
    for ln in sorted(result["per_line"].keys()):
        v = result["per_line"][ln]
        print(f"      L{ln}: {v['baseline']*100:5.2f}% → {v['optimized']*100:5.2f}%  "
              f"({v['delta_pts']:+.2f} pts)  [{v['n_blocks_baseline']} → {v['n_blocks_optimized']} blocks]")

    if result["swap_log"]:
        print(f"\n    swap log:")
        for s in result["swap_log"][:10]:
            print(f"      {s['description']}")
        if len(result["swap_log"]) > 10:
            print(f"      ... ({len(result['swap_log']) - 10} more)")

    payload = optimizer_v2_result_to_json(result)
    payload["parse_meta"] = parse_meta
    out_path = OUT_DIR / f"{src.stem}__{objective}.json"
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False, default=str))
    print(f"\n==> JSON written to: {out_path}")


if __name__ == "__main__":
    main()
