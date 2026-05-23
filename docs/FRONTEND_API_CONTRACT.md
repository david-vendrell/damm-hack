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

## 2 · The two operations

The Space exposes exactly two operations the frontend cares about:

| Function | Purpose | Average latency |
|---|---|---|
| `/predict` | Parse an uploaded Excel and forecast OEE per block + factory-wide | **3–10 s** |
| `/optimize_v3` | Same parse + reassign each OF to its best (línea × día × turno) to maximise OEE under all constraints | **30–90 s** (lookup precompute dominates) |

Both consume the **same Excel file**. The frontend should upload the file once, then offer the user both buttons. The backend re-parses on each call (no shared cache between calls — Gradio is stateless across function invocations).

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
  file_obj: file,           // same xlsx
  aggressive: false,        // bool — false=p50 (esperado), true=p90 (perseguir techo)
});
```

`aggressive = true` makes the optimizer pursue the achievable p90 ceiling (more ambitious recommendations); `false` optimises for the expected p50 OEE (safer recommendations).

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

Contains:
- 🏭 **OEE de la fábrica** headline — Plan actual → Plan optimizado → Ganancia (in pts)
- Move count, elapsed seconds, audit status (✅/⚠️)
- 🛠 Maintenance-day summary (how many días have a scheduled cleaning, audit confirms zero violations)
- Operational summary (`+X pts OEE · −Y min cambio · Z OFs alejados de mantenimiento`)
- 🔎 Per-línea **diagnostic** table embedded as Markdown (already includes the Simpson's-paradox explanation note)

Render as-is.

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
| SKU | string | `ED13LTW` |
| Desde | string | `L17 / 2026-05-21 / N` |
| Hacia | string | `L19 / 2026-05-18 / T` |
| ΔOEE pts | string | `+0.10` |
| Δ cambio min | string | `+0` |
| Δ mant h | string | `+34` |
| Agrupa formato | string | `Sí` / `""` |
| Descripción | string | full Spanish reason — render in monospace, this is the audit trail |

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
// app/api/linewise/optimize/route.ts
export const runtime = "nodejs";
export const maxDuration = 300;   // optimizer can take up to 240s

export async function POST(req: Request) {
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const aggressive = formData.get("aggressive") === "true";
  if (!file) return new Response("file required", { status: 400 });

  const client = await Client.connect("marcaguilar/linewise-demo", {
    hf_token: process.env.HF_TOKEN!,
  });
  const result = await client.predict("/optimize_v3", {
    file_obj: file,
    aggressive,
  });
  return Response.json({
    summary_md: result.data[0],
    day_tbl:    result.data[1],
    line_tbl:   result.data[2],
    swap_tbl:   result.data[3],
  });
}
```

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

1. **Volume invariance.** `optimize_v3` never changes `sum(HL per SKU)`. Total production planned is identical before and after.
2. **Format compatibility respected.** Optimizer never places a 1/2 SKU on L17 (1/3-only), etc. CF Prat line-format matrix is hard-enforced.
3. **Deadline respected.** No OF is scheduled past its original `fecha` (treated as deadline).
4. **Maintenance respected.** Optimizer never places production on a CF Prat 5-TURNOS LIMPIEZA or MANTENIMIENTO slot. Pre-existing OFs on such slots are flagged infeasible.
5. **Determinism.** Same input file + same `aggressive` flag → identical output (verified by test #02 in the test suite).
6. **No model drift mid-session.** The 12 LightGBM models are loaded once per container; restart triggers reload but predictions are identical to the file checksum.
7. **All swap-log moves are auditable.** Every `swap_tbl` row's `Descripción` is computed deterministically from the operational metrics (changeover min, maint hours, format clustering). No LLM in the loop.

---

## 9 · Demo plans available

Six pre-built test Excels live in the repo at `juego_de_pruebas/` — the frontend can ship these as "Try a sample plan" presets:

| File | Tests |
|---|---|
| `01_baseline_real.xlsx` | Well-grouped baseline plan |
| `02_baseline_repetido.xlsx` | Identical to 01 — determinism check |
| `03_caos_formatos.xlsx` | Format-alternating chaos — large optimizer gain |
| `04_infactible_formato.xlsx` | Has an ED12 SKU on L17 — shows format-incompat flag |
| `05_infactible_sin_historico.xlsx` | Has a fake SKU `ZZNEW01` — shows low-confidence warning |
| `06_techo_optimo.xlsx` | Already-optimal plan — do-no-harm test |
| `07_conflicto_mantenimiento.xlsx` | Has 3 OFs in scheduled LIMPIEZA slots — shows maintenance hard-reject |

Also useful for screenshots / smoke-testing the integration. Real production files live in `Repte operacions/` (Damm's confidential data — do NOT bundle in the frontend).

---

## 10 · Where to ask questions

- **Backend changes / new endpoints**: open an issue on the GitHub repo `david-vendrell/damm-hack`
- **Auth or Space access**: contact Marc (`marcaguilar`)
- **Damm data semantics**: consult `docs/IO_SCHEMA.md` (the diagram and column definitions)

Schema changes will be communicated by bumping the version line below.

---

**Contract version:** `1.0.0` · last updated 2026-05-24 (after Gap 1/2/3 ship)
