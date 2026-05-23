# LineWise — Technical Handoff

> **Damm × Engineering HUB Hackathon · Operations Challenge**
> Intelligent line sequencing & OEE optimization for canning lines 14, 17, 19 at El Prat.
>
> Repo: https://github.com/david-vendrell/damm-hack
> HF Space: https://huggingface.co/spaces/marcaguilar/linewise-demo (private)

This document is a complete onboarding for someone picking up the project cold. It covers what was built, why, how it works, and how to extend it. No prior context with the team or the codebase is assumed.

---

## 0. Two-minute summary

1. **Damm planners** schedule production with Blue Yonder / JDA which uses *theoretical* changeover times. Reality on the floor diverges (maintenance, format changes, micro-stops).
2. We built a system that **(a) predicts the OEE** a planned arrangement will actually deliver, with a confidence band, and **(b) proposes a better arrangement** within hard constraints (deadlines, line-format compatibility).
3. The system is a **single Hugging Face Space** the planner uploads weekly Excel files to. It auto-detects the format (`Planificado producciones` OR `Diario Hl_Planif`), runs a LightGBM quantile model trained on 2025 history, and surfaces per-block predictions + per-line aggregates + a recommended reassignment.
4. Everything is **deterministic and explainable** — no LLM in the prediction or optimization paths. The model returns SHAP drivers per prediction; the optimizer returns a per-move swap log with reasons.

---

## 1. High-level architecture

```
                                ┌────────────────────────────┐
                                │  Damm raw Excels (2025)    │
                                │  OEE · Cambios · Tiempo ·  │
                                │  Mantenimiento · Volumen · │
                                │  Planificado · Diario Hl   │
                                │  · Tabla CF Prat           │
                                └─────────────┬──────────────┘
                                              │ scripts/01_ingest.py
                                              ▼
                                ┌────────────────────────────┐
                                │  db/linewise.duckdb         │
                                │  10 raw_*  + 8 fact/dim    │
                                │  + _meta_*  +  Parquet     │
                                └─────────────┬──────────────┘
                                              │ scripts/06..09
                                              ▼
                                ┌────────────────────────────┐
                                │  models/  +  lookups/      │
                                │  3 LightGBM quantile pkls  │
                                │  9 Parquet reference files │
                                └─────────────┬──────────────┘
                                              │ engine/predict_oee.py
                                              │ engine/optimizer.py
                                              │ engine/optimizer_v2.py
                                              ▼
                ┌──────────────────────────────────────────────────────┐
                │  HF Space — app.py (Gradio)                          │
                │  · Upload .xlsx  →  parse + predict + (optionally)   │
                │    optimize                                          │
                │  · Two endpoints: /predict  and  /optimize_v2        │
                └──────────────────────────────────────────────────────┘
```

There are five layers, each independently testable:

| Layer | What | Lives in |
|---|---|---|
| **L1 — Raw ingestion** | Excel → DuckDB raw_* tables (lossless) | `scripts/01_ingest.py`, `scripts/02_parse_cf_matrix.py` |
| **L2 — Canonical model** | Joined fact / dim tables, derived metrics | `scripts/03_derived_tables.py` |
| **L3 — Analytics** | 20 SQL queries that produced the pitch numbers | `scripts/04_analytics.py` |
| **L4 — ML** | Feature engineering, training, evaluation, lookup precomputation | `scripts/06-09`, `models/`, `lookups/` |
| **L5 — Inference** | Parser → feature build → model → optimizer → Gradio | `engine/*.py`, `app.py` |

---

## 2. Data — sources, schema, and key findings

### 2.1 Raw source Excels (delivered by Damm)

| File | Rows | Cols | Granularity | Content |
|---|---:|---:|---|---|
| `OEE 14_17_19_ 2025.xlsx` | 2,274 | 43 | per OF | OEE + Disp/Rend/Calidad/Ineficiencia + 40 cols of product metadata |
| `Cambios 14_17_19_ 2025.xlsx` | 2,181 | 22 | per OF | Changeover events: `C. PRINCIPAL` (type), 8 dimension flags |
| `Tiempo 14_17_19_ 2025.xlsx` | 2,278 | 33 | per OF × filler | Lost-time decomposition: CIP, baja velocidad, saturación, falta producto, esterilización, …  **Critical for OEE diagnosis.** |
| `Mantenimiento 14_17_19_ 2025.xlsx` | 2,276 | 23 | per OF + LIMPIEZA | Maintenance call counts, wait/intervention time, dedicated LIMPIEZA work orders |
| `Volumen 14_17_19_ 2025.xlsx` | 2,278 | 19 | per OF | UDS + HL produced |
| `Planificado - producciones 14 - 17 - 19.xlsx` | 78 | 17 | per (línea × sku × shift × date) | **The richer planning format** — has `Definición de turno`, `Secuencia`, `Hora ini.` |
| `Produccion_L14,17,19_18-22.xlsx` | 36 | 19 | per OF actual | Real production for May 18-22, 2026 (matches the plan above) |
| `data - 2026-05-18T181640.542.xlsx` | 2,276 | 43 | per OF | Additional OEE history (Sep–Oct 2025 onwards) |
| `Diario Hl_Planif.xlsx` | 44 | 98 | wide cross-tab | **Daily HL planning, May 18-24 2026.** Per (línea × sku) × per day × 11 metrics |
| `Tabla CF Prat 2026_14_17_19.xlsx` | 2 sheets | — | reference | **Theoretical changeover matrix** per línea (1/3 ↔ 1/2 ↔ 2/5 × Packaging × Bandeja × Paletizado) |

