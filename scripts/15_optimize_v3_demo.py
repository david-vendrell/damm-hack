"""Backend demo of V3 optimizer (prev-aware lookup + operational reasoning)."""
from __future__ import annotations

import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from engine import parse_planning_excel, optimize_plan_v3, optimizer_v3_result_to_json  # noqa: E402

LOOKUPS = ROOT / "lookups"
MODELS = ROOT / "models"
FEAS = LOOKUPS / "sku_line_feasibility.parquet"
OUT_DIR = ROOT / "reports" / "optimizer_v3"
OUT_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_FILE = ROOT / "Repte operacions" / "Diario Hl_Planif.xlsx"


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_FILE
    objective = sys.argv[2] if len(sys.argv) > 2 else "p90"

    print(f"==> Source: {src}")
    print(f"==> Objective: {objective}")
    blocks, meta = parse_planning_excel(src, FEAS)
    print(f"==> Parsed {len(blocks)} blocks ({meta['source']})")

    result = optimize_plan_v3(blocks, str(LOOKUPS), str(MODELS),
                              objective=objective, time_budget_sec=90,
                              max_iter=40, top_k_prevs=20)

    print(f"\n==> Summary")
    print(f"  baseline  ({objective}): {result['baseline_score']*100:6.2f}%")
    print(f"  optimized ({objective}): {result['optimized_score']*100:6.2f}%")
    print(f"  Δ                       : {result['delta_oee_pts']:+.2f} pts")
    print(f"  moves applied            : {result['n_changes']}")
    print(f"  elapsed                  : {result['elapsed_sec']:.1f} s")
    print(f"  lookup size              : {result['lookup_size']:,}")
    print(f"  audit ok                 : {result['audit']['all_ok']}")
    print(f"\n  per-line:")
    for ln in sorted(result["per_line"].keys()):
        v = result["per_line"][ln]
        print(f"    L{ln}: {v['baseline']*100:5.2f}% → {v['optimized']*100:5.2f}% ({v['delta_pts']:+.2f} pts)")
    print(f"\n  weekly summary: {result['weekly_summary']}")
    if result['swap_log']:
        print(f"\n  swap log:")
        for s in result['swap_log']:
            print(f"    {s['description']}")

    payload = optimizer_v3_result_to_json(result)
    payload["parse_meta"] = meta
    out_path = OUT_DIR / f"{src.stem}__{objective}.json"
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False, default=str))
    print(f"\n==> JSON: {out_path}")


if __name__ == "__main__":
    main()
