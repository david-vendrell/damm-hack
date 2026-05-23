"""LineWise — Gradio app for the Hugging Face Space.

Upload a Damm planning Excel (`Planificado producciones` or `Diario Hl_Planif`).
Two actions:
  • Predecir OEE      → per-block OEE forecast (p10 / p50 / p90).
  • Optimizar plan    → wrap the model in a search loop, propose a better
                        feasible arrangement, return the swap log + before/after.
"""

from __future__ import annotations

from pathlib import Path

import gradio as gr
import pandas as pd

from engine import (
    parse_planning_excel,
    build_feature_rows,
    predict_blocks,
    optimize_plan,
)

ROOT = Path(__file__).resolve().parent
LOOKUPS = ROOT / "lookups"
MODELS = ROOT / "models"
FEASIBILITY = LOOKUPS / "sku_line_feasibility.parquet"


# ------------------------------------------------------------------ pipelines
def _predict_pipeline(xlsx_file: str) -> tuple[pd.DataFrame, dict]:
    blocks, meta = parse_planning_excel(xlsx_file, FEASIBILITY)
    if blocks.empty:
        return blocks, meta
    features = build_feature_rows(blocks, LOOKUPS)
    preds = predict_blocks(features, models_dir=str(MODELS), top_k_shap=3)
    return preds, meta


def _optimize_pipeline(xlsx_file: str) -> tuple[dict, dict]:
    blocks, meta = parse_planning_excel(xlsx_file, FEASIBILITY)
    if blocks.empty:
        return {}, meta
    result = optimize_plan(
        blocks,
        lookups_dir=str(LOOKUPS),
        models_dir=str(MODELS),
        max_iter=10,
        enable_cross_line=True,
        time_budget_sec=60,        # cap for the Space — keep request <60 s
    )
    return result, meta


# ------------------------------------------------------------------ helpers
def _fmt_pct(x) -> str:
    if x is None or (isinstance(x, float) and pd.isna(x)):
        return "—"
    return f"{x * 100:.1f}%"


def _block_table(preds: pd.DataFrame) -> pd.DataFrame:
    cols = ["linea", "sku", "marca", "fecha", "turno",
            "p10", "p50", "p90", "confidence", "feasible", "feas_reason"]
    cols = [c for c in cols if c in preds.columns]
    out = preds[cols].copy()
    if "fecha" in out.columns:
        out["fecha"] = pd.to_datetime(out["fecha"]).dt.strftime("%Y-%m-%d")
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
                "Fecha":  pd.to_datetime(r["fecha"]).strftime("%Y-%m-%d"),
                "Turno":  r.get("turno") or "",
                "Driver": tf["name"],
                "SHAP":   f"{tf['shap']:+.4f}",
            })
    return pd.DataFrame(rows)


def _swap_log_table(swap_log: list[dict]) -> pd.DataFrame:
    if not swap_log:
        return pd.DataFrame(columns=["#", "Tipo", "Línea", "Descripción", "Δ OEE pts"])
    rows = []
    for s in swap_log:
        rows.append({
            "#":           s.get("iteration", ""),
            "Tipo":        s.get("kind", ""),
            "Línea":       s.get("linea", ""),
            "Descripción": s.get("description", ""),
            "Δ OEE pts":   f"{s.get('delta_pts_global', 0):+.3f}",
        })
    return pd.DataFrame(rows)


def _per_line_compare_table(per_line: dict) -> pd.DataFrame:
    rows = []
    for ln in sorted(per_line.keys()):
        v = per_line[ln]
        rows.append({
            "Línea":          f"L{ln}",
            "OEE actual":     _fmt_pct(v["baseline"]),
            "OEE optimizada": _fmt_pct(v["optimized"]),
            "Δ pts":          f"{v['delta_pts']:+.2f}",
        })
    return pd.DataFrame(rows)


# ------------------------------------------------------------------ Gradio callbacks
def predict(file_obj):
    if file_obj is None:
        return ("⚠️ Sube un fichero .xlsx (Planificado producciones o Diario Hl_Planif).",
                pd.DataFrame(), pd.DataFrame(), pd.DataFrame())
    path = file_obj if isinstance(file_obj, str) else file_obj.name
    try:
        preds, meta = _predict_pipeline(path)
    except Exception as exc:
        return (f"❌ Error parseando el fichero: {exc}",
                pd.DataFrame(), pd.DataFrame(), pd.DataFrame())

    if preds.empty:
        return (f"⚠️ El fichero se ha parseado pero no contiene bloques válidos. "
                f"Formato detectado: **{meta['source']}**.",
                pd.DataFrame(), pd.DataFrame(), pd.DataFrame())

    n_blocks = meta["n_blocks"]
    n_infeas = meta["n_infeasible"]
    week_p50 = preds["p50"].mean()
    week_p90 = preds["p90"].mean()
    src = meta["source"]
    warning = ""
    if meta.get("warnings"):
        warning = "\n\n> ⚠️ " + " ".join(meta["warnings"])

    summary_md = f"""
### Resumen — Predicción
- **Formato detectado:** `{src}`
- **Bloques analizados:** {n_blocks}  ·  **No factibles:** {n_infeas}
- **OEE semanal estimado (p50 medio):** **{_fmt_pct(week_p50)}**  ·  techo p90 medio: {_fmt_pct(week_p90)}
{warning}
""".strip()

    return (summary_md, _line_summary(preds), _block_table(preds), _top_drivers_table(preds))


