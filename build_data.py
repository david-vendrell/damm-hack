"""LineWise · Preprocesador XLSX → data.json para dashboard."""
from __future__ import annotations
import json
import math
import os
import re
import sys
from pathlib import Path

import pandas as pd

BASE = Path(__file__).parent
DATA_DIR = BASE / "Repte operacions"
OUT = BASE / "data.json"
OUT_JS = BASE / "data.js"

F_OEE = DATA_DIR / "OEE 14_17_19_ 2025.xlsx"
F_CAMBIOS = DATA_DIR / "Cambios 14_17_19_ 2025.xlsx"
F_MANTTO = DATA_DIR / "Mantenimiento 14_17_19_ 2025.xlsx"
F_VOLUMEN = DATA_DIR / "Volumen 14_17_19_ 2025.xlsx"
F_TIEMPO = DATA_DIR / "Tiempo 14_17_19_ 2025.xlsx"
F_PROD_REAL = DATA_DIR / "Produccion_L14,17,19_18-22.xlsx"
F_PLAN = DATA_DIR / "Planificado - producciones 14 - 17 - 19.XLSX"
F_TIEMPOS_CF = DATA_DIR / "Tabla CF Prat 2026_14_17_19.xlsx"


def jsonable(v):
    if v is None:
        return None
    # pandas NaT/NaN
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(v, (pd.Timestamp,)):
        return v.strftime("%Y-%m-%d")
    # numpy scalars
    if hasattr(v, "item"):
        try:
            v = v.item()
        except (ValueError, AttributeError):
            pass
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return None
        return round(v, 6)
    if isinstance(v, (int, str, bool)):
        return v
    return str(v)


def df_to_records(df: pd.DataFrame) -> list[dict]:
    rows = df.to_dict(orient="records")
    return [{k: jsonable(v) for k, v in r.items()} for r in rows]


def parse_minutes(text) -> int | None:
    """'3 h' -> 180, '40 min' -> 40, '1,5 h' -> 90, '1 h 15 min' -> 75."""
    if text is None or (isinstance(text, float) and math.isnan(text)):
        return None
    s = str(text).strip().lower().replace(",", ".")
    if s in ("", "-", "nan"):
        return None
    total = 0
    matched = False
    for m in re.finditer(r"([0-9]+(?:\.[0-9]+)?)\s*(h|min)", s):
        val = float(m.group(1))
        total += val * 60 if m.group(2) == "h" else val
        matched = True
    return int(total) if matched else None


# ── Load core 2025 datasets ────────────────────────────────────────────────
print("Loading 2025 datasets…", file=sys.stderr)
oee = pd.read_excel(F_OEE, sheet_name="Export")
cambios = pd.read_excel(F_CAMBIOS, sheet_name="Export")
mantto = pd.read_excel(F_MANTTO, sheet_name="Export")
volumen = pd.read_excel(F_VOLUMEN, sheet_name="Export")
tiempo = pd.read_excel(F_TIEMPO, sheet_name="Export")
print(f"  oee={len(oee)} cambios={len(cambios)} mantto={len(mantto)} "
      f"volumen={len(volumen)} tiempo={len(tiempo)}", file=sys.stderr)

# Normalise types
for df in (oee, cambios, mantto, volumen, tiempo):
    df["Fecha Fin"] = pd.to_datetime(df["Fecha Fin"], errors="coerce")

# ── Master table per OF ────────────────────────────────────────────────────
# Use OEE as the spine. Bring in volume, change count, mantto times.
oee_keep = oee[[
    "OF", "Fecha Fin", "SKU", "TREN", "OEE", "Disponibilidad", "Rendimiento",
    "Ineficiencia", "Cambios", "Marca", "Familia", "Cerveza", "Envase",
    "Tipo Envase", "Mat. Precio",
]].copy()
oee_keep.rename(columns={"Mat. Precio": "MatPrecio"}, inplace=True)