### 2.2 Damm's data model (extracted from their diagram)

| Concept | Formula | Where |
|---|---|---|
| OEE | `Disponibilidad × Rendimiento × Calidad` | `fact_runs.oee` |
| Disponibilidad | `T_funcionamiento / T_planificado` | `fact_runs.disponibilidad` |
| Rendimiento | `(T_ciclo_ideal × Producción) / T_funcionamiento` | `fact_runs.rendimiento` |
| Calidad | `Producción_buena / Producción_total` | implicit (= 1 − ineficiencia) |
| **Tiempo cambio (real)** | **`PAR_TOT − (PNP + LIMPIEZA + IDLE)`** | **`fact_runs.horas_cambio`** — derived |
| IDLE | **Does NOT affect OEE** | informational only |

The diagram identifies **`MES / OF`** as the central nexus — every fact table joins on the OF / WOID key.

### 2.3 Line × format compatibility (Damm verbal confirmation, 2026-05-23)

| Línea | Allowed formats |
|---|---|
| **L14** | 1/3 (33 cl), 1/2 (50 cl) |
| **L17** | 1/3 (33 cl) **only** |
| **L19** | 1/3, 1/2, 2/5 (44 cl) |

Encoded as `engine.parse_planning_excel.LINE_FORMAT_COMPAT` and `lookups/line_format_compat.parquet`. **Hard constraint** in the optimizer; any (sku, línea) with the SKU's `estado_volumen` outside the line's allowlist is REFUSED.

### 2.4 DuckDB layout — `db/linewise.duckdb` (~6 MB, single file, portable)

**Raw layer** (`raw_*`) — lossless 1:1 with source files. Original Excel headers normalised to snake_case ASCII. Every cell preserved.

```
raw_oee                       2,274 × 45
raw_cambios                   2,181 × 31
raw_tiempo                    2,278 × 35   ← lost-time decomposition
raw_mantenimiento             2,276 × 25
raw_volumen                   2,278 × 20
raw_plan_2026                    78 × 19
raw_plan_2026_v2                 78 × 18
raw_actual_2026                  36 × 20
raw_data_extra                2,276 × 45
raw_diario_hl_planif             44 × 100  ← wide cross-tab as-is
raw_diario_hl_planif_headers     98 × 3    ← sidecar of original headers
raw_cf_lata_barril               46 × 8
raw_cf_tiempos_adicionales       37 × 12
```

**Canonical layer** (`fact_*` / `dim_*`) — joined, cleaned, ready for analysis & ML. **This is what you query 95 % of the time.**

```
dim_line                              3     línea ⇄ supported formats
dim_sku                             170     SKU master + inferred estado_volumen
dim_theoretical_changeover_matrix    86     CF Prat long-form (línea, from, to, minutes)
fact_runs                         2,184     ★ per-OF canonical run, 52 cols
                                              includes horas_cambio (Damm formula)
fact_lost_time                   19,602     long: per-OF × 9 categories (in minutes)
fact_changeovers                  2,180     per (prev_of, of) on same línea
fact_limpieza                       133     standalone LIMPIEZA WOs
fact_plan_vs_actual_2026             91     May 2026 plan ⇄ actual
fact_diario_hl_planif               197     daily HL planning long-form
_meta_files                          13     which Excel populated which raw_ table
_meta_tables                         10     description of each derived table
_meta_formulas                        6     Damm formulas (OEE, horas_cambio, etc.)
_meta_relationships                  20     edges from Damm's data-model diagram
```

**Mirror in `parquet/`** — same fact/dim tables exported for Power BI / Excel / non-DuckDB users.

### 2.5 Key headline statistics (from `scripts/04_analytics.py`)

| Stat | Value |
|---|---:|
| Production OFs in 2025 (excl. LIMPIEZA, outliers) | 2,141 |
| Lines | L14, L17, L19 |
| Unique SKUs | 170 |
| Unique SKU pairs that have run on ≥2 lines | **only 15** (most SKUs are line-locked) |
| Mean OEE — L14 | **42.6 %** |
| Mean OEE — L17 | **53.1 %** |
| Mean OEE — L19 | **48.1 %** |
| Mean OEE — overall | **49.0 %** |
| Median OEE (overall) | 50.0 % |
| Historical p90 ceiling (HL-weighted, per-(línea,SKU) p90 averaged) | **67.8 %** |
| Controllable gap (actual → ceiling) | **+13.7 pts** |
| **Single biggest OEE killer**: volume size change (1/3 ↔ 1/2) | **−10.7 pts** |
| Other significant changes: producto / brand / CAP | −5 to −6 pts each |
| Chronic underperforming SKUs (≥10 runs, mean OEE) | DAMM LEMON 4-pack 23 %, FREE DAMM 4-pack 29 %, COMPLOT 30 % |

### 2.6 Data quality flags (documented; the pipeline handles them)

| # | Issue | Mitigation |
|---|---|---|
| 1 | OEE > 1.0 on ~12 rows (data noise) | Clipped to [0, 1]; flagged |
| 2 | H.Tot. > 100 h on 6 rows (max 21,065 h) | `fact_runs.outlier` boolean filters them |
| 3 | LIMPIEZA OFs have NaN OEE | Split into `fact_limpieza`; excluded from `fact_runs` |
| 4 | 137 OFs in OEE missing from Cambios | LEFT JOIN; dimension flags become NULL |
| 5 | `Nº` → `no_` column-name normalization | Handled in `slug()` |
| 6 | Some `C.*` cols contain large ints (163, 803) | Use the engineered `c_*_flag` booleans |
| 7 | Date granularity = `Fecha Fin` only (no hour) | Use `turno` from Planificado uploads instead |
| 8 | 84 / 133 LIMPIEZA WOs have NULL `horas_total` | Median imputation per línea; flagged |
| 9 | "TOTAL" string leaked through Diario Hl parser | Defensive regex `^[A-Z0-9]{4,10}$` |
| 10 | Diario Hl day-headers double-matched ("Programa Prod" vs "Artículos Programa Prod") | Anchored `re.match(r"^Programa Prod...")` |

