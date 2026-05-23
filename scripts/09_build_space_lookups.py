"""
LineWise — Step 09: Precompute the lookup parquets the HF Space needs at runtime.

The Space ships only these small parquets + the models + the engine code.
No DuckDB at runtime — every Group D/E feature is read from a lookup.

Run from repo root after 08_evaluate_oee_quantile.py:
    python3 scripts/09_build_space_lookups.py

Output:
    lookups/dim_sku.parquet
    lookups/dim_theoretical_changeover_matrix.parquet
    lookups/sku_line_feasibility.parquet
    lookups/last_historical_of_per_line.parquet
    lookups/sku_line_aggregates.parquet
    lookups/linea_aggregates.parquet
    lookups/familia_line_aggregates.parquet
    lookups/pair_transition_aggregates.parquet
    lookups/maintenance_proxy.parquet
    lookups/fact_runs_slim.parquet
"""

from __future__ import annotations

from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "db" / "linewise.duckdb"
OUT = ROOT / "lookups"
OUT.mkdir(parents=True, exist_ok=True)


def main() -> None:
    con = duckdb.connect(str(DB_PATH), read_only=True)

    # ============================================================ dim_sku (full)
    con.execute(f"""
        COPY (SELECT * FROM dim_sku)
        TO '{(OUT / "dim_sku.parquet").as_posix()}' (FORMAT PARQUET)
    """)
    n = con.execute("SELECT COUNT(*) FROM dim_sku").fetchone()[0]
    print(f"==> dim_sku.parquet                       ({n} rows)")

    # ============================================================ theoretical matrix
    con.execute(f"""
        COPY (SELECT * FROM dim_theoretical_changeover_matrix)
        TO '{(OUT / "dim_theoretical_changeover_matrix.parquet").as_posix()}' (FORMAT PARQUET)
    """)
    n = con.execute("SELECT COUNT(*) FROM dim_theoretical_changeover_matrix").fetchone()[0]
    print(f"==> dim_theoretical_changeover_matrix.parquet ({n} rows)")

    # ============================================================ sku-line feasibility
    con.execute(f"""
        COPY (
            SELECT
                sku,
                linea,
                COUNT(*)                              AS n_historical_runs,
                ROUND(AVG(oee), 4)                    AS mean_oee_all_time,
                ROUND(QUANTILE_CONT(oee, 0.50), 4)    AS p50_oee_all_time,
                ROUND(QUANTILE_CONT(oee, 0.90), 4)    AS p90_oee_all_time
            FROM fact_runs
            WHERE NOT outlier AND oee IS NOT NULL AND oee BETWEEN 0 AND 1
            GROUP BY sku, linea
        )
        TO '{(OUT / "sku_line_feasibility.parquet").as_posix()}' (FORMAT PARQUET)
    """)
    n = con.execute("SELECT COUNT(*) FROM fact_runs WHERE NOT outlier AND oee BETWEEN 0 AND 1").fetchone()[0]
    n_pairs = con.execute("""
        SELECT COUNT(*) FROM (
            SELECT sku, linea FROM fact_runs
            WHERE NOT outlier AND oee BETWEEN 0 AND 1
            GROUP BY sku, linea
        )
    """).fetchone()[0]
    print(f"==> sku_line_feasibility.parquet              ({n_pairs} (sku,línea) pairs from {n} OFs)")

    # ============================================================ last OF per línea (anchor for stitching)
    con.execute(f"""
        COPY (
            WITH ranked AS (
                SELECT
                    linea, of, fecha_fin AS fecha, sku, marca, supramarca, familia,
                    cerveza, cbr, envase, tipo_envase, estado_volumen, oee,
                    ROW_NUMBER() OVER (PARTITION BY linea ORDER BY fecha_fin DESC, of DESC) AS rn
                FROM fact_runs
                WHERE NOT outlier AND linea IS NOT NULL
            )
            SELECT * EXCLUDE rn FROM ranked WHERE rn = 1
        )
        TO '{(OUT / "last_historical_of_per_line.parquet").as_posix()}' (FORMAT PARQUET)
    """)
    print(f"==> last_historical_of_per_line.parquet     (3 rows, 1 per line)")

    # ============================================================ sku × línea recent aggregates
    # "Recent" = the last 60 days of available history per (sku, línea)
    con.execute(f"""
        COPY (
            WITH last_per_pair AS (
                SELECT sku, linea, MAX(fecha_fin) AS last_seen
                FROM fact_runs
                WHERE NOT outlier AND oee BETWEEN 0 AND 1
                GROUP BY sku, linea
            ),
            recent AS (
                SELECT f.sku, f.linea, f.oee
                FROM fact_runs f
                JOIN last_per_pair l USING (sku, linea)
                WHERE NOT f.outlier
                  AND f.oee BETWEEN 0 AND 1
                  AND f.fecha_fin >= l.last_seen - INTERVAL 60 DAY
            )
            SELECT
                sku, linea,
                COUNT(*)                              AS n_runs_recent,
                ROUND(AVG(oee), 4)                    AS mean_oee_recent,
                ROUND(QUANTILE_CONT(oee, 0.50), 4)    AS p50_oee_recent,
                ROUND(QUANTILE_CONT(oee, 0.90), 4)    AS p90_oee_recent
            FROM recent
            GROUP BY sku, linea
        )
        TO '{(OUT / "sku_line_aggregates.parquet").as_posix()}' (FORMAT PARQUET)
    """)
    print(f"==> sku_line_aggregates.parquet")

    # ============================================================ línea aggregates (7d & 30d AS-OF latest)
    con.execute(f"""
        COPY (
            WITH latest AS (
                SELECT linea, MAX(fecha_fin) AS t FROM fact_runs
                WHERE NOT outlier GROUP BY linea
            ),
            w7 AS (
                SELECT f.linea, ROUND(QUANTILE_CONT(f.oee, 0.50), 4) AS oee_p50_last_7d
                FROM fact_runs f JOIN latest l USING (linea)
                WHERE NOT f.outlier AND f.oee BETWEEN 0 AND 1
                  AND f.fecha_fin >= l.t - INTERVAL 7 DAY
                GROUP BY f.linea
            ),
            w30 AS (
                SELECT f.linea, ROUND(QUANTILE_CONT(f.oee, 0.50), 4) AS oee_p50_last_30d
                FROM fact_runs f JOIN latest l USING (linea)
                WHERE NOT f.outlier AND f.oee BETWEEN 0 AND 1
                  AND f.fecha_fin >= l.t - INTERVAL 30 DAY
                GROUP BY f.linea
            )
            SELECT w7.linea, w7.oee_p50_last_7d, w30.oee_p50_last_30d
            FROM w7 JOIN w30 USING (linea)
        )
        TO '{(OUT / "linea_aggregates.parquet").as_posix()}' (FORMAT PARQUET)
    """)
    print(f"==> linea_aggregates.parquet")

    # ============================================================ familia × línea fallback
    con.execute(f"""
        COPY (
            SELECT
                linea,
                familia,
                COUNT(*)                              AS n_runs,
                ROUND(AVG(oee), 4)                    AS mean_oee,
                ROUND(QUANTILE_CONT(oee, 0.50), 4)    AS p50_oee,
                ROUND(QUANTILE_CONT(oee, 0.90), 4)    AS p90_oee
            FROM fact_runs
            WHERE NOT outlier AND oee BETWEEN 0 AND 1 AND familia IS NOT NULL
            GROUP BY linea, familia
        )
        TO '{(OUT / "familia_line_aggregates.parquet").as_posix()}' (FORMAT PARQUET)
    """)
    print(f"==> familia_line_aggregates.parquet")

    # ============================================================ pair transitions (linea, prev_sku, sku)
    con.execute(f"""
        COPY (
            WITH ordered AS (
                SELECT
                    linea, of, fecha_fin, sku, oee,
                    LAG(sku) OVER (PARTITION BY linea ORDER BY fecha_fin, of) AS prev_sku
                FROM fact_runs
                WHERE NOT outlier AND oee BETWEEN 0 AND 1
            )
            SELECT
                linea, prev_sku, sku,
                COUNT(*)                              AS n,
                ROUND(AVG(oee), 4)                    AS mean_oee,
                ROUND(QUANTILE_CONT(oee, 0.50), 4)    AS p50_oee,
                ROUND(QUANTILE_CONT(oee, 0.90), 4)    AS p90_oee
            FROM ordered
            WHERE prev_sku IS NOT NULL
            GROUP BY linea, prev_sku, sku
        )
        TO '{(OUT / "pair_transition_aggregates.parquet").as_posix()}' (FORMAT PARQUET)
    """)
    n = con.execute("""
        WITH ordered AS (SELECT linea, LAG(sku) OVER (PARTITION BY linea ORDER BY fecha_fin) AS prev_sku, sku FROM fact_runs WHERE NOT outlier)
        SELECT COUNT(DISTINCT (linea, prev_sku, sku)) FROM ordered WHERE prev_sku IS NOT NULL
    """).fetchone()[0]
    print(f"==> pair_transition_aggregates.parquet      ({n} unique triples)")

    # ============================================================ maintenance proxy per línea
    con.execute(f"""
        COPY (
            WITH latest AS (SELECT linea, MAX(fecha_fin) AS t FROM fact_runs WHERE NOT outlier GROUP BY linea),
            limp AS (
                SELECT linea, fecha_fin, horas_total
                FROM fact_limpieza WHERE linea IS NOT NULL
            ),
            recent AS (
                SELECT l.linea, l.fecha_fin, l.horas_total
                FROM limp l JOIN latest lat USING (linea)
                WHERE l.fecha_fin >= lat.t - INTERVAL 60 DAY
            ),
            cadence AS (
                SELECT linea,
                       COUNT(*)                         AS n_limpiezas_60d,
                       ROUND(AVG(horas_total), 2)       AS avg_horas_limpieza,
                       MAX(fecha_fin)                   AS last_limpieza
                FROM recent
                GROUP BY linea
            )
            SELECT linea,
                   n_limpiezas_60d,
                   avg_horas_limpieza,
                   last_limpieza,
                   60.0 / GREATEST(n_limpiezas_60d, 1) AS expected_days_between_limpiezas
            FROM cadence
        )
        TO '{(OUT / "maintenance_proxy.parquet").as_posix()}' (FORMAT PARQUET)
    """)
    print(f"==> maintenance_proxy.parquet")

    # ============================================================ fact_runs slim (for any ad-hoc engine lookups)
    con.execute(f"""
        COPY (
            SELECT
                of, linea, fecha_fin AS fecha, sku, marca, supramarca, familia,
                cerveza, cbr, envase, tipo_envase, estado_volumen,
                oee, hl,
                hubo_cambio, cambio_tipo_principal,
                n_llamadas_mant
            FROM fact_runs
            WHERE NOT outlier AND oee BETWEEN 0 AND 1
        )
        TO '{(OUT / "fact_runs_slim.parquet").as_posix()}' (FORMAT PARQUET)
    """)
    n = con.execute("SELECT COUNT(*) FROM fact_runs WHERE NOT outlier AND oee BETWEEN 0 AND 1").fetchone()[0]
    print(f"==> fact_runs_slim.parquet                  ({n} rows)")

    # ============================================================ Shift-capacity weights
    # For Diario Hl uploads we explode daily HL into 3 shift blocks. The weights
    # come from historical mean run length per (linea × dia_semana × turno).
    # We don't have turno in fact_runs, so fall back to even thirds for now;
    # this lookup ships as a NULL placeholder the engine will treat as 1/3 split.
    pd.DataFrame({
        "linea":     [14, 14, 14, 17, 17, 17, 19, 19, 19],
        "turno":     ["T", "N", "M", "T", "N", "M", "T", "N", "M"],
        "weight":    [1/3] * 9,
    }).to_parquet(OUT / "shift_capacity_weights.parquet", index=False)
    print(f"==> shift_capacity_weights.parquet           (placeholder 1/3 weights)")

    con.close()
    print(f"\n==> All lookups in: {OUT}/")


if __name__ == "__main__":
    main()
