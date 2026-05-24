# LineWise — Frontend API Contract

> Audience: the engineer wiring the **Next.js platform** (`web/`) to the LineWise model. This document is the only thing you need to read to integrate the file-upload + prediction + optimization flows. The backend will not change shape without bumping this doc.

---

## 1 · What you are calling

| | Value |
|---|---|
| **Backend** | Hugging Face Space (Gradio app) |
| **Space slug** | `marcaguilar/linewise-demo` |
| **Direct URL** | `https://marcaguilar-linewise-demo.hf.space` |
| **Visibility** | **Private** — auth required |
| **Auth header** | `Authorization: Bearer <HF_TOKEN>` |
| **Hosted code** | `app.py` at repo root (engine in `engine/*.py`) |
| **Transport** | HTTPS · JSON · multipart for file uploads |
| **Cold start** | ~30–60 s after idle; subsequent calls warm |

The Space exposes Python functions as HTTP endpoints automatically. You get them via the official `@gradio/client` JavaScript SDK (recommended) or as raw REST (documented in section 7 as a fallback).

> ⚠️ **Never put the HF_TOKEN in the browser.** Always call the Space from a Next.js Route Handler / API route on the server. See section 6 for the proxy pattern.

---

## 2 · The two operations (and the two workflows they cover)

The Space exposes exactly two operations:

| Function | Purpose | Average latency |
|---|---|---|
| `/predict` | Parse an uploaded Excel and forecast OEE per block + factory-wide | **3–10 s** |
| `/optimize_v3` | Same parse + reassign each OF to its best (línea × día × turno) to maximise OEE under all constraints | **30–90 s** (lookup precompute dominates; **doubles when `outages_json` or `priority_ofs_json` are non-empty** because the cost-of-incident analysis runs a second pass) |

Both consume the **same Excel file**. The frontend should upload the file once, then offer the user both buttons. The backend re-parses on each call (no shared cache between calls — Gradio is stateless across function invocations).

`/optimize_v3` is **one endpoint that adapts to two distinct workflows** based on which optional parameters you pass:

| Workflow | When | Parameters passed | UX recommendation |
|---|---|---|---|
| **A · Initial planning** | Monday morning — planner drafts next week | (nothing optional) | Route under *Validar plan* — single "Optimizar" button |
| **B · Mid-week replan** | Mid-week — a línea goes down or an urgent order arrives | `outages_json` and/or `priority_ofs_json` and/or `replan_from_ts` | Route under *Urgencias* — separate form with timestamp, outage list and urgent-order list |

Both workflows hit the **same `optimize_v3` function**. The recommendation is to create **two Next.js Route Handlers** (one per workflow) that both proxy to it — see section 6. That way the planner sees two cleanly-distinct surfaces but you maintain one backend.

---

## 3 · Accepted file formats

The Excel must be one of two Damm formats. The parser auto-detects which.

### Format A — `Planificado producciones` (per-shift, preferred)

One row per (línea × SKU × shift × date). Required columns (exact names, accented chars matter):

| Column | Type | Notes |
|---|---|---|
| `Material` | string | SKU code (e.g. `ED13LTW`) |
| `Tren` | int | 14, 17, or 19 |
| `Fecha_Ini` | date | the day the OF runs |
| `Definición de turno` | string | `M` / `T` / `N` (mañana / tarde / noche) |
| `Cntd Plan` | float | planned quantity in HL or CAJ |
| `Cntd JDA` | float | optional secondary planned quantity |
| `Hora Ini` | time | optional |
| `Secuencia` | int | optional ordering within slot |

Detection signature: file contains `Material` AND `Definición de turno`.

### Format B — `Diario Hl_Planif` (per-day cross-tab, fallback)

Wide layout with one column block per día. Detection signature: column headers contain `Programa Prod.` AND `Diario Hl`. Shift T/N/M is **inferred** by splitting each día's HL into thirds — predictions are slightly less accurate than format A.

### File size limits

- Max upload: **5 MB**
- Max OFs in plan: **500**
- Max planning window: **14 días**