---

## 3. Feature engineering — what the model sees

Per historical OF (one training row). **2,141 rows · ~70 features · target = `oee`.**

### 3.1 Six feature groups

**A — Plan parameters** *(historical source: `fact_runs`; inference: parsed Excel)*

| Column | Type | Notes |
|---|---|---|
| `linea` | cat | 14 / 17 / 19 |
| `sku` | cat | 170 values; LightGBM handles high cardinality natively |
| `fecha` | date | Derives day-of-week, month, ISO week |
| `turno` | cat | T / N / M (only from `Planificado` uploads; absent in `Diario Hl`) |
| `cntd_plan`, `cntd_jda`, `cntd_jda_minus_cntd_plan` | numeric | Planned vs JDA quantity + delta (replanning signal) |
| `secuencia` | numeric | Position within shift |

**B — SKU catalog** *(joined from `dim_sku`)*

| Column | Type | Notes |
|---|---|---|
| `marca`, `supramarca`, `familia`, `cerveza`, `cbr` | cat | Product hierarchy |
| `envase`, `tipo_envase` | cat | Container codes |
| **`estado_volumen`** | cat | **1/3, 1/2, 2/5 — highest-signal feature** |
| `packaging_primario`, `packaging_secundario`, `palet`, `tipo_palet` | cat | Packaging breakdown |
| `unidad_caja`, `unidades_packaging_primario`, `unidades_packaging_secundario` | numeric | Pack sizes |
| `retornable` | cat | Returnable flag |

**C — Context from the previous OF on the same línea** *(LAG)*

| Column | Type | Notes |
|---|---|---|
| `prev_sku`, `prev_marca`, `prev_familia`, `prev_cerveza`, `prev_cbr` | cat | Lagged identity |
| `prev_envase`, `prev_tipo_envase`, `prev_estado_volumen` | cat | Lagged packaging |
| `same_marca`, `same_familia`, …, `same_estado_volumen`, `same_packaging`, `same_palet` | bool | Continuity flags |
| **`cambio_tipo_principal`** | cat | Damm canonical change type: *Contenido, Pack. Primario, Pack. Secundario, Palet, Volumen Envase, Marca, CAP, Referencia, Bandeja* |
| `n_dimensiones_cambiadas` | numeric | Count of dimensions different from previous |
| **`teorico_cambio_min`** | numeric | Looked up from Tabla CF Prat matrix |
| `prev_oee` | numeric | The previous OF's actual OEE (warm-up signal) |
| `hours_since_same_format`, `hours_since_same_sku` | numeric | Recency |
| `first_of_day`, `no_predecessor` | bool | Boundary markers |

**D — Recent line history** *(time-filtered aggregates, strict `fecha < current_row.fecha`)*

| Column | Type | Notes |
|---|---|---|
| `sku_line_oee_p50_last_30d`, `sku_line_oee_p90_last_30d`, `sku_line_n_runs_last_30d` | numeric | Recent SKU performance on this line |
| `linea_oee_p50_last_7d`, `linea_oee_p50_last_30d` | numeric | Recent line baseline |
| `pair_transition_oee_p50`, `pair_transition_n` | numeric | History of (línea, prev_sku, sku) triple |
| `familia_line_oee_p50` | numeric | **Cold-start fallback** when SKU is new on a line |
| `sku_n_lineas_history` | numeric | 1 = line-locked, ≥2 = cross-line capable |

**E — Maintenance proximity** *(from `fact_limpieza`, `raw_mantenimiento`)*

| Column | Type | Notes |
|---|---|---|
| `mant_horas_dia` | numeric | Maintenance hours that day on the línea |
| `mant_flag_dia` | bool | Any maintenance event that day |
| `hours_to_next_scheduled_limpieza`, `hours_since_last_limpieza_on_line` | numeric | Continuous proximity |
| `is_first_run_after_limpieza` | bool | Warm-up flag (LIMPIEZA disrupts) |

**F — Calendar** *(derived from `fecha`)*

| Column | Type | Notes |
|---|---|---|
| `dia_semana` | numeric 1–7 | Mon=1 |
| `mes`, `week_iso` | numeric | — |
| `is_holiday_spain` | bool | `python-holidays` Spain calendar |

### 3.2 Target

| Variable | Source | Range | Pre-processing |
|---|---|---|---|
| `oee` | `fact_runs.oee` | [0, 1] | Clipped to [0.01, 1.0]; outlier rows excluded |

### 3.3 Anti-leakage rules

1. **All LAG and aggregate features** use only rows with `fecha_fin < current_row.fecha_fin` — strict time filter.
2. **No target-encoded features** computed over the full dataset.
3. **`prev_sku` at training** = actual previous OF execution. **At inference** = previous block in the proposed plan sequence.
4. **Maintenance proximity at inference** uses the maintenance schedule, never future executed maintenance.

### 3.4 Train / test split

