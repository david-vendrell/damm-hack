# LineWise · Damm × Engineering HUB Hackathon

> Predict the real OEE of a planned production week, and rearrange it to lift the ceiling.

LineWise is an internal planning aid for the canning lines **L14**, **L17** and **L19** at Damm's El Prat factory. Blue Yonder tells the planner what the schedule should look like. LineWise tells the planner what reality will actually deliver, and how to rearrange the week to do better.

---

## The problem

- Damm plans production with Blue Yonder / JDA, which uses **theoretical** changeover times.
- Reality diverges: format changes, maintenance windows, micro-stops, SKU mix, warm-up after CIP.
- Over 2,141 production OFs in 2025, mean OEE was ~**49 %** with a historical p90 ceiling of ~**68 %**.
- That is a ~**14 point controllable gap** that nobody is harvesting systematically. Each OEE point on these lines is millions of cans per year.

## Our solution

LineWise is built around four moves:

1. **Predict.** A LightGBM quantile model (p10 / p50 / p90) scores every planned block using ~70 features (SKU identity, previous OF, packaging hierarchy, recent line history, maintenance proximity, calendar). MAE on p50 is 0.103 on a Q4 2025 holdout.
2. **Validate.** Planners upload a `Planificado producciones` or `Diario Hl_Planif` Excel and get a per-OF verdict (Procede / Revisar / Evitar) with the top SHAP drivers behind it.
3. **Optimize.** A constraint-aware solver reassigns blocks across (línea, día, turno) respecting deadlines, line-format compatibility, HL invariance, and a quality gate (≥ 3 historical runs per SKU × línea). Two objectives: expected p50 or aggressive p90.
4. **Explain.** Every recommendation ships with a reason: drivers per block, swap log per move. No LLM in the prediction or optimization paths.

The planner-facing surface is a Next.js dashboard with four routes: **Observabilidad** (historic 2025 performance), **Validar plan** (upload + verdicts), **Post mortem** (root-cause), **Urgencias** (reactive replan). Stack: Next.js 14 (App Router) + Tailwind + Prisma/SQLite for editable objects + DuckDB for the analytics layer + LightGBM for the model.

---

## Quick start

One command, on a fresh clone:

```bash
git clone https://github.com/david-vendrell/damm-hack.git
cd damm-hack
./start.sh
```

`start.sh` is idempotent. It will:

1. Verify Node 18+ and npm.
2. Confirm the five required Excels are present in `Repte operacions/`.
3. Install `web/` dependencies if `node_modules` is missing.
4. Apply Prisma migrations to `web/prisma/dev.db`.
5. Build `db/linewise.duckdb` from the Excels (only if missing).
6. Launch Prisma Studio on `http://localhost:5555` and the Next dev server on `http://localhost:3000`.

Then open the dashboard at **http://localhost:3000/observabilidad**.

Useful flags:

```bash
./start.sh --setup-only      # prepare everything, do not launch any server
./start.sh --no-studio       # skip Prisma Studio, just the dev server
./start.sh --rebuild-duck    # force-rebuild db/linewise.duckdb from the Excels
./start.sh --help            # full usage
```

### One-time prerequisites

- **Node 18+** and **npm**.
- **Python 3** with `duckdb`, `pandas`, `openpyxl` (only needed the first time, to build `db/linewise.duckdb`). Quick setup:
  ```bash
  python3 -m venv .venv && source .venv/bin/activate
  pip install duckdb pandas openpyxl
  ```
- macOS only, and only if you intend to retrain the model: `brew install libomp` (LightGBM dependency). Not needed to run the dashboard.

---

## What lives where

