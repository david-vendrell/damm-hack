"""Inference function. Loads the 3 LightGBM quantile models on import and
turns enriched feature rows into per-block predictions with SHAP top features.
"""

from __future__ import annotations

import json
import pickle
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

MIN_HISTORICAL_RUNS_FOR_FEASIBILITY = 3


@lru_cache(maxsize=1)
def _load_artifacts(models_dir: str) -> dict:
    d = Path(models_dir)
    schema = json.loads((d / "feature_columns.json").read_text())
    models = {}
    for alpha in schema["alphas"]:
        tag = f"p{int(alpha * 100):02d}"
        with open(d / f"lgb_oee_{tag}.pkl", "rb") as f:
            models[alpha] = pickle.load(f)
    return {"schema": schema, "models": models}


def _prepare_features(df: pd.DataFrame, feature_cols: list[str], cat_cols: list[str]) -> pd.DataFrame:
    X = pd.DataFrame(index=df.index)
    for c in feature_cols:
        if c in df.columns:
            v = df[c]
        else:
            v = pd.Series([np.nan] * len(df), index=df.index)
        if v.dtype == "bool" or v.dtype.name == "boolean":
            X[c] = v.astype("Int8")
        elif c in cat_cols:
            X[c] = v.astype("category")
        else:
            X[c] = pd.to_numeric(v, errors="coerce")
    return X


def predict_blocks(
    feature_df: pd.DataFrame,
    models_dir: str | Path = "models",
    top_k_shap: int = 3,
) -> pd.DataFrame:
    """Return a DataFrame with columns added:
        p10, p50, p90  — clipped to [0, 1]
        top_features   — list[dict{name, shap}] of top |SHAP| features for p50
        confidence     — 'high' | 'medium' | 'low' based on sku_line_n_runs
    """
    if feature_df.empty:
        return feature_df.assign(p10=[], p50=[], p90=[], top_features=[], confidence=[])

    artifacts = _load_artifacts(str(models_dir))
    schema = artifacts["schema"]
    models = artifacts["models"]
    feat = schema["feature_columns"]
    cats = schema["categorical_columns"]

    X = _prepare_features(feature_df, feat, cats)

    out = feature_df.copy()
    for alpha in (0.10, 0.50, 0.90):
        tag = f"p{int(alpha * 100):02d}"
        out[tag] = np.clip(models[alpha].predict(X), 0.0, 1.0)

    # ============================================================ SHAP per row
    p50 = models[0.50]
    shap_vals = p50.predict(X, pred_contrib=True)  # (n_rows, n_features+1)
    shap_arr = shap_vals[:, :-1]
    top_records: list[list[dict]] = []
    for i in range(len(out)):
        order = np.argsort(-np.abs(shap_arr[i]))[:top_k_shap]
        top_records.append([
            {"name": feat[j], "shap": float(shap_arr[i, j])}
            for j in order
        ])
    out["top_features"] = top_records

    # ============================================================ confidence
    def _conf(n):
        if pd.isna(n):
            return "low"
        n = float(n)
        if n >= 10:
            return "high"
        if n >= 3:
            return "medium"
        return "low"

    n_runs_col = out.get("sku_line_n_runs_last_30d", pd.Series([np.nan] * len(out)))
    out["confidence"] = n_runs_col.map(_conf)

    # carry inference source if present
    if "source" not in out.columns and "inference_source" not in out.columns:
        out["inference_source"] = "unknown"
    elif "source" in out.columns:
        out["inference_source"] = out["source"]

    return out
