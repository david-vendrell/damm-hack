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
    """Load all (label × alpha) LightGBM models named `lgb_{label}_p{NN}.pkl`.

    Backwards-compatible: pre-Gap-1 model dirs only have `lgb_oee_pNN.pkl`
    files; we fall back to loading those alone and synthesise a single-label
    schema if `labels` is absent from feature_columns.json.
    """
    d = Path(models_dir)
    schema = json.loads((d / "feature_columns.json").read_text())
    labels = schema.get("labels") or [schema.get("target", "oee")]
    models: dict[tuple[str, float], object] = {}
    for label in labels:
        for alpha in schema["alphas"]:
            tag = f"p{int(alpha * 100):02d}"
            path = d / f"lgb_{label}_{tag}.pkl"
            if not path.exists():
                # Pre-Gap-1 backwards compat: 'lgb_oee_pNN.pkl' was the only file.
                if label == "oee":
                    path = d / f"lgb_oee_{tag}.pkl"
                if not path.exists():
                    raise FileNotFoundError(f"Missing model file: {path}")
            with open(path, "rb") as f:
                models[(label, alpha)] = pickle.load(f)
    return {"schema": schema, "models": models, "labels": labels}


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
    """Return a DataFrame with one column per (label × quantile) prediction:
        p10, p50, p90              — composite OEE (backwards-compat aliases)
        oee_p10/p50/p90            — composite OEE (new explicit names)
        disp_p10/p50/p90           — Disponibilidad
        rend_p10/p50/p90           — Rendimiento
        cal_p10/p50/p90            — Calidad
    plus `top_features` (SHAP for composite p50) and `confidence`.
    """
    if feature_df.empty:
        empty = {c: [] for c in ("p10","p50","p90","top_features","confidence")}
        return feature_df.assign(**empty)

    artifacts = _load_artifacts(str(models_dir))
    schema = artifacts["schema"]
    models = artifacts["models"]
    labels = artifacts["labels"]
    feat = schema["feature_columns"]
    cats = schema["categorical_columns"]

    # Short alias prefix per label for output column names
    LABEL_PREFIX = {
        "oee": "oee",
        "disponibilidad": "disp",
        "rendimiento": "rend",
        "calidad": "cal",
    }

    X = _prepare_features(feature_df, feat, cats)

    out = feature_df.copy()
    for label in labels:
        prefix = LABEL_PREFIX.get(label, label[:4])
        for alpha in schema["alphas"]:
            tag = f"p{int(alpha * 100):02d}"
            preds = np.clip(models[(label, alpha)].predict(X), 0.0, 1.0)
            out[f"{prefix}_{tag}"] = preds
            # Backwards-compat: bare p10/p50/p90 mirror composite OEE
            if label == "oee":
                out[tag] = preds

    # ============================================================ SHAP per row (composite OEE p50)
    p50 = models[("oee", 0.50)]
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
