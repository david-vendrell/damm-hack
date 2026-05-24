"""Generate a 6-Excel test suite for LineWise.

Produces `juego_de_pruebas/01..06_*.xlsx` in Planificado format, each
designed to exercise a specific behaviour of the parser, predictor, and
optimizer:

    01_baseline_real            — sensible well-grouped weekly plan
    02_baseline_repetido        — IDENTICAL copy of 01 (parser determinism)
    03_caos_formatos            — same SKUs, reshuffled to maximise format
                                  alternation (lots of changeovers)
    04_infactible_formato       — places ED12 (1/2) on L17 (1/3 only)
    05_infactible_sin_historico — uses a fake SKU "ZZNEW01" no model has seen
    06_techo_optimo             — pre-grouped by marca + formato; small gains
                                  expected (close to ceiling)
"""
from __future__ import annotations

import sys
from pathlib import Path
from datetime import date, timedelta

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "juego_de_pruebas"
OUT.mkdir(exist_ok=True)

# Week starts Monday 2026-05-25
MON = date(2026, 5, 25)
DAYS = [MON + timedelta(days=i) for i in range(7)]
SHIFTS = ["M", "T", "N"]   # mañana, tarde, noche

# SKU pool — all real, verified against dim_sku + sku_line_feasibility:
#  ED13LTW  1/3 — high history L14/L17/L19
#  ED12LTW  1/2 — fits L14/L19 only (NOT L17)
#  EX12LB   1/2 — fits L14/L19 only
#  3BNEBL23 1/3 — high history L14
#  SK13LN   1/3 — high history L17
#  FDL13LN  1/3 — high history L19
#  VO13LTNN 1/3 — high history L17
#  ED13LTMW 1/3 — high history L14


def _sku_row(linea: int, sku: str, fecha: date, turno: str, hl: float, secuencia: int) -> dict:
    """One Planificado row using slugified column names that the parser maps."""
    return {
        "Material":               sku,
        "Tren":                   linea,
        "Fecha_Ini":              pd.Timestamp(fecha),
        "Definición de turno":    turno,   # detector requires this exact spelling
        "Cntd Plan":              hl,
        "Cntd JDA":               hl,
        "Hora Ini":               {"M": "00:00", "T": "08:00", "N": "16:00"}[turno],
        "Secuencia":              secuencia,
    }


def _baseline_real() -> list[dict]:
    """30 OFs across 3 líneas, well-grouped by marca + formato within each día.

    Reflects how a careful planner would lay out a week: long runs of the same
    marca/formato per shift, minimising changeovers. Should give a decent OEE.
    """
    rows = []
    seq = 1
    # L14 — runs ED13LTMW Mon-Tue, ED13LTW Wed-Thu, 3BNEBL23 Fri-Sat
    L14_plan = [
        (0, "M", "ED13LTMW", 800),
        (0, "T", "ED13LTMW", 800),
        (0, "N", "ED13LTMW", 800),
        (1, "M", "ED13LTMW", 800),
        (2, "M", "ED13LTW",  900),
        (2, "T", "ED13LTW",  900),
        (3, "M", "ED13LTW",  900),
        (4, "M", "3BNEBL23", 700),
        (4, "T", "3BNEBL23", 700),
        (5, "M", "3BNEBL23", 700),
    ]
    for d, t, sku, hl in L14_plan:
        rows.append(_sku_row(14, sku, DAYS[d], t, hl, seq)); seq += 1

    # L17 — runs ED13LTW Mon-Wed, SK13LN Thu-Fri, VO13LTNN Sat
    L17_plan = [
        (0, "M", "ED13LTW",  1000),
        (0, "T", "ED13LTW",  1000),
        (0, "N", "ED13LTW",  1000),
        (1, "M", "ED13LTW",  1000),
        (1, "T", "ED13LTW",  1000),
        (2, "M", "ED13LTW",  1000),
        (3, "M", "SK13LN",    800),
        (3, "T", "SK13LN",    800),
        (4, "M", "SK13LN",    800),
        (5, "M", "VO13LTNN",  700),
    ]
    for d, t, sku, hl in L17_plan:
        rows.append(_sku_row(17, sku, DAYS[d], t, hl, seq)); seq += 1

    # L19 — runs FDL13LN Mon-Tue, ED12LTW Wed-Thu (1/2), EX12LB Fri (1/2)
    L19_plan = [
        (0, "M", "FDL13LN",  900),
        (0, "T", "FDL13LN",  900),
        (1, "M", "FDL13LN",  900),
        (1, "T", "FDL13LN",  900),
        (2, "M", "ED12LTW", 1200),
        (2, "T", "ED12LTW", 1200),
        (3, "M", "ED12LTW", 1200),
        (3, "T", "ED12LTW", 1200),
        (4, "M", "EX12LB",  1100),
        (4, "T", "EX12LB",  1100),
    ]
    for d, t, sku, hl in L19_plan:
        rows.append(_sku_row(19, sku, DAYS[d], t, hl, seq)); seq += 1
    return rows


