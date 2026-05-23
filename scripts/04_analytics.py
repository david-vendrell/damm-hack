"""
LineWise — Step 04: Deep analytical queries over the canonical tables.

For each analysis we (1) print a console summary and (2) save the full result
as a CSV in reports/analytics/ so the team can drop them into the deck or UI.
Also exports the main fact / dim tables to Parquet for non-DuckDB users.

Run from repo root after 03_derived_tables.py:
    python3 scripts/04_analytics.py
"""

from __future__ import annotations

from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "db" / "linewise.duckdb"
OUT = ROOT / "reports" / "analytics"
PARQUET_DIR = ROOT / "parquet"
OUT.mkdir(parents=True, exist_ok=True)
PARQUET_DIR.mkdir(parents=True, exist_ok=True)


def run(con, name: str, sql: str, n_print: int = 12) -> None:
    df = con.execute(sql).fetchdf()
    csv_path = OUT / f"{name}.csv"
    df.to_csv(csv_path, index=False)
    print(f"\n=== {name}  ({len(df)} rows -> {csv_path.name})")
    if len(df) > 0:
        with_pretty = df.head(n_print).to_string(index=False, max_colwidth=40)
        for line in with_pretty.splitlines():
            print("    " + line)
    return df


def main() -> None:
    con = duckdb.connect(str(DB_PATH))

    print("=" * 88)
    print("LINEWISE DEEP ANALYTICS")
    print("=" * 88)

    # ----------------------------------------------------------------- A1
    run(con, "A01_oee_por_linea", """
        SELECT
            linea,
            COUNT(*)                                    AS n_ofs,
            ROUND(AVG(oee), 4)                          AS oee_media,
            ROUND(MEDIAN(oee), 4)                       AS oee_mediana,
            ROUND(STDDEV(oee), 4)                       AS oee_std,
            ROUND(QUANTILE_CONT(oee, 0.10), 4)          AS oee_p10,
            ROUND(QUANTILE_CONT(oee, 0.25), 4)          AS oee_p25,
            ROUND(QUANTILE_CONT(oee, 0.75), 4)          AS oee_p75,
            ROUND(QUANTILE_CONT(oee, 0.90), 4)          AS oee_p90,
            ROUND(AVG(disponibilidad), 4)               AS disp_media,
            ROUND(AVG(rendimiento), 4)                  AS rend_media,
            ROUND(AVG(ineficiencia), 4)                 AS inef_media,
            ROUND(SUM(hl), 1)                           AS hl_total,
            ROUND(SUM(uds), 0)                          AS uds_total
        FROM fact_runs
        WHERE oee IS NOT NULL AND NOT outlier
        GROUP BY linea
        ORDER BY linea
    """)

    # ----------------------------------------------------------------- A2
    run(con, "A02_oee_por_tipo_cambio", """
        SELECT
            cambio_tipo_principal,
            COUNT(*)                              AS n,
            ROUND(AVG(oee), 4)                    AS oee_medio,
            ROUND(MEDIAN(oee), 4)                 AS oee_mediano,
            ROUND(AVG(disponibilidad), 4)         AS disp_media,
            ROUND(AVG(rendimiento), 4)            AS rend_media
        FROM fact_runs
        WHERE oee IS NOT NULL AND cambio_tipo_principal IS NOT NULL
        GROUP BY cambio_tipo_principal
        ORDER BY n DESC
    """)

    # ----------------------------------------------------------------- A3
    run(con, "A03_oee_por_linea_y_tipo_cambio", """
        SELECT
            linea,
            cambio_tipo_principal,
            COUNT(*)               AS n,
            ROUND(AVG(oee), 4)     AS oee_medio,
            ROUND(MEDIAN(oee), 4)  AS oee_mediano
        FROM fact_runs
        WHERE oee IS NOT NULL AND cambio_tipo_principal IS NOT NULL
        GROUP BY linea, cambio_tipo_principal
        ORDER BY linea, n DESC
    """)

    # ----------------------------------------------------------------- A4
    run(con, "A04_top_cambios_volumen_ineficientes", """
        SELECT
            linea,
            prev_estado_volumen                                    AS from_estado,
            estado_volumen                                         AS to_estado,
            COUNT(*)                                               AS n,
            ROUND(AVG(horas_cip) * 60, 1)                          AS cip_real_min_medio,
            teorico_cambio_volumen_min                             AS teorico_min,
            ROUND(AVG(horas_cip) * 60 - teorico_cambio_volumen_min, 1) AS delta_min,
            ROUND(AVG(oee), 4)                                     AS oee_medio,
            ROUND(SUM(horas_cip) * 60, 1)                          AS cip_total_min
        FROM fact_changeovers
        WHERE prev_estado_volumen IS NOT NULL
          AND estado_volumen      IS NOT NULL
          AND prev_estado_volumen <> estado_volumen
          AND horas_cip IS NOT NULL
        GROUP BY linea, prev_estado_volumen, estado_volumen, teorico_cambio_volumen_min
        HAVING COUNT(*) >= 3
        ORDER BY delta_min DESC NULLS LAST
        LIMIT 30
    """)

    # ----------------------------------------------------------------- A5
    run(con, "A05_lost_time_por_categoria_y_linea", """
        SELECT
            linea,
            categoria,
            COUNT(*)                              AS n_ofs,
            ROUND(SUM(minutos) / 60, 1)           AS horas_totales,
            ROUND(AVG(minutos), 1)                AS minutos_medios_por_of,
            ROUND(MEDIAN(minutos), 1)             AS minutos_medianos_por_of
        FROM fact_lost_time
        WHERE categoria NOT IN ('marcha')   -- ‘marcha’ is productive time
        GROUP BY linea, categoria
        ORDER BY linea, horas_totales DESC
    """, n_print=30)

    # ----------------------------------------------------------------- A6
    run(con, "A06_oee_por_dia_semana", """
        SELECT
            linea,
            dia_semana,                              -- 1=Mon, 7=Sun
            COUNT(*)                                AS n,
            ROUND(AVG(oee), 4)                      AS oee_medio
        FROM fact_runs
        WHERE oee IS NOT NULL AND NOT outlier
        GROUP BY linea, dia_semana
        ORDER BY linea, dia_semana
    """, n_print=25)

    # ----------------------------------------------------------------- A7
    run(con, "A07_oee_por_mes", """
        SELECT
            linea,
            anyo, mes,
            COUNT(*)               AS n,
            ROUND(AVG(oee), 4)     AS oee_medio,
            ROUND(SUM(hl), 1)      AS hl
        FROM fact_runs
        WHERE oee IS NOT NULL AND NOT outlier
        GROUP BY linea, anyo, mes
        ORDER BY linea, anyo, mes
    """, n_print=36)

    # ----------------------------------------------------------------- A8
    run(con, "A08_top_skus_por_volumen", """
        SELECT
            sku,
            ANY_VALUE(marca)         AS marca,
            ANY_VALUE(familia)       AS familia,
            ANY_VALUE(tipo_envase)   AS tipo_envase,
            COUNT(*)                 AS n_ofs,
            ROUND(SUM(uds), 0)       AS uds_total,
            ROUND(SUM(hl), 1)        AS hl_total,
            ROUND(AVG(oee), 4)       AS oee_medio
        FROM fact_runs
        WHERE oee IS NOT NULL AND NOT outlier
        GROUP BY sku
        ORDER BY uds_total DESC
        LIMIT 30
    """)

    # ----------------------------------------------------------------- A9
    run(con, "A09_top_skus_peor_oee", """
        SELECT
            sku,
            ANY_VALUE(marca)         AS marca,
            ANY_VALUE(tipo_envase)   AS tipo_envase,
            COUNT(*)                 AS n_ofs,
            ROUND(AVG(oee), 4)       AS oee_medio
        FROM fact_runs
        WHERE oee IS NOT NULL AND NOT outlier
        GROUP BY sku
        HAVING COUNT(*) >= 10
        ORDER BY oee_medio ASC
        LIMIT 20
    """)

    # ----------------------------------------------------------------- A10
    run(con, "A10_impacto_dimension_cambio", """
        WITH long AS (
            SELECT linea, oee, 'brand'      AS dimension, c_brand_flag      AS cambio FROM fact_runs WHERE oee IS NOT NULL UNION ALL
            SELECT linea, oee, 'cap'        AS dimension, c_cap_flag        AS cambio FROM fact_runs WHERE oee IS NOT NULL UNION ALL
            SELECT linea, oee, 'envase'     AS dimension, c_envase_flag     AS cambio FROM fact_runs WHERE oee IS NOT NULL UNION ALL
            SELECT linea, oee, 'palet'      AS dimension, c_palet_flag      AS cambio FROM fact_runs WHERE oee IS NOT NULL UNION ALL
            SELECT linea, oee, 'primario'   AS dimension, c_primario_flag   AS cambio FROM fact_runs WHERE oee IS NOT NULL UNION ALL
            SELECT linea, oee, 'producto'   AS dimension, c_producto_flag   AS cambio FROM fact_runs WHERE oee IS NOT NULL UNION ALL
            SELECT linea, oee, 'secundario' AS dimension, c_secundario_flag AS cambio FROM fact_runs WHERE oee IS NOT NULL UNION ALL
            SELECT linea, oee, 'volum'      AS dimension, c_volum_flag      AS cambio FROM fact_runs WHERE oee IS NOT NULL
        )
        SELECT
            dimension,
            ROUND(AVG(CASE WHEN cambio THEN oee END), 4)        AS oee_con_cambio,
            ROUND(AVG(CASE WHEN NOT cambio THEN oee END), 4)    AS oee_sin_cambio,
            ROUND(AVG(CASE WHEN cambio THEN oee END)
                 - AVG(CASE WHEN NOT cambio THEN oee END), 4)   AS delta,
            SUM(CASE WHEN cambio THEN 1 ELSE 0 END)             AS n_con_cambio,
            SUM(CASE WHEN NOT cambio THEN 1 ELSE 0 END)         AS n_sin_cambio
        FROM long
        GROUP BY dimension
        ORDER BY delta ASC NULLS LAST
    """)

    # ----------------------------------------------------------------- A11
    run(con, "A11_pares_sku_mas_frecuentes", """
        SELECT
            linea,
            prev_sku,
            sku                       AS next_sku,
            prev_marca,
            marca                     AS next_marca,
            COUNT(*)                  AS n,
            ROUND(AVG(oee), 4)        AS oee_medio
        FROM fact_changeovers
        WHERE prev_sku <> sku
          AND oee IS NOT NULL
        GROUP BY linea, prev_sku, sku, prev_marca, marca
        HAVING COUNT(*) >= 5
        ORDER BY n DESC
        LIMIT 30
    """)

    # ----------------------------------------------------------------- A12
    run(con, "A12_impacto_mantenimiento_oee", """
        WITH bucket AS (
            SELECT
                linea,
                CASE
                    WHEN n_llamadas_mant IS NULL OR n_llamadas_mant = 0 THEN '0'
                    WHEN n_llamadas_mant BETWEEN 1 AND 2 THEN '1-2'
                    WHEN n_llamadas_mant BETWEEN 3 AND 5 THEN '3-5'
                    ELSE '6+'
                END AS llamadas_bucket,
                oee
            FROM fact_runs
            WHERE oee IS NOT NULL AND NOT outlier
        )
        SELECT
            linea,
            llamadas_bucket,
            COUNT(*)                              AS n,
            ROUND(AVG(oee), 4)                    AS oee_medio
        FROM bucket
        GROUP BY linea, llamadas_bucket
        ORDER BY linea, llamadas_bucket
    """, n_print=20)

    # ----------------------------------------------------------------- A13
    run(con, "A13_limpieza_eventos_por_linea", """
        SELECT
            linea,
            COUNT(*)                              AS n_eventos,
            ROUND(SUM(horas_total), 1)            AS horas_total,
            ROUND(AVG(horas_total), 2)            AS horas_medio,
            ROUND(MEDIAN(horas_total), 2)         AS horas_mediano,
            ROUND(SUM(horas_intervencion), 1)     AS horas_intervencion_total,
            ROUND(SUM(horas_espera), 1)           AS horas_espera_total
        FROM fact_limpieza
        WHERE linea IS NOT NULL
        GROUP BY linea
        ORDER BY linea
    """)

    # ----------------------------------------------------------------- A14
    run(con, "A14_plan_vs_actual_2026", """
        SELECT *
        FROM fact_plan_vs_actual_2026
        ORDER BY linea, fecha_ini_plan, fecha_fin_actual
    """, n_print=20)

    # ----------------------------------------------------------------- A15
    run(con, "A15_runs_extremos_top_y_bottom_oee", """
        WITH ranked AS (
            SELECT *,
                   ROW_NUMBER() OVER (ORDER BY oee DESC) AS rk_best,
                   ROW_NUMBER() OVER (ORDER BY oee ASC)  AS rk_worst
            FROM fact_runs
            WHERE oee IS NOT NULL AND NOT outlier
        )
        SELECT 'best' AS kind, of, linea, fecha_fin, sku, marca, oee, horas_totales, horas_cip
        FROM ranked WHERE rk_best <= 10
        UNION ALL
        SELECT 'worst' AS kind, of, linea, fecha_fin, sku, marca, oee, horas_totales, horas_cip
        FROM ranked WHERE rk_worst <= 10
        ORDER BY kind, oee DESC
    """, n_print=20)

    # ----------------------------------------------------------------- A16
    run(con, "A16_distribucion_horas_por_of", """
        SELECT
            linea,
            COUNT(*)                              AS n_ofs,
            ROUND(MIN(horas_totales), 2)          AS h_min,
            ROUND(QUANTILE_CONT(horas_totales, 0.25), 2) AS h_p25,
            ROUND(MEDIAN(horas_totales), 2)       AS h_mediana,
            ROUND(QUANTILE_CONT(horas_totales, 0.75), 2) AS h_p75,
            ROUND(MAX(horas_totales), 2)          AS h_max
        FROM fact_runs
        WHERE NOT outlier AND horas_totales IS NOT NULL
        GROUP BY linea
        ORDER BY linea
    """)

    # ----------------------------------------------------------------- A17
    run(con, "A17_oee_alta_vs_baja_horas_cip", """
        WITH bucket AS (
            SELECT linea, oee,
                CASE
                    WHEN horas_cip IS NULL OR horas_cip = 0 THEN 'cip_0'
                    WHEN horas_cip < 0.5 THEN 'cip_lt_30min'
                    WHEN horas_cip < 1.5 THEN 'cip_30_90min'
                    ELSE 'cip_gt_90min'
                END AS cip_bucket
            FROM fact_runs
            WHERE oee IS NOT NULL AND NOT outlier
        )
        SELECT
            linea, cip_bucket,
            COUNT(*) AS n,
            ROUND(AVG(oee), 4) AS oee_medio
        FROM bucket
        GROUP BY linea, cip_bucket
        ORDER BY linea, cip_bucket
    """, n_print=20)

    # --------------------------------------------- EXPORT TO PARQUET
    print("\n=== Exporting fact / dim tables to Parquet")
    parquet_tables = [
        "dim_line", "dim_sku", "dim_theoretical_changeover_matrix",
        "fact_runs", "fact_lost_time", "fact_changeovers",
        "fact_limpieza", "fact_plan_vs_actual_2026",
    ]
    for t in parquet_tables:
        out = PARQUET_DIR / f"{t}.parquet"
        con.execute(f"COPY {t} TO '{out.as_posix()}' (FORMAT PARQUET)")
        n = con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        print(f"    {t:42s} -> {out.name:50s} ({n} rows)")

    con.close()
    print(f"\n==> Analytics CSVs in: {OUT}")
    print(f"==> Parquet exports in: {PARQUET_DIR}")
    print("==> Done.")


if __name__ == "__main__":
    main()
