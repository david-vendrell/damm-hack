# LineWise · Damm × Engineering HUB Hackathon

> Intelligent line sequencing and OEE optimization for canning lines **14**, **17**, **19** at El Prat.

Blue Yonder tells you what the plan *should* be. **LineWise** tells you what reality says will actually happen — and rearranges your week when an urgent order lands.

## Repo layout

```
damm-hack/
├── Repte operacions/   ← raw Damm Excels (single source of truth)
├── web/                ← Next.js app: ingest, API, dashboard
└── LineWise Operaciones ES.pdf
├── Repte operacions/            ← raw Damm Excels (untouched, includes Diario Hl + v2 Planificado)
├── docs/
│   └── IO_SCHEMA.md             ← Input / Output contract for engine, UI, Claude tools (source of truth)
├── scripts/                     ← repeatable pipeline (Python)
│   ├── 01_ingest.py             ← Excels → DuckDB raw_* tables (lossless, 12 tables now)
│   ├── 02_parse_cf_matrix.py    ← Tabla CF Prat → dim_theoretical_changeover_matrix
│   ├── 03_derived_tables.py     ← raw_* → fact_runs (with horas_cambio) / fact_changeovers / fact_lost_time / fact_limpieza / fact_plan_vs_actual_2026 / fact_diario_hl_planif / dim_sku / dim_line + _meta_formulas + _meta_relationships
│   ├── 04_analytics.py          ← 20 analytical queries → CSVs + Parquet exports
│   └── 05_report.py             ← Generate Data Analysis Report (HTML + PDF)
├── db/
│   └── linewise.duckdb          ← single-file portable database (~6 MB)
├── parquet/                     ← fact/dim tables for non-DuckDB users
├── reports/
│   ├── analytics/               ← per-query CSV results (20 files)
│   └── LineWise_Data_Report.pdf ← polished data report (17 sections)
└── LineWise Operaciones ES.pdf  ← original challenge brief
```

## Quick start

```bash
cd web
npm i
npx prisma migrate dev
npm run ingest          # reads Repte operacions/*.xlsx → SQLite (OfHecho)
npm run dev             # http://localhost:3000 → /observabilidad
```

See `web/README.md` for details on the ingest pipeline, cleaning decisions, and how to add more years.
All scripts are idempotent — re-run any of them after changes to upstream raw files.

---

## What's in the DuckDB database

### Raw layer (lossless — every Excel column preserved)

| Table | Source file | Rows | Cols |
|---|---|---:|---:|
| `raw_oee` | OEE 14_17_19_ 2025.xlsx | 2,274 | 45 |
| `raw_cambios` | Cambios 14_17_19_ 2025.xlsx | 2,181 | 31 |
| `raw_tiempo` | Tiempo 14_17_19_ 2025.xlsx | 2,278 | 35 |
| `raw_mantenimiento` | Mantenimiento 14_17_19_ 2025.xlsx | 2,276 | 25 |
| `raw_volumen` | Volumen 14_17_19_ 2025.xlsx | 2,278 | 20 |
| `raw_plan_2026` | Planificado producciones 14-17-19.xlsx | 78 | 19 |
| `raw_plan_2026_v2` | Planificado producciones (v2) | 78 | 18 |
| `raw_actual_2026` | Produccion_L14,17,19_18-22.xlsx | 36 | 20 |
| `raw_data_extra` | data - 2026-05-18T181640.542.xlsx | 2,276 | 45 |
| `raw_diario_hl_planif` | Diario Hl_Planif.xlsx (wide cells) | 44 | 100 |
| `raw_diario_hl_planif_headers` | sidecar — original multi-line headers | 98 | 3 |
| `raw_cf_lata_barril` | Tabla CF Prat (sheet) | 46 | 8 |
| `raw_cf_tiempos_adicionales` | Tabla CF Prat (sheet) | 37 | 12 |

### Canonical layer (use these for analysis)

