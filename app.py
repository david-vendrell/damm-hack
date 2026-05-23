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

import json
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


def _optimize_pipeline_v3(
    xlsx_file: str,
    objective: str,
    outages: list[dict] | None = None,
    priority_ofs: list[dict] | None = None,
) -> tuple[dict, dict]:
    blocks, meta = parse_planning_excel(xlsx_file, FEASIBILITY)
    if blocks.empty:
        return {}, meta
    # HF Space free tier is ~5-8x slower than local on CPU-heavy LightGBM
    # inference. We give a generous time budget and a smaller prev pool so
    # the precompute finishes well before the search budget runs out.
    result = optimize_plan_v3(
        blocks,
        lookups_dir=str(LOOKUPS),
        models_dir=str(MODELS),
        objective=objective,
        time_budget_sec=240,   # was 75
        max_iter=30,
        top_k_prevs=10,        # was 20 — halves lookup size + precompute time
        outages=outages,
        priority_ofs=priority_ofs,
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
        return pd.DataFrame(columns=["Línea", "# bloques", "HL planificados",
                                     "OEE p50 (HL-ponderada)", "OEE p90 (HL-ponderada)", "% feasible"])
    def _wavg(grp, col):
        hl = grp["hl"].fillna(0).clip(lower=0)
        if hl.sum() == 0:
            return float(grp[col].mean())
        return float((grp[col] * hl).sum() / hl.sum())
    rows = []
    for linea, grp in preds.groupby("linea"):
        rows.append({
            "Línea":                       f"L{int(linea)}",
            "# bloques":                   int(len(grp)),
            "HL planificados":             int(grp["hl"].sum()) if "hl" in grp.columns else 0,
            "OEE p50 (HL-ponderada)":      _fmt_pct(_wavg(grp, "p50")),
            "OEE p90 (HL-ponderada)":      _fmt_pct(_wavg(grp, "p90")),
            "% feasible":                  f"{int(round(grp['feasible'].mean()*100))}%",
        })
    return pd.DataFrame(rows)


def _factory_wide_oee(preds: pd.DataFrame, col: str) -> float:
    """HL-weighted OEE across ALL blocks (factory-wide, all 3 líneas)."""
    if preds.empty or col not in preds.columns:
        return 0.0
    hl = preds["hl"].fillna(0).clip(lower=0) if "hl" in preds.columns else None
    if hl is None or hl.sum() == 0:
        return float(preds[col].mean())
    return float((preds[col] * hl).sum() / hl.sum())


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
    obj_label = "p50" if objective == "p50" else "p90"
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


def _per_day_factory_table(per_day: list[dict], objective: str,
                           maintenance_per_day: dict | None = None) -> pd.DataFrame:
    """Factory-wide (3 líneas combinadas) HL-weighted OEE per día.

    Recommended view: no Simpson's paradox here because the weighting is
    factory-scope, so the per-día numbers compose into the headline by HL.
    """
    if not per_day:
        return pd.DataFrame(columns=["Día", "Bloques (act→opt)", "HL del día",
                                     f"OEE actual ({objective})", "OEE optimizada",
                                     "Δ pts", "Mantenimiento"])
    rows = []
    day_names_es = {0: "Lun", 1: "Mar", 2: "Mié", 3: "Jue", 4: "Vie", 5: "Sáb", 6: "Dom"}
    maintenance_per_day = maintenance_per_day or {}
    for d in per_day:
        dt = pd.Timestamp(d["fecha"])
        mant_badge = maintenance_per_day.get(d["fecha"], "")
        rows.append({
            "Día":                          f"{day_names_es[dt.weekday()]} {d['fecha']}",
            "Bloques (act→opt)":            f"{d['n_blocks_baseline']} → {d['n_blocks_optimized']}",
            "HL del día":                   int(d.get("hl_total", 0)),
            f"OEE actual ({objective})":    _fmt_pct(d["baseline"]),
            "OEE optimizada":               _fmt_pct(d["optimized"]),
            "Δ pts":                        f"{d['delta_pts']:+.2f}",
            "Mantenimiento":                mant_badge,
        })
    return pd.DataFrame(rows)


def _maintenance_per_day(per_day: list[dict]) -> dict[str, str]:
    """For each día in per_day, return a short Spanish badge listing the
    scheduled CF Prat events on that día. e.g. `🛠 L17 LIMPIEZA · L19 LIMPIEZA`.
    """
    if not per_day:
        return {}
    from engine.maintenance_blocker import projected_blocked_slots, load_schedule
    sched = load_schedule(ROOT / "lookups")
    if sched.empty:
        return {}
    fechas = [pd.Timestamp(d["fecha"]).date() for d in per_day]
    blocks = projected_blocked_slots(fechas, schedule=sched)
    out: dict[str, str] = {}
    for d in per_day:
        f_iso = d["fecha"]
        f_date = pd.Timestamp(f_iso).date()
        events = sorted(
            {f"L{b.linea} {b.block_event}" for b in blocks if b.fecha == f_date}
        )
        out[f_iso] = "🛠 " + " · ".join(events) if events else ""
    return out


def _swap_log_v3_table(swap_log: list[dict]) -> pd.DataFrame:
    if not swap_log:
        return pd.DataFrame(columns=["#", "Tipo", "SKU", "Desde", "Hacia", "ΔOEE pts",
                                     "Δ cambio min", "Δ mant h", "Agrupa formato", "Descripción"])
    type_label = {
        "optimization":           "⚙️ Optimización",
        "priority_insert":        "⭐ Prioritario",
        "eviction":               "⚠️ Desplazado",
        "displaced_reassignment": "↪️ Realojo",
    }
    def _fmt_loc(linea, fecha, turno):
        if linea is None or fecha is None:
            return "—"
        return f"L{linea} / {fecha} / {turno}"
    rows = []
    for i, s in enumerate(swap_log, 1):
        mt = s.get("move_type", "optimization")
        rows.append({
            "#":              i,
            "Tipo":           type_label.get(mt, mt),
            "SKU":            s["sku"],
            "Desde":          _fmt_loc(s.get("from_linea"), s.get("from_fecha"), s.get("from_turno")),
            "Hacia":          _fmt_loc(s.get("to_linea"), s.get("to_fecha"), s.get("to_turno")),
            "ΔOEE pts":       f"{s.get('delta_oee_pts', 0):+.2f}",
            "Δ cambio min":   f"{s.get('delta_changeover_min', 0):+.0f}" if s.get('delta_changeover_min') is not None else "—",
            "Δ mant h":       f"{s.get('delta_maint_hours_close', 0):+.0f}" if s.get('delta_maint_hours_close') is not None else "—",
            "Agrupa formato": "Sí" if s.get("same_format_neighbour") else "",
            "Descripción":    s.get("description", ""),
        })
    return pd.DataFrame(rows)


def _parse_json_param(raw: str | None, name: str) -> tuple[list[dict], str | None]:
    """Parse an optional JSON-string param from the UI. Returns (list, error)."""
    if raw is None:
        return [], None
    raw = raw.strip()
    if not raw:
        return [], None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        return [], f"`{name}` no es JSON válido: {exc.msg} (línea {exc.lineno}, col {exc.colno})"
    if not isinstance(parsed, list):
        return [], f"`{name}` debe ser una lista JSON (`[...]`), no {type(parsed).__name__}"
    return parsed, None


def _incidencias_section(incidencias: dict) -> str:
    """Render the Incidencias summary as Markdown. Empty string if no incidents."""
    if not incidencias:
        return ""
    out_list   = incidencias.get("outages_applied") or []
    prio_req   = incidencias.get("priority_ofs_requested") or []
    prio_done  = int(incidencias.get("priority_ofs_placed", 0) or 0)
    prio_fail  = incidencias.get("priority_ofs_failed") or []
    n_evict    = int(incidencias.get("evictions", 0) or 0)
    if not (out_list or prio_req):
        return ""
    bits: list[str] = []
    if out_list:
        bits.append(f"- ⛔ **{len(out_list)} outage(s) declarado(s)**: " +
                    ", ".join(f"L{o.get('linea')} {o.get('fecha')} {o.get('turno')}"
                              for o in out_list[:6]) +
                    ("…" if len(out_list) > 6 else ""))
    if prio_req:
        if prio_fail:
            bits.append(
                f"- ⭐ **{prio_done}/{len(prio_req)} OF(s) prioritario(s)** colocado(s) "
                f"· ⚠️ {len(prio_fail)} sin slot factible: " +
                ", ".join(f"{f.get('sku')} (deadline {f.get('deadline')})" for f in prio_fail[:4])
            )
        else:
            bits.append(f"- ⭐ **{prio_done}/{len(prio_req)} OF(s) prioritario(s)** colocado(s)")
    if n_evict:
        bits.append(f"- ↪️ **{n_evict} OF(s) desplazado(s)** y reasignado(s) por inserción prioritaria")
    return "\n#### ⚡ Incidencias gestionadas\n" + "\n".join(bits) + "\n"


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
    week_p50 = _factory_wide_oee(preds, "p50")
    week_p90 = _factory_wide_oee(preds, "p90")
    total_hl = int(preds["hl"].sum()) if "hl" in preds.columns else 0
    src = meta["source"]

    # OEE decomposition (Disp × Rend × Cal) — only present if multi-label
    # models have been trained (Gap 1). Falls back silently if absent.
    decomp_md = ""
    if all(f"{p}_p50" in preds.columns for p in ("disp", "rend", "cal")):
        disp = _factory_wide_oee(preds, "disp_p50")
        rend = _factory_wide_oee(preds, "rend_p50")
        cal  = _factory_wide_oee(preds, "cal_p50")
        product = disp * rend * cal
        decomp_md = (
            f"\n\n#### 🔬 Decomposición OEE (Damm formula: OEE = Disp × Rend × Cal)\n"
            f"| Componente       | Predicho (HL-pond p50) |\n"
            f"|------------------|-----------------------:|\n"
            f"| **Disponibilidad** | **{_fmt_pct(disp)}** |\n"
            f"| **Rendimiento**    | **{_fmt_pct(rend)}** |\n"
            f"| **Calidad**        | **{_fmt_pct(cal)}** |\n"
            f"| Producto Disp×Rend×Cal | {_fmt_pct(product)} |\n"
            f"| OEE compuesto (modelo) | {_fmt_pct(week_p50)} |\n\n"
            f"> Las dos últimas filas no son idénticas porque cada componente se "
            f"entrena como un modelo aparte; usa el OEE compuesto como número "
            f"operativo, y la decomposición como diagnóstico de **qué está "
            f"bajando** (downtime ↓ Disponibilidad, ritmo lento ↓ Rendimiento, "
            f"rechazos ↓ Calidad).\n"
        )

    # Maintenance-conflict breakdown
    mant_md = ""
    if "feas_reason" in preds.columns:
        mant_rows = preds[
            preds["feas_reason"].astype(str).str.contains("LIMPIEZA|MANTENIMIENTO", na=False)
        ]
        if len(mant_rows):
            unique_conflicts = mant_rows[["linea", "fecha", "turno", "feas_reason"]].drop_duplicates(
                subset=["linea", "fecha", "turno"]
            )
            n_unique_slots = len(unique_conflicts)
            mant_md = (
                f"\n\n> 🛠️ **{len(mant_rows)} OFs en {n_unique_slots} slots "
                f"coinciden con mantenimiento programado** (CF Prat 5-TURNOS).  "
                f"Estos OFs aparecen marcados como infactibles abajo — el optimizador "
                f"los reubicará automáticamente en slots libres.\n"
            )

    warning = ""
    if meta.get("warnings"):
        warning = "\n\n> ⚠️ " + " ".join(meta["warnings"])

    summary_md = f"""
### 🏭 OEE de la fábrica — 3 líneas combinadas (HL-ponderada)

|                      | OEE esperado (p50)      | Techo razonable (p90)   |
|----------------------|------------------------:|------------------------:|
| **Predicho para la semana** | **{_fmt_pct(week_p50)}** | **{_fmt_pct(week_p90)}** |

- **Formato detectado:** `{src}`
- **Bloques analizados:** {n_blocks}  ·  **No factibles:** {n_infeas}
- **HL totales planificados:** **{total_hl:,}**

> Estos números son la OEE de la **fábrica como conjunto** (HL-ponderada
> sobre las 3 líneas). La tabla *Resumen por línea* desglosa los mismos
> números por L14 / L17 / L19 para diagnóstico.
{decomp_md}{mant_md}{warning}
""".strip()

    return (summary_md, _line_summary(preds), _block_table(preds), _top_drivers_table(preds))


def optimize_v3(
    file_obj,
    aggressive: bool,
    outages_json: str = "",
    priority_ofs_json: str = "",
    progress=gr.Progress(track_tqdm=False),
):
    empty = pd.DataFrame()
    if file_obj is None:
        return ("⚠️ Sube un fichero .xlsx primero.", empty, empty, empty)
    path = file_obj if isinstance(file_obj, str) else file_obj.name
    objective = "p90" if aggressive else "p50"
    obj_label = "p90 (perseguir techo)" if aggressive else "p50 (esperado)"

    outages, err1 = _parse_json_param(outages_json, "outages")
    if err1:
        return (f"❌ {err1}", empty, empty, empty)
    priority_ofs, err2 = _parse_json_param(priority_ofs_json, "priority_ofs")
    if err2:
        return (f"❌ {err2}", empty, empty, empty)

    progress(0.05, desc=f"Parseando Excel (modo {obj_label})…")
    try:
        progress(0.15, desc="Construyendo lookup prev-aware (~30s)…")
        result, meta = _optimize_pipeline_v3(path, objective, outages, priority_ofs)
    except Exception as exc:
        return (f"❌ Error optimizando: {exc}", empty, empty, empty)

    if not result or not result.get("best_blocks", pd.DataFrame()).shape[0]:
        return ("⚠️ No se han encontrado bloques válidos para optimizar.",
                empty, empty, empty)

    baseline  = result["baseline_score"]
    optimized = result["optimized_score"]
    delta_pts = result["delta_oee_pts"]
    n_changes = result["n_changes"]
    elapsed   = result["elapsed_sec"]
    total_hl  = int(result.get("total_hl", 0))
    audit_ok  = result["audit"].get("all_ok", True)
    weekly    = result.get("weekly_summary", "")
    per_day   = result.get("per_day", [])
    per_line  = result.get("per_line", {})

    # Maintenance summary: how many slots blocked & did the optimizer respect them?
    mant_per_day = _maintenance_per_day(per_day)
    n_mant_days  = sum(1 for v in mant_per_day.values() if v)
    mant_violations = result["audit"].get("block_violations") or result["audit"].get("maintenance_violations", [])
    mant_line = ""
    if n_mant_days:
        if mant_violations:
            mant_line = (
                f"- 🛠 **{n_mant_days} día(s) con mantenimiento programado**  ·  "
                f"⚠️ {len(mant_violations)} OF(s) siguen en slot bloqueado "
                f"(el optimizador no pudo recolocarlos — formato/historia incompatible)"
            )
        else:
            mant_line = (
                f"- 🛠 **{n_mant_days} día(s) con mantenimiento programado** "
                f"(LIMPIEZA / MANTENIMIENTO) — todos los OFs respetan los slots bloqueados ✅"
            )

    progress(0.95, desc="Generando resumen…")
    status_emoji = "✅" if audit_ok else "⚠️"
    incidencias_md = _incidencias_section(result.get("incidencias", {}))

    # Build per-línea diagnostic markdown (with Simpson's-paradox note)
    per_line_md_rows = []
    for ln in sorted(per_line.keys()):
        v = per_line[ln]
        per_line_md_rows.append(
            f"| L{ln} | {_fmt_pct(v['baseline'])} | {_fmt_pct(v['optimized'])} | "
            f"{v['delta_pts']:+.2f} | {v['n_blocks_baseline']} → {v['n_blocks_optimized']} |"
        )
    per_line_md = "\n".join(per_line_md_rows) if per_line_md_rows else "| — | — | — | — | — |"

    summary_md = f"""
### 🏭 OEE de la fábrica — el número que importa

> Esto es la OEE que producirá la **fábrica como conjunto** (3 líneas combinadas,
> ponderada por HL). Es el número operativo: "qué fracción del tiempo total
> planificado vamos a convertir en producto bueno".

|                      | OEE de la fábrica ({objective}) |
|----------------------|--------------------------------:|
| **Plan actual**      | **{_fmt_pct(baseline)}** |
| **Plan optimizado**  | **{_fmt_pct(optimized)}** |
| **Ganancia**         | **{delta_pts:+.2f} puntos** |

- **{n_changes}** reasignaciones aplicadas en **{elapsed:.1f} s**  {status_emoji}
- **{total_hl:,} HL** totales planificados (incluye OF(s) prioritario(s) si los hay)
- Modo: **{obj_label}**
{mant_line}
{incidencias_md}
#### Detalle operacional
{weekly}

---

#### 🔎 Por línea (diagnóstico — usa con cuidado)

> ⚠️ **Paradoja de Simpson:** una línea puede empeorar de media mientras
> la **fábrica global mejora**. Cuando movemos un bloque de L14 a L19, el bloque
> aporta al global su NUEVA predicción más alta (buena noticia), pero la
> media de L14 puede caer (pierde un bloque que estaba por encima de su media)
> y la media de L19 también puede caer (gana un bloque por debajo de su media).
> **El número que importa es el de la fábrica como conjunto** (arriba).

| Línea | OEE actual ({objective}) | OEE optimizada | Δ pts | Bloques (act → opt) |
|---|---|---|---|---|
{per_line_md}

---

> V3 usa un **lookup prev-aware**: predicción para cada combinación de
> **(OF, línea×día×turno, SKU anterior)**. Cada movimiento se evalúa con el
> contexto *real* de cascada y se reporta con métricas operacionales explícitas
> (ΔOEE · Δ min de cambio · Δ horas a mantenimiento · si agrupa formato).
> Respeta plazos, volúmenes y la compatibilidad línea-formato.
""".strip()

    return (summary_md,
            _per_day_factory_table(per_day, objective, _maintenance_per_day(per_day)),
            _per_line_compare_table_v2(per_line, objective),
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
    - **Predecir OEE** — detecta el formato y devuelve la **OEE de la fábrica** (3 líneas combinadas, HL-ponderada) y la predicción p10 / p50 / p90 por bloque.
    - **Optimizar plan** — reasigna cada OF a la mejor combinación de **línea × día × turno** respetando plazos, volúmenes y la compatibilidad línea-formato. Activa el modo agresivo para perseguir el techo p90.

    > 💡 **Cómo leer los resultados:** el número que importa es la **OEE de la
    > fábrica como conjunto** (HL-ponderada sobre las 3 líneas). La vista por
    > línea es **diagnóstico** — puede mostrar caídas por línea aunque la
    > fábrica global mejore (paradoja de Simpson, explicación dentro).

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
            with gr.Accordion("⚡ Incidencias (avanzado — opcional)", open=False):
                gr.Markdown(
                    "> Las **incidencias** modifican la optimización en caliente. "
                    "Pega JSON aquí cuando una línea esté rota o haya un OF prioritario. "
                    "Vacío = sin incidencias. El back-end de la planta puede llamar al "
                    "endpoint directamente desde el front Next.js — ver `FRONTEND_API_CONTRACT.md`."
                )
                outages_in = gr.Textbox(
                    label="Outages — JSON [{linea, fecha, turno, reason?}, …]",
                    placeholder='[{"linea": 17, "fecha": "2026-05-26", "turno": "T", "reason": "Avería rodillo"}]',
                    lines=3,
                )
                priority_ofs_in = gr.Textbox(
                    label="OFs prioritarios — JSON [{sku, hl, deadline, preferred_linea?, reason?}, …]",
                    placeholder='[{"sku": "ED13LTW", "hl": 250, "deadline": "2026-05-28", "reason": "Pedido urgente cliente X"}]',
                    lines=3,
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
        with gr.TabItem("Optimizador — resumen"):
            opt_summary = gr.Markdown(
                "> Pulsa **Optimizar plan** tras subir un fichero. La búsqueda tarda "
                "entre 30 s y 75 s — verás el progreso encima del botón. Activa el "
                "**Modo agresivo** para perseguir el techo p90 con movimientos más ambiciosos."
            )
            opt_day_tbl = gr.Dataframe(
                label="Por día — 3 líneas combinadas (vista recomendada)",
                interactive=False,
            )
            opt_line_tbl = gr.Dataframe(
                label="Por línea — diagnóstico (lee la nota arriba)",
                interactive=False,
            )
        with gr.TabItem("Optimizador — reasignaciones"):
            opt_swap_tbl = gr.Dataframe(
                label="Reasignaciones aplicadas (con motivo operacional)",
                interactive=False, wrap=True,
            )

    btn_predict.click(
        fn=predict,
        inputs=file_in,
        outputs=[summary, line_tbl, blocks_tbl, drivers_tbl],
    )
    btn_optimize.click(
        fn=optimize_v3,
        inputs=[file_in, aggressive, outages_in, priority_ofs_in],
        outputs=[opt_summary, opt_day_tbl, opt_line_tbl, opt_swap_tbl],
    )

if __name__ == "__main__":
    demo.launch()