- **Time-based** (mirrors how predictions are used): train < `2025-10-01`, test ≥ `2025-10-01`.
- **Train**: 1,670 rows (Jan–Sep 2025).
- **Test**: 471 rows (Oct–Dec 2025).
- **Inside training**: 5-fold time-aware CV + LightGBM early stopping on the last ~15 % as inner holdout.

---

## 4. The model

### 4.1 Algorithm

**LightGBM Quantile Regressor × 3** — one model per α ∈ {0.10, 0.50, 0.90}.

- α = 0.10 → `p10` (downside / bad-case scenario)
- α = 0.50 → `p50` (expected / median)
- α = 0.90 → `p90` (achievable ceiling / best-case)

Each model is independent. Pickled to `models/lgb_oee_p{10,50,90}.pkl`, ~370–540 KB each. Feature schema in `models/feature_columns.json`.

### 4.2 Why LightGBM (and not the alternatives)

| Considered | Verdict | Reason |
|---|---|---|
| **LightGBM quantile** | ✅ Pick | ~30 s training per model · handles 170-cardinality categoricals natively (no one-hot blowup) · NaN-safe · SHAP-explainable · no GPU needed |
| CatBoost | ⚠️ Maybe | Slightly better with high-cardinality categoricals; adds dependency. Marginal gain. |
| XGBoost | ❌ No | Quantile loss not native until v1.7+; slower on this shape. |
| Deep nets (TabNet, FT-Transformer) | ❌ No | Too little data (~1.7 k train rows); will overfit. |
| LSTM / Transformer time-series | ❌ No | Not a sequential prediction problem at the OF grain. |
| Custom LLM fine-tune | ❌ No | 1.7 k rows is 5–6 orders of magnitude below LLM training thresholds. |
| Reinforcement learning | ❌ No | Tempting for sequencing but won't converge in 24 h hackathon time. |

### 4.3 Hyperparameters

Starting point (no Bayesian / grid search performed — left as future work):

```python
lgb.LGBMRegressor(
    objective="quantile",
    alpha=ALPHA,                # 0.10, 0.50, 0.90
    num_leaves=31,
    min_data_in_leaf=20,
    learning_rate=0.05,
    n_estimators=1500,
    feature_fraction=0.85,
    bagging_fraction=0.85,
    bagging_freq=5,
    verbose=-1,
)
# Early stopping
fit(..., callbacks=[lgb.early_stopping(stopping_rounds=50, verbose=False)])
```

Categorical features passed as `category` dtype; LightGBM handles natively (`categorical_feature` parameter).

### 4.4 Training pipeline

```
scripts/06_build_training_dataset.py   →  parquet/train.parquet (1,670 × ~70)
                                          parquet/test.parquet  (471 × ~70)

scripts/07_train_oee_quantile.py       →  models/lgb_oee_p10.pkl
                                          models/lgb_oee_p50.pkl
                                          models/lgb_oee_p90.pkl
                                          models/feature_columns.json

scripts/08_evaluate_oee_quantile.py    →  reports/model_eval/
                                              metrics.json
                                              predictions_test.csv
                                              shap_top_features.csv
                                              model_card.md
```

### 4.5 Hyperparameter tuning — what was done & what's pending

**What was done:** sensible defaults, time-aware CV for early stopping, manual sanity inspection of training curves.

**What's pending (future work):**

- **Bayesian hyperparameter search** via Optuna over `num_leaves`, `min_data_in_leaf`, `learning_rate`, `feature_fraction`, `bagging_fraction`, regularization (`reg_alpha`, `reg_lambda`). Budget: ~50 trials per quantile, ~30 min wall-clock per quantile.
- **Joint multi-quantile training** via `LGBMRegressor` with monotonic constraints to ensure p10 ≤ p50 ≤ p90 by construction (currently can be violated in rare edge cases; clipping in `predict_oee.py` fixes after the fact).
- **Calibration**: the p90 band is narrower than ideal (66.7 % coverage vs 80 % target). Could widen quantile alphas (0.05 / 0.95) and re-calibrate empirically.

### 4.6 Holdout evaluation — 471 OFs (2025-10-01 → 2025-12-31)

| Metric | Value | Target |
|---|---:|---|
| Pinball loss α=0.10 | 0.0257 | lower better |
| Pinball loss α=0.50 | 0.0514 | lower better |
| Pinball loss α=0.90 | 0.0231 | lower better |
| **MAE on p50** | **0.103** | **< 0.12 ✓** |
| RMSE on p50 | 0.131 | — |
| Coverage of [p10, p90] band | 66.7 % | ≈ 80 % (narrow — known) |
| p90 exceedance rate | 17.4 % | ≈ 10 % (slightly under-estimated ceiling) |
| p10 undershoot rate | 15.9 % | ≈ 10 % (slightly over-estimated floor) |

### 4.7 Baseline comparisons

| Predictor | MAE on p50 | vs LineWise |
|---|---:|---:|
| **LineWise p50** | **0.103** | — |
| Naive mean | 0.128 | **+20 % improvement** |
| Theoretical-time-only (lookup by (línea, prev_estado, estado)) | 0.123 | **+16 % improvement** |

### 4.8 Per-line slice MAE

| Línea | n | Mean actual OEE | Mean predicted p50 | MAE |
|---|---:|---:|---:|---:|
| L14 | 114 | 0.437 | 0.426 | 0.091 |
| L17 | 195 | 0.546 | 0.515 | 0.107 |
| L19 | 162 | 0.465 | 0.462 | 0.106 |

→ No systematic bias per línea — mean predictions within 3 pts of mean actuals. The MAE is row-to-row variance, not a tilt.