Outside these bounds the call returns an error in the summary string (see section 4.3).

---

## 4 · `predict` — full contract

### 4.1 Request

```ts
// Using @gradio/client (preferred)
const client = await Client.connect("marcaguilar/linewise-demo", {
  hf_token: process.env.HF_TOKEN,   // server-side only
});
const result = await client.predict("/predict", {
  file_obj: file,                   // File | Blob (the .xlsx)
});
```

### 4.2 Response — array of 4 elements

```ts
type PredictResponse = [
  string,        // [0] summary_md — Markdown. Render with react-markdown.
  Dataframe,     // [1] line_tbl   — per-línea summary
  Dataframe,     // [2] blocks_tbl — per-block predictions
  Dataframe,     // [3] drivers_tbl — SHAP top features for first 20 blocks
];

interface Dataframe {
  headers: string[];        // column names
  data: (string | number | boolean | null)[][];   // row-major
  metadata?: { dtype: string[] };
}
```

#### `[0] summary_md` — the headline

Markdown string ready to render. Always contains:

- A factory-wide HL-weighted **OEE p50 / p90** table
- File metadata (`Formato detectado`, `Bloques analizados`, `No factibles`, `HL totales planificados`)
- A 🔬 **Decomposición OEE** subsection (Disponibilidad × Rendimiento × Calidad)
- A 🛠 **maintenance conflicts** subsection (if any OFs land on a scheduled LIMPIEZA / MANTENIMIENTO slot per CF Prat 5-TURNOS)
- Optional ⚠️ warnings (e.g. Diario Hl format inference)

You should render this as-is; it is the user-facing prose explanation. No parsing required.

#### `[1] line_tbl` — per-línea summary

| Column | Type | Example |
|---|---|---|
| Línea | string | `L14` |
| `# bloques` | int | 24 |
| `HL planificados` | int | 8213 |
| `OEE p50 (HL-ponderada)` | string (pct) | `45.0%` |
| `OEE p90 (HL-ponderada)` | string (pct) | `55.5%` |
| `% feasible` | string | `100%` |

#### `[2] blocks_tbl` — per-block predictions (one row per OF)

| Column | Type | Example |
|---|---|---|
| Linea | int | 17 |
| Sku | string | `ED13LTW` |
| Marca | string | `ESTRELLA DAMM` |
| Fecha | string (YYYY-MM-DD) | `2026-05-19` |
| Turno | string | `T` |
| P10 / P50 / P90 | string (pct) | `45.3%` |
| Confidence | string | `high` / `medium` / `low` |
| Feasible | bool | `true` |
| Feas Reason | string \| null | `Slot bloqueado: LIMPIEZA programada en L17 los lunes ...` |

#### `[3] drivers_tbl` — SHAP top-3 features for the first 20 blocks

| Column | Type |
|---|---|
| Línea, SKU, Fecha, Turno | identifiers |
| Driver | feature name (e.g. `prev_oee`, `changeover_variance_min`) |
| SHAP | signed contribution string, e.g. `+0.0421` |

Use this to render *"why this OEE was predicted"* tooltips.

### 4.3 Error responses

The function never throws to the caller — errors are reported in `summary_md`:

| `summary_md` starts with | Meaning | Recommended UI |
|---|---|---|
| `⚠️ Sube un fichero .xlsx` | No file uploaded | Toast "Sube un fichero" |
| `❌ Error parseando` | Excel malformed / unknown format | Toast + show error string |
| `⚠️ El fichero se ha parseado pero no contiene bloques válidos` | Parsed but empty | Toast "Plan vacío" |
| `### 🏭 OEE de la fábrica` | Success | Render the markdown + tables |

Always check the first non-whitespace character of `summary_md` before rendering tables — if it's ⚠️ or ❌, the tables will be empty.

---

## 5 · `optimize_v3` — full contract

### 5.1 Request