| Table | Rows | What it is |
|---|---:|---|
| `dim_line` | 3 | Production lines L14/L17/L19 + format states they support |
| `dim_sku` | 170 | SKU master: brand, family, beer, can type, packaging, **inferred `estado_volumen`** (1/3, 1/2, 2/5) |
| `dim_theoretical_changeover_matrix` | 86 | Long-format theoretical changeover minutes per (linea, from_state, to_state) parsed from Tabla CF Prat |
| `fact_runs` | 2,184 | **Canonical per-OF run.** Joined OEE + Tiempo + Volumen + Mantenimiento + Cambios. **52 columns** including `horas_cambio` (the Damm-formula real changeover time). Excludes LIMPIEZA WOs. |
| `fact_lost_time` | 19,602 | Long-format breakdown of every OF's time in 9 categories: `marcha, cip, baja_velocidad, saturacion_salida, falta_producto, esterilizacion, paro_maquina, idle, pnp` (in minutes) |
| `fact_changeovers` | 2,180 | Per consecutive (prev_of, of) on the same line, with prev SKU/state, change type label, and theoretical reference duration |
| `fact_limpieza` | 133 | Standalone LIMPIEZA / cleaning WOs (separated from production runs) |
| `fact_plan_vs_actual_2026` | 91 | May 2026 Blue Yonder plan joined to actual production for plan-vs-actual comparison |
| `fact_diario_hl_planif` | 197 | **Daily HL planning** May 18-24 2026 in long format `(linea, sku, fecha, metric, value)` — Programa Prod / Acordado + 9 churn metrics |
| `_meta_formulas` | 6 | The OEE & changeover formulas from Damm's data-model diagram |
| `_meta_relationships` | 20 | The edges from Damm's data-model diagram |

### Metadata helpers

```sql
SELECT * FROM _meta_files;          -- which source file populated which raw_ table
SELECT * FROM _meta_tables;         -- description of every derived table
SELECT * FROM _meta_formulas;       -- Damm OEE & changeover formulas (from the diagram)
SELECT * FROM _meta_relationships;  -- Damm entity-relationship edges (from the diagram)
```

### Damm's data model & the corrected changeover formula

From the diagram Damm provided, **MES / OF is the central nexus**. Every fact table joins to a single OF identifier. The diagram also gives us the **real changeover formula**:

> `horas_cambio = PAR_TOT − (PNP + LIMPIEZA + IDLE)`

This is now exposed as `fact_runs.horas_cambio` (previously we approximated with `horas_cip` — wrong). Note: `IDLE` does **NOT** affect OEE — keep it informational. See `docs/IO_SCHEMA.md` for the full data-model diagram and Input/Output contract.

---

## How to query the database

### Python (preferred)

```python
import duckdb
con = duckdb.connect("db/linewise.duckdb", read_only=True)
df = con.execute("""
    SELECT linea, AVG(oee) FROM fact_runs WHERE oee IS NOT NULL GROUP BY linea ORDER BY linea
""").fetchdf()
print(df)
```

### Command line (DuckDB CLI)

```bash
brew install duckdb            # one-time
duckdb db/linewise.duckdb
duckdb> SELECT * FROM _meta_tables;
duckdb> .quit
```

### GUI (DBeaver / TablePlus / DataGrip)

- Driver: **DuckDB** (DBeaver has it built-in since v23)
- URL: `jdbc:duckdb:/abs/path/to/db/linewise.duckdb`
- Read-only is fine.

### Power BI / Excel (via Parquet)

`parquet/` contains every fact/dim table as `.parquet`. Power BI and Excel power-query can read Parquet natively — no DuckDB needed.

---

## Sharing the work with the team

The whole database is a **single file** (~5 MB):

```bash
db/linewise.duckdb
```

Options:
1. **Commit it.** It's small. Whoever pulls the repo gets it. (Already gitignored by default — see below if you want to commit.)
2. **Slack/Drop attach.** Send `db/linewise.duckdb` to anyone, they open with the DuckDB CLI or Python.
3. **Re-build.** Anyone with the raw Excels in `Repte operacions/` can run the 5 scripts and reproduce it exactly.

To commit the DB (optional):
```bash
# in .gitignore, remove the db/ line if present, then:
git add db/linewise.duckdb && git commit -m "snapshot duckdb"
```

---

## Headline findings (from `python3 scripts/04_analytics.py`)

### OEE per line (baseline)

| Line | n OFs | mean OEE | median OEE | p10 | p90 |
|---|---:|---:|---:|---:|---:|
| **L14** | 436 | **42.6 %** | 44.7 % | 25 % | 60 % |
| **L17** | 950 | **53.1 %** | 54.1 % | 33 % | 71 % |
| **L19** | 792 | **48.1 %** | 47.8 % | 24 % | 71 % |

**Brutally low.** That's the pitch: each +1 OEE point = millions of cans recovered.

