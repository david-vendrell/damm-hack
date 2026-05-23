"""
LineWise — Step 07: Train the 3 LightGBM quantile-regression models.

Train α = 0.10 (p10, downside), 0.50 (p50, expected), 0.90 (p90, achievable ceiling).
Categorical features handled natively. Early stopping on a time-ordered inner
holdout. Saves to models/ + feature_columns.json.

Run from repo root after 06_build_training_dataset.py:
    python3 scripts/07_train_oee_quantile.py
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
MODELS = ROOT / "models"
MODELS.mkdir(parents=True, exist_ok=True)

# Quantiles to train
ALPHAS = (0.10, 0.50, 0.90)

# Columns that are NOT features (identifiers, target, helpers, leakage risks)
EXCLUDE_COLS = {
    "of",        # identifier
    "oee",       # target
    "fecha",     # raw timestamp — calendar parts (dia_semana / mes / week_iso) are features
    "prev_fecha",
    "hl",        # quantity — keep as feature? actually keep, rename below
    "uds",
    "hubo_cambio",  # redundant with c_*_flags
    "n_dimensiones_cambiadas",  # redundant
}

# Numeric columns we want to keep as numeric (rest of object-dtype = categorical)
NUMERIC_HINT = {
    "linea", "n_llamadas_mant",
    "unidad_caja", "unidades_packaging_primario", "unidades_packaging_secundario",
    "dia_semana", "mes", "week_iso",
    "teorico_cambio_min", "hours_since_same_format", "hours_since_same_sku",
    "sku_line_oee_p50_last_30d", "sku_line_oee_p90_last_30d",
    "sku_line_n_runs_last_30d",
    "linea_oee_p50_last_7d", "linea_oee_p50_last_30d",
    "familia_line_oee_p50",
    "pair_transition_oee_p50", "pair_transition_n",
    "sku_n_lineas_history",
    "mant_horas_dia", "hours_to_next_scheduled_limpieza",
    "hours_since_last_limpieza_on_line",
    "prev_oee",
    "hl",
}


def prepare_features(df: pd.DataFrame) -> tuple[pd.DataFrame, list[str], list[str]]:
    """Return (X, categorical_cols, all_feature_cols)."""
    feature_cols = [c for c in df.columns if c not in EXCLUDE_COLS]
    X = df[feature_cols].copy()
    cat_cols: list[str] = []
    for c in feature_cols:
        if c in NUMERIC_HINT:
            X[c] = pd.to_numeric(X[c], errors="coerce")
        elif X[c].dtype == "bool" or X[c].dtype.name == "boolean":
            X[c] = X[c].astype("Int8")  # bool → 0/1 numeric
        elif X[c].dtype == "object" or str(X[c].dtype).startswith("category"):
            X[c] = X[c].astype("category")
            cat_cols.append(c)
        elif np.issubdtype(X[c].dtype, np.number):
            pass  # already numeric
        else:
            X[c] = X[c].astype("category")
            cat_cols.append(c)
    return X, cat_cols, feature_cols


def main() -> None:
    df = pd.read_parquet(TRAIN)
    df = df.sort_values("fecha").reset_index(drop=True)
    print(f"==> Loaded {len(df)} rows × {df.shape[1]} cols from {TRAIN.name}")

    y = df["oee"].clip(0.01, 1.0).astype(float)
    X, cat_cols, feature_cols = prepare_features(df)
    print(f"==> {len(feature_cols)} features ({len(cat_cols)} categorical, {len(feature_cols)-len(cat_cols)} numeric/bool)")

    # Time-ordered inner holdout for early stopping: last ~15 % of train as valid
    split = int(len(df) * 0.85)
    X_tr, X_val = X.iloc[:split], X.iloc[split:]
    y_tr, y_val = y.iloc[:split], y.iloc[split:]
    print(f"==> Inner split: {len(X_tr)} fit / {len(X_val)} early-stop")

    common_params = dict(
        learning_rate=0.05,
        num_leaves=31,
        min_data_in_leaf=20,
        feature_fraction=0.85,
        bagging_fraction=0.85,
        bagging_freq=5,
        verbose=-1,
        n_estimators=1500,
    )

    models = {}
    for alpha in ALPHAS:
        print(f"\n==> Training α = {alpha:.2f} ...")
        model = lgb.LGBMRegressor(
            objective="quantile",
            alpha=alpha,
            **common_params,
        )
        model.fit(
            X_tr, y_tr,
            eval_set=[(X_val, y_val)],
            eval_metric="quantile",
            categorical_feature=cat_cols,
            callbacks=[
                lgb.early_stopping(stopping_rounds=50, verbose=False),
                lgb.log_evaluation(period=0),
            ],
        )
        models[alpha] = model
        print(f"    best_iteration = {model.best_iteration_},  "
              f"best_score = {model.best_score_['valid_0']['quantile']:.5f}")

        # save
        tag = f"p{int(alpha * 100):02d}"
        out = MODELS / f"lgb_oee_{tag}.pkl"
        with open(out, "wb") as f:
            pickle.dump(model, f)
        print(f"    saved → {out.relative_to(ROOT)}")

    # save feature schema
    schema = {
        "feature_columns": feature_cols,
        "categorical_columns": cat_cols,
        "target": "oee",
        "alphas": list(ALPHAS),
        "split_date": "2025-10-01",
    }
    (MODELS / "feature_columns.json").write_text(json.dumps(schema, indent=2, ensure_ascii=False))
    print(f"\n==> feature schema saved → models/feature_columns.json")
    print("==> Done.")


if __name__ == "__main__":
    main()