vol_keep = volumen[["OF", "UDS", "HL"]].drop_duplicates("OF")
cam_keep = cambios[[
    "OF", "Nº de Cambios", "C. Brand", "C. CAP", "C. Envase", "C. Palet",
    "C. Primario", "C. Producto", "C. Secundario", "C. Volum",
]].drop_duplicates("OF").rename(columns={"Nº de Cambios": "NumCambios"})
man_keep = mantto[[
    "OF", "Nº LLamadas", "Tiempo en Espera", "Tiempo Intervención",
    "Tiempo Total en Paro",
]].drop_duplicates("OF").rename(columns={
    "Nº LLamadas": "NumLlamadas",
    "Tiempo en Espera": "TEspera",
    "Tiempo Intervención": "TIntervencion",
    "Tiempo Total en Paro": "TParo",
})

master = (oee_keep
          .merge(vol_keep, on="OF", how="left")
          .merge(cam_keep, on="OF", how="left")
          .merge(man_keep, on="OF", how="left"))

# Drop rows w/o valid OEE for KPI calcs, keep LIMPIEZA as side info
master["IsLimpieza"] = master["SKU"].astype(str).str.upper().eq("LIMPIEZA")
master_metric = master[~master["IsLimpieza"] & master["OEE"].notna()].copy()
print(f"  master rows={len(master)}  with-OEE={len(master_metric)}",
      file=sys.stderr)

# ── KPIs per line ──────────────────────────────────────────────────────────
def line_kpis(df: pd.DataFrame) -> dict:
    by_line = {}
    for tren, g in df.groupby("TREN"):
        if pd.isna(tren):
            continue
        by_line[int(tren)] = {
            "n_of": int(len(g)),
            "oee_mean": float(g["OEE"].mean()),
            "disp_mean": float(g["Disponibilidad"].mean()),
            "rend_mean": float(g["Rendimiento"].mean()),
            "inef_mean": float(g["Ineficiencia"].mean()),
            "hl_total": float(g["HL"].sum()),
            "uds_total": float(g["UDS"].sum()),
            "cambios_total": float(g["NumCambios"].sum()),
            "llamadas_total": float(g["NumLlamadas"].sum()),
            "paro_total_h": float(g["TParo"].sum()),
        }
    return by_line


# ── Daily series per line ──────────────────────────────────────────────────
def daily_series(df: pd.DataFrame) -> dict:
    out = {}
    for tren, g in df.groupby("TREN"):
        if pd.isna(tren):
            continue
        agg = (g.groupby(g["Fecha Fin"].dt.date)
               .agg(oee=("OEE", "mean"),
                    hl=("HL", "sum"),
                    cambios=("NumCambios", "sum"),
                    llamadas=("NumLlamadas", "sum"),
                    paro=("TParo", "sum"),
                    n=("OF", "count"))
               .reset_index()
               .rename(columns={"Fecha Fin": "date"}))
        agg["date"] = agg["date"].astype(str)
        out[int(tren)] = df_to_records(agg)
    return out


# ── Top inefficient changes (cambios vs OEE) ───────────────────────────────
def worst_changes(df: pd.DataFrame, n: int = 30) -> list[dict]:
    g = df[df["NumCambios"].fillna(0) > 0].copy()
    g["score"] = g["NumCambios"].fillna(0) * (1 - g["OEE"])
    g = g.sort_values("score", ascending=False).head(n)
    cols = ["OF", "Fecha Fin", "TREN", "SKU", "Marca", "Familia",
            "NumCambios", "OEE", "HL", "C. Brand", "C. CAP", "C. Envase",
            "C. Palet", "C. Primario", "C. Producto", "C. Secundario",
            "C. Volum"]
    return df_to_records(g[cols])


# ── Top mantto incidents ───────────────────────────────────────────────────
def worst_mantto(df: pd.DataFrame, n: int = 30) -> list[dict]:
    g = df[df["TParo"].fillna(0) > 0].copy()
    g = g.sort_values("TParo", ascending=False).head(n)
    cols = ["OF", "Fecha Fin", "TREN", "SKU", "Marca", "Familia",
            "NumLlamadas", "TEspera", "TIntervencion", "TParo", "OEE"]
    return df_to_records(g[cols])