def _caos_formatos() -> list[dict]:
    """SAME SKU mix as baseline but each shift switches marca/formato.

    Designed to force the model to predict lower OEE (many changeovers) and
    give the optimizer lots of room to regroup. Per-shift order alternates
    1/3 vs 1/2 vs different marcas.
    """
    rows = []
    seq = 1
    # Re-use baseline mix but alternate aggressively per shift
    L14_chaos = [
        (0, "M", "ED13LTMW", 800), (0, "T", "3BNEBL23", 700), (0, "N", "ED13LTW",  900),
        (1, "M", "3BNEBL23", 700), (1, "T", "ED13LTMW", 800), (1, "N", "ED13LTW",  900),
        (2, "M", "ED13LTW",  900), (2, "T", "3BNEBL23", 700),
        (3, "M", "ED13LTMW", 800), (3, "T", "ED13LTW",  900),
    ]
    for d, t, sku, hl in L14_chaos:
        rows.append(_sku_row(14, sku, DAYS[d], t, hl, seq)); seq += 1

    L17_chaos = [
        (0, "M", "ED13LTW",  1000), (0, "T", "SK13LN",    800), (0, "N", "VO13LTNN",  700),
        (1, "M", "SK13LN",    800), (1, "T", "ED13LTW",  1000), (1, "N", "VO13LTNN",  700),
        (2, "M", "ED13LTW",  1000), (2, "T", "SK13LN",    800),
        (3, "M", "VO13LTNN",  700), (3, "T", "ED13LTW",  1000),
    ]
    for d, t, sku, hl in L17_chaos:
        rows.append(_sku_row(17, sku, DAYS[d], t, hl, seq)); seq += 1

    L19_chaos = [
        (0, "M", "FDL13LN",  900), (0, "T", "ED12LTW", 1200), (0, "N", "EX12LB",  1100),
        (1, "M", "ED12LTW", 1200), (1, "T", "FDL13LN",  900), (1, "N", "EX12LB",  1100),
        (2, "M", "EX12LB",  1100), (2, "T", "ED12LTW", 1200),
        (3, "M", "FDL13LN",  900), (3, "T", "ED12LTW", 1200),
    ]
    for d, t, sku, hl in L19_chaos:
        rows.append(_sku_row(19, sku, DAYS[d], t, hl, seq)); seq += 1
    return rows


def _infactible_formato() -> list[dict]:
    """Baseline + one ED12LTW (1/2) on L17, which only produces 1/3.

    The parser should flag this single block as infeasible (`feasible=False`)
    with `feas_reason` explaining the format mismatch. The rest of the plan
    must remain feasible and predict normally.
    """
    rows = _baseline_real()
    rows.append(_sku_row(17, "ED12LTW", DAYS[5], "T", 1200, 999))
    return rows


def _infactible_sin_historico() -> list[dict]:
    """Baseline + a fabricated SKU 'ZZNEW01' on L19.

    Parser should mark this as low-confidence (`has_history=False`) because
    the SKU has never run on L19 in the training data. The block is still
    considered feasible (format unknown defaults to allowed) but the predict
    flag should warn.
    """
    rows = _baseline_real()
    rows.append(_sku_row(19, "ZZNEW01", DAYS[5], "T", 800, 998))
    return rows


