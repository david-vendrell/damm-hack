"""Project the deterministic CF Prat maintenance schedule onto a planning
window and return the set of `(línea, fecha, turno)` slots that the
optimizer/parser must treat as hard-blocked.

Source of truth: `lookups/maintenance_schedule.parquet` produced by
`scripts/19_build_maintenance_schedule.py`.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Iterable

import pandas as pd


@dataclass(frozen=True)
class BlockedSlot:
    linea:       int
    fecha:       date
    turno:       str        # "M" | "T" | "N"
    event_type:  str        # "LIMPIEZA" | "MANTENIMIENTO"
    duration_h:  float
    reason:      str        # human-readable Spanish reason for UI


def load_schedule(lookups_dir: str | Path) -> pd.DataFrame:
    path = Path(lookups_dir) / "maintenance_schedule.parquet"
    if not path.exists():
        # Graceful degradation: missing schedule → no blocks. Lets the
        # pipeline keep working before Gap 2's build step has run.
        return pd.DataFrame(columns=[
            "linea", "event_type", "day_of_week", "day_code",
            "frequency", "duration_h", "turnos_to_block", "anchor_iso_week",
        ])
    return pd.read_parquet(path)


def _fires_this_week(iso_week: int, frequency: str, anchor_iso_week: int) -> bool:
    if frequency == "SEMANAL":
        return True
    if frequency == "QUINCENAL":
        return (iso_week - anchor_iso_week) % 2 == 0
    if frequency == "MENSUAL":
        # Approximation: fires when (iso_week - anchor) % 4 == 0
        return (iso_week - anchor_iso_week) % 4 == 0
    return False


def projected_blocked_slots(
    fechas: Iterable[date],
    schedule: pd.DataFrame | None = None,
    lookups_dir: str | Path | None = None,
) -> set[BlockedSlot]:
    """For every día in `fechas`, decide which (línea, turno) pairs are blocked
    by scheduled LIMPIEZA / MANTENIMIENTO. Returns a set of BlockedSlot.
    """
    if schedule is None:
        if lookups_dir is None:
            raise ValueError("Provide either `schedule` or `lookups_dir`.")
        schedule = load_schedule(lookups_dir)
    if schedule.empty:
        return set()

    fechas_set = sorted({pd.Timestamp(f).date() for f in fechas})
    if not fechas_set:
        return set()

    out: set[BlockedSlot] = set()
    for f in fechas_set:
        iso_week = f.isocalendar()[1]
        weekday  = f.weekday()
        for _, ev in schedule.iterrows():
            if int(ev["day_of_week"]) != weekday:
                continue
            if not _fires_this_week(iso_week, ev["frequency"], int(ev["anchor_iso_week"])):
                continue
            days_es = {0: "lunes", 1: "martes", 2: "miércoles", 3: "jueves",
                       4: "viernes", 5: "sábado", 6: "domingo"}
            for turno in ev["turnos_to_block"]:
                reason = (
                    f"Slot bloqueado: {ev['event_type']} programada "
                    f"en L{int(ev['linea'])} los {days_es[weekday]} "
                    f"(turno {turno}, {ev['frequency'].lower()}, "
                    f"~{ev['duration_h']:.1f}h)"
                )
                out.add(BlockedSlot(
                    linea       = int(ev["linea"]),
                    fecha       = f,
                    turno       = str(turno),
                    event_type  = str(ev["event_type"]),
                    duration_h  = float(ev["duration_h"]),
                    reason      = reason,
                ))
    return out


def blocked_slot_map(
    fechas: Iterable[date],
    schedule: pd.DataFrame | None = None,
    lookups_dir: str | Path | None = None,
) -> dict[tuple[int, date, str], BlockedSlot]:
    """Same as `projected_blocked_slots` but indexed by `(línea, fecha, turno)`
    for O(1) lookup from the slot generator / parser."""
    return {(b.linea, b.fecha, b.turno): b
            for b in projected_blocked_slots(fechas, schedule, lookups_dir)}