# ── SKU ranking ────────────────────────────────────────────────────────────
def sku_ranking(df: pd.DataFrame) -> list[dict]:
    g = (df.groupby(["SKU", "Marca", "Familia"], dropna=False)
         .agg(n=("OF", "count"),
              oee=("OEE", "mean"),
              hl=("HL", "sum"),
              cambios=("NumCambios", "sum"))
         .reset_index())
    g = g.sort_values("hl", ascending=False).head(40)
    return df_to_records(g)


# ── SKU × TREN heatmap (OEE) ───────────────────────────────────────────────
def sku_tren_heatmap(df: pd.DataFrame) -> dict:
    top_skus = (df.groupby("SKU")["HL"].sum()
                .sort_values(ascending=False).head(20).index.tolist())
    sub = df[df["SKU"].isin(top_skus)]
    pivot = sub.pivot_table(index="SKU", columns="TREN", values="OEE",
                            aggfunc="mean")
    pivot = pivot.reindex(top_skus)
    return {
        "skus": pivot.index.tolist(),
        "trenes": [int(c) for c in pivot.columns if not pd.isna(c)],
        "z": [[jsonable(v) for v in row] for row in pivot.values.tolist()],
    }


# ── Cambios totals per type per line ───────────────────────────────────────
def cambios_breakdown(df: pd.DataFrame) -> dict:
    cols = ["C. Brand", "C. CAP", "C. Envase", "C. Palet", "C. Primario",
            "C. Producto", "C. Secundario", "C. Volum"]
    out = {}
    for tren, g in df.groupby("TREN"):
        if pd.isna(tren):
            continue
        out[int(tren)] = {c.replace("C. ", ""): float(g[c].sum())
                          for c in cols}
    return out


# ── Cambios vs OEE scatter sample ──────────────────────────────────────────
def cambios_oee_scatter(df: pd.DataFrame, max_rows: int = 1500) -> list[dict]:
    g = df[df["NumCambios"].notna() & df["OEE"].notna()].copy()
    if len(g) > max_rows:
        g = g.sample(max_rows, random_state=42)
    cols = ["OF", "TREN", "SKU", "Marca", "NumCambios", "OEE", "HL"]
    return df_to_records(g[cols])


# ── Mantto scatter ─────────────────────────────────────────────────────────
def mantto_scatter(df: pd.DataFrame, max_rows: int = 1500) -> list[dict]:
    g = df[df["TIntervencion"].notna() & df["OEE"].notna()].copy()
    if len(g) > max_rows:
        g = g.sample(max_rows, random_state=42)
    cols = ["OF", "TREN", "SKU", "Marca", "NumLlamadas", "TIntervencion",
            "TParo", "OEE"]
    return df_to_records(g[cols])


# ── Change-format matrix ───────────────────────────────────────────────────
def change_matrix() -> dict:
    raw = pd.read_excel(F_TIEMPOS_CF, sheet_name="LATA_BARRIL", header=None)
    # The block we want starts when a row begins with "TREN 14".
    # In the inspected file: row 3 has ["TREN 14","1/3","1/2","Cambio Packaging","Cambio a Bandeja","Cambio Paletizado"...]
    # rows 4-8 hold matrix data for that single tren.
    matrices = {}
    n = len(raw)
    i = 0
    while i < n:
        v = raw.iloc[i, 0]
        if isinstance(v, str) and v.strip().startswith("TREN"):
            tren_label = v.strip()
            header = [str(x).strip() for x in raw.iloc[i, 1:].tolist()
                      if isinstance(x, str) and str(x).strip() and
                      str(x).strip().lower() != "nan"]
            labels = header
            mat = []
            # following rows: row index 0 is label, columns are minutes
            for j in range(1, len(labels) + 1):
                if i + j >= n:
                    break
                row = raw.iloc[i + j]
                row_label = str(row.iloc[0]).strip() if not pd.isna(row.iloc[0]) else ""
                if row_label.lower() == "nan" or row_label == "":
                    break
                mins = [parse_minutes(row.iloc[k + 1])
                        for k in range(len(labels))]
                mat.append({"from": row_label, "values": mins})
            matrices[tren_label] = {"labels": labels, "matrix": mat}
            i += len(labels) + 1
        else:
            i += 1
    return matrices


