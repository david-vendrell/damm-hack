"""
LineWise — Step 06: Build the OEE quantile-regression training dataset.

One row per historical Production Order (OF). Six feature groups (A-F),
time-aware aggregates with strict anti-leakage filtering, time-based train/test split.

Run from repo root:
    python3 scripts/06_build_training_dataset.py

Output:
    parquet/train.parquet  (~1670 rows, fecha < 2025-10-01)
    parquet/test.parquet   (~471 rows,  fecha >= 2025-10-01)
"""

from __future__ import annotations

from pathlib import Path

import duckdb
import holidays as holidays_lib
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "db" / "linewise.duckdb"
OUT = ROOT / "parquet"
OUT.mkdir(parents=True, exist_ok=True)

SPLIT_DATE = pd.Timestamp("2025-10-01")


# --------------------------------------------------------- time-aware aggregate
def add_time_window_agg(
    df: pd.DataFrame,
    group_cols: list[str],
    value_col: str,
    out_col: str,
    fn,
    window_days: int,
) -> pd.DataFrame:
    """For each row, compute `fn(values)` over rows where the group_cols match
    and the partner row's `fecha` lies in [row.fecha - window_days, row.fecha).
    Strict less-than ensures no leakage from the current row.
    """
    df = df.copy()
    out = np.full(len(df), np.nan, dtype=float)
    for _, g in df.groupby(group_cols, sort=False, dropna=False):
        idx = g.index.to_numpy()
        fechas = g["fecha"].to_numpy(dtype="datetime64[ns]")
        values = g[value_col].to_numpy(dtype=float)
        for i, t in enumerate(fechas):
            lo = t - np.timedelta64(window_days, "D")
            mask = (fechas < t) & (fechas >= lo)
            if mask.sum() == 0:
                continue
            v = values[mask]
            v = v[~np.isnan(v)]
            if v.size == 0:
                continue
            out[idx[i]] = fn(v)
    df[out_col] = out
    return df


