"""
LineWise — Step 05: Generate the polished Data Analysis Report (HTML + PDF).

Reads /reports/analytics/*.csv produced by 04_analytics.py and stitches them into
a single Damm-themed HTML document. Then converts to PDF via headless Chrome.

Run from repo root:
    python3 scripts/05_report.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import duckdb
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "db" / "linewise.duckdb"
ANALYTICS = ROOT / "reports" / "analytics"
HTML_OUT = ROOT / "reports" / "LineWise_Data_Report.html"
PDF_OUT = ROOT / "reports" / "LineWise_Data_Report.pdf"

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    shutil.which("google-chrome") or "",
    shutil.which("chromium") or "",
]


# ------------------------------------------------------------- helpers
def fmt(v, kind: str = "auto") -> str:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return ""
    if kind == "int":
        try:
            return f"{int(v):,}"
        except Exception:
            return str(v)
    if kind == "float":
        try:
            return f"{float(v):,.4f}"
        except Exception:
            return str(v)
    return str(v)


def df_table(df: pd.DataFrame, max_rows: int = 30) -> str:
    """Render a DataFrame as a clean HTML table."""
    if len(df) > max_rows:
        df = df.head(max_rows)
    th = "".join(f"<th>{c}</th>" for c in df.columns)
    body_rows = []
    for _, row in df.iterrows():
        cells = []
        for v in row.tolist():
            if isinstance(v, float):
                if abs(v) < 10 and v != int(v):
                    cells.append(f"<td>{v:.4f}</td>")
                elif abs(v) >= 1000:
                    cells.append(f"<td>{v:,.1f}</td>")
                else:
                    cells.append(f"<td>{v:.2f}</td>")
            elif isinstance(v, int):
                cells.append(f"<td>{v:,}</td>")
            elif pd.isna(v):
                cells.append("<td class='na'>·</td>")
            else:
                txt = str(v)
                if len(txt) > 40:
                    txt = txt[:38] + "…"
                cells.append(f"<td>{txt}</td>")
        body_rows.append("<tr>" + "".join(cells) + "</tr>")
    return f"<table><thead><tr>{th}</tr></thead><tbody>{''.join(body_rows)}</tbody></table>"


def load_csv(name: str) -> pd.DataFrame:
    p = ANALYTICS / f"{name}.csv"
    if not p.exists():
        return pd.DataFrame()
    return pd.read_csv(p)


def kpi(value: str, label: str, accent: bool = False) -> str:
    cls = "kpi accent" if accent else "kpi"
    return f"<div class='{cls}'><div class='kpi-value'>{value}</div><div class='kpi-label'>{label}</div></div>"


# ------------------------------------------------------------- HTML
def build_html() -> str:
    con = duckdb.connect(str(DB_PATH), read_only=True)

    # Headline KPIs
    line_stats = load_csv("A01_oee_por_linea")
    total_ofs = int(line_stats["n_ofs"].sum()) if not line_stats.empty else 0
    total_hl = float(line_stats["hl_total"].sum()) if not line_stats.empty else 0
    avg_oee = (
        (line_stats["oee_media"] * line_stats["n_ofs"]).sum() / line_stats["n_ofs"].sum()
    ) if not line_stats.empty else 0.0

    raw_tables = con.execute("""
        SELECT m.source_file, m.table_name, m.description,
               (SELECT COUNT(*) FROM information_schema.columns
                  WHERE table_name = m.table_name) AS n_cols
        FROM _meta_files m
        ORDER BY table_name
    """).fetchdf()
    raw_tables["rows"] = [
        con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        for t in raw_tables["table_name"]
    ]

    derived_tables = con.execute("""
        SELECT t.table_name, t.description
        FROM _meta_tables t
        ORDER BY table_name
    """).fetchdf()
    derived_tables["rows"] = [
        con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        for t in derived_tables["table_name"]
    ]

    con.close()

    # Analytical findings
    A01 = load_csv("A01_oee_por_linea")
    A02 = load_csv("A02_oee_por_tipo_cambio")
    A03 = load_csv("A03_oee_por_linea_y_tipo_cambio")
    A04 = load_csv("A04_top_cambios_volumen_ineficientes")
    A05 = load_csv("A05_lost_time_por_categoria_y_linea")
    A06 = load_csv("A06_oee_por_dia_semana")
    A07 = load_csv("A07_oee_por_mes")
    A08 = load_csv("A08_top_skus_por_volumen")
    A09 = load_csv("A09_top_skus_peor_oee")
    A10 = load_csv("A10_impacto_dimension_cambio")
    A11 = load_csv("A11_pares_sku_mas_frecuentes")
    A12 = load_csv("A12_impacto_mantenimiento_oee")
    A13 = load_csv("A13_limpieza_eventos_por_linea")
    A14 = load_csv("A14_plan_vs_actual_2026")
    A15 = load_csv("A15_runs_extremos_top_y_bottom_oee")
    A16 = load_csv("A16_distribucion_horas_por_of")
    A17 = load_csv("A17_oee_alta_vs_baja_horas_cip")
    A18 = load_csv("A18_horas_cambio_real_vs_teorico")
    A19 = load_csv("A19_diario_hl_plan_vs_acordado")
    A20 = load_csv("A20_anatomia_par_tot_por_linea")

    # Damm-model tables
    con2 = duckdb.connect(str(DB_PATH), read_only=True)
    formulas = con2.execute("SELECT * FROM _meta_formulas").fetchdf()
    relationships = con2.execute("SELECT * FROM _meta_relationships").fetchdf()
    con2.close()

    # Volume change impact for the headline
    volum_row = A10[A10["dimension"] == "volum"].iloc[0] if not A10.empty else None
    volum_delta = volum_row["delta"] if volum_row is not None else None

    css = """
    @page { size: A4; margin: 18mm 14mm; @bottom-right { content: "p. " counter(page) " / " counter(pages); font-family: 'Helvetica Neue', sans-serif; font-size: 8.5pt; color: #888; } }
    :root { --red:#c8102e; --dark:#1a1a1a; --gray:#555; --light:#f5f5f5; --border:#e0e0e0; --accent:#fff5f5; }
    * { box-sizing: border-box; }
    body { font-family:'Helvetica Neue',Helvetica,Arial,sans-serif; font-size:9.5pt; line-height:1.5; color:var(--dark); margin:0; padding:0; }
    .cover { page-break-after: always; background: var(--red); color:white; padding: 60mm 14mm 20mm; margin:-18mm -14mm; min-height: 260mm; }
    .cover .eyebrow { font-weight:700; letter-spacing:0.1em; opacity:0.9; font-size:10pt; text-transform:uppercase; }
    .cover h1 { font-size:60pt; font-weight:800; line-height:1; margin:8mm 0; letter-spacing:-0.02em; }
    .cover .subtitle { font-size:16pt; font-weight:300; max-width:140mm; line-height:1.3; }
    .cover .meta { margin-top:80mm; border-top:1px solid rgba(255,255,255,0.4); padding-top:5mm; font-size:9.5pt; opacity:0.95; }
    h1 { color:var(--red); font-size:22pt; border-bottom:2px solid var(--red); padding-bottom:3mm; margin:0 0 5mm; page-break-before:always; page-break-after:avoid; }
    h1.no-break { page-break-before:avoid; }
    h2 { color:var(--red); font-size:13pt; margin:7mm 0 2mm; page-break-after:avoid; }
    h3 { color:var(--dark); font-size:10.5pt; margin:4mm 0 2mm; page-break-after:avoid; }
    h4 { color:var(--gray); font-size:9pt; text-transform:uppercase; letter-spacing:0.05em; margin:3mm 0 1mm; }
    p { margin: 0 0 3mm; }
    .small { font-size:8.5pt; color: var(--gray); }
    table { width:100%; border-collapse:collapse; margin: 2mm 0 5mm; font-size:8.5pt; page-break-inside: avoid; }
    th { background: var(--red); color:white; text-align:left; padding:1.5mm 2.5mm; font-weight:700; }
    td { padding:1.5mm 2.5mm; border-bottom: 1px solid var(--border); vertical-align: top; }
    tr:nth-child(even) td { background: var(--light); }
    td.na { color:#bbb; text-align:center; }
    .kpis { display:flex; flex-wrap:wrap; gap:3mm; margin:4mm 0; }
    .kpi { flex:1 1 38mm; min-width:38mm; padding:4mm; border:1px solid var(--border); border-radius:4px; background:white; page-break-inside:avoid; }
    .kpi.accent { background: var(--red); color:white; border-color: var(--red); }
    .kpi-value { font-size:20pt; font-weight:800; line-height:1; letter-spacing:-0.02em; }
    .kpi-label { font-size:8.5pt; color:var(--gray); margin-top:1.5mm; line-height:1.3; }
    .kpi.accent .kpi-label { color: rgba(255,255,255,0.9); }
    .callout { background:var(--accent); border-left:4px solid var(--red); padding:4mm; margin:3mm 0; border-radius:0 4px 4px 0; page-break-inside: avoid; }
    .callout .label { font-size:8.5pt; font-weight:700; color:var(--red); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:1mm; }
    .callout p:last-child { margin-bottom:0; }
    .pill { display:inline-block; background:var(--red); color:white; font-size:7.5pt; font-weight:700; padding:1px 6px; border-radius:8px; text-transform:uppercase; letter-spacing:0.05em; margin-right:3px; }
    code { font-family: 'SF Mono', Menlo, Consolas, monospace; font-size:8.5pt; background:var(--light); padding:1px 4px; border-radius:3px; color:var(--red); }
    .toc ol { list-style:none; padding:0; }
    .toc li { padding:1.5mm 0; border-bottom:1px dotted var(--border); font-size:10pt; counter-increment: toc; }
    .toc li::before { content: counter(toc, decimal-leading-zero) "  "; color:var(--red); font-weight:700; margin-right:3mm; }
    .toc ol { counter-reset: toc; }
    """

    html_parts = []
    html_parts.append(f"<!doctype html><html><head><meta charset='utf-8'><title>LineWise · Data Analysis Report</title><style>{css}</style></head><body>")

    # ---------- cover
    html_parts.append(f"""
    <div class="cover">
        <div class="eyebrow">DAMM × ENGINEERING HUB · HACKATHON</div>
        <h1>LineWise</h1>
        <div class="subtitle">Data Analysis Report — Operations Challenge, canning lines 14 · 17 · 19 at El Prat factory.</div>
        <div class="meta"><strong>Audience:</strong> hackathon team &nbsp;·&nbsp; <strong>Source:</strong> {total_ofs:,} production OFs in 2025 across 3 lines &nbsp;·&nbsp; Database: <code>db/linewise.duckdb</code></div>
    </div>
    """)

    # ---------- TOC
    html_parts.append("""
    <h1 class="no-break">Contents</h1>
    <div class="toc"><ol>
        <li>Executive summary &amp; headline KPIs</li>
        <li>Damm data model — formulas &amp; relationships</li>
        <li>Data inventory — raw &amp; canonical tables</li>
        <li>OEE baseline per line</li>
        <li>What changeovers cost — by type &amp; dimension</li>
        <li>Real vs theoretical changeover times (Damm formula)</li>
        <li>Anatomy of PAR_TOT per line</li>
        <li>Lost-time decomposition</li>
        <li>Temporal patterns — day-of-week, month</li>
        <li>SKU portfolio — volume, performance, transitions</li>
        <li>Maintenance &amp; LIMPIEZA events</li>
        <li>Plan vs Actual (May 2026) — Blue Yonder window</li>
        <li>Daily HL planning — Programa Prod. vs Acordado</li>
        <li>Run-length distribution &amp; CIP impact</li>
        <li>Extreme runs — best &amp; worst OEE</li>
        <li>Data quality notes</li>
        <li>Implications for LineWise build</li>
    </ol></div>
    """)

    # ---------- 1. Executive summary
    html_parts.append(f"""
    <h1>1. Executive summary</h1>
    <div class="kpis">
        {kpi(f"{total_ofs:,}", "Production OFs analysed (excl. LIMPIEZA)", True)}
        {kpi(f"{total_hl:,.0f}", "Hectolitres produced (HL) 2025")}
        {kpi(f"{avg_oee*100:.1f}%", "Weighted-average OEE across L14·17·19")}
        {kpi(f"{abs(volum_delta)*100:.1f} pts" if volum_delta is not None else "—", "OEE drop when a size change occurs")}
    </div>
    <h2>One-line headline</h2>
    <div class="callout">
      <div class="label">The opportunity</div>
      <p>L14 averages <strong>42&thinsp;%</strong> OEE, L17 <strong>53&thinsp;%</strong>, L19 <strong>48&thinsp;%</strong>. The single biggest OEE killer is a <strong>volume size change</strong> (1/3 ↔ 1/2): −10.7 OEE points on average. Even +1 OEE point across the three lines = millions of additional cans per year.</p>
    </div>
    <h2>Top three actionable findings</h2>
    <ol>
      <li><strong>Cluster same-size runs.</strong> Size changes (1/3 ↔ 1/2) are the headline OEE killer. Sequencing should avoid them whenever feasible. (See §4.)</li>
      <li><strong>The Tiempo file gives us free explainability.</strong> Lost time already decomposed into CIP, baja velocidad, saturación, falta de producto, etc. The diagnostics panel can use these categories natively without inventing them. (See §6.)</li>
      <li><strong>Sub-portfolio of chronic underperformers</strong> (DAMM LEMON 4-pack, FREE DAMM 4-pack, COMPLOT, SKOL 12-pack): mean OEE 23–35&thinsp;%. Worth flagging as a category in the UI. (See §8.)</li>
    </ol>
    """)

    # ---------- 2. Damm data model
    html_parts.append("""
    <h1>2. Damm data model — formulas &amp; relationships</h1>
    <p>Encoded verbatim from the data-model diagram provided by Damm. These are also stored as queryable tables (<code>_meta_formulas</code>, <code>_meta_relationships</code>) inside the DuckDB database.</p>
    <h2>Formulas</h2>
    """)
    html_parts.append(df_table(formulas))
    html_parts.append("""
    <div class="callout">
      <div class="label">Critical correction</div>
      <p>Earlier we used <code>horas_cip</code> as the proxy for changeover duration per OF. The correct Damm formula is:</p>
      <p style="font-family:'SF Mono',Menlo,monospace; font-size:11pt; text-align:center; margin:3mm 0;">
        <strong>Tiempo cambio = PAR_TOT &minus; (PNP + LIMPIEZA + IDLE)</strong>
      </p>
      <p>This is now exposed as <code>fact_runs.horas_cambio</code>. <strong>IDLE does NOT affect OEE</strong> — keep it informational, exclude from impact arithmetic.</p>
    </div>
    <h2>Entity relationships</h2>
    <p>The central nexus is <strong>MES / OF (Material × Production Order)</strong>. Every analytical table joins to it.</p>
    """)
    html_parts.append(df_table(relationships, max_rows=25))

    # ---------- 3. Data inventory
    html_parts.append("<h1>3. Data inventory</h1><h2>Raw tables (lossless ingestion)</h2>")
    html_parts.append(df_table(raw_tables[["table_name", "source_file", "rows", "n_cols", "description"]], max_rows=20))
    html_parts.append("<h2>Canonical / derived tables</h2>")
    html_parts.append(df_table(derived_tables[["table_name", "rows", "description"]], max_rows=20))

    # ---------- 4. OEE baseline
    html_parts.append("<h1>4. OEE baseline per line</h1>")
    html_parts.append("<p>Aggregated over all production OFs in 2025, excluding LIMPIEZA WOs and outlier rows where <code>H. Tot. &gt; 100h</code>.</p>")
    html_parts.append(df_table(A01))
    html_parts.append("""
    <div class="callout">
      <div class="label">Read</div>
      <p>L17 is the strongest line by mean OEE, L14 the weakest. The p10–p90 spread is wide on every line (L19: 24 % → 71 %), confirming that <em>which</em> SKU runs and <em>after what</em> matter a lot. That spread is the optimization opportunity LineWise exploits.</p>
    </div>
    """)

    # ---------- 5. Changeover impact
    html_parts.append("<h1>5. What changeovers cost — by type &amp; dimension</h1>")
    html_parts.append("<h2>By <code>C. PRINCIPAL</code> (the type label)</h2>")
    html_parts.append(df_table(A02))
    html_parts.append("<h2>By line × type</h2>")
    html_parts.append(df_table(A03, max_rows=30))
    html_parts.append("<h2>OEE delta when each change-dimension flips</h2>")
    html_parts.append(df_table(A10))
    html_parts.append("""
    <div class="callout">
      <div class="label">Why this matters</div>
      <p><strong>Size (volum)</strong> changes are the single biggest OEE drag (−10.7 pts). They&apos;re relatively rare (~109 events in 2025), but each one is expensive. <strong>Producto</strong>, <strong>brand</strong> and <strong>CAP (tapón)</strong> changes are next: −5 to −6 pts. <em>Palet</em> changes hurt least (−2.6 pts). The sequencer should weight these accordingly when choosing among candidates.</p>
    </div>
    """)

    # ---------- 6. Real vs theoretical changeover times (Damm formula)
    html_parts.append("<h1>6. Real vs theoretical changeover times (Damm formula)</h1>")
    html_parts.append("<p>Using the corrected formula <code>horas_cambio = PAR_TOT &minus; (PNP + LIMPIEZA + IDLE)</code> per OF, compared against the theoretical reference in <code>dim_theoretical_changeover_matrix</code>. We also retain the earlier CIP-only view for transparency.</p>")
    html_parts.append("<h3>A18 — Damm-formula version (per OF, in-OF time only)</h3>")
    html_parts.append(df_table(A18))
    html_parts.append("<h3>A04 — CIP-only proxy (legacy view)</h3>")
    html_parts.append(df_table(A04, max_rows=15))
    html_parts.append("""
    <div class="callout">
      <div class="label">Important nuance</div>
      <p>The Damm-formula <em>horas_cambio</em> captures only the in-OF portion of a changeover. The full changeover budget = in-OF <code>horas_cambio</code> + duration of any standalone LIMPIEZA WO(s) that occurred between the previous and current production OF (see §11). The L19 1/3 ↔ 1/2 size change averages 6 h theoretical but only ~21 min of in-OF changeover time — the bulk happens as separate LIMPIEZA WOs.</p>
    </div>
    """)

    # ---------- 7. Anatomy of PAR_TOT
    html_parts.append("<h1>7. Anatomy of PAR_TOT per line</h1>")
    html_parts.append("<p>Where does the total stoppage time per OF actually go? Average minutes per OF, decomposed.</p>")
    html_parts.append(df_table(A20))
    html_parts.append("""
    <div class="callout">
      <div class="label">L14 is dominated by PNP</div>
      <p>L14 has an average <strong>319 min</strong> of PNP (Planned Non-Production) per OF — vs ~131 min on L17 and L19. PNP is shorter shifts / scheduled downtime, not lost productivity. This explains a big chunk of L14&apos;s low OEE: less wall-clock running time per OF.</p>
    </div>
    """)

    # ---------- 8. Lost-time decomposition
    html_parts.append("<h1>8. Lost-time decomposition</h1>")
    html_parts.append("<p>From <code>fact_lost_time</code>. <em>marcha</em> (productive) excluded.</p>")
    html_parts.append(df_table(A05, max_rows=30))
    html_parts.append("""
    <div class="callout">
      <div class="label">Use this directly in the UI</div>
      <p>The brief asks us to <em>explain</em> why OEE drops. We don&apos;t need to invent categories — the Damm Tiempo file already provides them. Power the diagnostic panel and Claude&apos;s tool responses with these eight categories natively.</p>
    </div>
    """)

    # ---------- 9. Temporal patterns
    html_parts.append("<h1>9. Temporal patterns</h1>")
    html_parts.append("<h2>OEE by day of week (1=Mon, 7=Sun)</h2>")
    html_parts.append(df_table(A06, max_rows=25))
    html_parts.append("<h2>OEE by month</h2>")
    html_parts.append(df_table(A07, max_rows=40))

    # ---------- 10. SKU portfolio
    html_parts.append("<h1>10. SKU portfolio</h1>")
    html_parts.append("<h2>Top 20 SKUs by produced volume</h2>")
    html_parts.append(df_table(A08, max_rows=20))
    html_parts.append("<h2>Worst-performing SKUs (≥ 10 runs in 2025)</h2>")
    html_parts.append(df_table(A09))
    html_parts.append("<h2>Most-frequent SKU pair transitions</h2>")
    html_parts.append(df_table(A11, max_rows=20))

    # ---------- 11. Maintenance & limpieza
    html_parts.append("<h1>11. Maintenance &amp; LIMPIEZA events</h1>")
    html_parts.append("<h2>OEE by number of maintenance calls during the OF</h2>")
    html_parts.append(df_table(A12, max_rows=15))
    html_parts.append("<h2>Standalone LIMPIEZA WOs per line</h2>")
    html_parts.append(df_table(A13))

    # ---------- 12. Plan vs actual May 2026
    html_parts.append("<h1>12. Plan vs Actual — May 2026 sample</h1>")
    html_parts.append("<p>The provided plan covers May 18–24 2026. Actual production data covers May 18–22 2026. Below: best-effort alignment on (linea, sku, date).</p>")
    html_parts.append(df_table(A14, max_rows=25))

    # ---------- 13. Daily HL planning
    html_parts.append("<h1>13. Daily HL planning — Programa Prod. vs Acordado</h1>")
    html_parts.append("<p>From the <code>Diario Hl_Planif.xlsx</code> daily replanning report (May 18–24 2026). <em>delta_hl</em> = Acordado − Programa Prod. Positive = added volume, negative = removed. Together with the format/quantity-modification counters, this is the <strong>real-world ground truth</strong> of how much a plan has to flex during the week.</p>")
    html_parts.append(df_table(A19, max_rows=25))
    html_parts.append("""
    <div class="callout">
      <div class="label">Demo gold</div>
      <p>L19 had &plus;384 HL added on May 20 and &minus;186 HL removed on May 21 — with <strong>6 changes</strong> on that single day (3 format mods, 3 quantity mods, 1 inclusion, 2 exclusions). Use this week as the live scenario in the demo: replay the plan, inject those real interventions, watch LineWise rebalance.</p>
    </div>
    """)

    # ---------- 14. Run length
    html_parts.append("<h1>14. Run-length distribution &amp; CIP impact</h1>")
    html_parts.append("<h2>Hours per OF — distribution by line</h2>")
    html_parts.append(df_table(A16))
    html_parts.append("<h2>OEE bucketed by CIP duration</h2>")
    html_parts.append(df_table(A17, max_rows=20))

    # ---------- 15. Extremes
    html_parts.append("<h1>15. Best &amp; worst runs by OEE</h1>")
    html_parts.append(df_table(A15, max_rows=22))

    # ---------- 13. Data quality
    html_parts.append("""
    <h1>16. Data quality notes</h1>
    <table>
      <tr><th>#</th><th>Issue</th><th>Mitigation</th></tr>
      <tr><td>1</td><td><code>OEE &gt; 1</code> on ~12 rows (e.g. 1.57 on a FREE DAMM run on L17). Likely a unit / aggregation glitch.</td><td>Clip to <code>[0, 1]</code> in modelling. Flag when &gt; 1.</td></tr>
      <tr><td>2</td><td><code>H. Tot.</code> outliers (max 21,065 h on one row).</td><td><code>fact_runs.outlier</code> filters <code>H. Tot. &gt; 100h</code>.</td></tr>
      <tr><td>3</td><td>LIMPIEZA OFs have NaN OEE.</td><td>Split into <code>fact_limpieza</code>; excluded from <code>fact_runs</code>.</td></tr>
      <tr><td>4</td><td>41 OFs in OEE file missing from Cambios file.</td><td>LEFT JOIN; dimension flags become NULL.</td></tr>
      <tr><td>5</td><td>Date granularity = <code>Fecha Fin</code> only (no time-of-day for OFs).</td><td>Sort by <code>(fecha_fin, of)</code> to get a stable order.</td></tr>
      <tr><td>6</td><td>May 2026 plan duplicates rows per shift (T/N/M).</td><td><code>fact_plan_vs_actual_2026.estado_join</code> ∈ {matched, only_plan, only_actual}.</td></tr>
      <tr><td>7</td><td>Some <code>C.*</code> dimension columns contain large ints (163, 803, etc.) instead of 0/1.</td><td>Use the <code>c_*_flag</code> boolean columns (engineered: any value &gt; 0 → TRUE).</td></tr>
      <tr><td>8</td><td>Cambios file uses <code>Nº</code> → ingested as <code>no_</code> (e.g. <code>no_llamadas</code>, <code>no_de_cambios</code>).</td><td>Column-name normalisation: lowercase ASCII snake_case.</td></tr>
    </table>
    """)

    # ---------- 14. Implications
    html_parts.append("""
    <h1>17. Implications for the LineWise build</h1>
    <ul>
      <li><strong>Sequencer objective:</strong> minimise the number of <em>size</em> changes first, then <em>brand/producto/cap</em> changes. Use the empirical OEE deltas as weights (volum: −10.7, producto: −5.8, brand: −5.7, cap: −5.5, primario: −3.9, secundario: −3.4, palet: −2.6).</li>
      <li><strong>OEE estimator features</strong> (already in <code>fact_runs</code> ready to use): <code>linea</code>, <code>sku</code>, <code>prev_sku</code>, <code>cambio_tipo_principal</code>, <code>estado_volumen</code>, <code>prev_estado_volumen</code>, <code>dia_semana</code>, <code>mes</code>, <code>n_llamadas_mant</code>, <code>horas_cip</code>, plus the 8 <code>c_*_flag</code> booleans.</li>
      <li><strong>Target variable</strong>: <code>fact_runs.oee</code>. Clip to <code>[0, 1]</code> before training.</li>
      <li><strong>Diagnostic panel</strong>: rank by <code>SUM(minutos)</code> from <code>fact_lost_time</code>, grouped by <code>(linea, categoria)</code>. The eight categories are ready-made.</li>
      <li><strong>Time Machine backtest</strong>: split <code>fact_runs</code> at week 40 of 2025; the last ~13 weeks become the holdout. Aggregate "predicted vs actual OEE" gives the killer slide number.</li>
      <li><strong>Claude tool schema</strong> should match the canonical tables: <code>query_history(linea, sku, prev_sku, window)</code> → <code>fact_runs</code> aggregations; <code>find_analogs(of_id, k)</code> → kNN on encoded feature vector; <code>score_sequence(plan)</code> → empirical lookup + LightGBM blend; <code>list_diagnostics(linea, week)</code> → <code>fact_lost_time</code> aggregation.</li>
    </ul>
    <div class="callout">
      <div class="label">Bottom line</div>
      <p>The data is richer than the brief suggested. We have lossless OEE history, an already-decomposed lost-time breakdown, a theoretical changeover matrix, and a plan-vs-actual May 2026 sample for the validation story. There is no need to invent features: the dataset hands us the answer to "why did OEE drop?" — we just need to surface it intelligently and let the optimizer choose better sequences.</p>
    </div>
    """)

    html_parts.append(f"""
    <div style="margin-top:12mm; padding-top:5mm; border-top:2px solid var(--red); font-size:8.5pt; color:var(--gray); text-align:center;">
      <strong>LineWise</strong> · Data Analysis Report · Damm × Engineering HUB Hackathon · Confidential
    </div>
    """)
    html_parts.append("</body></html>")

    return "".join(html_parts)


# ------------------------------------------------------------- main
def main() -> None:
    html = build_html()
    HTML_OUT.write_text(html, encoding="utf-8")
    print(f"==> Wrote {HTML_OUT}")

    chrome = next((c for c in CHROME_CANDIDATES if c and os.path.exists(c)), None)
    if not chrome:
        print("==> Chrome not found. Skipping PDF; open the HTML in any browser to print.")
        return
    cmd = [
        chrome,
        "--headless", "--disable-gpu",
        "--no-pdf-header-footer",
        f"--print-to-pdf={PDF_OUT.as_posix()}",
        f"file://{HTML_OUT.as_posix()}",
    ]
    res = subprocess.run(cmd, capture_output=True)
    if PDF_OUT.exists():
        size_kb = PDF_OUT.stat().st_size / 1024
        print(f"==> Wrote {PDF_OUT}  ({size_kb:.0f} KB)")
    else:
        print("==> PDF conversion failed:")
        print(res.stderr.decode("utf-8", errors="ignore")[:500])


if __name__ == "__main__":
    main()
