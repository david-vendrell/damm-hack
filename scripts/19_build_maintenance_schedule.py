"""Parse the CF Prat "Tiempos adicionales" sheet to derive the deterministic
maintenance schedule and emit `lookups/maintenance_schedule.parquet`.

Damm operates the canning lines in a **5-TURNOS** continuous regime, so we
pull the 5-TURNOS column (día + frecuencia) from the LIMPIEZA Y MANTENIMIENTO
block. Each event is 8h (one shift). LIMPIEZA events also carry an
Esterilización (1.5h) + CIP (2h) overhead, extending to ~11.5h, which
overflows into a second turno.

Source: Repte operacions/Tabla CF Prat 2026_14_17_19.xlsx · sheet "Tiempos
adicionales" · rows 4-9 (limpieza/mantenimiento) and rows 13-18 (CIP).

Output schema (one row per event type per línea):
    linea           int             14 / 17 / 19
    event_type      str             "LIMPIEZA" | "MANTENIMIENTO"
    day_of_week     int             0=Mon ... 6=Sun  (L=0, X=2, J=3, V=4)
    frequency       str             "SEMANAL" | "QUINCENAL"
    duration_h      float           total event hours (8 base, 11.5 for LIMPIEZA)
    turnos_to_block list[str]       ["M"] for 8h, ["M","T"] for 11.5h
    anchor_iso_week int             reference ISO week for QUINCENAL parity
"""
from __future__ import annotations

from pathlib import Path

import openpyxl
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
SRC  = ROOT / "Repte operacions" / "Tabla CF Prat 2026_14_17_19.xlsx"
OUT  = ROOT / "lookups" / "maintenance_schedule.parquet"

# Damm día code → ISO weekday (Monday = 0)
DAY_CODE = {"L": 0, "M": 1, "X": 2, "J": 3, "V": 4, "S": 5, "D": 6}

# 5-TURNOS column in the LIMPIEZA Y MANTENIMIENTO block
COL_DIA_5T = 9    # 0-indexed
COL_FREQ_5T = 10

# Anchor ISO week for QUINCENAL parity. Convention: ISO week 2 of 2025
# (first calendar Monday of 2025 was 2025-01-06). QUINCENAL events fire on
# weeks of the SAME parity. Users can override by editing the parquet.
ANCHOR_ISO_WEEK = 2

# Turno mapping: each turno is 8h, ordered M (00-08) → T (08-16) → N (16-24)
# An event starting at 00:00 of its día with N hours blocks ⌈N/8⌉ turnos.
def _turnos_for_duration(hours: float) -> list[str]:
    n = max(1, int((hours + 7.99) // 8))   # ceil(hours/8)
    return ["M", "T", "N"][:n]


def parse_schedule() -> pd.DataFrame:
    wb = openpyxl.load_workbook(SRC, data_only=True)
    ws = wb["Tiempos adicionales"]

    rows: list[dict] = []
    # Esterilización + CIP overhead per línea (we'll add to LIMPIEZA duration)
    extras_per_linea = {14: 1.5 + 2.0, 17: 1.5 + 2.0, 19: 1.5 + 2.0}

    # The LIMPIEZA Y MANTENIMIENTO block lives in rows 4-9 (1-indexed) of the
    # sheet. Pairs of rows per línea: even row = Limpieza, odd = Mantenimiento.
    # We walk all data rows and pick out the events.
    current_linea: int | None = None
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        if i < 4 or i > 9:
            continue
        # Column 0 holds "TREN 14" / "TREN 17" / "TREN 19" on even rows
        c0 = (row[0] or "").strip() if row[0] else ""
        if c0.startswith("TREN"):
            current_linea = int(c0.split()[1])
        c1 = (row[1] or "").strip() if row[1] else ""
        if c1 not in ("Limpieza", "Mantenimiento") or current_linea is None:
            continue

        dia_code  = (row[COL_DIA_5T]  or "").strip() if row[COL_DIA_5T]  else ""
        freq      = (row[COL_FREQ_5T] or "").strip() if row[COL_FREQ_5T] else ""
        if not dia_code or dia_code == "-" or not freq or freq == "-":
            # No event scheduled for this línea in 5-TURNOS regime
            continue
        if dia_code not in DAY_CODE:
            print(f"  WARN: unknown día code '{dia_code}' for L{current_linea} {c1}")
            continue
        if freq not in ("SEMANAL", "QUINCENAL", "MENSUAL"):
            print(f"  WARN: unknown frecuencia '{freq}' for L{current_linea} {c1}")
            continue

        event_type = c1.upper()  # "LIMPIEZA" | "MANTENIMIENTO"
        base_h = 8.0
        total_h = base_h + (extras_per_linea[current_linea] if event_type == "LIMPIEZA" else 0.0)

        rows.append({
            "linea":            current_linea,
            "event_type":       event_type,
            "day_of_week":      DAY_CODE[dia_code],
            "day_code":         dia_code,
            "frequency":        freq,
            "duration_h":       round(total_h, 2),
            "turnos_to_block":  _turnos_for_duration(total_h),
            "anchor_iso_week":  ANCHOR_ISO_WEEK,
        })

    return pd.DataFrame(rows)


def main() -> None:
    print(f"==> Parsing {SRC.name}")
    df = parse_schedule()

    print(f"\n==> {len(df)} events extracted (5-TURNOS regime):")
    for _, r in df.iterrows():
        days_es = {0: "Lunes", 1: "Martes", 2: "Miércoles", 3: "Jueves",
                   4: "Viernes", 5: "Sábado", 6: "Domingo"}
        turnos = ",".join(r["turnos_to_block"])
        print(f"  L{r['linea']}  {r['event_type']:<14s}  "
              f"{days_es[r['day_of_week']]:<10s}  {r['frequency']:<10s}  "
              f"{r['duration_h']:>5.1f}h  → bloquea turnos [{turnos}]")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(OUT, index=False)
    print(f"\n==> Wrote {OUT}")


if __name__ == "__main__":
    main()
