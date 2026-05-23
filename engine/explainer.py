"""V3 per-move reasoning generator.

Deterministic Spanish descriptions of each move applied by the optimizer.
Inputs are computed metrics — no LLM, every number auditable.

Each move's reason mentions at least one of:
    · ΔOEE pts
    · minutos de cambio ahorrados / añadidos
    · mantenimiento próximo evitado / afrontado
    · agrupación de formato preservada / rota

V3.1 adds templates for incident-driven moves:
    · `describe_priority_insert`  — for OF prioritario insertado en X
    · `describe_eviction`         — for OF desplazado por OF prioritario
"""

from __future__ import annotations


def describe_move(move: dict) -> str:
    """Render one optimization move into a single-line Spanish description.

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


def describe_priority_insert(job, slot) -> str:
    """`job` is a Job (is_priority=True), `slot` is the Slot it was placed in."""
    reason = str(job.raw_row.get("priority_reason") or "OF prioritario")
    return (
        f"⭐ OF prioritario {job.sku} ({int(job.hl)} HL) insertado en "
        f"L{slot.linea}/{slot.fecha.isoformat()}/{slot.turno} · "
        f"deadline {job.deadline.isoformat()} · {reason}"
    )


def describe_eviction(victim_job, victim_slot, displaced_by_job) -> str:
    """`victim_job` is the OF being evicted from `victim_slot`,
    displaced by `displaced_by_job` (a priority Job)."""
    return (
        f"⚠️ OF {victim_job.sku} desplazado de "
        f"L{victim_slot.linea}/{victim_slot.fecha.isoformat()}/{victim_slot.turno} "
        f"por OF prioritario {displaced_by_job.sku} · pendiente de realojo"
    )


def weekly_summary(
    swap_log: list[dict],
    baseline_oee: float,
    optimized_oee: float,
    *,
    n_outages: int = 0,
    n_priority_placed: int = 0,
    n_priority_failed: int = 0,
    n_evictions: int = 0,
) -> str:
    """Aggregate week-level summary of all moves, with optional incident line."""
    delta_oee_pts = (optimized_oee - baseline_oee) * 100

    # Count only optimization-type moves for changeover/format aggregates
    opt_moves = [m for m in swap_log if m.get("move_type", "optimization") == "optimization"]
    total_changeover_saved = -sum(
        m.get("delta_changeover_min", 0) for m in opt_moves
        if m.get("delta_changeover_min", 0) < 0
    )
    total_changeover_added = sum(
        m.get("delta_changeover_min", 0) for m in opt_moves
        if m.get("delta_changeover_min", 0) > 0
    )
    net_changeover = total_changeover_added - total_changeover_saved
    n_maint_better = sum(
        1 for m in opt_moves if m.get("delta_maint_hours_close", 0) > 0
    )
    n_format_grouped = sum(
        1 for m in opt_moves if m.get("same_format_neighbour")
    )

    parts = [
        f"**{len(opt_moves)}** movimientos de optimización aplicados",
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

    base_line = "  ·  ".join(parts)

    incidencias_bits: list[str] = []
    if n_outages:
        incidencias_bits.append(f"**{n_outages}** outage(s) declarado(s)")
    if n_priority_placed:
        incidencias_bits.append(f"**{n_priority_placed}** OF(s) prioritario(s) insertado(s)")
    if n_evictions:
        incidencias_bits.append(f"**{n_evictions}** OF(s) desplazado(s)")
    if n_priority_failed:
        incidencias_bits.append(f"⚠️ **{n_priority_failed}** OF(s) prioritario(s) sin slot factible")

    if incidencias_bits:
        return base_line + "\n\n**Incidencias:** " + "  ·  ".join(incidencias_bits)
    return base_line