### 4.9 Top SHAP features (p50 model)

1. `sku`
2. `prev_oee`
3. `sku_line_oee_p90_last_30d`
4. `familia`
5. `week_iso`
6. `linea_oee_p50_last_7d`
7. `familia_line_oee_p50`
8. `n_llamadas_mant`
9. `c_producto_flag`
10. `hours_since_same_sku`

The model relies most heavily on SKU identity, recent context, and family-level priors — exactly what's expected. Sequencing-controllable features (`prev_*`, `cambio_tipo_principal`, `c_*_flag`) appear but are not dominant — which directly explains why the optimizer's deltas are modest.

### 4.10 Honest limitations & residual error

- **Worst-prediction OFs in the holdout** are all incidents that no sequencing-aware model could foresee: mid-shift breakdowns (OEE 5 %), surprisingly good days (77 % on a typically-50 % SKU), total failures (OEE 0.1 %). These are **unobservable** factors (equipment, crew, materials) — accept and report.
- Coverage gap (67 % vs 80 % target) → V2 could widen quantile alphas.
- Most May 2026 SKUs are **new** (didn't run in 2025) → cold-start fallback via `familia_line_oee_p50`. Predictions vary less per-block; the optimizer has less to differentiate.

---

## 5. The optimizer

Two versions, both backend-callable; **V2 is what the HF Space's button drives**. V1 is kept as a backup / reference.

### 5.1 V1 — within-line 2-opt swap + cross-line move

**File**: `engine/optimizer.py` · **API**: `optimize_plan(blocks, ...)`

Treats the planner's `(línea, fecha, turno)` slots as fixed. Only reshuffles which block sits in which slot.

- **Within-line swap**: for each pair (i, j) on the same línea, swap the blocks at those slots.
- **Cross-line move**: for cross-line-capable SKUs (15 of 170), try moving to each compatible alternative line.
- **Precomputed lookup** for (block, alt_prev_sku) pairs → O(1) candidate scoring.
- **Tabu list** + min-improvement threshold to break cycles.
- **Safety guard**: if final < baseline, fall back.

Typical result: **+0.5 OEE pts** on a 132-block plan. Modest because the move space is small.

### 5.2 V2 — flexible scheduling (current production)

**File**: `engine/optimizer_v2.py` · **API**: `optimize_plan_v2(blocks, ..., objective="p50"|"p90")`

Reformulates the problem as a generalised assignment / scheduling problem:

```
Each OF (job) is a (sku, hl, deadline, feasible_lines) tuple.
Each (línea, fecha, turno) is a slot with implicit capacity.

Decision variables: assignment[job] = slot
Constraints:
  Hard:  slot.fecha ≤ job.deadline            (deadline integrity)
  Hard:  slot.línea ∈ LINE_FORMAT_COMPAT for job.estado_volumen
  Hard:  (sku, línea) has ≥3 historical runs    (quality gate)
  Hard:  capacity[slot] not exceeded            (rough capacity from history)
  Hard:  Σ hl per SKU preserved                 (no volume change)
Objective: maximise HL-weighted Σ predicted_OEE(job, slot)
       where the objective metric is p50 (expected) or p90 (ceiling)
```

#### Algorithm

1. **Phase A — Precompute** (`engine/precompute.py`):
   - For each (job, feasible slot) pair: predict OEE assuming no predecessor.
   - ~7,500 predictions for a 120-block plan → batched in one `predict_blocks` call (~10 s).
   - Lookup is **prev_sku blind** for speed; the model's prev_sku features are present but secondary in SHAP, so accuracy loss is bounded.
2. **Phase B — Baseline assignment** (`_baseline_assignment`):
   - Initial = the planner's original (línea, fecha, turno). The optimizer never starts from scratch — it can only **improve** the original.
3. **Phase C — Validated local search** (`_local_search`):
   - Propose candidate moves using the lookup as a fast HEURISTIC (rank by lookup-score delta).
   - For each accepted candidate, **validate against the FULL model** (build features, predict, compare to current full score).
   - Accept only if the *real* score strictly improves. Otherwise revert + tabu.
   - Iterate up to `max_iter` or `time_budget_sec`.
4. **Phase D — Safety guard**:
   - If the post-search score is somehow worse than baseline (lookup-mis-estimated edge case), revert to baseline. **Never makes plans worse.**
5. **Phase E — Audit**:
   - Run `engine/constraints.full_audit()` — verifies HL invariance, deadlines, format compat, capacity.
6. **Phase F — JSON-friendly output**:
   - `engine.optimizer_v2_result_to_json(result)` returns a serialisable dict for frontend / API consumption.

#### Modes

- **`p50` mode** (default): maximise the expected OEE.
- **`p90` mode** ("aggressive"): maximise the realistic ceiling. UI checkbox `Modo agresivo`.

#### Honest output on the three test plans

| Plan | Baseline p90 | Optimized p90 | Δ | Interpretation |
|---|---:|---:|---:|---|
| `Planificado producciones May 2026` (good plan) | 68.1 % | 68.1 % | **+0.00** | Already at historical ceiling — no room. |
| `Diario Hl_Planif` (mediocre plan) | 59.6 % | 60.0 % | **+0.42** | 7 cross-(línea×día×turno) reassignments. |
| `Planificado - DEMO bad week (W14 2025)` (real bad historical week) | 62.4 % | 62.5 % | **+0.01** | Schedule was fine; bad week was operational. |

→ The system **correctly differentiates** validate-this-is-good vs find-improvements vs diagnose-not-schedulable.

### 5.3 Constraints module (`engine/constraints.py`)

Pure-function validators used both during search and as a final audit:

| Function | Purpose |
|---|---|
| `deadline_ok(job, slot)` | `slot.fecha ≤ job.deadline` |
| `format_ok(job, slot)` | `job.estado_volumen ∈ LINE_FORMAT_COMPAT[slot.línea]` |
| `line_in_feasible_set(job, slot)` | `slot.línea ∈ job.feasible_lines` (historical) |
| `can_place(job, slot)` | All three above |
| `hl_invariance_ok(before, after)` | `sum(hl per sku)` strictly identical |
| `capacity_audit(assignment, slots)` | Returns over-capacity slots |
| `deadline_audit(assignment, jobs, slots)` | Returns deadline violations |
| `format_audit(assignment, jobs, slots)` | Returns format violations |
| `full_audit(...)` | Bundles all of the above |

Dataclasses `Job(job_id, sku, hl, deadline, estado_volumen, feasible_lines)` and `Slot(slot_id, línea, fecha, turno, capacity_blocks)` are the canonical data structures.

---

## 6. HF Space deployment (`app.py`)

### 6.1 Layout

Single private Space under the personal account `marcaguilar/linewise-demo`. Contains:

```
linewise-demo/                       (Gradio SDK, CPU-basic free hardware)
├── app.py                           ← Gradio UI + callbacks
├── requirements.txt                 ← gradio, pandas, lightgbm, scikit-learn, holidays, pyarrow, openpyxl, numpy
├── README.md                        ← Space card (YAML frontmatter)
├── engine/                          ← parse, build_features, predict, optimizer, optimizer_v2, etc.
├── models/                          ← 3 LightGBM pickles + feature_columns.json
└── lookups/                         ← 11 reference parquets (dim_sku, feasibility, recent aggregates, theoretical matrix, etc.)
```

Pushed via `scripts/10_push_to_hf_space.py` (uses `huggingface_hub.upload_folder`). Token read from `HF_TOKEN` env var; never committed.

### 6.2 UI elements

| Element | Behaviour |
|---|---|
| File upload (`.xlsx`) | Accepts Planificado producciones or Diario Hl_Planif (auto-detected) |
| Button: **Predecir OEE** | Calls `predict()` — per-block p10/p50/p90 + SHAP drivers + per-line summary |
| Button: **Optimizar plan** | Calls `optimize_v2()` |
| Checkbox: **Modo agresivo (perseguir el techo p90)** | Switches objective from p50 → p90 |
| Tab: **Predicciones por bloque** | Per-block table of predictions + feasibility reasons |
| Tab: **Drivers (SHAP)** | First 20 blocks × top 3 SHAP features each |
| Tab: **Alternativas recomendadas** | Optimizer summary + per-línea comparison + swap log |

### 6.3 API endpoints (consumable from any client)

```python
from gradio_client import Client, handle_file
c = Client("marcaguilar/linewise-demo", hf_token="hf_xxx")   # private; teammate token

# Prediction
summary_md, line_tbl, blocks_tbl, drivers_tbl = c.predict(
    file_obj=handle_file("week.xlsx"),
    api_name="/predict",
)

# Optimization (V2)
summary_md, line_tbl, swap_tbl = c.predict(
    file_obj=handle_file("week.xlsx"),
    aggressive=True,        # True → p90; False → p50
    api_name="/optimize_v2",
)
```

Each returns a JSON-friendly tuple (Markdown string + Pandas DataFrames serialised as `{headers, data}`).

### 6.4 Visibility

The Space is **private** (intentionally — hackathon org is shared with competitors). Flip to public from Settings → Visibility for the 10-minute live demo, back to private after.

---

## 7. Inference engine — file-by-file

| File | Purpose | Public functions |
|---|---|---|
| `engine/__init__.py` | Re-exports | All public APIs below |
| `engine/parse_planning_excel.py` | Auto-detect format + parse to plan blocks + feasibility check | `parse_planning_excel`, `detect_format`, `LINE_FORMAT_COMPAT`, `infer_estado_volumen_from_sku` |
| `engine/build_features.py` | Enrich blocks with Groups B-F using lookup parquets (no DuckDB at runtime) | `build_feature_rows` |
| `engine/predict_oee.py` | Load 3 quantile models, score a feature DataFrame, attach top SHAP | `predict_blocks`, `MIN_HISTORICAL_RUNS_FOR_FEASIBILITY` |
| `engine/optimizer.py` | V1 (within-line + cross-line, swap-based) | `optimize_plan`, `optimizer_result_to_json` |
| `engine/precompute.py` | V2's intrinsic (job × slot) lookup builder | `build_jobs_and_slots`, `precompute_intrinsic_scores` |
| `engine/constraints.py` | V2's dataclasses + validators | `Job`, `Slot`, `can_place`, `full_audit`, etc. |
| `engine/optimizer_v2.py` | V2 flexible-scheduling solver | `optimize_plan_v2`, `optimizer_v2_result_to_json` |

---

## 8. Scripts — pipeline reference

All scripts are **idempotent** — re-run any of them after upstream changes. Run from repo root.

| # | Script | Reads | Writes | Time |
|---|---|---|---|---|
| 01 | `scripts/01_ingest.py` | `Repte operacions/*.xlsx` | `db/linewise.duckdb` (raw_* tables) | ~10 s |
| 02 | `scripts/02_parse_cf_matrix.py` | `raw_cf_lata_barril` | `dim_theoretical_changeover_matrix` | <1 s |
| 03 | `scripts/03_derived_tables.py` | raw_* tables | fact_* + dim_* + _meta_* tables | ~3 s |
| 04 | `scripts/04_analytics.py` | fact_* tables | `reports/analytics/*.csv` (20 files) + `parquet/*.parquet` | ~5 s |
| 05 | `scripts/05_report.py` | analytics CSVs | `reports/LineWise_Data_Report.{html,pdf}` | ~3 s + Chrome conversion |
| 06 | `scripts/06_build_training_dataset.py` | fact_runs + dim_sku + dim_theoretical_changeover_matrix + fact_limpieza | `parquet/train.parquet`, `parquet/test.parquet` | ~30 s |
| 07 | `scripts/07_train_oee_quantile.py` | train.parquet | `models/lgb_oee_p{10,50,90}.pkl`, `feature_columns.json` | ~2 min |
| 08 | `scripts/08_evaluate_oee_quantile.py` | test.parquet + models | `reports/model_eval/{metrics.json, predictions_test.csv, shap_top_features.csv, model_card.md}` | ~10 s |
| 09 | `scripts/09_build_space_lookups.py` | fact_*/dim_* tables | `lookups/*.parquet` (11 files) | ~5 s |
| 10 | `scripts/10_push_to_hf_space.py` | app.py + engine/ + models/ + lookups/ + Space-specific requirements | HF Space remote | ~30 s (requires `HF_TOKEN`) |
| 11 | `scripts/11_backtest_for_pitch.py` | model_eval predictions | `reports/backtest/backtest_summary.json` + console summary | <5 s |
| 12 | `scripts/12_optimize_demo.py` | upload file + lookups + models | `reports/optimizer/<name>.json` | ~30 s |
| 13 | `scripts/13_optimize_v2_demo.py` | upload file + lookups + models | `reports/optimizer_v2/<name>__<obj>.json` | ~10-30 s |
| 14 | `scripts/14_build_bad_plan_demo.py` | DuckDB | `~/Downloads/Planificado - DEMO bad week.xlsx` | <1 s |

---

## 9. Repo layout summary

```
damm-hack/
├── HANDOFF.md                       ← THIS FILE (you are here)
├── README.md                        ← user-facing quick start
├── docs/IO_SCHEMA.md                ← Input / Output contract (frontend integration)
├── requirements.txt                 ← Python deps for the full pipeline
├── Repte operacions/                ← raw Damm Excels (source of truth)
├── scripts/                         ← 14 numbered scripts (above)
├── engine/                          ← Inference modules (used by the Space)
├── app.py                           ← Gradio UI (the Space's entry point)
├── db/linewise.duckdb               ← Portable database (~6 MB)
├── parquet/                         ← fact/dim tables + train/test parquet
├── models/                          ← Trained LightGBM models + schema
├── lookups/                         ← Precomputed runtime parquets for the Space
├── reports/
│   ├── analytics/                   ← 20 CSV outputs
│   ├── model_eval/                  ← metrics, predictions, SHAP, model_card.md
│   ├── backtest/                    ← Q4 2025 backtest summary
│   ├── optimizer/                   ← V1 demo outputs (JSON per file)
│   ├── optimizer_v2/                ← V2 demo outputs (JSON per file)
│   ├── LineWise_Data_Report.html    ← analytics report (17 sections)
│   └── LineWise_Data_Report.pdf     ← same, polished
├── web/                             ← Next.js front-end (teammate's, separate)
└── LineWise Operaciones ES.pdf      ← original challenge brief from Damm
```

---

## 10. Setup — how to reproduce from scratch on a fresh machine

```bash
# 0. Clone
git clone https://github.com/david-vendrell/damm-hack.git
cd damm-hack

# 1. Install Python deps
pip install -r requirements.txt

# 2. macOS only: LightGBM needs libomp
brew install libomp

# 3. Build the database + canonical tables + analytics report
python3 scripts/01_ingest.py
python3 scripts/02_parse_cf_matrix.py
python3 scripts/03_derived_tables.py
python3 scripts/04_analytics.py
python3 scripts/05_report.py

# 4. Train the OEE quantile model
python3 scripts/06_build_training_dataset.py
python3 scripts/07_train_oee_quantile.py
python3 scripts/08_evaluate_oee_quantile.py
python3 scripts/09_build_space_lookups.py
python3 scripts/11_backtest_for_pitch.py

# 5. Test the Gradio app locally
python3 app.py        # opens http://localhost:7860

# 6. Push the demo to the HF Space (requires HF_TOKEN)
export HF_TOKEN=hf_xxx
python3 scripts/10_push_to_hf_space.py
```

---

## 11. Querying the DuckDB

### Python
```python
import duckdb
con = duckdb.connect("db/linewise.duckdb", read_only=True)
df = con.execute("""
    SELECT linea, AVG(oee) AS oee_mean
    FROM fact_runs
    WHERE oee IS NOT NULL
    GROUP BY linea ORDER BY linea
""").fetchdf()
print(df)
```

### CLI
```bash
brew install duckdb            # one-time
duckdb db/linewise.duckdb
duckdb> SELECT * FROM _meta_tables;
duckdb> .quit
```

### GUI (DBeaver / TablePlus / DataGrip)
DBeaver has built-in DuckDB driver since v23. JDBC URL:
`jdbc:duckdb:/Users/you/path/to/db/linewise.duckdb`.

### Discovery helpers
```sql
SELECT * FROM _meta_files;          -- which Excel populated which raw_ table
SELECT * FROM _meta_tables;         -- description of every derived table
SELECT * FROM _meta_formulas;       -- Damm formulas (OEE, horas_cambio, IDLE no afecta)
SELECT * FROM _meta_relationships;  -- edges from Damm's data-model diagram
```

---

## 12. Known issues, limitations, and what to fix first

### 12.1 Model

| Issue | Severity | Suggested fix |
|---|---|---|
| Coverage of [p10, p90] band = 67 % vs 80 % target | medium | Widen quantile alphas from (0.10, 0.90) to (0.05, 0.95) and refit |
| MAE vs naive baseline improvement = 20 % (target ≥ 30 %) | low | Optuna hyperparameter search; more training data |
| Cold-start SKUs (new in May 2026 plan) get conservative defaults | medium | Better SKU embeddings (e.g. trained on packaging hierarchy); brand-prefix already helps |
| Worst predictions (~0.5 OEE error) are mid-shift incidents | unfixable with current data | Would need real-time sensor data / fault codes from Damm IT |

### 12.2 Optimizer

| Issue | Severity | Suggested fix |
|---|---|---|
| V2 improvements are modest (+0.4 OEE pts typical) | medium (pitch concern) | Most history plans are already near-optimal — true; communicate diagnostic value instead. Or implement block-splitting. |
| Optimizer is greedy/local; can get stuck | low | Simulated annealing or OR-tools CP-SAT for global optimization |
| Slot capacity is a heuristic from history | low | Get real per-shift capacities from Damm Ops |
| Block splitting not supported (one OF = atomic) | medium | Implement V3: allow splitting large OFs across multiple slots |
| Lookup is prev_sku-blind (intrinsic scoring) | low | Full prev_sku precomputation explodes to ~900K rows (12 h); current approach is the right speed-accuracy trade-off |

### 12.3 Data

| Issue | Severity | Suggested fix |
|---|---|---|
| `fact_runs` only has `Fecha Fin` (date, no hour) | medium | Get hour-of-day if Damm has it; would unlock shift-level OEE patterns |
| 84 of 133 LIMPIEZA WOs lack `horas_total` | low | Imputed; flag |
| ~12 rows with OEE > 1.0 | trivial | Clipped |
| Most cross-line moves blocked by historical feasibility | medium | If Damm validates new (sku, línea) pairs are physically possible, relax the ≥3 historical runs check |

### 12.4 Deployment

| Issue | Severity | Suggested fix |
|---|---|---|
| HF Space is private (hackathon org public to competitors) | by design | Flip to public for the 10-min live demo |
| Gradio "Dataframe" component shows render flicker on first load | cosmetic | Add `gr.Progress` (done in `optimize_v2`); could add a loading skeleton |
| Optimizer can take up to 75 s on the Space | acceptable | Increase Space hardware tier if Damm wants faster turnaround |

---

## 13. The pitch story (compressed)

### The problem
Damm plans canning-line production with **theoretical** changeover times. Real OEE depends on contextual factors the planner can't see — previous SKU, maintenance proximity, shift mix. The same (línea, SKU) achieves 36–80 % OEE; nobody systematically biases each new plan toward the high end.

### The data
2,141 production OFs in 2025 across L14/L17/L19. Median OEE = 50 %. **Best-day p90 ceiling = 67.8 % HL-weighted.** The 13.7 pt gap is the prize.

### The system
- **Model**: LightGBM quantile (p10/p50/p90) predicts per-block OEE with confidence band. MAE 0.103, beats naive baselines by 20 %.
- **Optimizer**: Reassigns each OF to the best feasible (línea, día, turno) respecting deadlines, volumes, and Damm's line-format compatibility.
- **Deployment**: Single HF Space accepts both Damm-native Excel formats.

### The honest result
On already-optimised plans (e.g. May 2026 Planificado), the optimizer confirms +0.00 pts — *"your planner did it right."* On mediocre plans (Diario Hl), it finds +0.4 pts of cross-línea moves. On real bad historical weeks, it correctly diagnoses that bad OEE was operational, not schedulable.

**The product value is fast, defensible, evidence-backed plan validation** — not magic gains. The system tells you when to ship the plan as-is and when to rearrange it; both answers are valuable.

---

## 14. Future work / extensions (in priority order)

1. **Block splitting** for V2 — allow large OFs to span multiple (línea, día, turno) slots.
2. **Optuna hyperparameter tuning** for the LightGBM quantile models.
3. **Recalibrate quantile alphas** (widen to 0.05/0.95) → fix band coverage.
4. **OR-tools CP-SAT formulation** for global optimization → bigger gains than greedy.
5. **Multi-week optimization** — current is single-week.
6. **Downloadable optimized Excel** in Damm's original Planificado format.
7. **Real-time integration with Damm MES** — pull plans directly, push recommendations back.
8. **More training data** — 2024 + 2023 if Damm shares it. Doubles training set → expect +2-3 MAE pts.
9. **Claude / LLM narrator** — natural-language explanations of recommendations (was scoped, deferred as optional).
10. **OR-tools / RL** for sequencing within slots.

---

## 15. Contact / ownership

- **Repo owner**: David Vendrell (github.com/david-vendrell)
- **HF Space owner**: @marcaguilar (private; flip to public during demo only)
- **Challenge**: LineWise (Operations) — DAMM x Engineering HUB Hackathon, May 2026
- **Lines**: 14, 17, 19 at El Prat factory

For any question on this document: read first, then ask. The code is structured to be self-documenting (every script and module has a module-level docstring explaining what it does and why).