```ts
const result = await client.predict("/optimize_v3", {
  file_obj: file,                       // same xlsx
  aggressive: false,                    // bool — false=p50 (esperado), true=p90 (perseguir techo)
  outages_json: "[]",                   // OPTIONAL — JSON string, see 5.1.1
  priority_ofs_json: "[]",              // OPTIONAL — JSON string, see 5.1.2
  replan_from_ts: "",                   // OPTIONAL — ISO timestamp, see 5.1.3
});
```

`aggressive = true` makes the optimizer pursue the achievable p90 ceiling (more ambitious recommendations); `false` optimises for the expected p50 OEE (safer recommendations).

#### 5.1.1 `outages_json` — broken-línea incidents (optional)

JSON-encoded string of an array. Each element marks one `(línea × día × turno)` slot as **hard-blocked** at runtime — treated identically to a CF Prat scheduled maintenance. Pre-existing OFs sitting on those slots are reassigned by the optimizer; new placements are refused.

```ts
type Outage = {
  linea: 14 | 17 | 19;
  fecha: string;          // ISO date "YYYY-MM-DD" — must be within plan window
  turno: "M" | "T" | "N";
  reason?: string;        // free-text Spanish, shown in summary + audit
};
// Send as: outages_json: JSON.stringify(outages)
```

Empty string or `"[]"` ⇒ no outages.

#### 5.1.2 `priority_ofs_json` — urgent OFs to hard-insert (optional)

JSON-encoded array of urgent OFs that **must** be placed before their `deadline`. If a feasible slot has spare capacity, the OF is dropped there; otherwise the optimizer evicts the lowest-(p50 × HL) existing OF from the best feasible slot (single-level eviction — the displaced OF is re-placed by the standard local search).

```ts
type PriorityOF = {
  sku: string;                  // must exist in dim_sku (else format-only feasibility)
  hl: number;                   // positive
  deadline: string;             // ISO date — slot.fecha ≤ deadline is hard-enforced
  preferred_linea?: 14 | 17 | 19;   // optional; intersected with format compat
  reason?: string;              // free-text, shown in swap log
};
// Send as: priority_ofs_json: JSON.stringify(priorityOFs)
```

Empty string or `"[]"` ⇒ no priority OFs.

> ⚠️ **HL impact.** Priority OFs are **additive** to total planned HL (they did not exist in the input plan). The HL-invariance audit excludes them; the optimized headline OEE includes their contribution.

#### 5.1.3 `replan_from_ts` — mid-week replan timestamp (optional)

ISO timestamp marking the moment the planner is reacting from. **Every OF whose scheduled `start_ts` is at or before this moment is pinned** — already produced or currently in-progress, the optimizer cannot move or evict it. Only OFs that start strictly after `replan_from_ts` are rearrangeable.

```ts
type ReplanFromTs = string;     // "YYYY-MM-DDTHH:MM:SS"  (no timezone — local plant time)
// Send as: replan_from_ts: "2026-05-27T10:00:00"
// Empty string ⇒ initial planning mode (everything rearrangeable, today's behaviour)
```

**When to send it:**
- **Workflow A (initial planning, Mon AM):** send `""` — every OF is rearrangeable, the full optimizer behaviour applies.
- **Workflow B (mid-week replan):** send the current wall-clock time as an ISO string. Mon + Tue OFs (and any Wed-AM OF that started before the timestamp) will be pinned. Only the remainder of the week is open to reassignment.

**Defaults & validation:**
- Empty or missing → initial planning mode (backwards-compatible with v1.1.0 callers)
- Malformed timestamp → `summary_md` starts with `❌ replan_from_ts no es timestamp válido: …`
- Any timestamp **before** the plan's earliest day → no OFs frozen (acts like empty)
- Any timestamp **after** the plan's last day → ALL OFs frozen → optimizer applies zero moves

**What appears in `summary_md` when `replan_from_ts` is set:**

```
#### 🔒 Replanificación desde 2026-05-27T10:00:00
- 24 OF(s) congelado(s) (17 000 HL ya producidos o en curso) — el optimizador no los toca.
- El optimizador sólo reorganiza los OFs posteriores al momento del replán.
```

