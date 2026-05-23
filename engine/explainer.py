"""V3 per-move reasoning generator.

Deterministic Spanish descriptions of each move applied by the optimizer.
Inputs are computed metrics — no LLM, every number auditable.

Each move's reason mentions at least one of:
    · ΔOEE pts
    · minutos de cambio ahorrados / añadidos
    · mantenimiento próximo evitado / afrontado
    · agrupación de formato preservada / rota
"""

from __future__ import annotations

from datetime import date

import pandas as pd


def describe_move(move: dict) -> str:
    """Render one move into a single-line Spanish description.

    `move` must contain (all optional, render whatever is present):
        sku, from_linea, from_fecha, from_turno, to_linea, to_fecha, to_turno,
        delta_oee_pts        (float)
        delta_changeover_min (float, negative = saved)
        delta_maint_hours_close (float, positive = farther from maint = better)
        same_format_neighbour   (bool)
    """
    sku = move.get("sku", "?")
    from_str = f"L{move.get('from_linea','?')}/{move.get('from_fecha','?')}/{move.get('from_turno','?')}"
    to_str   = f"L{move.get('to_linea','?')}/{move.get('to_fecha','?')}/{move.get('to_turno','?')}"

    bits: list[str] = []
    d_oee = move.get("delta_oee_pts")
    if d_oee is not None and abs(d_oee) >= 0.01:
        bits.append(f"{d_oee:+.2f} pts OEE")
    d_co = move.get("delta_changeover_min")
    if d_co is not None and abs(d_co) >= 1:
        if d_co < 0:
            bits.append(f"ahorra {abs(int(d_co))} min de cambio")
        else:
            bits.append(f"añade {int(d_co)} min de cambio")
    d_maint = move.get("delta_maint_hours_close")
    if d_maint is not None and abs(d_maint) >= 1:
        if d_maint > 0:
            bits.append(f"se aleja {int(d_maint)} h de mantenimiento")
        else:
            bits.append(f"se acerca {abs(int(d_maint))} h al mantenimiento")
    if move.get("same_format_neighbour"):
        bits.append("agrupa formato")

    reason = " · ".join(bits) if bits else "ajuste neutro"
    return f"Mover {sku}  {from_str}  →  {to_str}  ·  {reason}"


def weekly_summary(swap_log: list[dict], baseline_oee: float, optimized_oee: float) -> str:
    """Aggregate week-level summary of all moves."""
    delta_oee_pts = (optimized_oee - baseline_oee) * 100
    total_changeover_saved = -sum(
        m.get("delta_changeover_min", 0) for m in swap_log
        if m.get("delta_changeover_min", 0) < 0
    )
    total_changeover_added = sum(
        m.get("delta_changeover_min", 0) for m in swap_log
        if m.get("delta_changeover_min", 0) > 0
    )
    net_changeover = total_changeover_added - total_changeover_saved
    n_maint_better = sum(
        1 for m in swap_log if m.get("delta_maint_hours_close", 0) > 0
    )
    n_format_grouped = sum(
        1 for m in swap_log if m.get("same_format_neighbour")
    )

    parts = [
        f"**{len(swap_log)}** movimientos aplicados",
        f"**{delta_oee_pts:+.2f} pts** de OEE (HL-ponderada)",
    ]
    if net_changeover < 0:
        parts.append(f"**−{abs(int(net_changeover))} min** netos de cambio")
    elif net_changeover > 0:
        parts.append(f"**+{int(net_changeover)} min** netos de cambio (peor)")
    if n_maint_better > 0:
        parts.append(f"**{n_maint_better}** OFs alejados de mantenimiento próximo")
    if n_format_grouped > 0:
        parts.append(f"**{n_format_grouped}** OFs reagrupados por formato")

    return "  ·  ".join(parts)