# ── Planificado vs real semana 2026-05-18 ──────────────────────────────────
def plan_vs_real() -> dict:
    plan = pd.read_excel(F_PLAN, sheet_name="Sheet1")
    real = pd.read_excel(F_PROD_REAL, sheet_name="Export")

    plan["Fecha ini."] = pd.to_datetime(plan["Fecha ini."], errors="coerce")
    plan["Fecha fin"] = pd.to_datetime(plan["Fecha fin"], errors="coerce")
    real["Fecha Fin"] = pd.to_datetime(real["Fecha Fin"], errors="coerce")

    plan_rows = []
    for _, r in plan.iterrows():
        hora = r.get("Hora ini.")
        hora_s = str(hora) if hora is not None and not pd.isna(hora) else None
        plan_rows.append({
            "material": jsonable(r.get("Material")),
            "denominacion": jsonable(r.get("Denominación")),
            "tren": jsonable(r.get("Tren")),
            "fecha_ini": jsonable(r.get("Fecha ini.")),
            "fecha_fin": jsonable(r.get("Fecha fin")),
            "hora_ini": hora_s,
            "turno": jsonable(r.get("Definición de turno")),
            "cntd_plan": jsonable(r.get("Cntd plan")),
            "cntd_jda": jsonable(r.get("Cntd JDA")),
            "secuencia": jsonable(r.get("Secuencia")),
        })

    real_rows = []
    for _, r in real.iterrows():
        real_rows.append({
            "of": jsonable(r.get("OF")),
            "fecha": jsonable(r.get("Fecha Fin")),
            "sku": jsonable(r.get("SKU")),
            "tren": jsonable(r.get("TREN")),
            "uds": jsonable(r.get("UDS")),
            "hl": jsonable(r.get("HL")),
            "oee": jsonable(r.get("OEE")),
            "marca": jsonable(r.get("Marca")),
            "familia": jsonable(r.get("Familia")),
            "envase": jsonable(r.get("Envase")),
        })
    return {"plan": plan_rows, "real": real_rows}


# ── Build everything ───────────────────────────────────────────────────────
print("Computing aggregates…", file=sys.stderr)
out = {
    "meta": {
        "generated_at": pd.Timestamp.now("UTC").strftime("%Y-%m-%dT%H:%M:%SZ"),
        "rows": {
            "oee": len(oee), "cambios": len(cambios), "mantto": len(mantto),
            "volumen": len(volumen), "tiempo": len(tiempo),
            "master": len(master), "master_with_oee": len(master_metric),
        },
        "trenes": sorted(int(t) for t in master_metric["TREN"].dropna().unique()),
        "date_min": str(master_metric["Fecha Fin"].min().date()),
        "date_max": str(master_metric["Fecha Fin"].max().date()),
        "familias": sorted(x for x in master_metric["Familia"].dropna().unique()
                            if x and x != "DefaultValue"),
        "marcas": sorted(x for x in master_metric["Marca"].dropna().unique()
                         if x and x not in ("Sin asignar", "DefaultValue")),
    },
    "kpis_by_line": line_kpis(master_metric),
    "daily_by_line": daily_series(master_metric),
    "cambios_breakdown": cambios_breakdown(master_metric),
    "cambios_oee_scatter": cambios_oee_scatter(master_metric),
    "worst_changes": worst_changes(master_metric),
    "mantto_scatter": mantto_scatter(master_metric),
    "worst_mantto": worst_mantto(master_metric),
    "sku_ranking": sku_ranking(master_metric),
    "sku_tren_heatmap": sku_tren_heatmap(master_metric),
    "change_matrix": change_matrix(),
    "plan_vs_real": plan_vs_real(),
}

with OUT.open("w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
print(f"Wrote {OUT}  ({OUT.stat().st_size/1024:.1f} KB)", file=sys.stderr)

# Also write a JS file that assigns to window.__DATA__ so that linewise.html
# can be opened directly via file:// (fetch() is blocked on file:// in most
# browsers; <script src=…> is not).
with OUT_JS.open("w", encoding="utf-8") as f:
    f.write("window.__DATA__ = ")
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    f.write(";\n")
print(f"Wrote {OUT_JS}  ({OUT_JS.stat().st_size/1024:.1f} KB)",
      file=sys.stderr)