If `replan_from_ts` is non-empty AND (`outages_json` OR `priority_ofs_json` is non-empty), the summary also gets a **3-row cost-of-incident table** — see 5.2.

### 5.2 Response — array of 4 elements

```ts
type OptimizeResponse = [
  string,        // [0] summary_md — full optimization narrative
  Dataframe,     // [1] day_tbl    — per-día factory-combined OEE (RECOMMENDED view)
  Dataframe,     // [2] line_tbl   — per-línea diagnostic (Simpson's paradox warning included)
  Dataframe,     // [3] swap_tbl   — every reassignment with operational reasoning
];
```

#### `[0] summary_md`

Always contains:
- 🏭 **OEE de la fábrica** headline — Plan actual → Plan optimizado → Ganancia (in pts)
- Move count, elapsed seconds, audit status (✅/⚠️)
- 🛠 Maintenance-day summary (how many días have a scheduled cleaning, audit confirms zero violations)
- Operational summary (`+X pts OEE · −Y min cambio · Z OFs alejados de mantenimiento`)
- 🔎 Per-línea **diagnostic** table embedded as Markdown (already includes the Simpson's-paradox explanation note)

Additionally appears **only when the relevant parameter is set**:

| Section | Trigger | What it shows |
|---|---|---|
| `🔒 Replanificación desde X` | `replan_from_ts` non-empty | Number of frozen OFs + their HL (already produced or in-progress) |
| `⚡ Incidencias gestionadas` | `outages_json` or `priority_ofs_json` non-empty | Count of outages declared · priority OFs placed vs failed · evictions triggered |
| `⚖️ Coste de las incidencias` (3-row table) | `outages_json` or `priority_ofs_json` non-empty | See below |
| `📋 Veredicto por OF prioritario` | `priority_ofs_json` non-empty | Per-OF verdict 🟢 PROCEDE / 🟠 REVISAR / 🔴 EVITAR / 🚫 IMPOSIBLE based on cost in pts + HL displaced |

**The 3-row cost-of-incident table** is the planner's decision-support view when responding to an incident:

```
|                                     | OEE de la fábrica | Movimientos          |
|-------------------------------------|------------------:|---------------------:|
| Plan original (sin incidencia)      | 62.25%            | —                    |
| Replan mínimo (sólo lo obligatorio) | 61.65%            | 3 🔧 obligatorio(s)  |
| Replan optimizado (con mejoras)     | 62.25%            | 9 totales (6 💡)     |
| Diferencia (original → optimizado)  | = +0.00 pts · 500 HL reasignados        |

> Coste real de la incidencia (inevitable): +0.60 pts.
> Mejora opcional disponible: aceptar los 6 cambios marcados 💡 OPCIONAL añade
> +0.60 pts extra. Es decisión del planificador …
```

Reading the three rows:
- **Plan original** — counterfactual ceiling assuming the incident never happened (computed by re-running the optimizer with empty incidents).
- **Replan mínimo** — what OEE looks like after applying ONLY the moves forced by the incident (an OF on a blocked slot, an eviction). The diff vs original = **unavoidable cost** of the incident.
- **Replan optimizado** — the full optimizer output, including discretionary OEE-improving moves. The diff vs mínimo = **discretionary upside** the planner can take or decline.

**Render as-is** — the whole markdown is ready for `react-markdown`. The interpretive prose between the table and the next section is part of the contract.

#### `[1] day_tbl` — RECOMMENDED view to lead with

| Column | Type | Example |
|---|---|---|
| Día | string | `Lun 2026-05-18` |
| `Bloques (act→opt)` | string | `39 → 48` |
| `HL del día` | int | 8254 |
| `OEE actual (p90)` | string (pct) | `59.1%` |
| `OEE optimizada` | string (pct) | `61.3%` |
| Δ pts | string | `+2.25` |
| Mantenimiento | string | `🛠 L17 LIMPIEZA · L19 LIMPIEZA` (empty if none) |

**Use this table as the primary visualization.** It composes cleanly into the headline (HL-weighted across all 3 líneas per día). No Simpson's paradox at this scope.

#### `[2] line_tbl` — diagnostic only, NOT the recommended view

Same shape as the predict's per-línea but with `actual` vs `optimizada` columns. **Render with a visible warning** that per-línea deltas can look contradictory to the factory-wide delta — this is Simpson's paradox, documented inside `summary_md`. Demote to a collapsed "Diagnóstico" tab.

#### `[3] swap_tbl` — every move with reason

| Column | Type | Example |
|---|---|---|
| # | int | 1 |
| Tipo | string | `⚙️ Optimización` / `⭐ Prioritario` / `⚠️ Desplazado` / `↪️ Realojo` |
| SKU | string | `ED13LTW` |
| Desde | string | `L17 / 2026-05-21 / N` (or `—` for priority inserts) |
| Hacia | string | `L19 / 2026-05-18 / T` (or `—` for evictions without re-place) |
| ΔOEE pts | string | `+0.10` |
| Δ cambio min | string | `+0` / `—` |
| Δ mant h | string | `+34` / `—` |
| Agrupa formato | string | `Sí` / `""` |
| Descripción | string | full Spanish reason — render in monospace, this is the audit trail |

The `Tipo` column distinguishes five move kinds (was four prior to v1.3.0):

| Tipo | When |
|---|---|
| `🔧 Obligatorio` | The OF was on a hard-blocked slot (LIMPIEZA / MANTENIMIENTO / OUTAGE) — it **had** to move. **No planner discretion: this move stays.** |
| `💡 Opcional` | The OF was on a fine slot but the optimizer found an OEE improvement by moving it. **The planner can decline this move without violating any constraint.** |
| `⭐ Prioritario` | A priority OF has been hard-inserted at the listed `Hacia` slot (`Desde` populated) |
| `⚠️ Desplazado` | An existing OF was evicted from its slot by a priority insert (`Desde` populated, `Hacia` null pending the realojo entry) |
| `↪️ Realojo` | The displaced OF was reassigned to a new feasible slot (`Desde` null, `Hacia` populated) |

The first two (🔧/💡) are the post-v1.3.0 split of what was previously a single `⚙️ Optimización` tag. The rule:

```
if move_type == "optimization":
    Tipo = "🔧 Obligatorio" if is_required else "💡 Opcional"
```

Where `is_required = True` iff the source slot was hard-blocked. The other three (⭐/⚠️/↪️) are always `is_required = True` by construction.

**Recommended frontend UX for mid-week replans:**
- Display all 🔧/⭐/⚠️/↪️ moves as a single "Cambios obligatorios" group at the top — the planner cannot decline these.
- Display 💡 moves as a separate "Mejoras opcionales sugeridas" group with an "Aceptar / Descartar" toggle per row. The OEE delta on each row tells the planner what they'd give up by declining.
- For initial-planning calls (no incidents), almost every move is 💡 — render them as a single grouped list, no obligatorio split.

Use this as a chronological "reassignments" panel. The `Descripción` is deterministic Spanish — safe to display directly.

### 5.3 Performance

| Plan size | Cold | Warm |
|---|---:|---:|
| ≤ 50 OFs | 90 s | 15 s |
| 50–120 OFs | 120 s | 30 s |
| 120–250 OFs | 180 s | 60 s |
| 250+ OFs | up to 240 s | up to 90 s |

Show a progress UI from t=0 with copy *"Construyendo lookup prev-aware… 30-90 s"*. The server-side `time_budget_sec=240` is the hard ceiling; never let your fetch timeout below 300 s.

### 5.4 Errors

Same convention as `predict`. If the optimizer cannot improve the plan (already at ceiling), `n_changes = 0` and `summary_md` will show *"Ganancia: +0.00 puntos"* — this is **not** an error, it's a *do-no-harm* signal. Display it as info, not warning.

---

## 6 · Recommended Next.js integration pattern

### 6.1 Proxy through a Route Handler (keeps HF_TOKEN server-side)

```ts
// app/api/linewise/predict/route.ts
import { Client } from "@gradio/client";

export const runtime = "nodejs";  // gradio-client needs Node runtime
export const maxDuration = 60;    // seconds — for predict

export async function POST(req: Request) {
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return new Response("file required", { status: 400 });

  const client = await Client.connect("marcaguilar/linewise-demo", {
    hf_token: process.env.HF_TOKEN!,
  });
  const result = await client.predict("/predict", { file_obj: file });
  return Response.json({
    summary_md: result.data[0],
    line_tbl:   result.data[1],
    blocks_tbl: result.data[2],
    drivers:    result.data[3],
  });
}
```

```ts
// app/api/linewise/plan-week/route.ts
// Workflow A: initial planning (Monday AM). No incidents, no replan_from_ts.
// Used by the "Validar plan" route in the platform.
export const runtime = "nodejs";
export const maxDuration = 300;   // optimizer can take up to 240s

export async function POST(req: Request) {
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const aggressive = formData.get("aggressive") === "true";
  // Priority OFs are allowed even in initial planning (planner may know about
  // urgent commitments from day 1). Outages and replan_from_ts are NOT.
  const priority_ofs_json = (formData.get("priority_ofs_json") as string) ?? "[]";
  if (!file) return new Response("file required", { status: 400 });

  const client = await Client.connect("marcaguilar/linewise-demo", {
    hf_token: process.env.HF_TOKEN!,
  });
  const result = await client.predict("/optimize_v3", {
    file_obj: file,
    aggressive,
    outages_json: "",            // initial planning: no incidents
    priority_ofs_json,
    replan_from_ts: "",          // initial planning: all OFs rearrangeable
  });
  return Response.json({
    mode:       "initial_planning",
    summary_md: result.data[0],
    day_tbl:    result.data[1],
    line_tbl:   result.data[2],
    swap_tbl:   result.data[3],
  });
}
```

```ts
// app/api/linewise/replan-incident/route.ts
// Workflow B: mid-week replan after an outage or urgent order. All four
// incident parameters are accepted; `replan_from_ts` is REQUIRED.
// Used by the "Urgencias" route in the platform.
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const aggressive = formData.get("aggressive") === "true";
  const outages_json      = (formData.get("outages_json")      as string) ?? "[]";
  const priority_ofs_json = (formData.get("priority_ofs_json") as string) ?? "[]";
  const replan_from_ts    = (formData.get("replan_from_ts")    as string) ?? "";

  if (!file) return new Response("file required", { status: 400 });
  if (!replan_from_ts) {
    return Response.json(
      { error: "replan_from_ts is required for incident replan" },
      { status: 400 }
    );
  }
  // Soft check: incident replans should declare at least one incident.
  if (outages_json === "[]" && priority_ofs_json === "[]") {
    return Response.json(
      { error: "Pass at least one outage or priority OF; use /plan-week otherwise" },
      { status: 400 }
    );
  }

  const client = await Client.connect("marcaguilar/linewise-demo", {
    hf_token: process.env.HF_TOKEN!,
  });
  const result = await client.predict("/optimize_v3", {
    file_obj: file,
    aggressive,
    outages_json,
    priority_ofs_json,
    replan_from_ts,
  });
  return Response.json({
    mode:       "mid_week_replan",
    summary_md: result.data[0],     // includes 🔒 Replan + ⚖️ 3-row cost table
    day_tbl:    result.data[1],
    line_tbl:   result.data[2],
    swap_tbl:   result.data[3],     // Tipo column splits into 🔧 vs 💡
  });
}
```

Both routes hit the same Gradio function. The separation is purely a UX clarity benefit on the frontend.

### 6.2 Client component — upload + display

```tsx
"use client";
import { useState } from "react";
import ReactMarkdown from "react-markdown";

export function LineWiseUploader() {
  const [file, setFile] = useState<File | null>(null);
  const [aggressive, setAggressive] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState<"predict" | "optimize" | null>(null);

  async function call(endpoint: "predict" | "optimize") {
    if (!file) return;
    setLoading(endpoint);
    const fd = new FormData();
    fd.append("file", file);
    if (endpoint === "optimize") fd.append("aggressive", String(aggressive));
    const r = await fetch(`/api/linewise/${endpoint}`, { method: "POST", body: fd });
    setResult(await r.json());
    setLoading(null);
  }

  return (
    <div>
      <input type="file" accept=".xlsx,.xls"
             onChange={e => setFile(e.target.files?.[0] ?? null)} />
      <label>
        <input type="checkbox" checked={aggressive}
               onChange={e => setAggressive(e.target.checked)} />
        Modo agresivo (p90)
      </label>
      <button onClick={() => call("predict")}  disabled={!file || !!loading}>
        Predecir OEE {loading === "predict" && "…"}
      </button>
      <button onClick={() => call("optimize")} disabled={!file || !!loading}>
        Optimizar plan {loading === "optimize" && "…"}
      </button>
      {result?.summary_md && <ReactMarkdown>{result.summary_md}</ReactMarkdown>}
      {result?.day_tbl && <DataframeTable df={result.day_tbl} />}
    </div>
  );
}
```

### 6.3 Environment variables required

```env
# .env.local — do NOT commit
HF_TOKEN=hf_XXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

The token needs **Read** access to the `marcaguilar/linewise-demo` Space. Generate at https://huggingface.co/settings/tokens.

---

## 7 · Raw REST (fallback if `@gradio/client` is unavailable)

Gradio exposes its functions at:

```
POST https://marcaguilar-linewise-demo.hf.space/run/predict
Content-Type: multipart/form-data
Authorization: Bearer <HF_TOKEN>

(file upload via the `file_obj` field, JSON body for scalars)
```

Use this **only** if you cannot install `@gradio/client`. The SDK handles file uploads, streaming responses, queue management, and reconnections — implementing those by hand against the Gradio queue protocol is a rabbit hole. There is a Python `gradio_client` equivalent if you ever want to call from a Python server.

Reference: https://www.gradio.app/docs/js-client

---

## 8 · Behavioural contracts (the guarantees you can rely on)

1. **Volume invariance.** `optimize_v3` never changes `sum(HL per SKU)` for SKUs present in the input plan. Priority OFs (passed via `priority_ofs_json`) are **additive** — their HL is added on top and excluded from the invariance audit.
2. **Format compatibility respected.** Optimizer never places a 1/2 SKU on L17 (1/3-only), etc. CF Prat line-format matrix is hard-enforced — applies equally to baseline OFs and priority OFs.
3. **Deadline respected.** No OF is scheduled past its `fecha`/`deadline` — applies equally to baseline (uses `fecha`) and priority OFs (uses their `deadline` field).
4. **Blocks respected.** Optimizer never places production on a slot marked blocked — applies equally to CF Prat 5-TURNOS LIMPIEZA / MANTENIMIENTO **and** caller-declared `OUTAGE` slots. Pre-existing OFs on such slots are flagged infeasible and reassigned by the optimizer.
5. **Priority OF guarantee.** Every entry in `priority_ofs_json` is placed before its deadline on a feasible slot, OR surfaced explicitly in `audit.priority_violations` (and the swap log carries the reason). The optimizer never silently drops a priority OF.
6. **Eviction is single-level and deterministic.** When a priority OF requires eviction, exactly one existing OF is displaced (the lowest `p50 × HL` occupant of the chosen slot, tie-broken by `block_id`). The displaced OF is reassigned via standard local search; if it cannot fit anywhere, that's surfaced in `audit` (rare; means the plan was already over-tight).
7. **Determinism.** Same inputs (file + `aggressive` + `outages_json` + `priority_ofs_json`) → identical output (verified by test #02 in the test suite).
8. **No model drift mid-session.** The 12 LightGBM models are loaded once per container; restart triggers reload but predictions are identical to the file checksum.
9. **All swap-log moves are auditable.** Every `swap_tbl` row's `Descripción` is computed deterministically from operational metrics or incident metadata — no LLM in the loop.
10. **Mid-week freeze invariant.** When `replan_from_ts` is non-empty, every OF whose scheduled `start_ts` is `<= replan_from_ts` is pinned to its original `(línea, fecha, turno)`. The optimizer cannot move it, evict it, or count it among its `swap_log` changes. Verified by test #11 (`scripts/18_run_test_suite.py`) which asserts `frozen_moved == 0` for the entire frozen subset.
11. **Required vs optional separation.** When the planner accepts only the moves with `🔧 Obligatorio` / `⭐` / `⚠️` / `↪️` tags (skipping every `💡 Opcional`), the resulting OEE equals `score_required_only` shown in the 3-row cost table. The two passes (clean vs full) are computed against the **same frozen baseline** so the cost is honestly attributable to the incident.
12. **Cost-of-incident sign convention.** In the 3-row table, the `Diferencia` row uses `▼` when the incident hurt OEE (negative pts), `▲` when the incident's priority OF actually helped (positive pts — its higher prediction lifted the HL-weighted average), `=` when within ±0.01 pts. The 3-row math always satisfies `optimized = (mínimo) + (sum of 💡 deltas)` to within rounding.

---

## 9 · Demo plans available

Pre-built test Excels live in the repo at `juego_de_pruebas/` — the frontend can ship these as "Try a sample plan" presets:

| File | Tests |
|---|---|
| `01_baseline_real.xlsx` | Well-grouped baseline plan |
| `02_baseline_repetido.xlsx` | Identical to 01 — determinism check |
| `03_caos_formatos.xlsx` | Format-alternating chaos — large optimizer gain |
| `04_infactible_formato.xlsx` | Has an ED12 SKU on L17 — shows format-incompat flag |
| `05_infactible_sin_historico.xlsx` | Has a fake SKU `ZZNEW01` — shows low-confidence warning |
| `06_techo_optimo.xlsx` | Already-optimal plan — do-no-harm test |
| `07_conflicto_mantenimiento.xlsx` | Has 3 OFs in scheduled LIMPIEZA slots — shows maintenance hard-reject |
| `08_outage_basico.xlsx` | Baseline + caller passes 1 outage on L17 — incident reassignment |
| `09_priority_holgado.xlsx` | Baseline + caller passes 1 priority OF that fits without eviction |
| `10_priority_evict.xlsx` | Baseline + 1 priority OF requiring single-level eviction |
| `11_replan_midweek.xlsx` | 4-day plan + send `replan_from_ts=2026-05-27T10:00:00` and outages on L17 Wed PM — shows 24 OFs frozen, 3 🔧 obligatorios + 6 💡 opcionales, 3-row cost-of-incident table |

Also useful for screenshots / smoke-testing the integration. Real production files live in `Repte operacions/` (Damm's confidential data — do NOT bundle in the frontend).

---

## 10 · Where to ask questions

- **Backend changes / new endpoints**: open an issue on the GitHub repo `david-vendrell/damm-hack`
- **Auth or Space access**: contact Marc (`marcaguilar`)
- **Damm data semantics**: consult `docs/IO_SCHEMA.md` (the diagram and column definitions)

Schema changes will be communicated by bumping the version line below.

---

**Contract version:** `1.3.0` · last updated 2026-05-24

**Changelog**
- `1.3.0` (2026-05-24): Adds `replan_from_ts` to `/optimize_v3` (mid-week replan with pinned baseline). Split the `Tipo` column in `swap_tbl` for `optimization` moves into `🔧 Obligatorio` (forced by an incident) vs `💡 Opcional` (planner can decline). New 3-row cost-of-incident table in `summary_md` (Plan original / Replan mínimo / Replan optimizado). New behavioural guarantees #10, #11, #12. Recommended two Next.js Route Handlers (`/plan-week` + `/replan-incident`) backed by the same Gradio endpoint.
- `1.1.0` (2026-05-24): Adds `outages_json` + `priority_ofs_json` to `/optimize_v3`. New `Tipo` column in `swap_tbl`. New `audit.priority_violations` + `audit.block_violations` keys.
- `1.0.0` (2026-05-23): Initial contract.