def _con_mantenimiento_conflict() -> list[dict]:
    """Baseline + three OFs deliberately placed on slots blocked by the CF
    Prat schedule:
      · L17 Lunes turno M  ← LIMPIEZA semanal (blocked)
      · L17 Lunes turno T  ← LIMPIEZA semanal (blocked, 11.5h overflow)
      · L14 Viernes turno M ← LIMPIEZA semanal (blocked)

    The parser should mark all three as infeasible with the explicit
    `Slot bloqueado: LIMPIEZA programada ...` reason. The optimizer should
    refuse to keep them in place and report `maintenance_violations=[]` after
    relocation (or leave them flagged if no legal slot exists).

    DAYS[0] = Monday (2026-05-25, iso_week 22 → even → QUINCENAL events also fire).
    DAYS[4] = Friday (2026-05-29).
    """
    rows = _baseline_real()
    rows.append(_sku_row(17, "ED13LTW", DAYS[0], "M", 900, 990))   # L17 Mon M — LIMPIEZA
    rows.append(_sku_row(17, "ED13LTW", DAYS[0], "T", 900, 991))   # L17 Mon T — LIMPIEZA overflow
    rows.append(_sku_row(14, "ED13LTMW", DAYS[4], "M", 800, 992))  # L14 Fri M — LIMPIEZA
    return rows


def _techo_optimo() -> list[dict]:
    """Each línea runs ONE marca all week, sequenced cleanly.

    This is the ideal layout — minimal changeovers, no format mixing. The
    optimizer should find very little to improve (<0.3 pts gain expected).
    """
    rows = []
    seq = 1
    # L14 — ED13LTW all week (high-history, 1/3, fits L14)
    for d_idx, d in enumerate(DAYS[:5]):
        for t in SHIFTS:
            rows.append(_sku_row(14, "ED13LTW", d, t, 600, seq)); seq += 1
    # L17 — ED13LTW all week (highest-history on L17)
    for d_idx, d in enumerate(DAYS[:5]):
        for t in SHIFTS:
            rows.append(_sku_row(17, "ED13LTW", d, t, 700, seq)); seq += 1
    # L19 — ED13LTW all week (also high-history on L19)
    for d_idx, d in enumerate(DAYS[:5]):
        for t in SHIFTS:
            rows.append(_sku_row(19, "ED13LTW", d, t, 800, seq)); seq += 1
    return rows


def _outage_basico() -> list[dict]:
    """Baseline plan — the runner will declare an outage on L17 Wed M
    (currently empty in baseline, but verifies the optimizer treats it as
    a hard block and that any pre-existing OF on it would have been moved).

    Same shape as baseline_real so the comparison is clean.
    """
    return _baseline_real()


def _priority_holgado() -> list[dict]:
    """Light plan with plenty of headroom — runner declares 1 priority OF
    that can be placed without eviction.
    """
    rows = []
    seq = 1
    # Light plan: 2 OFs per línea per día for 3 días, leaves N turno empty
    light_skus = [(14, "ED13LTMW", 700), (17, "ED13LTW", 800), (19, "FDL13LN", 700)]
    for d_idx in range(3):
        for (ln, sku, hl) in light_skus:
            for t in ("M", "T"):
                rows.append(_sku_row(ln, sku, DAYS[d_idx], t, hl, seq)); seq += 1
    return rows


