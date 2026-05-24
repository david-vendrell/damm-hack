"""Pure-function validators for the V2/V3 optimizers.

Used during search (cheap O(1) checks per candidate move) and as a final audit
after optimization to guarantee the returned plan is implementable.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any

import pandas as pd

from .parse_planning_excel import LINE_FORMAT_COMPAT


# ============================================================
# Data structures
# ============================================================
@dataclass
class Job:
    """A production order to place. Immutable identity."""
    job_id: str
    sku: str
    hl: float
    deadline: date                # latest fecha the job may finish on
    estado_volumen: str | None    # 1/3 | 1/2 | 2/5 | None (unknown)
    feasible_lines: set[int]      # lines this job can physically run on
    # carry-through (not used by the solver but preserved for output):
    original_block_id: str
    raw_row: dict                 # full row from parse_planning_excel for round-trip
    is_priority: bool = False     # caller-injected urgent OF — pre-placed + pinned
    is_frozen: bool = False       # already produced / in-progress at replan_from_ts
                                  # → pinned to original slot, can't be moved or evicted
    frozen_reason: str | None = None  # human-readable why (for the audit UI)


@dataclass
class Slot:
    """A (línea, fecha, turno) bucket that can hold one or more jobs in sequence."""
    slot_id: str
    linea: int
    fecha: date
    turno: str                    # T / N / M
    capacity_blocks: int          # max # jobs (heuristic from history)
    is_blocked: bool = False              # any hard-block source (LIMPIEZA / MANT / OUTAGE)
    block_event: str | None = None        # "LIMPIEZA" | "MANTENIMIENTO" | "OUTAGE" | None
    block_reason: str | None = None       # human-readable Spanish for the UI


# ============================================================
# Validators (return True if OK; cheap)
# ============================================================
def deadline_ok(job: Job, slot: Slot) -> bool:
    return slot.fecha <= job.deadline


def format_ok(job: Job, slot: Slot) -> bool:
    if job.estado_volumen is None:
        return True              # unknown format → benefit of the doubt
    allowed = LINE_FORMAT_COMPAT.get(slot.linea, set())
    return job.estado_volumen in allowed


def line_in_feasible_set(job: Job, slot: Slot) -> bool:
    return slot.linea in job.feasible_lines


def block_ok(_job: Job, slot: Slot) -> bool:
    """A slot blocked by LIMPIEZA / MANTENIMIENTO / OUTAGE cannot accept any
    production OF — hard reject."""
    return not slot.is_blocked


def can_place(job: Job, slot: Slot) -> bool:
    """All the hard constraints excluding capacity (capacity is checked
    against the running assignment, not a static slot property)."""
    return (deadline_ok(job, slot)
            and format_ok(job, slot)
            and line_in_feasible_set(job, slot)
            and block_ok(job, slot))


# ============================================================
# Aggregate audits (run once at the end on the final assignment)
# ============================================================
def hl_invariance_ok(blocks_before: pd.DataFrame, blocks_after: pd.DataFrame) -> tuple[bool, float]:
    """`sum(hl) per sku` must be identical before/after. Returns (ok, max_abs_diff).

    Priority OFs (rows tagged with `_is_priority=True`) are EXCLUDED from both
    sides because they are additive to total HL by definition.
    """
    def _drop_priority(df: pd.DataFrame) -> pd.DataFrame:
        if "_is_priority" in df.columns:
            mask = df["_is_priority"].fillna(False).astype(bool)
            return df[~mask]
        return df
    before = _drop_priority(blocks_before).groupby("sku")["hl"].sum().sort_index()
    after  = _drop_priority(blocks_after).groupby("sku")["hl"].sum().sort_index()
    aligned = before.align(after, fill_value=0)
    diff = (aligned[0] - aligned[1]).abs().max()
    return diff < 1e-3, float(diff)


def capacity_audit(assignment: dict[str, str], slots_by_id: dict[str, Slot]) -> dict[str, int]:
    """Return any slots that exceed their capacity."""
    counts: dict[str, int] = {}
    for slot_id in assignment.values():
        counts[slot_id] = counts.get(slot_id, 0) + 1
    over = {sid: n for sid, n in counts.items() if n > slots_by_id[sid].capacity_blocks}
    return over


def deadline_audit(assignment: dict[str, str], jobs_by_id: dict[str, Job],
                   slots_by_id: dict[str, Slot]) -> list[tuple[str, date, date]]:
    """Return [(job_id, slot_fecha, deadline)] for any deadline violations."""
    out = []
    for jid, sid in assignment.items():
        if slots_by_id[sid].fecha > jobs_by_id[jid].deadline:
            out.append((jid, slots_by_id[sid].fecha, jobs_by_id[jid].deadline))
    return out


def format_audit(assignment: dict[str, str], jobs_by_id: dict[str, Job],
                 slots_by_id: dict[str, Slot]) -> list[tuple[str, int, str]]:
    """Return [(job_id, slot_linea, estado_volumen)] for any format violations."""
    out = []
    for jid, sid in assignment.items():
        job = jobs_by_id[jid]; slot = slots_by_id[sid]
        if job.estado_volumen is None:
            continue
        if job.estado_volumen not in LINE_FORMAT_COMPAT.get(slot.linea, set()):
            out.append((jid, slot.linea, job.estado_volumen))
    return out


def block_audit(assignment: dict[str, str],
                slots_by_id: dict[str, Slot]) -> list[tuple[str, str, str]]:
    """Return [(job_id, slot_id, block_event)] for any OF placed on a blocked
    slot (LIMPIEZA / MANTENIMIENTO / OUTAGE)."""
    out = []
    for jid, sid in assignment.items():
        slot = slots_by_id[sid]
        if slot.is_blocked:
            out.append((jid, sid, slot.block_event or "BLOCK"))
    return out


def priority_audit(assignment: dict[str, str | None],
                   jobs_by_id: dict[str, Job],
                   slots_by_id: dict[str, Slot]) -> list[dict]:
    """Return one record per priority OF that was NOT correctly placed.

    A priority OF is correctly placed iff it has an assignment, the slot is
    feasible (deadline + format + not blocked), and the slot's fecha is on or
    before the job's deadline.
    """
    out = []
    for jid, job in jobs_by_id.items():
        if not job.is_priority:
            continue
        sid = assignment.get(jid)
        if sid is None:
            out.append({"job_id": jid, "sku": job.sku, "reason": "no_slot_assigned",
                        "deadline": job.deadline.isoformat()})
            continue
        slot = slots_by_id[sid]
        if slot.fecha > job.deadline:
            out.append({"job_id": jid, "sku": job.sku, "reason": "past_deadline",
                        "placed_at": slot.fecha.isoformat(),
                        "deadline": job.deadline.isoformat()})
            continue
        if not can_place(job, slot):
            out.append({"job_id": jid, "sku": job.sku, "reason": "infeasible_slot",
                        "slot_id": sid})
    return out


def full_audit(
    blocks_before: pd.DataFrame,
    blocks_after: pd.DataFrame,
    assignment: dict[str, str],
    jobs_by_id: dict[str, Job],
    slots_by_id: dict[str, Slot],
) -> dict[str, Any]:
    hl_ok, hl_diff = hl_invariance_ok(blocks_before, blocks_after)
    over_cap = capacity_audit(assignment, slots_by_id)
    bad_dl = deadline_audit(assignment, jobs_by_id, slots_by_id)
    bad_fmt = format_audit(assignment, jobs_by_id, slots_by_id)
    bad_blk = block_audit(assignment, slots_by_id)
    bad_prio = priority_audit(assignment, jobs_by_id, slots_by_id)
    return {
        "hl_invariance_ok":     hl_ok,
        "hl_max_abs_diff":      hl_diff,
        "capacity_overruns":    over_cap,        # {} if all ok
        "deadline_violations":  bad_dl,          # [] if all ok
        "format_violations":    bad_fmt,         # [] if all ok
        "block_violations":     bad_blk,         # [] if all ok (LIMPIEZA / MANT / OUTAGE)
        # Back-compat alias for any consumer still reading the old key:
        "maintenance_violations": bad_blk,
        "priority_violations":  bad_prio,        # [] if every priority OF placed correctly
        "all_ok":               hl_ok and not over_cap and not bad_dl
                                and not bad_fmt and not bad_blk and not bad_prio,
    }
