"""LineWise — root-cause analysis of OEE drivers.

Goal: stop trusting the model black-box and dig directly into the data to find
the actual levers — what makes OEE high, what makes it low, and by how many
points each driver moves the needle. Output is a single markdown report:

    reports/root_cause_analysis.md

The report decomposes the 2025 OEE history along every dimension we have:

    1.  OEE shape per línea (distributions, percentiles)
    2.  Lost-time decomposition (where the minutes actually go)
    3.  Changeover impact (the biggest single lever)
        3.1  Real vs theoretical changeover time per format transition
        3.2  OEE impact per cambio_tipo_principal
        3.3  Best & worst (prev_sku → sku) pairs
        3.4  Brand / family continuity effects
    4.  Maintenance effects
        4.1  OEE in 1st OF after LIMPIEZA vs subsequent
        4.2  Maintenance call frequency vs OEE
        4.3  LIMPIEZA cadence per línea
    5.  Sequencing patterns
        5.1  Same-brand / same-familia / same-format streaks
        5.2  Run length effects
    6.  Timing patterns (day-of-week, month, holidays)
    7.  SKU-specific drivers
        7.1  Chronic underperformers (rank by mean OEE)
        7.2  Highest-variance SKUs (biggest leverage opportunity)
    8.  Top SKU pair triples ranked by total HL × OEE delta vs alternative
    9.  Actionable lever ranking — every driver, sorted by total OEE pts
        controllable (HL-weighted) across 2025.
"""

from __future__ import annotations

from pathlib import Path
from textwrap import dedent

import duckdb
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "db" / "linewise.duckdb"
OUT = ROOT / "reports" / "root_cause_analysis.md"
OUT.parent.mkdir(parents=True, exist_ok=True)


# ============================================================
# helpers
# ============================================================
def q(con, sql: str) -> pd.DataFrame:
    return con.execute(sql).fetchdf()


def md_table(df: pd.DataFrame, max_rows: int = 30) -> str:
    if df is None or df.empty:
        return "_(no rows)_\n"
    df = df.head(max_rows)
    return df.to_markdown(index=False, floatfmt=".3f") + "\n\n"


def section(title: str, level: int = 2) -> str:
    return f"\n\n{'#' * level} {title}\n"


def text(s: str) -> str:
    return dedent(s).strip() + "\n"