# --------------------------------------------------------- main
def main() -> None:
    con = duckdb.connect(str(DB_PATH), read_only=True)
    print(f"==> Connected to {DB_PATH}")

    # ============================================================== Base
    df = con.execute("""
        SELECT
            r.of,
            r.linea,
            r.fecha_fin                     AS fecha,
            r.sku,
            r.hl,
            r.uds,
            r.oee,
            r.disponibilidad,
            r.rendimiento,
            (1.0 - COALESCE(r.ineficiencia, 0.0)) AS calidad,
            r.horas_cambio * 60.0           AS actual_cambio_min,
            r.estado_volumen,
            r.cambio_tipo_principal,
            r.hubo_cambio,
            r.n_dimensiones_cambiadas,
            r.c_brand_flag, r.c_cap_flag, r.c_envase_flag,
            r.c_palet_flag, r.c_primario_flag, r.c_producto_flag,
            r.c_secundario_flag, r.c_volum_flag,
            r.n_llamadas_mant,
            s.marca, s.supramarca, s.familia, s.cerveza, s.cbr,
            s.envase, s.tipo_envase,
            s.packaging_primario, s.packaging_secundario,
            s.palet, s.tipo_palet,
            s.unidad_caja,
            s.unidades_packaging_primario,
            s.unidades_packaging_secundario,
            s.retornable
        FROM fact_runs r
        LEFT JOIN dim_sku s ON s.sku = r.sku
        WHERE NOT r.outlier
          AND r.oee BETWEEN 0 AND 1
          AND r.linea IS NOT NULL
          AND r.fecha_fin IS NOT NULL
    """).fetchdf()
    print(f"==> Base rows: {len(df)}")

    df["fecha"] = pd.to_datetime(df["fecha"])
    df = df.sort_values(["linea", "fecha", "of"]).reset_index(drop=True)

    # ============================================================ Group F: Calendar
    es = holidays_lib.country_holidays("ES")
    df["dia_semana"] = df["fecha"].dt.weekday + 1            # 1=Mon..7=Sun
    df["mes"] = df["fecha"].dt.month
    df["week_iso"] = df["fecha"].dt.isocalendar().week.astype(int)
    df["is_holiday_spain"] = df["fecha"].dt.date.map(lambda d: d in es).astype(bool)
    print("==> Group F (calendar): added 4 cols")

    # ============================================================ Group C: LAG
    g = df.groupby("linea", sort=False, group_keys=False)
    for col in [
        "sku", "marca", "supramarca", "familia", "cerveza", "cbr",
        "envase", "tipo_envase", "estado_volumen", "oee", "fecha",
    ]:
        df[f"prev_{col}"] = g[col].shift(1)

    df["no_predecessor"] = df["prev_sku"].isna()
    df["first_of_day"] = (df["fecha"].dt.date != df["prev_fecha"].dt.date) | df["prev_fecha"].isna()

    for dim in ["marca", "supramarca", "familia", "cerveza", "cbr",
                "envase", "tipo_envase", "estado_volumen"]:
        df[f"same_{dim}"] = (df[dim] == df[f"prev_{dim}"]) & df[f"prev_{dim}"].notna()

    df["same_volume_state"] = df["same_estado_volumen"]
    df["same_packaging"] = df["same_envase"] & df["same_tipo_envase"]
    df["same_palet"] = df["palet"] == g["palet"].shift(1)

    print("==> Group C (LAG + same flags): added ~30 cols")

    # ============================================================ Teórico cambio
    matrix = con.execute("""
        SELECT linea,
               from_state AS prev_estado_volumen,
               to_state   AS estado_volumen,
               minutes    AS teorico_cambio_min
        FROM dim_theoretical_changeover_matrix
    """).fetchdf()
    df = df.merge(matrix, how="left",
                  on=["linea", "prev_estado_volumen", "estado_volumen"])
    print("==> Teórico cambio: joined CF Prat matrix")

    # Gap 3 — changeover variance (actual − theoretical). Captures chronic
    # changeover overruns per (línea, transition).
    df["changeover_variance_min"] = df["actual_cambio_min"] - df["teorico_cambio_min"]
    print("==> Changeover variance: actual − theoretical (Gap 3)")

    # ============================================================ Hours since
    # last time same format / same sku ran on this line (strictly past)
    fmt_g = df.groupby(["linea", "estado_volumen"], sort=False, group_keys=False)
    df["hours_since_same_format"] = (
        df["fecha"] - fmt_g["fecha"].shift(1)
    ).dt.total_seconds() / 3600.0

    sku_g = df.groupby(["linea", "sku"], sort=False, group_keys=False)
    df["hours_since_same_sku"] = (
        df["fecha"] - sku_g["fecha"].shift(1)
    ).dt.total_seconds() / 3600.0
    print("==> hours_since features added")

    # ============================================================ Group D: time-aware
    print("==> Group D: time-aware aggregates (will take ~30 s)...")
    df = add_time_window_agg(df, ["linea", "sku"], "oee", "sku_line_oee_p50_last_30d",
                             lambda v: float(np.percentile(v, 50)), 30)
    df = add_time_window_agg(df, ["linea", "sku"], "oee", "sku_line_oee_p90_last_30d",
                             lambda v: float(np.percentile(v, 90)), 30)
    df = add_time_window_agg(df, ["linea", "sku"], "oee", "sku_line_n_runs_last_30d",
                             lambda v: float(v.size), 30)
    df = add_time_window_agg(df, ["linea"], "oee", "linea_oee_p50_last_7d",
                             lambda v: float(np.percentile(v, 50)), 7)
    df = add_time_window_agg(df, ["linea"], "oee", "linea_oee_p50_last_30d",
                             lambda v: float(np.percentile(v, 50)), 30)
    df = add_time_window_agg(df, ["linea", "familia"], "oee", "familia_line_oee_p50",
                             lambda v: float(np.percentile(v, 50)), 365)
    df = add_time_window_agg(df, ["linea", "prev_sku", "sku"], "oee", "pair_transition_oee_p50",
                             lambda v: float(np.percentile(v, 50)), 365)
    df = add_time_window_agg(df, ["linea", "prev_sku", "sku"], "oee", "pair_transition_n",
                             lambda v: float(v.size), 365)

    # sku_n_lineas_history is a static-per-sku count (not time-aware) — fine for the model.
    sku_lineas = df.groupby("sku")["linea"].nunique().rename("sku_n_lineas_history")
    df = df.merge(sku_lineas, on="sku", how="left")
    print("==> Group D done")

    # ============================================================ Group E: maintenance
    limpieza = con.execute("""
        SELECT linea, fecha_fin AS fecha, horas_total
        FROM fact_limpieza
        WHERE linea IS NOT NULL AND fecha_fin IS NOT NULL
    """).fetchdf()
    limpieza["fecha"] = pd.to_datetime(limpieza["fecha"])

    # daily aggregate: hours per (linea, date)
    daily = (
        limpieza.assign(fecha_date=limpieza["fecha"].dt.normalize())
                .groupby(["linea", "fecha_date"])["horas_total"]
                .agg([("mant_horas_dia", lambda s: float(s.fillna(0).sum())),
                      ("mant_flag_dia",  lambda s: bool(len(s) > 0))])
                .reset_index()
                .rename(columns={"fecha_date": "fecha"})
    )
    df = df.merge(daily, on=["linea", "fecha"], how="left")
    df["mant_horas_dia"] = df["mant_horas_dia"].fillna(0.0)
    df["mant_flag_dia"]  = df["mant_flag_dia"].fillna(False)

    # hours_to_next + hours_since_last LIMPIEZA
    next_arr = np.full(len(df), np.nan)
    prev_arr = np.full(len(df), np.nan)
    first_after = np.zeros(len(df), dtype=bool)
    for linea in df["linea"].dropna().unique():
        line_l = limpieza[limpieza["linea"] == linea].sort_values("fecha")
        lf = line_l["fecha"].to_numpy(dtype="datetime64[ns]")
        line_idx = df.index[df["linea"] == linea].to_numpy()
        for i in line_idx:
            t = np.datetime64(df.at[i, "fecha"])
            fut = lf[lf > t]
            pst = lf[lf <= t]
            if fut.size:
                next_arr[i] = (fut[0] - t) / np.timedelta64(1, "h")
            if pst.size:
                prev_arr[i] = (t - pst[-1]) / np.timedelta64(1, "h")
                first_after[i] = prev_arr[i] < 24
    df["hours_to_next_scheduled_limpieza"] = next_arr
    df["hours_since_last_limpieza_on_line"] = prev_arr
    df["is_first_run_after_limpieza"] = first_after
    print("==> Group E done")

    # ============================================================ Final cleanup
    # Drop helper cols we don't need in training
    df = df.drop(columns=[c for c in ["uds"] if c in df.columns])
    # Cast booleans (LightGBM handles them as 0/1)
    bool_cols = [c for c in df.columns if df[c].dtype == "object"
                 and df[c].dropna().isin([True, False]).all() and df[c].dropna().size > 0]
    for c in bool_cols:
        df[c] = df[c].astype("boolean")

    # ============================================================ Split & save
    train = df[df["fecha"] < SPLIT_DATE].copy()
    test  = df[df["fecha"] >= SPLIT_DATE].copy()

    train.to_parquet(OUT / "train.parquet", index=False)
    test.to_parquet(OUT / "test.parquet", index=False)
    print(f"\n==> train.parquet: {len(train)} rows × {train.shape[1]} cols")
    print(f"==> test.parquet:  {len(test)} rows × {test.shape[1]} cols")
    print(f"==> Files at: {OUT}/")

    # Print a feature-count summary
    print("\n==> Columns in dataset:")
    for c in train.columns:
        print(f"    {c:45s} dtype={train[c].dtype}  null%={train[c].isna().mean()*100:5.1f}")

    con.close()
    print("\n==> Done.")


if __name__ == "__main__":
    main()