def _priority_evict_plan() -> list[dict]:
    """Stress-placement: priority OF with tight deadline + preferred línea
    forces the optimizer to find SOME feasible slot quickly.

    Cap heuristic in precompute is loose (historical max ~88-172 OFs/día),
    so true capacity-driven eviction is hard to trigger from a synthetic
    plan without an override. This test instead exercises the placement
    path under a tight constraint: priority OF deadline = Tue, prefers L17,
    L17 Mon M is LIMPIEZA-blocked, so the only feasible slots are L17 Mon
    T/N and L17 Tue M/T/N (5 slots) — placement should land at the highest
    intrinsic-OEE one.
    """
    rows = []
    seq = 1
    # L17 Mon-Tue — moderately filled (4 OFs per shift on each unblocked slot)
    packed_slots = [
        (DAYS[0], "T"), (DAYS[0], "N"),
        (DAYS[1], "M"), (DAYS[1], "T"), (DAYS[1], "N"),
    ]
    for (d, t) in packed_slots:
        for _ in range(4):
            rows.append(_sku_row(17, "ED13LTW", d, t, 400, seq)); seq += 1
    # L14 + L19 — filler so the plan isn't L17-only
    for d_idx in range(2):
        for t in ("M", "T"):
            rows.append(_sku_row(14, "ED13LTMW", DAYS[d_idx], t, 600, seq)); seq += 1
            rows.append(_sku_row(19, "FDL13LN",  DAYS[d_idx], t, 600, seq)); seq += 1
    return rows


def _replan_midweek() -> list[dict]:
    """Plan spanning Mon-Fri with 2-3 OFs per día per línea, dense enough
    that a Wednesday replan freezes a meaningful chunk while leaving the
    rest of the week rearrangeable.

    Combined with replan_from_ts=2026-05-27T10:00:00 (Wed mañana shift end)
    and an outage on L17/Wed/T+N, the test asserts:
      · frozen_count > 0    (Mon + Tue OFs pinned)
      · n_changes ≥ 0       (the optimizer may or may not find improvements
                             on the unfrozen remainder)
      · all frozen OFs keep their original (línea, fecha, turno)
    """
    rows = []
    seq = 1
    # 3 OFs per día per línea — moderate density on Mon-Thu
    pattern = [
        (14, "ED13LTMW", 600), (14, "ED13LTW", 600), (14, "3BNEBL23", 500),
        (17, "ED13LTW", 700), (17, "SK13LN", 600), (17, "VO13LTNN", 500),
        (19, "FDL13LN", 700), (19, "ED12LTW", 900), (19, "EX12LB", 800),
    ]
    for d_idx in range(4):  # Mon-Thu
        # Distribute the 3 SKUs per línea across M/T/N turnos
        for (linea, sku, hl) in pattern:
            # Pick turno by SKU index in this línea's group
            seq_in_line = sum(1 for p in pattern[:pattern.index((linea, sku, hl))]
                              if p[0] == linea)
            turno = SHIFTS[seq_in_line % 3]
            rows.append(_sku_row(linea, sku, DAYS[d_idx], turno, hl, seq)); seq += 1
    return rows


def write_xlsx(rows: list[dict], out_path: Path) -> None:
    df = pd.DataFrame(rows)
    df.to_excel(out_path, index=False, sheet_name="Planificado")
    print(f"  wrote {out_path.name}  ({len(df)} OFs)")


def main():
    print(f"==> Writing test suite to {OUT}")
    print()

    plans = [
        ("01_baseline_real.xlsx",            _baseline_real),
        ("02_baseline_repetido.xlsx",        _baseline_real),       # IDENTICAL to 01
        ("03_caos_formatos.xlsx",            _caos_formatos),
        ("04_infactible_formato.xlsx",       _infactible_formato),
        ("05_infactible_sin_historico.xlsx", _infactible_sin_historico),
        ("06_techo_optimo.xlsx",             _techo_optimo),
        ("07_conflicto_mantenimiento.xlsx",  _con_mantenimiento_conflict),
        ("08_outage_basico.xlsx",            _outage_basico),
        ("09_priority_holgado.xlsx",         _priority_holgado),
        ("10_priority_evict.xlsx",           _priority_evict_plan),
        ("11_replan_midweek.xlsx",           _replan_midweek),
    ]

    for name, gen in plans:
        write_xlsx(gen(), OUT / name)

    print()
    print(f"==> Done. {len(plans)} files in {OUT}")


if __name__ == "__main__":
    main()
