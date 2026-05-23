"""
LineWise — Step 08: Evaluate the OEE quantile models on the holdout.

Diagnostics:
  - Pinball loss per α
  - Coverage of [p10, p90] band (target ≈ 80 %)
  - p90 exceedance rate (target ≈ 10 %)
  - MAE on p50
  - Baseline comparisons (naive-mean, theoretical-time-only proxy)
  - Per-line and per-marca slice MAE
  - SHAP top features for the p50 model

Output:
    reports/model_eval/metrics.json
    reports/model_eval/predictions_test.csv  (with p10/p50/p90 per row)
    reports/model_eval/shap_top_features.csv
    reports/model_eval/model_card.md
"""

from __future__ import annotations

import json
import pickle
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
TRAIN = ROOT / "parquet" / "train.parquet"
TEST  = ROOT / "parquet" / "test.parquet"
MODELS = ROOT / "models"
OUT = ROOT / "reports" / "model_eval"
OUT.mkdir(parents=True, exist_ok=True)


def load_models() -> dict[float, lgb.LGBMRegressor]:
    out = {}
    for alpha in (0.10, 0.50, 0.90):
        tag = f"p{int(alpha * 100):02d}"
        with open(MODELS / f"lgb_oee_{tag}.pkl", "rb") as f:
            out[alpha] = pickle.load(f)
    return out


def prepare_features(df: pd.DataFrame, feature_cols: list[str], cat_cols: list[str]) -> pd.DataFrame:
    X = df[feature_cols].copy()
    for c in feature_cols:
        if X[c].dtype == "bool" or X[c].dtype.name == "boolean":
            X[c] = X[c].astype("Int8")
        elif c in cat_cols:
            X[c] = X[c].astype("category")
        else:
            X[c] = pd.to_numeric(X[c], errors="coerce")
    return X


def pinball_loss(y_true: np.ndarray, y_pred: np.ndarray, alpha: float) -> float:
    e = y_true - y_pred
    return float(np.mean(np.maximum(alpha * e, (alpha - 1) * e)))