def optimize(file_obj, progress=gr.Progress(track_tqdm=False)):
    if file_obj is None:
        return ("⚠️ Sube un fichero .xlsx primero.",
                pd.DataFrame(), pd.DataFrame())
    path = file_obj if isinstance(file_obj, str) else file_obj.name
    progress(0.05, desc="Parseando Excel…")
    try:
        progress(0.20, desc="Construyendo features y baseline…")
        result, meta = _optimize_pipeline(path)
    except Exception as exc:
        return (f"❌ Error optimizando: {exc}", pd.DataFrame(), pd.DataFrame())

    if not result:
        return ("⚠️ No se han encontrado bloques válidos para optimizar.",
                pd.DataFrame(), pd.DataFrame())

    progress(0.95, desc="Generando resumen…")
    baseline = result["baseline_score"]
    optimized = result["optimized_score"]
    delta_pts = result["delta_oee_pts"]
    n_swaps = result["n_iterations"]
    elapsed = result["elapsed_sec"]
    trunc = " · ⏱️ tiempo agotado, mostrando el mejor encontrado" if result.get("truncated") else ""

    summary_md = f"""
### Resumen — Optimización
- **OEE actual** (HL-ponderada, p50):  **{_fmt_pct(baseline)}**
- **OEE optimizada** (HL-ponderada, p50):  **{_fmt_pct(optimized)}**
- **Ganancia:**  **{delta_pts:+.2f} puntos de OEE**
- **{n_swaps}** intercambios aplicados en **{elapsed:.1f} s**{trunc}

> El optimizador explora **intercambios dentro de cada línea** y **movimientos entre líneas**
> (sólo para SKUs físicamente compatibles, según Damm: L14 = 1/3 + 1/2, L17 = 1/3,
> L19 = 1/3 + 1/2 + 2/5), y conserva los HL totales por SKU.
""".strip()

    return (summary_md,
            _per_line_compare_table(result["per_line"]),
            _swap_log_table(result["swap_log"]))


# ------------------------------------------------------------------ UI
with gr.Blocks(
    title="LineWise — OEE forecaster & optimizer",
    theme=gr.themes.Soft(primary_hue="red", neutral_hue="slate"),
    css="""
        .gradio-container { max-width: 1280px !important; margin: 0 auto; }
        h1, h2, h3 { color: #c8102e; }
        footer { display: none !important; }
    """,
) as demo:
    gr.Markdown("""
    # LineWise · OEE forecaster & optimizer
    Sube el Excel de planificación de la semana (**`Planificado producciones`** o **`Diario Hl_Planif`**).
    - **Predecir OEE** — detecta el formato, enriquece cada bloque con el histórico de 2025 y devuelve la predicción (p10 / p50 / p90) por bloque.
    - **Optimizar plan** — además, ejecuta una búsqueda local que prueba intercambios y movimientos entre líneas para proponer una mejor disposición.

    *Damm × Engineering HUB Hackathon · canning lines 14 · 17 · 19 at El Prat.*
    """)

    with gr.Row():
        with gr.Column(scale=1):
            file_in = gr.File(
                label="Planning Excel (.xlsx)",
                file_types=[".xlsx", ".xls"],
                type="filepath",
            )
            with gr.Row():
                btn_predict  = gr.Button("Predecir OEE",  variant="primary")
                btn_optimize = gr.Button("Optimizar plan", variant="secondary")
            gr.Markdown(
                "> El sistema usa un modelo **LightGBM quantile** entrenado con "
                "~2 200 OFs históricos de 2025. **`p90`** = techo de OEE razonablemente "
                "alcanzable para esa combinación. El optimizador respeta la "
                "**compatibilidad línea-formato** confirmada por Damm."
            )

        with gr.Column(scale=2):
            summary = gr.Markdown()
            line_tbl = gr.Dataframe(label="Resumen por línea", interactive=False)

    with gr.Tabs():
        with gr.TabItem("Predicciones por bloque"):
            blocks_tbl = gr.Dataframe(interactive=False, wrap=True)
        with gr.TabItem("Drivers (SHAP) — primeras 20 filas"):
            drivers_tbl = gr.Dataframe(interactive=False, wrap=True)
        with gr.TabItem("Alternativas recomendadas (optimizador)"):
            opt_summary = gr.Markdown(
                "> Pulsa **Optimizar plan** tras subir un fichero. La búsqueda tarda "
                "entre 30 s y 60 s — verás el progreso encima del botón."
            )
            with gr.Row():
                opt_line_tbl = gr.Dataframe(
                    label="Por línea: actual vs optimizada",
                    interactive=False,
                )
            opt_swap_tbl = gr.Dataframe(
                label="Intercambios aplicados",
                interactive=False, wrap=True,
            )

    btn_predict.click(
        fn=predict,
        inputs=file_in,
        outputs=[summary, line_tbl, blocks_tbl, drivers_tbl],
    )
    btn_optimize.click(
        fn=optimize,
        inputs=file_in,
        outputs=[opt_summary, opt_line_tbl, opt_swap_tbl],
    )

if __name__ == "__main__":
    demo.launch()
