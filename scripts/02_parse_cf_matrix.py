"""
LineWise — Step 02: Parse the LATA/BARRIL changeover-format matrix.

The Excel sheet 'LATA_BARRIL' has one square sub-matrix per line (TREN 14, 17, 19).
Each sub-matrix has format states as rows AND columns (1/3, 1/2, [2/5 only on L19],
Cambio Packaging, Cambio a Bandeja, Cambio Paletizado). Cell values are durations
expressed in human strings ('3 h', '40 min', '1 h 15 min'). The diagonal is omitted
(implicit zero). We parse the whole thing into a clean long-format table.

Output:
    dim_theoretical_changeover_matrix(linea, from_state, to_state, minutes)

Plus a normalised state map so we can join against the Cambios file later.
"""

from __future__ import annotations

import re
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "db" / "linewise.duckdb"


def parse_duration(s) -> int | None:
    """Parse strings like '3 h', '40 min', '1 h 15 min' into integer minutes."""
    if s is None:
        return None
    txt = str(s).strip().lower()
    if not txt:
        return None
    minutes = 0
    found = False
    m = re.search(r"(\d+)\s*h", txt)
    if m:
        minutes += int(m.group(1)) * 60
        found = True
    m = re.search(r"(\d+)\s*min", txt)
    if m:
        minutes += int(m.group(1))
        found = True
    if not found:
        # bare number? interpret as minutes
        m = re.match(r"^\d+$", txt)
        if m:
            return int(txt)
        return None
    return minutes


def main() -> None:
    con = duckdb.connect(str(DB_PATH))

    rows = con.execute(
        "SELECT row_idx, col_0, col_1, col_2, col_3, col_4, col_5, col_6 "
        "FROM raw_cf_lata_barril ORDER BY row_idx"
    ).fetchall()

    parsed: list[tuple[int, str, str, int]] = []
    i = 0
    while i < len(rows):
        row = rows[i]
        c0 = row[1]
        if c0 and isinstance(c0, str) and c0.upper().startswith("TREN"):
            m = re.search(r"\d+", c0)
            if not m:
                i += 1
                continue
            linea = int(m.group())
            # State headers are in col_1..col_k (positions row[2:] in the tuple)
            # Collect non-null contiguous from position 2 onwards.
            states: list[str] = []
            for c in row[2:]:
                if c is None or str(c).strip() == "":
                    break
                states.append(str(c).strip())
            n_states = len(states)
            # The next n_states rows are the matrix body. Cell layout: col_0 = FROM
            # label, col_1..col_n_states = values aligned to states[0..n_states-1].
            # The diagonal cell (FROM == state) is NULL in the spreadsheet.
            for j in range(1, n_states + 1):
                if i + j >= len(rows):
                    break
                data = rows[i + j]
                from_raw = data[1]
                if from_raw is None:
                    continue
                from_state = str(from_raw).strip()
                for k, to_state in enumerate(states):
                    raw_val = data[2 + k]  # col_(k+1)
                    if to_state == from_state:
                        parsed.append((linea, from_state, to_state, 0))  # diagonal
                        continue
                    minutes = parse_duration(raw_val)
                    if minutes is None:
                        continue
                    parsed.append((linea, from_state, to_state, minutes))
            i += n_states + 1
        else:
            i += 1

    # write table
    con.execute("DROP TABLE IF EXISTS dim_theoretical_changeover_matrix")
    con.execute("""
        CREATE TABLE dim_theoretical_changeover_matrix (
            linea       INTEGER,
            from_state  VARCHAR,
            to_state    VARCHAR,
            minutes     INTEGER
        )
    """)
    con.executemany(
        "INSERT INTO dim_theoretical_changeover_matrix VALUES (?, ?, ?, ?)",
        parsed,
    )

    n = con.execute(
        "SELECT COUNT(*) FROM dim_theoretical_changeover_matrix"
    ).fetchone()[0]
    print(f"==> dim_theoretical_changeover_matrix: {n} rows")

    print("\nSample:")
    sample = con.execute("""
        SELECT linea, from_state, to_state, minutes
        FROM dim_theoretical_changeover_matrix
        WHERE minutes > 0
        ORDER BY linea, minutes DESC
        LIMIT 10
    """).fetchall()
    for r in sample:
        print(f"  L{r[0]}  {r[1]:>20} -> {r[2]:<20}  {r[3]:>4} min")

    print("\nSummary by line:")
    summary = con.execute("""
        SELECT linea,
               COUNT(*) AS n_pairs,
               COUNT(DISTINCT from_state) AS n_states,
               MIN(minutes) FILTER (WHERE minutes > 0) AS min_min,
               MAX(minutes) AS max_min,
               ROUND(AVG(minutes) FILTER (WHERE minutes > 0), 1) AS avg_min
        FROM dim_theoretical_changeover_matrix
        GROUP BY linea
        ORDER BY linea
    """).fetchall()
    for r in summary:
        print(f"  L{r[0]}: {r[1]:>3} pairs, {r[2]} states, range {r[3]}-{r[4]} min, avg {r[5]} min")

    con.close()
    print("\n==> Done.")


if __name__ == "__main__":
    main()
