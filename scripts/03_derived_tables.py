"""
LineWise — Step 03: Build canonical (derived) tables on top of the raw_* layer.

Produces:
    dim_sku                — one row per SKU with product metadata
    dim_line               — one row per production line
    fact_runs              — canonical per-OF table: joined OEE+Volumen+Tiempo+Mantenimiento+Cambios
    fact_lost_time         — long-format time breakdown per OF (category, minutes)
    fact_changeovers       — per-OF changeover event with previous SKU and theoretical match
    fact_limpieza          — standalone LIMPIEZA / cleaning WOs as their own fact
    fact_plan_vs_actual_2026 — May 2026 plan rows aligned with actual production

Run from repo root after 01_ingest.py and 02_parse_cf_matrix.py:
    python3 scripts/03_derived_tables.py
"""

from __future__ import annotations

import re
from pathlib import Path

import duckdb
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "db" / "linewise.duckdb"


# --------------- Diario Hl long-format parser ------------------------
# The Excel sheet 'Diario Hl' is a hierarchical wide cross-tab. We reshape
# it to long format: (centro, linea, sku, fecha, metric, value).
DIARIO_METRICS_ORDER = [
    "programa_prod_hl",
    "programa_acordado_hl",
    "inclusion_formatos",
    "exclusion_formato",
    "total_modif_formato",
    "aumento_cantidad",
    "disminucion_cantidad",
    "total_modif_cantidad",
    "n_total_cambios",
    "articulos_programa_prod",
    "articulos_programa_acord",
]
# 7 days × (11 metrics + 1 separator) = 84 cols; then TOTAL block = 11 metrics.
DIARIO_DAYS = [
    "2026-05-18", "2026-05-19", "2026-05-20", "2026-05-21",
    "2026-05-22", "2026-05-23", "2026-05-24",
]


