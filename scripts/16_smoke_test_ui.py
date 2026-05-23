"""Smoke-test the new UI callbacks against all 3 known plan Excels.

Calls `app.optimize_v3` and `app.predict` directly so we see exactly what
the Gradio interface will render — summary markdown + dataframes.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import app  # noqa: E402

PLANS = [
    ("Diario Hl_Planif (real)",
     ROOT / "Repte operacions" / "Diario Hl_Planif.xlsx"),
    ("Planificado producciones (mayo 2026)",
     ROOT / "Repte operacions" / "Planificado - producciones 14 - 17 - 19 (v2).xlsx"),
    ("Planificado DEMO bad week W14-2025",
     Path("/Users/marcaguilar/Downloads/Planificado - DEMO bad week.xlsx")),
]


def _print_df(label, df):
    print(f"\n  >> {label}  ({len(df)} rows)")
    if df.empty:
        print("     (empty)")
        return
    print(df.to_string(index=False, max_colwidth=70))


def run_one(label: str, path: Path, aggressive: bool):
    print("\n" + "=" * 90)
    print(f"PLAN: {label}    file={path.name}    aggressive={aggressive}")
    print("=" * 90)

    # ---- 1. Predict
    pred_summary, pred_line, pred_blocks, pred_drivers = app.predict(str(path))
    print("\n--- PREDICT TAB ---")
    print(pred_summary)
    _print_df("Resumen por línea (Predicción)", pred_line)

    # ---- 2. Optimize
    opt_summary, opt_day, opt_line, opt_swap = app.optimize_v3(str(path), aggressive)
    print("\n--- OPTIMIZE TAB ---")
    print(opt_summary)
    _print_df("Por día — 3 líneas combinadas", opt_day)
    _print_df("Por línea — diagnóstico", opt_line)
    _print_df("Swap log (primeras 8)", opt_swap.head(8))


def main():
    for label, path in PLANS:
        if not path.exists():
            print(f"!! SKIP — file not found: {path}")
            continue
        try:
            run_one(label, path, aggressive=True)  # p90 aggressive (most interesting)
        except Exception as exc:
            print(f"!! ERROR on {label}: {exc}")
            import traceback; traceback.print_exc()


if __name__ == "__main__":
    main()
