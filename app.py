"""LineWise — Gradio app for the Hugging Face Space.

Upload a Damm planning Excel (`Planificado producciones` or `Diario Hl_Planif`).
Two actions:
  • Predecir OEE      → per-block OEE forecast (p10 / p50 / p90).
  • Optimizar plan    → V2 flexible-scheduling solver: reassigns each OF to the
                        best (línea × día × turno) subject to deadline +
                        LINE_FORMAT_COMPAT + historical feasibility.
                        Supports p50 (expected) and p90 (aggressive ceiling) modes.
"""

from __future__ import annotations

from pathlib import Path

import gradio as gr
import pandas as pd

from engine import (
    parse_planning_excel,
    build_feature_rows,
    predict_blocks,
    optimize_plan_v3,
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


def _optimize_pipeline_v3(xlsx_file: str, objective: str) -> tuple[dict, dict]:
    blocks, meta = parse_planning_excel(xlsx_file, FEASIBILITY)
    if blocks.empty:
        return {}, meta
    result = optimize_plan_v3(
        blocks,
        lookups_dir=str(LOOKUPS),
        models_dir=str(MODELS),
        objective=objective,
        time_budget_sec=75,
        max_iter=30,
        top_k_prevs=20,
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


def _per_line_compare_table_v2(per_line: dict, objective: str) -> pd.DataFrame:
    rows = []
    obj_label = "p50 (esperado)" if objective == "p50" else "p90 (techo)"
    for ln in sorted(per_line.keys()):
        v = per_line[ln]
        rows.append({
            "Línea":                       f"L{ln}",
            f"OEE actual ({obj_label})":   _fmt_pct(v["baseline"]),
            f"OEE optimizada":              _fmt_pct(v["optimized"]),
            "Δ pts":                        f"{v['delta_pts']:+.2f}",
            "Bloques (antes → después)":   f"{v['n_blocks_baseline']} → {v['n_blocks_optimized']}",
        })
    return pd.DataFrame(rows)


def _swap_log_v3_table(swap_log: list[dict]) -> pd.DataFrame:
    if not swap_log:
        return pd.DataFrame(columns=["#", "SKU", "Desde", "Hacia", "ΔOEE pts",
                                     "Δ cambio min", "Δ mant h", "Agrupa formato", "Descripción"])
    rows = []
    for i, s in enumerate(swap_log, 1):
        rows.append({
            "#":              i,
            "SKU":            s["sku"],
            "Desde":          f"L{s['from_linea']} / {s['from_fecha']} / {s['from_turno']}",
            "Hacia":          f"L{s['to_linea']} / {s['to_fecha']} / {s['to_turno']}",
            "ΔOEE pts":       f"{s.get('delta_oee_pts', 0):+.2f}",
            "Δ cambio min":   f"{s.get('delta_changeover_min', 0):+.0f}",
            "Δ mant h":       f"{s.get('delta_maint_hours_close', 0):+.0f}",
            "Agrupa formato": "Sí" if s.get("same_format_neighbour") else "",
            "Descripción":    s.get("description", ""),
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


def optimize_v3(file_obj, aggressive: bool, progress=gr.Progress(track_tqdm=False)):
    if file_obj is None:
        return ("⚠️ Sube un fichero .xlsx primero.",
                pd.DataFrame(), pd.DataFrame())
    path = file_obj if isinstance(file_obj, str) else file_obj.name
    objective = "p90" if aggressive else "p50"
    obj_label = "p90 (perseguir techo)" if aggressive else "p50 (esperado)"
    progress(0.05, desc=f"Parseando Excel (modo {obj_label})…")
    try:
        progress(0.15, desc="Construyendo lookup prev-aware (~30s)…")
        result, meta = _optimize_pipeline_v3(path, objective)
    except Exception as exc:
        return (f"❌ Error optimizando: {exc}", pd.DataFrame(), pd.DataFrame())

    if not result or not result.get("best_blocks", pd.DataFrame()).shape[0]:
        return ("⚠️ No se han encontrado bloques válidos para optimizar.",
                pd.DataFrame(), pd.DataFrame())

    baseline = result["baseline_score"]
    optimized = result["optimized_score"]
    delta_pts = result["delta_oee_pts"]
    n_changes = result["n_changes"]
    elapsed = result["elapsed_sec"]
    audit_ok = result["audit"].get("all_ok", True)
    weekly = result.get("weekly_summary", "")

    progress(0.95, desc="Generando resumen…")
    status_emoji = "✅" if audit_ok else "⚠️"

    summary_md = f"""
### Resumen — Optimización V3 (modo: {obj_label})
- **OEE actual** (HL-ponderada, {objective}): **{_fmt_pct(baseline)}**
- **OEE optimizada** (HL-ponderada, {objective}): **{_fmt_pct(optimized)}**
- **Ganancia:** **{delta_pts:+.2f} puntos de OEE**
- **{n_changes}** reasignaciones en **{elapsed:.1f} s**  {status_emoji}

#### Resumen operacional
{weekly}

> V3 usa un **lookup prev-aware** (predicción para cada combinación de **(OF, línea×día×turno, SKU anterior)**)
> en lugar del lookup ciego de V2. Cada movimiento se evalúa con el contexto *real* de
> cascada y se reporta con métricas operacionales explícitas:
> **ΔOEE pts · Δ minutos de cambio · Δ horas a mantenimiento · si agrupa formato**.
> Respeta plazos, volúmenes y la compatibilidad línea-formato confirmada por Damm.
""".strip()

    return (summary_md,
            _per_line_compare_table_v2(result["per_line"], objective),
            _swap_log_v3_table(result["swap_log"]))


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
    - **Predecir OEE** — detecta el formato y devuelve la predicción de OEE (p10 / p50 / p90) por bloque.
    - **Optimizar plan** — reasigna cada OF a la mejor combinación de **línea × día × turno** respetando plazos, volúmenes y la compatibilidad línea-formato. Activa el modo agresivo para perseguir el techo p90.

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
            aggressive = gr.Checkbox(
                label="Modo agresivo (perseguir el techo p90)",
                value=False,
                info=(
                    "Activado: optimiza el techo p90 — recomendaciones más ambiciosas. "
                    "Desactivado: optimiza el OEE esperado p50."
                ),
            )
            gr.Markdown(
                "> El sistema usa un modelo **LightGBM quantile** entrenado con "
                "~2 200 OFs históricos de 2025. **`p90`** = techo de OEE razonablemente "
                "alcanzable. El optimizador respeta los **plazos y volúmenes** del plan "
                "original y la **compatibilidad línea-formato** confirmada por Damm."
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
                "entre 30 s y 75 s — verás el progreso encima del botón. Activa el "
                "**Modo agresivo** para perseguir el techo p90 con movimientos más ambiciosos."
            )
            with gr.Row():
                opt_line_tbl = gr.Dataframe(
                    label="Por línea: actual vs optimizada",
                    interactive=False,
                )
            opt_swap_tbl = gr.Dataframe(
                label="Reasignaciones aplicadas",
                interactive=False, wrap=True,
            )

    btn_predict.click(
        fn=predict,
        inputs=file_in,
        outputs=[summary, line_tbl, blocks_tbl, drivers_tbl],
    )
    btn_optimize.click(
        fn=optimize_v3,
        inputs=[file_in, aggressive],
        outputs=[opt_summary, opt_line_tbl, opt_swap_tbl],
    )

if __name__ == "__main__":
    demo.launch()