### Biggest OEE killers (which dimensions of change hurt most)

| Change dimension | OEE with change | OEE without | **Δ** |
|---|---:|---:|---:|
| **Volum (size 1/3 ↔ 1/2)** | 0.39 | 0.50 | **−10.7 pts** |
| Producto | 0.47 | 0.53 | −5.8 pts |
| Brand | 0.47 | 0.53 | −5.7 pts |
| CAP (tapón) | 0.44 | 0.49 | −5.5 pts |
| Primario | 0.47 | 0.51 | −3.9 pts |
| Secundario | 0.47 | 0.50 | −3.4 pts |
| Palet | 0.48 | 0.50 | −2.6 pts |

→ **Size changes are the headline OEE killer.** Sequencing should ruthlessly cluster same-size runs.

### Most-frequent SKU pair transitions (top 5)

| Line | from → to | n | OEE after |
|---|---|---:|---:|
| 19 | LC12LTW → VI12LTW | 14 | 44 % |
| 19 | ED13LP12 → ED13P12M | 12 | 64 % |
| 17 | FD13LTNN → FDT13LT | 11 | 61 % |
| 17 | ED13LTCW → ED13LTW | 10 | 61 % |
| 17 | VO13LP24 → VO13LTNN | 10 | 62 % |

### Worst-performing SKUs (≥10 runs)

| SKU | brand | mean OEE |
|---|---|---:|
| DL13LP4A | DAMM LEMON | **23 %** |
| FD13LP4A | FREE DAMM | 29 % |
| CM13LT | COMPLOT | 30 % |
| SK13L12 | SKOL | 31 % |
| SK1312MN | SKOL | 35 % |

→ **Damm Lemon and Free Damm small-pack variants are chronic underperformers.**

Full numbers in `reports/analytics/*.csv` and the polished PDF at `reports/LineWise_Data_Report.pdf`.

---

## Known data quality flags (don't pretend these don't exist)

| # | Issue | Mitigation |
|---|---|---|
| 1 | **`OEE > 1` on ~12 rows** (data noise — some best runs report 1.57, etc.) | Clip OEE to `[0, 1]` in modelling. Flag at `> 1.0`. |
| 2 | **`H. Tot. > 100h` outliers** (max = 21,065h) | `fact_runs.outlier` boolean filters these out. |
| 3 | **LIMPIEZA OFs** have NaN OEE | Split into `fact_limpieza`; excluded from `fact_runs`. |
| 4 | **`Cambios` file has 41 OFs missing** vs OEE file | LEFT JOIN handles it; the dimensional flags become NULL. |
| 5 | **Date granularity is `Fecha Fin` only** (no time-of-day) | Sort by `(fecha_fin, of)` to get a stable order. |
| 6 | **Plan vs Actual May 2026** has duplicate plan rows (shift T/N/M) | `fact_plan_vs_actual_2026.estado_join` ∈ {matched, only_plan, only_actual}. |
| 7 | **`C.*` columns occasionally hold large ints** (e.g. 163, 803) | Use the `*_flag` boolean columns we engineered. |

---

## Next steps (the build, in priority order)

1. **OEE estimator** (Person A) — lookup + LightGBM blend over `fact_runs`. Feature list in spec.
2. **Sequence optimizer** (Person A) — OR-tools CP-SAT over candidate insertions of an urgent demand block.
3. **Claude tools schema** (Person C) — exposes `query_history`, `score_sequence`, `find_analogs`, `optimize_sequence`, `list_diagnostics`. Use the `fact_*` and `dim_*` tables — they're already shaped for it.
4. **Frontend** (Person B) — Three.js 3D + drag-and-drop schedule strip + Claude chat panel.
5. **Time Machine backtest** (Person C) — holdout last 13 weeks of 2025; quantify "what if Damm had followed LineWise" in OEE points & cans.

---

## Dependencies

```
duckdb >= 0.10
pandas >= 2.0
openpyxl >= 3.1
# for the HTML→PDF report:
google-chrome   (system; or use the bundled Chromium fallback in scripts/05_report.py)
```

`pip install -r requirements.txt` covers the Python ones.

---

## Contact / ownership

- **Repo:** github.com/david-vendrell/damm-hack
- **Challenge:** LineWise (Operations) — DAMM x Engineering HUB Hackathon
- **Lines:** 14, 17, 19 at El Prat factory