def main() -> None:
    schema = json.loads((MODELS / "feature_columns.json").read_text())
    feat = schema["feature_columns"]
    cats = schema["categorical_columns"]

    train = pd.read_parquet(TRAIN)
    test  = pd.read_parquet(TEST)
    y_true = test["oee"].clip(0.01, 1.0).astype(float).to_numpy()
    print(f"==> train={len(train)} test={len(test)} cols={len(feat)}")

    models = load_models()
    X_test = prepare_features(test, feat, cats)

    preds = {}
    for alpha, m in models.items():
        preds[alpha] = np.clip(m.predict(X_test), 0.0, 1.0)

    # ============================================================ Metrics
    metrics: dict = {}

    # Pinball per alpha
    for alpha in (0.10, 0.50, 0.90):
        metrics[f"pinball_loss_alpha_{int(alpha*100):02d}"] = pinball_loss(y_true, preds[alpha], alpha)

    # MAE p50
    metrics["mae_p50"] = float(np.mean(np.abs(y_true - preds[0.50])))

    # Coverage [p10, p90]
    covered = (y_true >= preds[0.10]) & (y_true <= preds[0.90])
    metrics["coverage_p10_p90"] = float(covered.mean())

    # p90 exceedance
    metrics["p90_exceedance"] = float((y_true > preds[0.90]).mean())
    metrics["p10_undershoot"] = float((y_true < preds[0.10]).mean())

    # ============================================================ Baselines
    # naive-mean baseline (train mean)
    train_mean = float(train["oee"].clip(0, 1).mean())
    metrics["baseline_naive_mean_value"] = train_mean
    metrics["baseline_naive_mean_mae"]  = float(np.mean(np.abs(y_true - train_mean)))

    # theoretical-time-only baseline: predict OEE from (linea, prev_estado_volumen, estado_volumen)
    # by looking up the global mean OEE per (linea, prev_estado_volumen, estado_volumen) in train,
    # falling back to train_mean. This proxies "use only theoretical setup info".
    pivot = train.groupby(["linea", "prev_estado_volumen", "estado_volumen"], dropna=False)["oee"].mean()
    test_keys = list(zip(test["linea"], test["prev_estado_volumen"], test["estado_volumen"]))
    theo_pred = np.array([pivot.get(k, train_mean) for k in test_keys])
    metrics["baseline_theoretical_only_mae"] = float(np.mean(np.abs(y_true - theo_pred)))

    # ============================================================ Slice MAE
    test["__y_pred_p50"] = preds[0.50]
    test["__abs_err"] = np.abs(y_true - preds[0.50])
    slice_linea = test.groupby("linea")["__abs_err"].mean().to_dict()
    slice_marca = (
        test.groupby("marca")["__abs_err"]
            .agg(["mean", "count"])
            .query("count >= 8")
            .sort_values("mean")
    )
    metrics["mae_by_linea"] = {int(k): float(v) for k, v in slice_linea.items() if k == k}

    # ============================================================ SHAP
    # Use built-in LightGBM 'pred_contrib' for speed
    p50_model = models[0.50]
    shap_vals = p50_model.predict(X_test, pred_contrib=True)
    # Last column is the bias; preceding columns map to feature contributions
    shap_arr = shap_vals[:, :-1]
    abs_mean = np.abs(shap_arr).mean(axis=0)
    shap_df = pd.DataFrame({"feature": feat, "mean_abs_shap": abs_mean}).sort_values("mean_abs_shap", ascending=False)
    shap_df.head(40).to_csv(OUT / "shap_top_features.csv", index=False)
    metrics["shap_top_10"] = shap_df.head(10)["feature"].tolist()

    # ============================================================ Print
    print("\n" + "=" * 60)
    print("HOLDOUT METRICS (test = 2025-10-01 → 2025-12-31)")
    print("=" * 60)
    for k, v in metrics.items():
        if isinstance(v, float):
            print(f"  {k:38s} {v:.4f}")
        elif isinstance(v, (list, dict)) and len(str(v)) < 200:
            print(f"  {k:38s} {v}")
    print("\nMAE breakdown")
    print(f"  Model p50 MAE                          {metrics['mae_p50']:.4f}")
    print(f"  Naive-mean baseline                    {metrics['baseline_naive_mean_mae']:.4f}")
    print(f"  Theoretical-only baseline              {metrics['baseline_theoretical_only_mae']:.4f}")
    improvement_naive = (1 - metrics['mae_p50'] / metrics['baseline_naive_mean_mae']) * 100
    improvement_theo  = (1 - metrics['mae_p50'] / metrics['baseline_theoretical_only_mae']) * 100
    print(f"  → Improvement vs naive    : {improvement_naive:+.1f}%")
    print(f"  → Improvement vs theo-only: {improvement_theo:+.1f}%")
    print()
    print("Per-line MAE")
    for k, v in metrics["mae_by_linea"].items():
        print(f"  L{k}: MAE = {v:.4f}")
    print()
    print("Top 10 SHAP features for p50 model:")
    for i, f in enumerate(metrics["shap_top_10"], 1):
        print(f"  {i:2d}. {f}")
    print()
    print("Marca slice (≥8 OFs in test):")
    print(slice_marca.head(15).round(4).to_string())

    # ============================================================ Save
    (OUT / "metrics.json").write_text(json.dumps(metrics, indent=2, ensure_ascii=False))
    pred_df = test[["of", "linea", "fecha", "sku", "marca", "oee"]].copy()
    pred_df["p10"] = preds[0.10]
    pred_df["p50"] = preds[0.50]
    pred_df["p90"] = preds[0.90]
    pred_df["abs_err_p50"] = np.abs(pred_df["oee"] - pred_df["p50"])
    pred_df["in_band"] = (pred_df["oee"] >= pred_df["p10"]) & (pred_df["oee"] <= pred_df["p90"])
    pred_df.to_csv(OUT / "predictions_test.csv", index=False)

    # ============================================================ Model card
    model_card = f"""# LineWise OEE Quantile Model — Model Card

**Algorithm:** LightGBM Quantile Regressor × 3 (α = 0.10 / 0.50 / 0.90)
**Target:** `oee` (OEE per Production Order, clipped to [0.01, 1.0])
**Training window:** 2025-01-02 → 2025-09-30 (1,670 OFs)
**Holdout window:** 2025-10-01 → 2025-12-31 (471 OFs)
**Features:** {len(feat)} ({len(cats)} categorical, {len(feat)-len(cats)} numeric/bool)

## Holdout metrics

| Metric | Value | Target |
|---|---:|---|
| Pinball loss α=0.10 | {metrics['pinball_loss_alpha_10']:.4f} | lower better |
| Pinball loss α=0.50 | {metrics['pinball_loss_alpha_50']:.4f} | lower better |
| Pinball loss α=0.90 | {metrics['pinball_loss_alpha_90']:.4f} | lower better |
| MAE on p50 | {metrics['mae_p50']:.4f} | < 0.12 |
| Coverage of [p10, p90] band | {metrics['coverage_p10_p90']*100:.1f}% | ≈ 80% |
| p90 exceedance rate | {metrics['p90_exceedance']*100:.1f}% | ≈ 10% |
| p10 undershoot rate | {metrics['p10_undershoot']*100:.1f}% | ≈ 10% |

## Baseline comparison

| Predictor | MAE | vs model |
|---|---:|---:|
| **LineWise p50** | **{metrics['mae_p50']:.4f}** | — |
| Naive-mean baseline | {metrics['baseline_naive_mean_mae']:.4f} | {improvement_naive:+.1f}% |
| Theoretical-time-only baseline | {metrics['baseline_theoretical_only_mae']:.4f} | {improvement_theo:+.1f}% |

## Top SHAP features (p50 model)

{chr(10).join(f"{i+1}. `{f}`" for i, f in enumerate(metrics['shap_top_10']))}

## Per-line MAE

{chr(10).join(f"- **L{k}**: MAE = {v:.4f}" for k, v in metrics['mae_by_linea'].items())}

## Known limitations

- Date-only granularity (no hour-of-day) → `turno` available only at inference from Planificado uploads, not in training.
- Sparse pair transitions: many (línea, prev_sku, sku) triples have n=1 historically. Model down-weights via SHAP.
- 84 LIMPIEZA WOs (63 %) lack `horas_total` → imputed to 0 in maintenance proximity features.
- Only 15 / 170 SKUs are cross-line capable — most assignments are physical-locked.
"""
    (OUT / "model_card.md").write_text(model_card)
    print(f"\n==> Outputs:\n    {OUT}/metrics.json\n    {OUT}/predictions_test.csv\n    {OUT}/shap_top_features.csv\n    {OUT}/model_card.md")


if __name__ == "__main__":
    main()
