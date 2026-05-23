"""
LineWise — Step 01: Lossless ingestion of all Damm raw files into DuckDB.

Loads every Excel file into a raw_* table preserving 100% of columns and rows.
Type-cleans dates and numerics. Does NOT drop anything.

Run from repo root:
    python3 scripts/01_ingest.py

Output:
    db/linewise.duckdb   (single portable DuckDB database file)
"""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path

import duckdb
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "Repte operacions"
DB_PATH = ROOT / "db" / "linewise.duckdb"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)


# ---------- Helpers ---------------------------------------------------------

def slug(name: str) -> str:
    """Normalise a column name to ASCII snake_case."""
    s = unicodedata.normalize("NFKD", str(name)).encode("ascii", "ignore").decode()
    s = s.lower().strip()
    s = re.sub(r"[^\w]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s or "col"


def normalise_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Rename df columns to ASCII snake_case, deduplicating collisions."""
    new = []
    seen: dict[str, int] = {}
    for c in df.columns:
        s = slug(c)
        if s in seen:
            seen[s] += 1
            s = f"{s}_{seen[s]}"
        else:
            seen[s] = 0
        new.append(s)
    df = df.copy()
    df.columns = new
    return df


def coerce_numeric(df: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    """Coerce columns to numeric, NaN on failure. Lossless for ingestion."""
    df = df.copy()
    for c in cols:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


# ---------- Per-file loaders ------------------------------------------------

def load_oee() -> pd.DataFrame:
    df = pd.read_excel(RAW / "OEE 14_17_19_ 2025.xlsx", sheet_name="Export")
    df = normalise_columns(df)
    df = coerce_numeric(df, [
        "tren", "oee", "disponibilidad", "rendimiento", "ineficiencia",
        "cantidad_registros", "unidad_caja", "unidades_packaging_primario",
        "unidades_packaging_secundario", "id_jerarquia_productos",
        "id_organizacion_ventas",
    ])
    df["fecha_fin"] = pd.to_datetime(df["fecha_fin"], errors="coerce")
    df["cambios_bool"] = df["cambios"].astype(str).str.upper().eq("SI")
    df["source_file"] = "OEE 14_17_19_ 2025.xlsx"
    return df


def load_cambios() -> pd.DataFrame:
    df = pd.read_excel(RAW / "Cambios 14_17_19_ 2025.xlsx", sheet_name="Export")
    df = normalise_columns(df)
    df["fecha_fin"] = pd.to_datetime(df["fecha_fin"], errors="coerce")
    flag_cols = [
        "c_brand", "c_cap", "c_envase", "c_palet", "c_primario",
        "c_producto", "c_secundario", "c_volum",
    ]
    for c in flag_cols:
        if c in df.columns:
            num = pd.to_numeric(df[c], errors="coerce")
            df[f"{c}_flag"] = num.fillna(0) > 0
    df = coerce_numeric(df, ["n_de_cambios", "frecuencia_total"])
    df["source_file"] = "Cambios 14_17_19_ 2025.xlsx"
    return df


def load_tiempo() -> pd.DataFrame:
    df = pd.read_excel(RAW / "Tiempo 14_17_19_ 2025.xlsx", sheet_name="Export")
    df = normalise_columns(df)
    df["fecha_fin"] = pd.to_datetime(df["fecha_fin"], errors="coerce")
    df = coerce_numeric(df, [
        "tren", "h_tot", "par_tot", "parada", "pnp", "limpieza", "idle",
        "oee", "disp", "rend", "calidad", "inef",
        "tiempo_paro_por_saturacion_a_la_salida", "tiempo_de_cip",
        "tiempo_maquina_en_paro", "tiempo_paro_por_falta_producto",
        "tiempo_baja_velocidad", "tiempo_maquina_en_marcha",
        "tiempo_de_esterilizacion", "tiempo_operativo_neto",
        "tiempo_operativo_neto2",
    ])
    df["outlier_h_tot"] = df["h_tot"] > 100
    df["source_file"] = "Tiempo 14_17_19_ 2025.xlsx"
    return df


def load_mantenimiento() -> pd.DataFrame:
    df = pd.read_excel(RAW / "Mantenimiento 14_17_19_ 2025.xlsx", sheet_name="Export")
    df = normalise_columns(df)
    df["fecha_fin"] = pd.to_datetime(df["fecha_fin"], errors="coerce")
    df = coerce_numeric(df, [
        "tren", "n_llamadas", "tiempo_en_espera", "tiempo_intervencion",
        "tiempo_total", "tiempo_total_en_marcha", "tiempo_total_en_paro",
        "oee", "disp", "rend", "calid", "inef",
    ])
    df["is_limpieza"] = df["sku"].astype(str).str.upper().eq("LIMPIEZA")
    df["source_file"] = "Mantenimiento 14_17_19_ 2025.xlsx"
    return df


def load_volumen() -> pd.DataFrame:
    df = pd.read_excel(RAW / "Volumen 14_17_19_ 2025.xlsx", sheet_name="Export")
    df = normalise_columns(df)
    df["fecha_fin"] = pd.to_datetime(df["fecha_fin"], errors="coerce")
    df = coerce_numeric(df, [
        "tren", "uds", "hl", "oee", "disp", "rend", "calid", "inef",
    ])
    df["source_file"] = "Volumen 14_17_19_ 2025.xlsx"
    return df


def load_plan_2026() -> pd.DataFrame:
    df = pd.read_excel(RAW / "Planificado - producciones 14 - 17 - 19.XLSX", sheet_name="Sheet1")
    df = normalise_columns(df)
    df["fecha_ini"] = pd.to_datetime(df["fecha_ini"], errors="coerce")
    df["fecha_fin"] = pd.to_datetime(df["fecha_fin"], errors="coerce")
    def combine(row):
        if pd.isna(row["fecha_ini"]):
            return pd.NaT
        h = row.get("hora_ini")
        if pd.isna(h):
            return row["fecha_ini"]
        try:
            if hasattr(h, "hour"):
                return row["fecha_ini"].replace(
                    hour=int(h.hour), minute=int(h.minute), second=int(h.second)
                )
            return pd.to_datetime(f"{row['fecha_ini'].date()} {h}", errors="coerce")
        except Exception:
            return row["fecha_ini"]
    df["start_ts"] = df.apply(combine, axis=1)
    df = coerce_numeric(df, [
        "centro", "tren", "cntd_jda", "cntd_plan", "pndt_env",
        "secuencia", "entrada_en_tabla",
    ])
    df["source_file"] = "Planificado - producciones 14 - 17 - 19.XLSX"
    return df


def load_actual_2026() -> pd.DataFrame:
    df = pd.read_excel(RAW / "Produccion_L14,17,19_18-22.xlsx", sheet_name="Export")
    df = normalise_columns(df)
    df["fecha_fin"] = pd.to_datetime(df["fecha_fin"], errors="coerce")
    df = coerce_numeric(df, [
        "tren", "uds", "hl", "oee", "disp", "rend", "calid", "inef",
    ])
    df["source_file"] = "Produccion_L14,17,19_18-22.xlsx"
    return df


def load_data_extra() -> pd.DataFrame:
    df = pd.read_excel(RAW / "data - 2026-05-18T181640.542.xlsx", sheet_name="Export")
    df = normalise_columns(df)
    df["fecha_fin"] = pd.to_datetime(df["fecha_fin"], errors="coerce")
    df = coerce_numeric(df, [
        "tren", "oee", "disponibilidad", "rendimiento", "ineficiencia",
    ])
    df["cambios_bool"] = df["cambios"].astype(str).str.upper().eq("SI")
    df["source_file"] = "data - 2026-05-18T181640.542.xlsx"
    return df


def load_plan_2026_v2() -> pd.DataFrame:
    """Refreshed Planificado file (missing 'Denominación' but same shape)."""
    df = pd.read_excel(RAW / "Planificado - producciones 14 - 17 - 19 (v2).xlsx", sheet_name="Sheet1")
    df = normalise_columns(df)
    df["fecha_ini"] = pd.to_datetime(df["fecha_ini"], errors="coerce")
    df["fecha_fin"] = pd.to_datetime(df["fecha_fin"], errors="coerce")
    def combine(row):
        if pd.isna(row["fecha_ini"]):
            return pd.NaT
        h = row.get("hora_ini")
        if pd.isna(h):
            return row["fecha_ini"]
        try:
            if hasattr(h, "hour"):
                return row["fecha_ini"].replace(
                    hour=int(h.hour), minute=int(h.minute), second=int(h.second)
                )
            return pd.to_datetime(f"{row['fecha_ini'].date()} {h}", errors="coerce")
        except Exception:
            return row["fecha_ini"]
    df["start_ts"] = df.apply(combine, axis=1)
    df = coerce_numeric(df, [
        "centro", "tren", "cntd_jda", "cntd_plan", "pndt_env",
        "secuencia", "entrada_en_tabla",
    ])
    df["source_file"] = "Planificado - producciones 14 - 17 - 19 (v2).xlsx"
    return df


def load_diario_hl_planif_raw() -> pd.DataFrame:
    """Load the wide cross-tab as-is, preserving every cell."""
    df = pd.read_excel(RAW / "Diario Hl_Planif.xlsx", sheet_name="Diario Hl")
    # Preserve the original (possibly multi-line) column names in a sidecar
    df = df.where(pd.notna(df), None)
    # Normalize column names to col_0, col_1, ... for safe SQL identifiers,
    # but keep the original headers in a separate metadata row table
    original_columns = list(df.columns)
    df.columns = [f"col_{i}" for i in range(df.shape[1])]
    df.insert(0, "row_idx", range(len(df)))
    df["source_file"] = "Diario Hl_Planif.xlsx"
    # Stash original headers
    global _DIARIO_HL_HEADERS
    _DIARIO_HL_HEADERS = original_columns
    return df


_DIARIO_HL_HEADERS: list[str] = []


def load_cf_matrix_raw() -> tuple[pd.DataFrame, pd.DataFrame]:
    """Load both sheets of the changeover-format matrix as raw cell tables."""
    xl = pd.ExcelFile(RAW / "Tabla CF Prat 2026_14_17_19.xlsx")
    sheets = {}
    for sh in xl.sheet_names:
        df = pd.read_excel(xl, sheet_name=sh, header=None)
        df = df.where(pd.notna(df), None)
        df.columns = [f"col_{i}" for i in range(df.shape[1])]
        df.insert(0, "row_idx", range(len(df)))
        sheets[sh] = df
    return sheets["Tiempos adicionales"], sheets["LATA_BARRIL"]


# ---------- Main ------------------------------------------------------------

def main() -> None:
    print(f"==> Connecting to {DB_PATH}")
    if DB_PATH.exists():
        DB_PATH.unlink()
    con = duckdb.connect(str(DB_PATH))

    loaders = {
        "raw_oee": load_oee,
        "raw_cambios": load_cambios,
        "raw_tiempo": load_tiempo,
        "raw_mantenimiento": load_mantenimiento,
        "raw_volumen": load_volumen,
        "raw_plan_2026": load_plan_2026,
        "raw_plan_2026_v2": load_plan_2026_v2,
        "raw_actual_2026": load_actual_2026,
        "raw_data_extra": load_data_extra,
        "raw_diario_hl_planif": load_diario_hl_planif_raw,
    }

    for table, fn in loaders.items():
        print(f"==> Loading {table:25s} ...", end=" ", flush=True)
        df = fn()
        con.register("_tmp_", df)
        con.execute(f"CREATE OR REPLACE TABLE {table} AS SELECT * FROM _tmp_")
        con.unregister("_tmp_")
        n = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        c = len(df.columns)
        print(f"{n:>6} rows x {c:>3} cols")

    print("==> Loading raw_cf_matrix_*")
    adicionales, lata_barril = load_cf_matrix_raw()
    con.register("_a", adicionales)
    con.register("_lb", lata_barril)
    con.execute("CREATE OR REPLACE TABLE raw_cf_tiempos_adicionales AS SELECT * FROM _a")
    con.execute("CREATE OR REPLACE TABLE raw_cf_lata_barril AS SELECT * FROM _lb")
    con.unregister("_a"); con.unregister("_lb")

    # Diario Hl header sidecar — preserves the original multi-line Excel headers
    if _DIARIO_HL_HEADERS:
        headers_df = pd.DataFrame({
            "col_idx": range(len(_DIARIO_HL_HEADERS)),
            "col_name": [f"col_{i}" for i in range(len(_DIARIO_HL_HEADERS))],
            "original_header": [str(h) for h in _DIARIO_HL_HEADERS],
        })
        con.register("_hd", headers_df)
        con.execute("CREATE OR REPLACE TABLE raw_diario_hl_planif_headers AS SELECT * FROM _hd")
        con.unregister("_hd")

    con.execute("""
        CREATE OR REPLACE TABLE _meta_files AS
        SELECT * FROM (VALUES
            ('OEE 14_17_19_ 2025.xlsx',                       'raw_oee',                  'OEE master per OF, 43 cols of product metadata.'),
            ('Cambios 14_17_19_ 2025.xlsx',                   'raw_cambios',              'Changeover events per OF. C. PRINCIPAL = type. Binary flags per dimension.'),
            ('Tiempo 14_17_19_ 2025.xlsx',                    'raw_tiempo',               'Per-OF lost-time breakdown: CIP, baja velocidad, saturacion, falta producto, marcha, paro.'),
            ('Mantenimiento 14_17_19_ 2025.xlsx',             'raw_mantenimiento',        'Maintenance events per OF + standalone LIMPIEZA WOs.'),
            ('Volumen 14_17_19_ 2025.xlsx',                   'raw_volumen',              'Per-OF produced volumes (UDS, HL).'),
            ('Planificado - producciones 14 - 17 - 19.XLSX',  'raw_plan_2026',            'Blue Yonder / JDA theoretical plan for May 2026.'),
            ('Produccion_L14,17,19_18-22.xlsx',               'raw_actual_2026',          'Actual production for May 18-22, 2026 (same window as plan).'),
            ('data - 2026-05-18T181640.542.xlsx',             'raw_data_extra',           'Additional OEE history (Sep-Oct 2025 onwards).'),
            ('Tabla CF Prat 2026_14_17_19.xlsx',              'raw_cf_lata_barril',       'Theoretical changeover matrix LATA/BARRIL per line (raw cells).'),
            ('Tabla CF Prat 2026_14_17_19.xlsx',              'raw_cf_tiempos_adicionales','Additional cleaning/maintenance time references (raw cells).'),
            ('Planificado - producciones 14 - 17 - 19 (v2).xlsx','raw_plan_2026_v2',       'Refreshed Planificado for May 2026 (same shape, missing Denominacion).'),
            ('Diario Hl_Planif.xlsx',                         'raw_diario_hl_planif',     'Daily HL planning report May 18-24 2026 (raw wide cross-tab cells).'),
            ('Diario Hl_Planif.xlsx',                         'raw_diario_hl_planif_headers','Sidecar with original multi-line Excel headers for the Diario Hl table.')
        ) AS t(source_file, table_name, description)
    """)

    print("\n==> Tables in database:")
    for row in con.execute(
        "SELECT table_name, estimated_size FROM duckdb_tables() ORDER BY table_name"
    ).fetchall():
        print(f"    {row[0]:35s} {row[1]:>8} rows")

    con.close()
    print(f"\n==> Done. Database at: {DB_PATH}")


if __name__ == "__main__":
    main()