def parse_diario_hl(con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    raw = con.execute(
        "SELECT * EXCLUDE (source_file) FROM raw_diario_hl_planif ORDER BY row_idx"
    ).fetchdf()
    records: list[dict] = []
    current_centro = None
    current_linea = None
    for _, row in raw.iterrows():
        label = row["col_0"]
        if label is None:
            continue
        label = str(label).strip()
        # Centro line:  "-  Centro : 0099 Factoría El Prat"
        m = re.search(r"Centro\s*:\s*(\S+)", label)
        if m:
            current_centro = m.group(1)
            continue
        # Tren line:  "-  Tren : Tren 14 - LT"
        m = re.search(r"Tren\s*:\s*Tren\s*(\d+)", label)
        if m:
            current_linea = int(m.group(1))
            continue
        # Skip totals and headers
        if label.startswith("Total") or label.startswith("-") or label == "":
            continue
        # Else: it's a SKU row
        sku = label
        # Walk the 7 day-groups
        for day_idx, fecha in enumerate(DIARIO_DAYS):
            base = 1 + day_idx * 12  # col_1, col_13, col_25, ...
            for m_idx, metric in enumerate(DIARIO_METRICS_ORDER):
                col = f"col_{base + m_idx}"
                if col not in raw.columns:
                    continue
                val = row[col]
                if val is None or (isinstance(val, float) and pd.isna(val)):
                    continue
                try:
                    val = float(val)
                except (TypeError, ValueError):
                    continue
                records.append({
                    "centro": current_centro,
                    "linea": current_linea,
                    "sku": sku,
                    "fecha": fecha,
                    "metric": metric,
                    "value": val,
                })
    return pd.DataFrame(records)


def main() -> None:
    con = duckdb.connect(str(DB_PATH))

    # ---------------------------------------------------------------- dim_line
    con.execute("""
        CREATE OR REPLACE TABLE dim_line AS
        SELECT * FROM (VALUES
            (14, 'L14', 'LATA 1/3 & 1/2', ARRAY['1/3','1/2','Cambio Packaging','Cambio a Bandeja','Cambio Paletizado']),
            (17, 'L17', 'LATA 1/3 & 1/2', ARRAY['1/3','1/2','Cambio Packaging','Cambio a Bandeja','Cambio Paletizado']),
            (19, 'L19', 'LATA 1/3, 1/2 & 2/5', ARRAY['1/3','1/2','2/5','Cambio Packaging','Cambio a Bandeja','Cambio Paletizado'])
        ) AS t(linea, nombre, descripcion, estados)
    """)

    # ----------------------------------------------------------------- dim_sku
    con.execute("""
        CREATE OR REPLACE TABLE dim_sku AS
        WITH ranked AS (
            SELECT sku, marca, supramarca, cbr, familia, cerveza,
                   id_material_precio, mat_precio, envase, tipo_envase,
                   linea_de_negocio, linea_de_producto, material_comercial,
                   retornable, tipo_articulo, grupo_materiales_4,
                   grupo_materiales_5, packaging_primario, packaging_secundario,
                   palet, tipo_palet, unidad_caja,
                   unidades_packaging_primario, unidades_packaging_secundario,
                   ROW_NUMBER() OVER (PARTITION BY sku ORDER BY fecha_fin DESC NULLS LAST) AS rn
            FROM raw_oee
            WHERE sku IS NOT NULL
        )
        SELECT sku, marca, supramarca, cbr, familia, cerveza,
               id_material_precio, mat_precio, envase, tipo_envase,
               linea_de_negocio, linea_de_producto, material_comercial,
               retornable, tipo_articulo, grupo_materiales_4,
               grupo_materiales_5, packaging_primario, packaging_secundario,
               palet, tipo_palet, unidad_caja,
               unidades_packaging_primario, unidades_packaging_secundario,
               -- Map tipo_envase to a changeover-matrix state where possible.
               CASE
                   WHEN UPPER(tipo_envase) LIKE '%1/3%' THEN '1/3'
                   WHEN UPPER(tipo_envase) LIKE '%1/2%' THEN '1/2'
                   WHEN UPPER(tipo_envase) LIKE '%2/5%' THEN '2/5'
                   ELSE NULL
               END AS estado_volumen
        FROM ranked
        WHERE rn = 1
    """)

    # --------------------------------------------------------------- fact_runs
    # Canonical per-OF table. Production OFs only by default — LIMPIEZA WOs
    # are split into fact_limpieza. Joins OEE, Volumen, Tiempo, Mantenimiento,
    # Cambios on OF (Tiempo uses WOID which equals OF for production runs).
    con.execute("""
        CREATE OR REPLACE TABLE fact_runs AS
        SELECT
            o.of                                              AS of,
            CAST(o.tren AS INTEGER)                           AS linea,
            o.fecha_fin                                       AS fecha_fin,
            EXTRACT(year FROM o.fecha_fin)                    AS anyo,
            EXTRACT(month FROM o.fecha_fin)                   AS mes,
            EXTRACT(week FROM o.fecha_fin)                    AS semana,
            EXTRACT(isodow FROM o.fecha_fin)                  AS dia_semana,    -- 1=Mon..7=Sun
            o.sku                                             AS sku,
            o.marca, o.supramarca, o.cbr, o.familia, o.cerveza,
            o.envase, o.tipo_envase,
            o.definicion_de_turno                             AS turno,
            o.oee, o.disponibilidad, o.rendimiento, o.ineficiencia,
            o.cambios_bool                                    AS hubo_cambio,
            v.uds, v.hl,
            t.h_tot                                           AS horas_totales,
            t.par_tot                                         AS horas_paro,
            t.tiempo_maquina_en_marcha                        AS horas_marcha,
            t.tiempo_maquina_en_paro                          AS horas_paro_maquina,
            t.tiempo_de_cip                                   AS horas_cip,
            t.tiempo_baja_velocidad                           AS horas_baja_velocidad,
            t.tiempo_paro_por_saturacion_a_la_salida          AS horas_saturacion,
            t.tiempo_paro_por_falta_producto                  AS horas_falta_producto,
            t.tiempo_de_esterilizacion                        AS horas_esterilizacion,
            t.tiempo_operativo_neto                           AS horas_operativo_neto,
            t.idle                                            AS horas_idle,
            t.limpieza                                        AS horas_limpieza_dentro_of,
            t.pnp                                             AS horas_pnp,
            -- Per Damm data-model image:
            -- Tiempo cambio = PAR_TOT - (PNP + LIMPIEZA + IDLE)
            GREATEST(
                COALESCE(t.par_tot, 0)
              - COALESCE(t.pnp, 0)
              - COALESCE(t.limpieza, 0)
              - COALESCE(t.idle, 0),
                0
            )                                                 AS horas_cambio,
            t.outlier_h_tot                                   AS outlier,
            m.no_llamadas                                     AS n_llamadas_mant,
            m.tiempo_en_espera                                AS horas_espera_mant,
            m.tiempo_intervencion                             AS horas_intervencion_mant,
            c.c_principal                                     AS cambio_tipo_principal,
            c.no_de_cambios                                   AS n_dimensiones_cambiadas,
            c.c_brand_flag, c.c_cap_flag, c.c_envase_flag,
            c.c_palet_flag, c.c_primario_flag, c.c_producto_flag,
            c.c_secundario_flag, c.c_volum_flag,
            c.frecuencia_total                                AS frecuencia_cambio,
            -- format state mapping
            CASE
                WHEN UPPER(o.tipo_envase) LIKE '%1/3%' THEN '1/3'
                WHEN UPPER(o.tipo_envase) LIKE '%1/2%' THEN '1/2'
                WHEN UPPER(o.tipo_envase) LIKE '%2/5%' THEN '2/5'
                ELSE NULL
            END                                               AS estado_volumen
        FROM raw_oee o
        LEFT JOIN raw_volumen v       ON v.of  = o.of
        LEFT JOIN raw_tiempo  t       ON t.woid = o.of
        LEFT JOIN raw_mantenimiento m ON m.of  = o.of
        LEFT JOIN raw_cambios c       ON c.of  = o.of
        WHERE COALESCE(UPPER(o.sku), '') <> 'LIMPIEZA'
    """)

    # --------------------------------------------------------- fact_lost_time
    # Decompose H.Tot into named categories, in MINUTES, long-format.
    con.execute("""
        CREATE OR REPLACE TABLE fact_lost_time AS
        WITH base AS (
            SELECT of, linea, fecha_fin, sku, marca,
                   horas_marcha,
                   horas_cip,
                   horas_baja_velocidad,
                   horas_saturacion,
                   horas_falta_producto,
                   horas_esterilizacion,
                   horas_paro_maquina,
                   horas_idle,
                   horas_pnp,
                   horas_totales
            FROM fact_runs
            WHERE NOT outlier
        )
        SELECT of, linea, fecha_fin, sku, marca, 'marcha'             AS categoria, horas_marcha            * 60 AS minutos FROM base WHERE horas_marcha            IS NOT NULL UNION ALL
        SELECT of, linea, fecha_fin, sku, marca, 'cip'                AS categoria, horas_cip               * 60 AS minutos FROM base WHERE horas_cip               IS NOT NULL UNION ALL
        SELECT of, linea, fecha_fin, sku, marca, 'baja_velocidad'     AS categoria, horas_baja_velocidad    * 60 AS minutos FROM base WHERE horas_baja_velocidad    IS NOT NULL UNION ALL
        SELECT of, linea, fecha_fin, sku, marca, 'saturacion_salida'  AS categoria, horas_saturacion        * 60 AS minutos FROM base WHERE horas_saturacion        IS NOT NULL UNION ALL
        SELECT of, linea, fecha_fin, sku, marca, 'falta_producto'     AS categoria, horas_falta_producto    * 60 AS minutos FROM base WHERE horas_falta_producto    IS NOT NULL UNION ALL
        SELECT of, linea, fecha_fin, sku, marca, 'esterilizacion'     AS categoria, horas_esterilizacion    * 60 AS minutos FROM base WHERE horas_esterilizacion    IS NOT NULL UNION ALL
        SELECT of, linea, fecha_fin, sku, marca, 'paro_maquina'       AS categoria, horas_paro_maquina      * 60 AS minutos FROM base WHERE horas_paro_maquina      IS NOT NULL UNION ALL
        SELECT of, linea, fecha_fin, sku, marca, 'idle'               AS categoria, horas_idle              * 60 AS minutos FROM base WHERE horas_idle              IS NOT NULL UNION ALL
        SELECT of, linea, fecha_fin, sku, marca, 'pnp'                AS categoria, horas_pnp               * 60 AS minutos FROM base WHERE horas_pnp               IS NOT NULL
    """)

    # ----------------------------------------------------- fact_changeovers
    # Per consecutive (prev_of, of) on the same line; brings together changeover
    # type, previous SKU/state, and theoretical reference duration when both
    # states map to a changeover-matrix state.
    con.execute("""
        CREATE OR REPLACE TABLE fact_changeovers AS
        WITH ordered AS (
            SELECT
                r.*,
                LAG(of)              OVER (PARTITION BY linea ORDER BY fecha_fin, of) AS prev_of,
                LAG(sku)             OVER (PARTITION BY linea ORDER BY fecha_fin, of) AS prev_sku,
                LAG(estado_volumen)  OVER (PARTITION BY linea ORDER BY fecha_fin, of) AS prev_estado_volumen,
                LAG(marca)           OVER (PARTITION BY linea ORDER BY fecha_fin, of) AS prev_marca,
                LAG(fecha_fin)       OVER (PARTITION BY linea ORDER BY fecha_fin, of) AS prev_fecha_fin
            FROM fact_runs r
        )
        SELECT
            o.of, o.prev_of, o.linea, o.fecha_fin, o.prev_fecha_fin,
            o.sku, o.prev_sku, o.marca, o.prev_marca,
            o.estado_volumen, o.prev_estado_volumen,
            o.hubo_cambio, o.cambio_tipo_principal,
            o.n_dimensiones_cambiadas,
            o.c_brand_flag, o.c_cap_flag, o.c_envase_flag, o.c_palet_flag,
            o.c_primario_flag, o.c_producto_flag, o.c_secundario_flag, o.c_volum_flag,
            o.oee, o.rendimiento, o.disponibilidad, o.ineficiencia,
            o.horas_totales, o.horas_marcha, o.horas_cip, o.horas_baja_velocidad,
            o.horas_saturacion, o.horas_falta_producto,
            -- when both ends map to matrix states, attach theoretical reference
            tcm.minutes AS teorico_cambio_volumen_min
        FROM ordered o
        LEFT JOIN dim_theoretical_changeover_matrix tcm
               ON tcm.linea       = o.linea
              AND tcm.from_state  = o.prev_estado_volumen
              AND tcm.to_state    = o.estado_volumen
        WHERE o.prev_of IS NOT NULL
    """)

    # ------------------------------------------------------------- fact_limpieza
    # Standalone LIMPIEZA / cleaning WOs from the maintenance file.
    con.execute("""
        CREATE OR REPLACE TABLE fact_limpieza AS
        SELECT
            m.of                                              AS wo,
            CAST(m.tren AS INTEGER)                           AS linea,
            m.fecha_fin,
            m.no_llamadas                                     AS n_llamadas,
            m.tiempo_en_espera                                AS horas_espera,
            m.tiempo_intervencion                             AS horas_intervencion,
            m.tiempo_total                                    AS horas_total,
            m.tiempo_total_en_marcha                          AS horas_marcha,
            m.tiempo_total_en_paro                            AS horas_paro,
            t.tiempo_de_cip                                   AS horas_cip,
            t.limpieza                                        AS horas_limpieza_tag,
            t.maquina                                         AS maquina
        FROM raw_mantenimiento m
        LEFT JOIN raw_tiempo t ON t.woid = m.of
        WHERE m.is_limpieza
    """)

    # -------------------------------------------- fact_plan_vs_actual_2026
    # Best-effort alignment of May 2026 plan vs actual on (linea, sku, date).
    con.execute("""
        CREATE OR REPLACE TABLE fact_plan_vs_actual_2026 AS
        WITH plan AS (
            SELECT
                CAST(tren AS INTEGER) AS linea,
                material              AS sku,
                denominacion,
                fecha_ini,
                fecha_fin             AS fecha_fin_plan,
                start_ts,
                definicion_de_turno   AS turno,
                cntd_jda,
                cntd_plan,
                pndt_env,
                secuencia,
                manual,
                no_pac
            FROM raw_plan_2026
        ),
        actual AS (
            SELECT
                CAST(tren AS INTEGER) AS linea,
                sku,
                of,
                fecha_fin             AS fecha_fin_actual,
                uds                   AS uds_actual,
                hl                    AS hl_actual,
                oee, disp, rend, calid, inef,
                marca, familia, cerveza, tipo_envase
            FROM raw_actual_2026
        )
        SELECT
            COALESCE(p.linea, a.linea)               AS linea,
            COALESCE(p.sku, a.sku)                   AS sku,
            p.denominacion,
            p.fecha_ini                              AS fecha_ini_plan,
            p.fecha_fin_plan,
            p.start_ts                               AS start_ts_plan,
            p.turno                                  AS turno_plan,
            p.cntd_jda, p.cntd_plan,
            p.secuencia                              AS secuencia_plan,
            a.of                                     AS of_actual,
            a.fecha_fin_actual,
            a.uds_actual, a.hl_actual,
            a.oee, a.disp, a.rend, a.calid, a.inef,
            CASE
                WHEN p.sku IS NULL THEN 'only_actual'
                WHEN a.sku IS NULL THEN 'only_plan'
                ELSE 'matched'
            END AS estado_join
        FROM plan p
        FULL OUTER JOIN actual a
               ON p.linea = a.linea
              AND p.sku   = a.sku
              AND DATE_TRUNC('day', a.fecha_fin_actual) BETWEEN p.fecha_ini - INTERVAL 1 DAY
                                                            AND p.fecha_fin_plan + INTERVAL 1 DAY
    """)

    # ----------------------------------------------- fact_diario_hl_planif
    print("==> Parsing Diario Hl_Planif into long format ...")
    diario_long = parse_diario_hl(con)
    print(f"    {len(diario_long)} (linea, sku, fecha, metric) rows")
    con.register("_diario", diario_long)
    con.execute("""
        CREATE OR REPLACE TABLE fact_diario_hl_planif AS
        SELECT centro,
               CAST(linea AS INTEGER) AS linea,
               sku,
               CAST(fecha AS DATE)    AS fecha,
               metric,
               value
        FROM _diario
        WHERE linea IS NOT NULL
    """)
    con.unregister("_diario")

    # ---------------------------------------------- _meta_formulas (Damm)
    # Encoded verbatim from the diagram the team received.
    con.execute("""
        CREATE OR REPLACE TABLE _meta_formulas AS
        SELECT * FROM (VALUES
            ('OEE',
             'OEE = Disponibilidad * Rendimiento * Calidad',
             'Multiplicative. Available in raw_oee/fact_runs as oee, disponibilidad, rendimiento, ineficiencia.'),
            ('Disponibilidad',
             'Disponibilidad = Tiempo_de_funcionamiento / Tiempo_planificado',
             'Already provided per OF in raw_oee.disponibilidad.'),
            ('Rendimiento',
             'Rendimiento = (Tiempo_ciclo_ideal * Produccion_total) / Tiempo_de_funcionamiento',
             'Already provided per OF in raw_oee.rendimiento.'),
            ('Calidad',
             'Calidad = Produccion_buena / Produccion_total',
             'Implicit in OEE; equals 1.0 when no rework. Inef = 1 - calidad equivalent.'),
            ('Tiempo cambio (real)',
             'Tiempo_cambio = PAR_TOT - (PNP + LIMPIEZA + IDLE)',
             'fact_runs.horas_cambio. Use this (not horas_cip) for real changeover duration per OF.'),
            ('IDLE',
             'IDLE no afecta OEE',
             'Exclude IDLE from OEE-impact arithmetic. fact_runs.horas_idle is informational only.')
        ) AS t(concept, formula, notes)
    """)

    # ------------------------------------------- _meta_relationships (Damm)
    # The diagram's entity relationships, encoded as edges.
    con.execute("""
        CREATE OR REPLACE TABLE _meta_relationships AS
        SELECT * FROM (VALUES
            ('MES_OF',               'CAMBIOS',                  'central nexus -> changeover events per OF',                           'blue dashed'),
            ('MES_OF',               'OEE',                      'central nexus -> OEE master',                                         'blue dashed'),
            ('MES_OF',               'TIEMPO',                   'central nexus -> lost-time breakdown',                                'blue dashed'),
            ('MES_OF',               'VOLUMEN',                  'central nexus -> produced volumes',                                   'blue dashed'),
            ('MES_OF',               'TIEMPO_CAMBIO_TEORICO',    'central nexus <-> theoretical changeover reference',                  'red bidirectional (CRITICAL)'),
            ('CAMBIO_FORMATO',       'TIEMPO_CAMBIO_TEORICO',    'format change matrix feeds theoretical changeover times',             'red dashed (CRITICAL)'),
            ('MANTENIMIENTO_LIMPIEZAS','TIEMPO_CAMBIO_TEORICO',  'cleaning/maintenance events feed theoretical changeover times',       'red dashed (CRITICAL)'),
            ('CAMBIOS',              'TIPO_DE_CAMBIO',           'each changeover event has a type (Contenido, Pack, Palet, ...)',      'green'),
            ('TIPO_DE_CAMBIO',       'PREVIOUS_OF',              'WARNING: tipo de cambio requires inspecting the previous OF',         'green (CRITICAL warning)'),
            ('OEE',                  'CAMBIO_SI_NO',             'OEE row tags whether a changeover occurred during that OF',           'green'),
            ('OEE',                  'PCT_OEE_PCT_RENDIMIENTO',  'OEE row reports % OEE and % Rendimiento',                             'green'),
            ('TIEMPO',               'H_TOT',                    'tiempo container -> total hours',                                     'green'),
            ('TIEMPO',               'PAR_TOT_1',                'tiempo container -> total stoppage (component 1 of changeover formula)','green'),
            ('TIEMPO',               'PNP_2',                    'tiempo container -> planned non-production (component 2)',            'green'),
            ('TIEMPO',               'LIMPIEZA_3',               'tiempo container -> cleaning time (component 3)',                     'green'),
            ('TIEMPO',               'IDLE_4',                   'tiempo container -> idle time (component 4) - does NOT affect OEE',   'green'),
            ('TIEMPO',               'PCT_DISP_CALID_REND',      'tiempo container -> the three OEE component percentages',             'green'),
            ('VOLUMEN',              'HL',                       'volumen container -> hectolitres',                                    'green'),
            ('VOLUMEN',              'UDS',                      'volumen container -> units',                                          'green'),
            ('VOLUMEN',              'OEE',                      'volumen container -> redundant OEE for cross-check',                  'green')
        ) AS t(entity_from, entity_to, semantics, edge_style)
    """)

    # ------------------------------------------------------- _meta_tables
    con.execute("""
        CREATE OR REPLACE TABLE _meta_tables AS
        SELECT * FROM (VALUES
            ('dim_line',                          'Production lines (L14/L17/L19) and their format states.'),
            ('dim_sku',                           'SKU master with product hierarchy and inferred format state.'),
            ('dim_theoretical_changeover_matrix', 'Theoretical changeover minutes per (linea, from_state, to_state) from Tabla CF Prat.'),
            ('fact_runs',                         'Canonical per-OF run: OEE + lost-time decomposition + horas_cambio + maintenance + change flags.'),
            ('fact_lost_time',                    'Long-format lost-time per OF and category (minutes).'),
            ('fact_changeovers',                  'Per-OF transitions on the same line with previous SKU/state and theoretical reference.'),
            ('fact_limpieza',                     'Standalone LIMPIEZA / cleaning WOs.'),
            ('fact_plan_vs_actual_2026',          'May 2026 Blue Yonder plan aligned with actual production.'),
            ('fact_diario_hl_planif',             'Daily HL planning long-format (linea, sku, fecha, metric, value) — Programa Prod vs Acordado and 9 churn metrics for May 18-24 2026.'),
            ('_meta_formulas',                    'Damm OEE & changeover formulas extracted from the data-model diagram.'),
            ('_meta_relationships',               'Edges from Damm''s data-model diagram (CAMBIOS, OEE, TIEMPO, VOLUMEN, ...).')
        ) AS t(table_name, description)
    """)

    # ------------------- Report counts ----------------------
    print("\n==> Derived tables built:")
    for name in [
        "dim_line", "dim_sku", "dim_theoretical_changeover_matrix",
        "fact_runs", "fact_lost_time", "fact_changeovers", "fact_limpieza",
        "fact_plan_vs_actual_2026", "fact_diario_hl_planif",
        "_meta_formulas", "_meta_relationships",
    ]:
        n = con.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0]
        print(f"    {name:40s} {n:>7} rows")

    print("\n==> fact_runs sample columns:")
    cols = con.execute(
        "SELECT column_name FROM duckdb_columns() WHERE table_name='fact_runs' ORDER BY column_index"
    ).fetchall()
    print("    " + ", ".join(c[0] for c in cols))

    con.close()
    print("\n==> Done.")


if __name__ == "__main__":
    main()