```
damm-hack/
├── start.sh                     one-shot setup + launch (entry point)
├── web/                         Next.js dashboard (Observabilidad, Validar, Post mortem, Urgencias)
├── db/linewise.duckdb           analytics DB consumed by the dashboard (~6 MB)
├── Repte operacions/            raw Damm Excels (source of truth)
├── scripts/                     Python pipeline: Excel → DuckDB → model → lookups
├── engine/                      inference modules (parser, features, predict, optimizer)
├── app.py                       Gradio model demo (separate from the web app)
├── models/, lookups/, parquet/  trained models, runtime lookups, table exports
├── reports/                     analytics CSVs, model eval, backtest, PDF report
├── HANDOFF.md                   deep technical handoff (read this for the full story)
└── PRODUCT.md                   product intent, users, voice
```

---

## Assumptions

- The Excels in `Repte operacions/` are the canonical inputs. Sheet names and headers match the originals delivered by Damm (May 2026 snapshot). If Damm reshapes a file, the ingestion scripts need a small update.
- Line × format compatibility is a hard constraint, codified from Damm's verbal confirmation on 2026-05-23: **L14 = {1/3, 1/2}**, **L17 = {1/3}**, **L19 = {1/3, 1/2, 2/5}**.
- `Fecha Fin` is the only date granularity available in OEE history (no hour of day). Intra-shift effects only land when uploads include a `turno` column.
- The OEE formula and `horas_cambio = PAR_TOT − (PNP + LIMPIEZA + IDLE)` follow Damm's own data-model diagram (also stored in `_meta_formulas`). `IDLE` does **not** affect OEE.
- Cross-line moves are limited to (SKU × línea) pairs with ≥ 3 historical runs. Physical feasibility is inferred from history, not asserted by Damm.
- The model was trained on 2025 only. Cold-start SKUs new in May 2026 fall back to family-level priors (`familia_line_oee_p50`).

## Limitations

- Confidence band coverage of `[p10, p90]` is **67 %** on the holdout, vs an 80 % target. The band is narrower than ideal.
- MAE improvement over a naive-mean baseline is **+20 %** on p50, vs a ≥ 30 % stretch target.
- The optimizer's typical lift on already-decent plans is modest (**~+0.4 OEE pts**). Most historical plans are already close to the ceiling. The diagnostic value (validate-this-plan / find-improvements / diagnose-not-schedulable) matters more than the delta.
- Block splitting is not supported. Each OF is atomic and assigned to a single slot.
- The worst prediction errors come from mid-shift incidents (breakdowns, quality events) that no sequencing-aware model can foresee from planning data alone.
- The Hugging Face demo Space is private (the hackathon org is shared with competitors). Flip to public only during a live demo.

## Next steps

1. Block splitting in the optimizer (V3) so large OFs can span multiple (línea, día, turno) slots.
2. Optuna hyperparameter search plus recalibrated quantile alphas (0.05 / 0.95) to widen the `[p10, p90]` band to its 80 % target.
3. OR-tools CP-SAT formulation for global optimization (the current solver is greedy with tabu).
4. Multi-week optimization. Today the horizon is a single week.
5. Downloadable optimized Excel in Damm's original `Planificado producciones` format, so the planner can push it straight back into Blue Yonder.
6. Real-time integration with Damm MES: pull plans directly, push recommendations back. Ingest 2024 and 2023 history if Damm shares it, to lift the training set.

---

## Where to go next

- [`HANDOFF.md`](HANDOFF.md) — full technical handoff: architecture, schemas, model card, optimizer internals, metrics.
- [`PRODUCT.md`](PRODUCT.md) — product intent, users, tone, anti-references.
- [`web/README.md`](web/README.md) — frontend details, ingest pipeline, API contract.
- [`docs/IO_SCHEMA.md`](docs/IO_SCHEMA.md) — engine / UI / tool input-output contract.
- [`reports/LineWise_Data_Report.pdf`](reports/LineWise_Data_Report.pdf) — polished data analysis report.

**Lines:** 14, 17, 19 at El Prat. **Challenge:** LineWise (Operations), DAMM × Engineering HUB Hackathon, May 2026.
