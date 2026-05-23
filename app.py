"""LineWise — Gradio app for the Hugging Face Space.

Upload a Damm planning Excel (`Planificado producciones` or `Diario Hl_Planif`) →
get per-block predicted OEE (p10 / p50 / p90), the SHAP drivers of each
prediction, and a weekly summary per line.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import gradio as gr
import pandas as pd

from engine import parse_planning_excel, build_feature_rows, predict_blocks

ROOT = Path(__file__).resolve().parent
LOOKUPS = ROOT / "lookups"
MODELS = ROOT / "models"
FEASIBILITY = LOOKUPS / "sku_line_feasibility.parquet"

DAMM_RED = "#c8102e"


# ------------------------------------------------------------------ pipeline
def _run_pipeline(xlsx_file: str) -> tuple[pd.DataFrame, dict]:
    blocks, meta = parse_planning_excel(xlsx_file, FEASIBILITY)
    if blocks.empty:
        return blocks, meta
    features = build_feature_rows(blocks, LOOKUPS)
    preds = predict_blocks(features, models_dir=str(MODELS), top_k_shap=3)
    return preds, meta


# ------------------------------------------------------------------ helpers
def _fmt_pct(x: float) -> str:
    if pd.isna(x):
        return "—"
    return f"{x * 100:.1f}%"


def _block_table(preds: pd.DataFrame) -> pd.DataFrame:
    cols = ["linea", "sku", "marca", "fecha", "turno",
            "p10", "p50", "p90", "confidence", "feasible", "feas_reason"]
    cols = [c for c in cols if c in preds.columns]
    out = preds[cols].copy()
    out["fecha"] = out["fecha"].dt.strftime("%Y-%m-%d") if "fecha" in out.columns else None
    for c in ("p10", "p50", "p90"):
        if c in out.columns:
            out[c] = (out[c] * 100).round(1).astype(str) + "%"
    out.columns = [c.replace("_", " ").title() for c in out.columns]
    return out


def _line_summary(preds: pd.DataFrame) -> pd.DataFrame:
    if preds.empty:
        return pd.DataFrame(columns=["Línea", "# bloques", "OEE p50 medio", "OEE p90 medio", "% feasible"])
    g = preds.groupby("linea").agg(
        n=("sku", "size"),
        p50_avg=("p50", "mean"),
        p90_avg=("p90", "mean"),
        feasible_rate=("feasible", "mean"),
    ).reset_index()
    g.columns = ["Línea", "# bloques", "OEE p50 medio", "OEE p90 medio", "% feasible"]
    g["OEE p50 medio"] = g["OEE p50 medio"].map(_fmt_pct)
    g["OEE p90 medio"] = g["OEE p90 medio"].map(_fmt_pct)
    g["% feasible"]    = (g["% feasible"] * 100).round(0).astype(int).astype(str) + "%"
    return g


def _top_drivers_table(preds: pd.DataFrame, n_rows: int = 20) -> pd.DataFrame:
    if preds.empty or "top_features" not in preds.columns:
        return pd.DataFrame(columns=["Línea", "SKU", "Fecha", "Turno", "Driver", "SHAP"])
    rows = []
    sub = preds.head(n_rows)
    for _, r in sub.iterrows():
        for tf in r.get("top_features") or []:
            rows.append({
                "Línea":  r["linea"],
                "SKU":    r["sku"],
                "Fecha":  r["fecha"].strftime("%Y-%m-%d") if pd.notna(r["fecha"]) else "",
                "Turno":  r.get("turno") or "",
                "Driver": tf["name"],
                "SHAP":   f"{tf['shap']:+.4f}",
            })
    return pd.DataFrame(rows)


# ------------------------------------------------------------------ Gradio callback
def predict(file_obj):
    if file_obj is None:
        return ("⚠️ Sube un fichero .xlsx (Planificado producciones o Diario Hl_Planif).",
                pd.DataFrame(), pd.DataFrame(), pd.DataFrame())
    path = file_obj if isinstance(file_obj, str) else file_obj.name
    try:
        preds, meta = _run_pipeline(path)
    except Exception as exc:
        return (f"❌ Error parseando el fichero: {exc}",
                pd.DataFrame(), pd.DataFrame(), pd.DataFrame())

    if preds.empty:
        return (f"⚠️ El fichero se ha parseado pero no contiene bloques válidos. Formato detectado: **{meta['source']}**.",
                pd.DataFrame(), pd.DataFrame(), pd.DataFrame())

    n_blocks = meta["n_blocks"]
    n_infeas = meta["n_infeasible"]
    week_p50 = preds["p50"].mean()
    week_p90 = preds["p90"].mean()
    src = meta["source"]
    warning = ""
    if meta["warnings"]:
        warning = "\n\n> ⚠️ " + " ".join(meta["warnings"])

    summary_md = f"""
### Resumen
- **Formato detectado:** `{src}`
- **Bloques analizados:** {n_blocks}  ·  **No factibles** (sin histórico suficiente): {n_infeas}
- **OEE semanal estimado (p50 medio):** **{_fmt_pct(week_p50)}**  ·  techo p90 medio: {_fmt_pct(week_p90)}
{warning}
""".strip()

    return (summary_md, _line_summary(preds), _block_table(preds), _top_drivers_table(preds))


# ------------------------------------------------------------------ UI
with gr.Blocks(
    title="LineWise — OEE forecaster",
    theme=gr.themes.Soft(primary_hue="red", neutral_hue="slate"),
    css="""
        .gradio-container { max-width: 1280px !important; margin: 0 auto; }
        h1, h2, h3 { color: #c8102e; }
        footer { display: none !important; }
    """,
) as demo:
    gr.Markdown("""
    # LineWise · OEE forecaster
    Sube el Excel de planificación de la semana (**`Planificado producciones`** o **`Diario Hl_Planif`**).
    El sistema detecta el formato, enriquece cada bloque con el histórico de 2025, y devuelve la predicción de OEE (p10 / p50 / p90) por bloque.

    *Damm × Engineering HUB Hackathon · canning lines 14 · 17 · 19 at El Prat.*
    """)

    with gr.Row():
        with gr.Column(scale=1):
            file_in = gr.File(
                label="Planning Excel (.xlsx)",
                file_types=[".xlsx", ".xls"],
                type="filepath",
            )
            go = gr.Button("Predecir OEE", variant="primary")
            gr.Markdown(
                "> El sistema usa un modelo LightGBM quantile entrenado con "
                "~2 200 OFs históricos de 2025. La predicción **`p90`** representa el techo "
                "de OEE razonablemente alcanzable para esa combinación."
            )

        with gr.Column(scale=2):
            summary = gr.Markdown(label="Resumen")
            line_tbl = gr.Dataframe(label="Resumen por línea", interactive=False)

    with gr.Tabs():
        with gr.TabItem("Predicciones por bloque"):
            blocks_tbl = gr.Dataframe(label=None, interactive=False, wrap=True)
        with gr.TabItem("Drivers (SHAP) — primeras 20 filas"):
            drivers_tbl = gr.Dataframe(label=None, interactive=False, wrap=True)

    go.click(
        fn=predict,
        inputs=file_in,
        outputs=[summary, line_tbl, blocks_tbl, drivers_tbl],
    )

if __name__ == "__main__":
    demo.launch()
