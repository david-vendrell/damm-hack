"""Enrich parsed plan blocks with the full ~70-column feature row the LightGBM
quantile models expect. Reads only the precomputed lookup parquets — no DuckDB
at inference time.

Inputs:
    blocks       : DataFrame from parse_planning_excel (~10 cols)
    lookups_dir  : Path to lookups/

Output:
    feature_df   : DataFrame with the same columns as parquet/train.parquet
                   minus 'oee' (the target).
"""

from __future__ import annotations

from pathlib import Path

import holidays as holidays_lib
import numpy as np
import pandas as pd


_HOLIDAYS_ES = holidays_lib.country_holidays("ES")


def _load_lookups(lookups_dir: str | Path) -> dict[str, pd.DataFrame]:
    d = Path(lookups_dir)
    names = [
        "dim_sku", "dim_theoretical_changeover_matrix",
        "sku_line_feasibility", "last_historical_of_per_line",
        "sku_line_aggregates", "linea_aggregates",
        "familia_line_aggregates", "pair_transition_aggregates",
        "maintenance_proxy", "fact_runs_slim",
    ]
    return {n: pd.read_parquet(d / f"{n}.parquet") for n in names}


def build_feature_rows(
    blocks: pd.DataFrame,
    lookups_dir: str | Path,
) -> pd.DataFrame:
    """Return a feature DataFrame ready to feed the LightGBM models."""
    if blocks.empty:
        return blocks.copy()

    lk = _load_lookups(lookups_dir)
    dim_sku = lk["dim_sku"]
    matrix = lk["dim_theoretical_changeover_matrix"].rename(
        columns={"from_state": "prev_estado_volumen",
                 "to_state":   "estado_volumen",
                 "minutes":    "teorico_cambio_min"}
    )
    sku_line = lk["sku_line_aggregates"]
    linea_agg = lk["linea_aggregates"]
    familia_line = lk["familia_line_aggregates"]
    pair_tr = lk["pair_transition_aggregates"]
    last_per_line = lk["last_historical_of_per_line"]
    fact_slim = lk["fact_runs_slim"]
    maint = lk["maintenance_proxy"]

    out = blocks.copy().reset_index(drop=True)

    # ============================================================ Group B: SKU enrichment
    out = out.merge(dim_sku, on="sku", how="left", suffixes=("", "_dim"))

    # Brand-prefix fallback for SKUs not in dim_sku (new May 2026 SKUs).
    # Damm naming: first 2-3 chars are the brand code (ED, VO, XI, FD, FDT, SK, …).
    # For each unknown SKU we look up the most common marca / supramarca / familia
    # of SKUs sharing the same 3-char prefix and use that for UI + model features.
    if out["marca"].isna().any():
        def _build_prefix_map(col: str, pfx_len: int) -> dict[str, str]:
            d = dim_sku[["sku", col]].dropna()
            if d.empty:
                return {}
            d = d.assign(pfx=d["sku"].str[:pfx_len])
            return (
                d.groupby("pfx")[col]
                 .agg(lambda s: s.value_counts().idxmax())
                 .to_dict()
            )

        for col in ("marca", "supramarca", "familia", "cerveza", "cbr",
                    "tipo_envase", "estado_volumen"):
            if col not in out.columns:
                continue
            pmap3 = _build_prefix_map(col, 3)
            pmap2 = _build_prefix_map(col, 2)
            need = out[col].isna()
            if not need.any():
                continue
            out.loc[need, col] = (
                out.loc[need, "sku"].astype(str).str[:3].map(pmap3)
                .fillna(out.loc[need, "sku"].astype(str).str[:2].map(pmap2))
            )

    # ============================================================ Group F: calendar
    out["fecha"] = pd.to_datetime(out["fecha"])
    out["dia_semana"] = out["fecha"].dt.weekday + 1
    out["mes"] = out["fecha"].dt.month
    out["week_iso"] = out["fecha"].dt.isocalendar().week.astype(int)
    out["is_holiday_spain"] = out["fecha"].dt.date.map(lambda d: d in _HOLIDAYS_ES).astype(bool)

    # ============================================================ Group C: LAG within the upload
    out = out.sort_values(["linea", "start_ts", "secuencia"], na_position="last").reset_index(drop=True)
    g = out.groupby("linea", sort=False, group_keys=False)
    for col in [
        "sku", "marca", "supramarca", "familia", "cerveza", "cbr",
        "envase", "tipo_envase", "estado_volumen", "fecha",
    ]:
        out[f"prev_{col}"] = g[col].shift(1)

    # Stitch the FIRST block of each line in the upload to the last historical OF
    last_idx = last_per_line.set_index("linea")
    for col in ["sku", "marca", "supramarca", "familia", "cerveza", "cbr",
                "envase", "tipo_envase", "estado_volumen"]:
        out_col = f"prev_{col}"
        mask = out[out_col].isna()
        if mask.any():
            for i in out.index[mask]:
                ln = out.at[i, "linea"]
                if ln in last_idx.index and col in last_idx.columns:
                    out.at[i, out_col] = last_idx.at[ln, col]

    # prev_oee from the previous *upload* block; for the first block of the upload
    # we stitch to the last historical OF's OEE.
    out["prev_oee"] = np.nan  # uploaded blocks don't have actual OEE yet
    for i in range(len(out)):
        ln = out.at[i, "linea"]
        if i == 0 or out.at[i - 1, "linea"] != ln:
            # first block of this línea — use last historical OEE
            if ln in last_idx.index:
                out.at[i, "prev_oee"] = last_idx.at[ln, "oee"]

    # same_* flags + no_predecessor + first_of_day
    out["no_predecessor"] = out["prev_sku"].isna()
    out["first_of_day"] = (
        out["fecha"].dt.date != out["prev_fecha"].dt.date
    ) | out["prev_fecha"].isna()
    for dim in ["marca", "supramarca", "familia", "cerveza", "cbr",
                "envase", "tipo_envase", "estado_volumen"]:
        out[f"same_{dim}"] = (out[dim] == out[f"prev_{dim}"]) & out[f"prev_{dim}"].notna()
    out["same_volume_state"] = out["same_estado_volumen"]
    out["same_packaging"] = out["same_envase"] & out["same_tipo_envase"]
    out["same_palet"] = out["palet"] == g["palet"].shift(1)

    # ============================================================ Teórico cambio
    out = out.merge(matrix, how="left", on=["linea", "prev_estado_volumen", "estado_volumen"])

    # ============================================================ hours_since features
    # Approximate using fact_runs_slim: time since last historical (linea, sku) and (linea, estado_volumen)
    fact_slim = fact_slim.copy()
    fact_slim["fecha"] = pd.to_datetime(fact_slim["fecha"])
    last_sku_line = (
        fact_slim.groupby(["linea", "sku"])["fecha"]
                 .max().rename("last_sku_line_fecha").reset_index()
    )
    last_fmt_line = (
        fact_slim.groupby(["linea", "estado_volumen"])["fecha"]
                 .max().rename("last_fmt_line_fecha").reset_index()
    )
    out = out.merge(last_sku_line, on=["linea", "sku"], how="left")
    out = out.merge(last_fmt_line, on=["linea", "estado_volumen"], how="left")
    out["hours_since_same_sku"] = (
        (out["fecha"] - out["last_sku_line_fecha"]).dt.total_seconds() / 3600.0
    )
    out["hours_since_same_format"] = (
        (out["fecha"] - out["last_fmt_line_fecha"]).dt.total_seconds() / 3600.0
    )
    out = out.drop(columns=["last_sku_line_fecha", "last_fmt_line_fecha"])

    # ============================================================ Group D: recent aggregates
    sku_line_renamed = sku_line.rename(columns={
        "n_runs_recent":  "sku_line_n_runs_last_30d",
        "p50_oee_recent": "sku_line_oee_p50_last_30d",
        "p90_oee_recent": "sku_line_oee_p90_last_30d",
    })[["sku", "linea", "sku_line_n_runs_last_30d",
        "sku_line_oee_p50_last_30d", "sku_line_oee_p90_last_30d"]]
    out = out.merge(sku_line_renamed, on=["sku", "linea"], how="left")

    out = out.merge(linea_agg.rename(columns={
        "oee_p50_last_7d": "linea_oee_p50_last_7d",
        "oee_p50_last_30d": "linea_oee_p50_last_30d",
    }), on="linea", how="left")

    out = out.merge(
        familia_line.rename(columns={"p50_oee": "familia_line_oee_p50"})[["linea", "familia", "familia_line_oee_p50"]],
        on=["linea", "familia"], how="left",
    )

    out = out.merge(
        pair_tr.rename(columns={"p50_oee": "pair_transition_oee_p50", "n": "pair_transition_n"})
              [["linea", "prev_sku", "sku", "pair_transition_oee_p50", "pair_transition_n"]],
        on=["linea", "prev_sku", "sku"], how="left",
    )

    sku_n_lineas = (
        fact_slim.groupby("sku")["linea"].nunique().rename("sku_n_lineas_history").reset_index()
    )
    out = out.merge(sku_n_lineas, on="sku", how="left")

    # ============================================================ Group E: maintenance proxy
    out = out.merge(maint, on="linea", how="left")
    out["mant_horas_dia"] = 0.0   # at plan time we don't know — assume none on this day
    out["mant_flag_dia"] = False

    # Approximate hours_to_next_scheduled_limpieza from cadence
    out["last_limpieza"] = pd.to_datetime(out["last_limpieza"])
    out["hours_since_last_limpieza_on_line"] = (
        (out["fecha"] - out["last_limpieza"]).dt.total_seconds() / 3600.0
    )
    out["hours_to_next_scheduled_limpieza"] = out["expected_days_between_limpiezas"].fillna(7) * 24.0
    out["is_first_run_after_limpieza"] = out["hours_since_last_limpieza_on_line"].fillna(99999) < 24

    # ============================================================ Inherit cambios placeholders
    # We don't have measured c_*_flag at plan time; use prev/current dim comparisons as proxy
    out["c_brand_flag"]      = ~out["same_marca"]
    out["c_cap_flag"]        = ~out["same_envase"]   # tapón proxy
    out["c_envase_flag"]     = ~out["same_envase"]
    out["c_palet_flag"]      = ~out["same_palet"]
    out["c_primario_flag"]   = ~out["same_packaging"]
    out["c_producto_flag"]   = ~out["same_familia"]
    out["c_secundario_flag"] = ~out["same_tipo_envase"]
    out["c_volum_flag"]      = ~out["same_volume_state"]

    # cambio_tipo_principal — heuristic from the dim flags
    def _ctp(r):
        if not r["same_volume_state"]:
            return "Volumen Envase"
        if not r["same_marca"]:
            return "Marca"
        if not r["same_familia"]:
            return "Contenido"
        if not r["same_packaging"]:
            return "Pack. Primario"
        if not r["same_tipo_envase"]:
            return "Pack. Secundario"
        if not r["same_palet"]:
            return "Palet"
        return None
    out["cambio_tipo_principal"] = out.apply(_ctp, axis=1)

    # n_llamadas_mant — unknown at plan time; impute the historical median per línea
    if "n_llamadas_mant" in fact_slim.columns:
        med = fact_slim.groupby("linea")["n_llamadas_mant"].median().rename("med_n_llam").reset_index()
        out = out.merge(med, on="linea", how="left")
        out["n_llamadas_mant"] = out["med_n_llam"].fillna(0)
        out = out.drop(columns="med_n_llam")
    else:
        out["n_llamadas_mant"] = 0

    return out