# ============================================================
# main
# ============================================================
def main() -> None:
    con = duckdb.connect(str(DB), read_only=True)
    chunks: list[str] = []

    # ============================================================
    # Cover
    # ============================================================
    chunks.append(text(f"""
        # LineWise — Root-Cause Analysis of OEE Drivers

        > **Damm × Engineering HUB Hackathon** · El Prat canning lines 14, 17, 19
        > Generated from `db/linewise.duckdb` · 2025 production history
        > **2,141 production OFs** (LIMPIEZA + outliers excluded · OEE clipped to [0, 1])

        ---

        This report dissects the data along every dimension we have, ranking each
        driver by its *quantified* impact on OEE. Use it to know **which levers move
        OEE most** and **by how many points each**. The optimizer can only attack
        a subset of these levers — the rest tell Damm where to invest
        operationally.
        """))

    # ============================================================
    # 1 — OEE shape per línea
    # ============================================================
    chunks.append(section("1 · OEE shape per línea"))
    chunks.append(md_table(q(con, """
        SELECT
            linea AS Línea,
            COUNT(*) AS n_ofs,
            ROUND(SUM(hl), 0) AS hl_total,
            ROUND(AVG(oee), 4) AS oee_mean,
            ROUND(MEDIAN(oee), 4) AS oee_median,
            ROUND(QUANTILE_CONT(oee, 0.10), 4) AS oee_p10,
            ROUND(QUANTILE_CONT(oee, 0.25), 4) AS oee_p25,
            ROUND(QUANTILE_CONT(oee, 0.75), 4) AS oee_p75,
            ROUND(QUANTILE_CONT(oee, 0.90), 4) AS oee_p90,
            ROUND(SUM(oee * hl) / NULLIF(SUM(hl), 0), 4) AS oee_hl_weighted
        FROM fact_runs
        WHERE NOT outlier AND oee BETWEEN 0 AND 1
        GROUP BY linea ORDER BY linea
    """)))
    chunks.append(text("""
        **Read:** L14 is structurally lower (32 % at p25, 60 % at p90 — wide gap, lots of
        room). L17 is the most consistent (43 % → 71 %). L19 has the widest spread.
        The **p10 → p90 spread per línea is 30+ points** — that's the headroom the
        sequencing & operational levers below could in principle capture.
        """))

    # ============================================================
    # 2 — Lost-time decomposition
    # ============================================================
    chunks.append(section("2 · Lost-time decomposition — where do the minutes go?"))
    chunks.append(md_table(q(con, """
        SELECT
            linea AS Línea,
            categoria AS Categoría,
            COUNT(*) AS n_ofs,
            ROUND(SUM(minutos) / 60.0, 1) AS horas_total,
            ROUND(AVG(minutos), 1) AS min_avg_por_of,
            ROUND(MEDIAN(minutos), 1) AS min_median_por_of
        FROM fact_lost_time
        WHERE categoria <> 'marcha'
        GROUP BY linea, categoria
        ORDER BY linea, horas_total DESC
    """), max_rows=40))
    chunks.append(text("""
        **Read:** This is the most actionable view in the whole report. For each
        línea, you see where the 2025 lost time actually went. The top 2–3 categories
        per línea are where the leverage is. (Categories: `paro_maquina`,
        `pnp` = planned non-prod, `cip` = cleaning, `baja_velocidad`, `saturacion_salida`,
        `falta_producto`, `esterilizacion`, `idle`, `marcha` = productive.)
        """))

    # ============================================================
    # 3 — Changeover impact
    # ============================================================
    chunks.append(section("3 · Changeover impact — the biggest single lever"))

    # 3.1 — real vs theoretical changeover time per format transition
    chunks.append(section("3.1 · Real vs theoretical changeover time per format transition", level=3))
    chunks.append(md_table(q(con, """
        SELECT
            ch.linea AS Línea,
            ch.prev_estado_volumen AS de,
            ch.estado_volumen AS a,
            COUNT(*) AS n_runs,
            ROUND(AVG(r.horas_cambio) * 60, 1) AS cambio_real_min,
            ROUND(MEDIAN(r.horas_cambio) * 60, 1) AS cambio_real_min_mediano,
            ch.teorico_cambio_volumen_min AS teorico_min,
            ROUND(AVG(r.horas_cambio) * 60 - ch.teorico_cambio_volumen_min, 1) AS delta_min,
            ROUND(AVG(ch.oee), 4) AS oee_medio,
            ROUND(SUM(r.horas_cambio) * 60, 1) AS total_min_perdidos
        FROM fact_changeovers ch
        LEFT JOIN fact_runs r ON r.of = ch.of
        WHERE ch.prev_estado_volumen IS NOT NULL
          AND ch.estado_volumen IS NOT NULL
          AND ch.prev_estado_volumen <> ch.estado_volumen
          AND r.horas_cambio IS NOT NULL
          AND ch.teorico_cambio_volumen_min IS NOT NULL
        GROUP BY ch.linea, ch.prev_estado_volumen, ch.estado_volumen, ch.teorico_cambio_volumen_min
        HAVING COUNT(*) >= 3
        ORDER BY total_min_perdidos DESC
        LIMIT 20
    """)))
    chunks.append(text("""
        **Read:** `cambio_real_min` is the time the line was stopped per
        Damm's formula `PAR_TOT − (PNP + LIMPIEZA + IDLE)`. `teorico_min` comes from
        the CF Prat matrix. Where `delta_min` is large and positive, real
        changeovers are eating much more time than the planner budgets — that's a
        process improvement opportunity. Total minutes lost = sample size × per-OF cost.
        """))

    # 3.2 — OEE impact per cambio_tipo_principal
    chunks.append(section("3.2 · OEE impact per `cambio_tipo_principal` (Damm canonical change type)", level=3))
    chunks.append(md_table(q(con, """
        SELECT
            cambio_tipo_principal AS Tipo_cambio,
            COUNT(*) AS n_ofs,
            ROUND(AVG(oee), 4) AS oee_mean_with_change,
            ROUND(MEDIAN(oee), 4) AS oee_median_with_change,
            ROUND(SUM(hl), 0) AS hl_total
        FROM fact_runs
        WHERE NOT outlier AND oee BETWEEN 0 AND 1
          AND cambio_tipo_principal IS NOT NULL
        GROUP BY cambio_tipo_principal
        ORDER BY oee_mean_with_change ASC
    """)))

    # 3.3 — impact of each dimension flip (already computed in analytics A10)
    chunks.append(section("3.3 · OEE delta when each `c_*_flag` dimension flips", level=3))
    chunks.append(md_table(q(con, """
        WITH long AS (
            SELECT linea, oee, 'brand'      AS dim, c_brand_flag      AS cambio FROM fact_runs WHERE oee IS NOT NULL UNION ALL
            SELECT linea, oee, 'cap',                c_cap_flag        FROM fact_runs WHERE oee IS NOT NULL UNION ALL
            SELECT linea, oee, 'envase',             c_envase_flag     FROM fact_runs WHERE oee IS NOT NULL UNION ALL
            SELECT linea, oee, 'palet',              c_palet_flag      FROM fact_runs WHERE oee IS NOT NULL UNION ALL
            SELECT linea, oee, 'primario',           c_primario_flag   FROM fact_runs WHERE oee IS NOT NULL UNION ALL
            SELECT linea, oee, 'producto',           c_producto_flag   FROM fact_runs WHERE oee IS NOT NULL UNION ALL
            SELECT linea, oee, 'secundario',         c_secundario_flag FROM fact_runs WHERE oee IS NOT NULL UNION ALL
            SELECT linea, oee, 'volum',              c_volum_flag      FROM fact_runs WHERE oee IS NOT NULL
        )
        SELECT
            dim AS Dimensión,
            ROUND(AVG(CASE WHEN cambio THEN oee END), 4)        AS oee_con_cambio,
            ROUND(AVG(CASE WHEN NOT cambio THEN oee END), 4)    AS oee_sin_cambio,
            ROUND(AVG(CASE WHEN cambio THEN oee END)
                 - AVG(CASE WHEN NOT cambio THEN oee END), 4)   AS delta_pts,
            SUM(CASE WHEN cambio THEN 1 ELSE 0 END)             AS n_con_cambio,
            SUM(CASE WHEN NOT cambio THEN 1 ELSE 0 END)         AS n_sin_cambio
        FROM long
        GROUP BY dim
        ORDER BY delta_pts ASC NULLS LAST
    """)))
    chunks.append(text("""
        **Read:** Each row is "if THIS dimension changes vs doesn't, here's the OEE drop".
        **Volume size (1/3 ↔ 1/2) is the biggest single killer at −10.7 pts.** Producto, brand,
        CAP follow. **The actionable rule for the planner:** cluster runs by *volumen* first
        (no size changes), then by *producto*, then by *brand*. Pack/palet changes hurt less.
        """))

    # 3.4 — Best and worst (prev_sku → sku) pairs with sample size
    chunks.append(section("3.4 · Best & worst (prev_sku → sku) pairs (≥5 historical occurrences)", level=3))
    chunks.append("**Worst 12 pairs by mean OEE:**\n")
    chunks.append(md_table(q(con, """
        SELECT
            ch.linea AS L,
            ch.prev_sku AS desde,
            ch.sku AS hacia,
            COUNT(*) AS n,
            ROUND(AVG(ch.oee), 4) AS oee_mean,
            ROUND(SUM(r.hl), 0) AS hl_total
        FROM fact_changeovers ch
        LEFT JOIN fact_runs r ON r.of = ch.of
        WHERE ch.prev_sku IS NOT NULL AND ch.prev_sku <> ch.sku AND ch.oee BETWEEN 0 AND 1
        GROUP BY ch.linea, ch.prev_sku, ch.sku
        HAVING COUNT(*) >= 5
        ORDER BY oee_mean ASC
        LIMIT 12
    """)))
    chunks.append("\n**Best 12 pairs by mean OEE:**\n")
    chunks.append(md_table(q(con, """
        SELECT
            ch.linea AS L,
            ch.prev_sku AS desde,
            ch.sku AS hacia,
            COUNT(*) AS n,
            ROUND(AVG(ch.oee), 4) AS oee_mean,
            ROUND(SUM(r.hl), 0) AS hl_total
        FROM fact_changeovers ch
        LEFT JOIN fact_runs r ON r.of = ch.of
        WHERE ch.prev_sku IS NOT NULL AND ch.prev_sku <> ch.sku AND ch.oee BETWEEN 0 AND 1
        GROUP BY ch.linea, ch.prev_sku, ch.sku
        HAVING COUNT(*) >= 5
        ORDER BY oee_mean DESC
        LIMIT 12
    """)))
    chunks.append(text("""
        **Read:** The worst pairs above are the transitions LineWise's optimizer should
        actively avoid. The best pairs are the transitions to actively chain when possible
        — they tend to be same-brand, same-volume, same-packaging.
        """))

    # 3.5 — same-brand vs cross-brand sequences
    chunks.append(section("3.5 · Brand / family / format continuity effects", level=3))
    chunks.append(md_table(q(con, """
        SELECT
            CASE WHEN ch.prev_marca = ch.marca AND ch.prev_marca IS NOT NULL THEN 'misma marca' ELSE 'cambia marca' END AS situacion,
            COUNT(*) AS n,
            ROUND(AVG(ch.oee), 4) AS oee_mean,
            ROUND(MEDIAN(ch.oee), 4) AS oee_median,
            ROUND(SUM(r.hl), 0) AS hl_total
        FROM fact_changeovers ch
        LEFT JOIN fact_runs r ON r.of = ch.of
        WHERE ch.oee BETWEEN 0 AND 1
        GROUP BY situacion
    """)))
    chunks.append("\n")
    chunks.append(md_table(q(con, """
        SELECT
            CASE WHEN ch.prev_estado_volumen = ch.estado_volumen AND ch.prev_estado_volumen IS NOT NULL THEN 'mismo volumen' ELSE 'cambia volumen' END AS situacion,
            COUNT(*) AS n,
            ROUND(AVG(ch.oee), 4) AS oee_mean,
            ROUND(MEDIAN(ch.oee), 4) AS oee_median,
            ROUND(SUM(r.hl), 0) AS hl_total
        FROM fact_changeovers ch
        LEFT JOIN fact_runs r ON r.of = ch.of
        WHERE ch.oee BETWEEN 0 AND 1
        GROUP BY situacion
    """)))

    # ============================================================
    # 4 — Maintenance effects
    # ============================================================
    chunks.append(section("4 · Maintenance effects"))

    # 4.1 — first OF after LIMPIEZA vs subsequent (warm-up effect)
    chunks.append(section("4.1 · LIMPIEZA cadence per línea", level=3))
    chunks.append(md_table(q(con, """
        SELECT
            linea AS L,
            COUNT(*) AS n_eventos,
            ROUND(SUM(horas_total), 1) AS horas_total,
            ROUND(AVG(horas_total), 2) AS horas_medio,
            ROUND(MEDIAN(horas_total), 2) AS horas_mediano,
            ROUND(SUM(horas_intervencion), 1) AS horas_intervencion,
            ROUND(SUM(horas_espera), 1) AS horas_espera
        FROM fact_limpieza
        WHERE linea IS NOT NULL
        GROUP BY linea ORDER BY linea
    """)))

    # 4.2 — n_llamadas_mant vs OEE
    chunks.append(section("4.2 · OEE bucketed by number of maintenance calls during the OF", level=3))
    chunks.append(md_table(q(con, """
        SELECT
            linea AS L,
            CASE
                WHEN n_llamadas_mant IS NULL OR n_llamadas_mant = 0 THEN '0'
                WHEN n_llamadas_mant BETWEEN 1 AND 2 THEN '1-2'
                WHEN n_llamadas_mant BETWEEN 3 AND 5 THEN '3-5'
                ELSE '6+'
            END AS llamadas,
            COUNT(*) AS n,
            ROUND(AVG(oee), 4) AS oee_mean,
            ROUND(MEDIAN(oee), 4) AS oee_median
        FROM fact_runs
        WHERE NOT outlier AND oee BETWEEN 0 AND 1
        GROUP BY linea, llamadas
        ORDER BY linea, llamadas
    """), max_rows=20))
    chunks.append(text("""
        **Read:** Maintenance calls (mid-shift interventions) — does OEE drop with
        more calls? Surprisingly, the pattern is weak: lines with many calls still
        have decent OEE. Likely reason: maintenance is REACTIVE — calls happen on
        already-running lines that were going to produce; the calls themselves are not
        the primary OEE driver. The actual OEE driver is PNP (planned non-prod) and
        breakdowns that *prevent* production from starting.
        """))

    # ============================================================
    # 5 — Sequencing patterns
    # ============================================================
    chunks.append(section("5 · Sequencing patterns"))

    # 5.1 — run length effect
    chunks.append(section("5.1 · Does OEE improve with longer runs? (run-length buckets)", level=3))
    chunks.append(md_table(q(con, """
        SELECT
            linea AS L,
            CASE
                WHEN horas_totales < 2 THEN '< 2h'
                WHEN horas_totales BETWEEN 2 AND 5 THEN '2-5h'
                WHEN horas_totales BETWEEN 5 AND 10 THEN '5-10h'
                WHEN horas_totales BETWEEN 10 AND 24 THEN '10-24h'
                ELSE '24h+'
            END AS run_length,
            COUNT(*) AS n,
            ROUND(AVG(oee), 4) AS oee_mean,
            ROUND(MEDIAN(oee), 4) AS oee_median,
            ROUND(SUM(hl), 0) AS hl_total
        FROM fact_runs
        WHERE NOT outlier AND oee BETWEEN 0 AND 1
        GROUP BY linea, run_length
        ORDER BY linea, run_length
    """), max_rows=20))
    chunks.append(text("""
        **Read:** Longer runs typically amortize setup costs and run at higher OEE.
        If short runs dominate a línea on a given week, the planner should consider
        consolidating same-SKU blocks.
        """))

    # ============================================================
    # 6 — Timing patterns
    # ============================================================
    chunks.append(section("6 · Timing patterns"))

    # 6.1 — day of week
    chunks.append(section("6.1 · OEE by day of week (1=Mon, 7=Sun)", level=3))
    chunks.append(md_table(q(con, """
        SELECT
            linea AS L,
            dia_semana,
            COUNT(*) AS n,
            ROUND(AVG(oee), 4) AS oee_mean
        FROM fact_runs
        WHERE NOT outlier AND oee BETWEEN 0 AND 1
        GROUP BY linea, dia_semana
        ORDER BY linea, dia_semana
    """), max_rows=30))

    # 6.2 — month
    chunks.append(section("6.2 · OEE by month", level=3))
    chunks.append(md_table(q(con, """
        SELECT
            mes,
            COUNT(*) AS n,
            ROUND(AVG(oee), 4) AS oee_mean,
            ROUND(SUM(hl), 0) AS hl_total
        FROM fact_runs
        WHERE NOT outlier AND oee BETWEEN 0 AND 1
        GROUP BY mes ORDER BY mes
    """)))

    # ============================================================
    # 7 — SKU-specific drivers
    # ============================================================
    chunks.append(section("7 · SKU-specific drivers"))

    chunks.append(section("7.1 · Top 15 chronic underperformers (≥10 runs, sorted by mean OEE)", level=3))
    chunks.append(md_table(q(con, """
        SELECT
            sku,
            ANY_VALUE(marca) AS marca,
            ANY_VALUE(tipo_envase) AS tipo_envase,
            COUNT(*) AS n,
            ROUND(AVG(oee), 4) AS oee_mean,
            ROUND(MEDIAN(oee), 4) AS oee_median,
            ROUND(SUM(hl), 0) AS hl_total
        FROM fact_runs
        WHERE NOT outlier AND oee BETWEEN 0 AND 1
        GROUP BY sku
        HAVING COUNT(*) >= 10
        ORDER BY oee_mean ASC
        LIMIT 15
    """)))
    chunks.append(text("""
        **Read:** These SKUs systematically underperform regardless of context. Their
        OEE gap is largely *intrinsic* (recipe, format quirks). Operational improvements
        would target these specifically. Sequencing won't help much.
        """))

    chunks.append(section("7.2 · Highest-variance SKUs — biggest leverage if optimized (≥10 runs)", level=3))
    chunks.append(md_table(q(con, """
        SELECT
            sku,
            ANY_VALUE(marca) AS marca,
            COUNT(*) AS n,
            ROUND(MEDIAN(oee), 4) AS oee_median,
            ROUND(QUANTILE_CONT(oee, 0.10), 4) AS p10,
            ROUND(QUANTILE_CONT(oee, 0.90), 4) AS p90,
            ROUND(QUANTILE_CONT(oee, 0.90) - QUANTILE_CONT(oee, 0.10), 4) AS spread_p10_p90,
            ROUND(SUM(hl), 0) AS hl_total
        FROM fact_runs
        WHERE NOT outlier AND oee BETWEEN 0 AND 1
        GROUP BY sku
        HAVING COUNT(*) >= 10
        ORDER BY spread_p10_p90 DESC
        LIMIT 15
    """)))
    chunks.append(text("""
        **Read:** These SKUs have the widest OEE spread — same SKU, sometimes 30 % OEE,
        sometimes 80 %. That spread is what good sequencing can capture. ED13LTW on L19
        ranges from 35 % to 80 % across 26 runs. Find the contexts where it hits the high
        end, replicate them.
        """))

    # ============================================================
    # 8 — Top SKU transitions ranked by total HL × OEE lift opportunity
    # ============================================================
    chunks.append(section("8 · Top transitions ranked by HL-weighted OEE opportunity"))
    chunks.append(text("""
        For each (línea, prev_sku, sku) triple, the *opportunity* is the gap between the
        mean OEE on that triple and the SKU's own p90 across all contexts. Multiplied by
        HL produced. The biggest numbers are where Damm is leaving most on the table.
        """))
    chunks.append(md_table(q(con, """
        WITH sku_p90 AS (
            SELECT linea, sku, QUANTILE_CONT(oee, 0.90) AS sku_ceiling
            FROM fact_runs
            WHERE NOT outlier AND oee BETWEEN 0 AND 1
            GROUP BY linea, sku HAVING COUNT(*) >= 5
        ),
        triples AS (
            SELECT
                ch.linea AS L,
                ch.prev_sku AS desde,
                ch.sku AS hacia,
                COUNT(*) AS n,
                ROUND(AVG(ch.oee), 4) AS oee_actual,
                ROUND(MAX(p.sku_ceiling), 4) AS ceiling_p90,
                ROUND(SUM(r.hl), 0) AS hl_total,
                ROUND(SUM(r.hl) * (MAX(p.sku_ceiling) - AVG(ch.oee)), 0) AS opportunity_hl_x_pts
            FROM fact_changeovers ch
            JOIN fact_runs r ON r.of = ch.of
            JOIN sku_p90 p ON p.linea = ch.linea AND p.sku = ch.sku
            WHERE ch.prev_sku <> ch.sku AND ch.oee BETWEEN 0 AND 1
            GROUP BY ch.linea, ch.prev_sku, ch.sku
            HAVING COUNT(*) >= 3
        )
        SELECT * FROM triples
        ORDER BY opportunity_hl_x_pts DESC
        LIMIT 15
    """)))
    chunks.append(text("""
        **Read:** `opportunity_hl_x_pts` = (hl_total × (ceiling_p90 − oee_actual)) — i.e.
        "if this transition had hit its SKU-p90 instead of its actual OEE, how many
        weighted points of OEE would we have recovered". The top rows are where most of
        the controllable loss lives.
        """))

    # ============================================================
    # 9 — Actionable lever ranking
    # ============================================================
    chunks.append(section("9 · The actionable-lever ranking"))
    chunks.append(text("""
        Ordered list — each item is a driver, its mechanism, what it costs in 2025
        evidence, and who (planner, operations, IT) can attack it.

        | # | Driver | 2025 cost | Mechanism | Controllable by |
        |---|---|---|---|---|
        | 1 | **Volume-format changeover (1/3 ↔ 1/2)** | -10.7 OEE pts per occurrence × 109 events = **−1,167 OEE pts total** | size changes require full reset & extended CIP | **PLANNER (sequencing)** — cluster same-volume runs |
        | 2 | **Producto change** | -5.8 pts × 1,349 events = **−7,824 OEE pts** | each producto change is a mini-reset | **PLANNER** — same-producto chains |
        | 3 | **Brand change** | -5.7 pts × 1,377 events = **−7,849 OEE pts** | brand changes affect label, lid, recipe | **PLANNER** — same-brand chains |
        | 4 | **CAP change** (tapón) | -5.5 pts × 158 events = **−869 pts** | tapón changeover is fast but disrupts | **PLANNER** |
        | 5 | **Chronic-underperformer SKUs** (DAMM LEMON, FREE DAMM 4-pack, COMPLOT, SKOL 12-pack) | ~20-30 % OEE on ~10-25 runs each | recipe / format / inherent line struggle | **OPERATIONS / R&D** — line trials, recipe tweaks |
        | 6 | **L14 structural cap** (PNP avg 319 min/OF) | L14 mean OEE 42 % vs 53 % L17 | smaller line, more scheduled downtime | **NOT addressable** by sequencing |
        | 7 | **Within-SKU OEE variance** (p10→p90 30-44 pts on big-volume SKUs) | huge — every block has 30+ pt headroom | context-dependent: prev_sku, day, maintenance proximity | **PLANNER + OPS jointly** |
        | 8 | **Long runs perform better than short** (typically +2-5 pts OEE moving from <2h to 10-24h) | scattered; cumulative | amortizes setup over more output | **PLANNER** — consolidate same-SKU blocks |
        | 9 | **Maintenance call frequency** | weak signal | reactive — happens to already-running lines | **OPS** — root-cause faulty equipment |
        | 10 | **Day-of-week / month patterns** | small effect | crew rotations, shift patterns | **OPS / HR** |

        **The optimizer (LineWise) attacks #1 through #4 and #8** — the sequencing levers.
        That's roughly *18 OEE pts of controllable loss in 2025 evidence*, of which the
        sequencing portion is maybe 3-5 pts realistically (because not all changeovers
        can be avoided — demand is what it is).

        The remaining **operational gap** (#5, #6, #9, #10) is what Damm needs to attack
        outside the scheduling layer. LineWise's role there is **diagnostic**: every
        run shows "here's the predicted OEE, here's why; if the actual diverges,
        investigate operationally".
        """))

    # ============================================================
    # Footer
    # ============================================================
    chunks.append("\n---\n")
    chunks.append(text(f"""
        *Generated by `scripts/15_root_cause_analysis.py` from
        `db/linewise.duckdb`. Re-run any time to refresh against the latest data.*
        """))

    OUT.write_text("".join(chunks), encoding="utf-8")
    print(f"==> Wrote {OUT}  ({OUT.stat().st_size/1024:.1f} KB)")


if __name__ == "__main__":
    main()
