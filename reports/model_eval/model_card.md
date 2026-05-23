# LineWise OEE Quantile Model — Model Card

**Algorithm:** LightGBM Quantile Regressor × 3 (α = 0.10 / 0.50 / 0.90)
**Target:** `oee` (OEE per Production Order, clipped to [0.01, 1.0])
**Training window:** 2025-01-02 → 2025-09-30 (1,670 OFs)
**Holdout window:** 2025-10-01 → 2025-12-31 (471 OFs)
**Features:** 72 (24 categorical, 48 numeric/bool)

## Holdout metrics

| Metric | Value | Target |
|---|---:|---|
| Pinball loss α=0.10 | 0.0257 | lower better |
| Pinball loss α=0.50 | 0.0514 | lower better |
| Pinball loss α=0.90 | 0.0231 | lower better |
| MAE on p50 | 0.1027 | < 0.12 |
| Coverage of [p10, p90] band | 66.7% | ≈ 80% |
| p90 exceedance rate | 17.4% | ≈ 10% |
| p10 undershoot rate | 15.9% | ≈ 10% |

## Baseline comparison

| Predictor | MAE | vs model |
|---|---:|---:|
| **LineWise p50** | **0.1027** | — |
| Naive-mean baseline | 0.1284 | +20.0% |
| Theoretical-time-only baseline | 0.1229 | +16.4% |

## Top SHAP features (p50 model)

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

## Per-line MAE

- **L14**: MAE = 0.0909
- **L17**: MAE = 0.1072
- **L19**: MAE = 0.1056

## Known limitations

- Date-only granularity (no hour-of-day) → `turno` available only at inference from Planificado uploads, not in training.
- Sparse pair transitions: many (línea, prev_sku, sku) triples have n=1 historically. Model down-weights via SHAP.
- 84 LIMPIEZA WOs (63 %) lack `horas_total` → imputed to 0 in maintenance proximity features.
- Only 15 / 170 SKUs are cross-line capable — most assignments are physical-locked.
