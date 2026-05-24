# LineWise — Local model sidecar contract for the frontend

> Audience: anyone wiring a frontend (Next.js, anything else) to the LineWise
> model when the team is developing locally. This is the **primary** path —
> the HF Space (documented in `FRONTEND_API_CONTRACT.md`) is the fallback for
> sharing with non-developers.

---

## 1 · Why local

Instead of round-tripping to the HF Space (60-90 s cold start, requires
`HF_TOKEN`, breaks when the Space falls over), we run a small Python sidecar
on `localhost:8001`. Same models, same engine, same `app.py` code — just
exposed via FastAPI on the same machine as the frontend.

| | Local sidecar | HF Space |
|---|---|---|
| Per-call latency | **~13 s** | 60-90 s cold / ~30 s warm |
| Cold start | ~5 s (once per `npm run dev:full`) | Every idle hour |
| Auth | None | `HF_TOKEN` |
| Offline | Works | Fails |
| Debug | Server logs in your terminal | HF Space log delay |

---

## 2 · Prerequisites

Repo root has:

| Path | What it is | Required |
|---|---|---|
| `models/lgb_*_p10/p50/p90.pkl` | 12 trained LightGBM quantile models | ✅ |
| `engine/*.py` | Predict + optimizer + maintenance + features | ✅ |
| `lookups/*.parquet` | CF Prat matrix, dim_sku, maintenance schedule, fact_runs_slim | ✅ |
| `app.py` | Gradio app — its `predict()` and `optimize_v3()` callbacks are reused | ✅ |
| `scripts/local_model_server.py` | The sidecar itself | ✅ (just created) |
| `.venv/` with `fastapi`, `uvicorn`, `lightgbm`, `pandas`, `duckdb`, `openpyxl`, `holidays`, `huggingface_hub` | Python deps | ✅ |

Frontend (Next.js example) needs: `@gradio/client` (for HF fallback only),
`concurrently` (for `dev:full` script).

---

## 3 · Starting everything

### One command (recommended)

```bash
cd web
npm run dev:full
```

This runs `concurrently`:
- **NEXT** — `next dev` on `:3000`
- **LWMODEL** — `python scripts/local_model_server.py` on `:8001`

Color-prefixed logs show in the same terminal.

### Independently (if you prefer two terminals)

```bash
# Terminal 1 — Python sidecar
cd "/path/to/damm-hack"
source .venv/bin/activate
python scripts/local_model_server.py

# Terminal 2 — Next.js
cd "/path/to/damm-hack/web"
npm run dev
```

### Verify both are alive

```bash
curl -s http://localhost:8001/healthz
# → {"status":"ok","version":"1.0.0"}

curl -sI http://localhost:3000 | head -1
# → HTTP/1.1 200 OK
```

---

## 4 · Architecture

```
Browser
   │  POST /api/planes  (multipart, the Excel file)
   ▼
Next.js Route Handler  (web/src/app/api/planes/route.ts)
   │  Excel → buffer → parseDiarioHl() → DB insert
   │  then: callLineWise(buffer, fileName)
   ▼
linewise-client.ts  (web/src/server/linewise-client.ts)
   │  HTTP POST http://localhost:8001/optimize_v3
   │   (multipart: file + aggressive + outages_json + …)
   ▼
Local sidecar  (scripts/local_model_server.py)
   │  imports app.py → calls app.optimize_v3(path, aggressive, …)
   ▼
Engine  (engine/optimizer_v3.py, predict_oee.py, …)
   │  12 LightGBM models in models/  ← already loaded into memory
   │  CF Prat lookup tables in lookups/
   ▼
Returns 4-tuple JSON  →  parsed by linewise-client.ts
   │  → analizarPlanConLineWise() merges with parsed file
   ▼
AnalisisPlan JSON  →  Browser
```

**Key**: the sidecar imports `app.py` directly. It's literally the same code
the HF Space runs and the same code `scripts/18_run_test_suite.py` exercises.
No model duplication, no logic drift.

---

## 5 · Sidecar endpoints

| Method | Path | Purpose | Latency |
|---|---|---|---|
| `GET`  | `/healthz` | Liveness check | <10 ms |
| `POST` | `/predict` | Per-OF OEE prediction only | ~5 s |
| `POST` | `/optimize_v3` | Full optimizer (recommended for /validar) | **~13 s** |

Both POST endpoints use **multipart/form-data** (so the Excel file goes in
as a binary upload).

### `/optimize_v3` request fields

| Field | Type | Default | Purpose |
|---|---|---|---|
| `file` | binary (multipart) | required | The planning Excel (.xlsx) |
| `aggressive` | string `"true"`/`"false"` | `"false"` | `true` = chase p90 ceiling, more ambitious recos |
| `outages_json` | string (JSON array) | `""` | Caller-declared línea outages — see below |
| `priority_ofs_json` | string (JSON array) | `""` | Urgent OFs to insert — see below |
| `replan_from_ts` | string (ISO timestamp) | `""` | Mid-week replan — pins OFs scheduled before this moment |

`outages_json` shape (when non-empty):
```json
[{"linea": 17, "fecha": "2026-05-27", "turno": "T", "reason": "Avería rodillo"}]
```

`priority_ofs_json` shape (when non-empty):
```json
[{"sku": "ED13LTW", "hl": 250, "deadline": "2026-05-27",
  "preferred_linea": 17, "reason": "Pedido urgente"}]
```

### `/optimize_v3` response

```jsonc
{
  "data": [
    "### 🏭 OEE de la fábrica …",  // [0] summary_md — Markdown, render with react-markdown
    { "headers": […], "data": [[…]] },  // [1] day_tbl   — per-día factory OEE
    { "headers": […], "data": [[…]] },  // [2] line_tbl  — per-línea breakdown
    { "headers": […], "data": [[…]] }   // [3] swap_tbl  — every reassignment
  ],
  "duration_ms": 13391
}
```

The four `data` elements mirror the HF Space's Gradio response exactly,
so the same parsers work for both backends.

---

## 6 · Calling the sidecar from a Next.js Route Handler

Real working example: **`web/src/server/linewise-client.ts`** (in this repo).
Read it as the canonical reference — it handles local-first, HF-fallback,
error detection, and parses each piece of the response.

Minimal version for a fresh project:

```typescript
// app/api/your-route/route.ts
export const runtime = 'nodejs';
export const maxDuration = 60;   // sidecar can take ~15s, give yourself margin

export async function POST(req: Request) {
  const formData = await req.formData();
  const file = formData.get('file') as File | null;
  if (!file) return new Response('file required', { status: 400 });

  // Forward to the local sidecar
  const buf = Buffer.from(await file.arrayBuffer());
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(buf)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    file.name,
  );
  form.append('aggressive', 'false');
  form.append('outages_json', '');
  form.append('priority_ofs_json', '');
  form.append('replan_from_ts', '');

  const resp = await fetch('http://localhost:8001/optimize_v3', {
    method: 'POST',
    body: form,
  });

  if (!resp.ok) {
    return Response.json({ error: 'sidecar_failed' }, { status: 502 });
  }
  const body = await resp.json() as { data: unknown[]; duration_ms: number };

  // The sidecar wraps engine errors in a "❌ Error ..." markdown reply
  // instead of throwing. Detect that and surface as failure.
  const summary_md = String(body.data[0] ?? '');
  if (summary_md.startsWith('❌')) {
    return Response.json({ error: 'engine_error', detail: summary_md }, { status: 500 });
  }

  return Response.json({
    summary_md,
    day_tbl:  body.data[1],
    line_tbl: body.data[2],
    swap_tbl: body.data[3],
    latencyMs: body.duration_ms,
  });
}
```

---

## 7 · Parsing the four response pieces

Each piece is documented in detail in `FRONTEND_API_CONTRACT.md` (sections 5.2
onwards). Quick reference:

### `[0] summary_md`  (string)

Markdown. Always contains a "🏭 OEE de la fábrica" headline table plus the
operational summary. Extra sections appear conditionally:

- `🔒 Replanificación desde X` — when `replan_from_ts` was set
- `⚡ Incidencias gestionadas` — when outages or priority OFs
- `⚖️ Coste de las incidencias` — same trigger
- `📋 Veredicto por OF prioritario` — when priority OFs

**Extract structured numbers with regex** when you need them in JS — see
`parseHeadlineOee`, `parseDecomposicion`, `parseBloqueosMant` in
`web/src/server/linewise-client.ts`.

### `[1] day_tbl`  (Gradio dataframe)

```typescript
type DayTable = {
  headers: string[];                    // ['Día', 'Bloques (act→opt)', 'HL del día',
                                        //  'OEE actual (p50)', 'OEE optimizada',
                                        //  'Δ pts', 'Mantenimiento']
  data: (string | number | null)[][];
};
```

This is the **recommended visualization** — per-día factory-combined OEE,
no Simpson's paradox at this scope.

### `[2] line_tbl`  (Gradio dataframe)

Per-línea diagnostic (L14 / L17 / L19) — actual vs optimizada with delta.
**Render with a Simpson-paradox warning**: per-línea numbers can go down
while the global goes up. The contract doc explains why.

### `[3] swap_tbl`  (Gradio dataframe)

Every reassignment the optimizer applied. Columns:

```
['#', 'Tipo', 'SKU', 'Desde', 'Hacia', 'ΔOEE pts',
 'Δ cambio min', 'Δ mant h', 'Agrupa formato', 'Descripción']
```

The `Tipo` column splits into 5 categories:
- `🔧 Obligatorio` — moved because slot was blocked (LIMPIEZA / MANT / OUTAGE)
- `💡 Opcional` — pure OEE improvement (planner can decline)
- `⭐ Prioritario` — caller-injected priority OF
- `⚠️ Desplazado` — evicted by a priority insert
- `↪️ Realojo` — displaced OF re-assigned

Slot format: `L17 / 2026-05-27 / N`. `—` means null (priority insert or eviction).

---

## 8 · Mapping swap_tbl rows to recommendations

Real working example: **`buildPlanRecomendadoFromSwapLog()`** in
`web/src/server/analysis.ts`. The TL;DR:

```typescript
function classify(swap: SwapRow): 'reordenar' | 'mover_linea' | 'reprogramar' {
  if (swap.fromLinea !== swap.toLinea) return 'mover_linea';
  if (swap.fromDia   !== swap.toDia)   return 'reprogramar';
  return 'reordenar';
}
```

Sort tip: required moves first (obligatorio / prioritario / desplazado /
realojo), then optional sorted by `ΔOEE pts` descending.

---

## 9 · Error handling

The sidecar **never throws to the caller** in normal failure modes. Instead,
errors are wrapped in `data[0]` as `"❌ Error ..."` markdown. Always check
this before parsing the tables.

### Common error → response

| What happened | `summary_md` starts with | What to do |
|---|---|---|
| File missing or unreadable | `❌ Error parseando el fichero: …` | Show the message to the user |
| File parsed but empty | `⚠️ El fichero se ha parseado pero no contiene bloques válidos.` | Show "plan vacío" |
| Engine crash mid-optimization | `❌ Error optimizando: …` | Fall back to heuristic or show error |
| File not provided | (500 from FastAPI) | Validate before posting |

### Graceful degradation

When the sidecar is **down or unreachable**, the recommended pattern is:
1. Try local first (connection refused → instant)
2. Fall back to HF Space (if you have `HF_TOKEN`)
3. Fall back to a local heuristic last

See `callLineWise()` in `linewise-client.ts` for the working version.

---

## 10 · Performance + troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| First request after sidecar start takes ~15 s | Cold model load + first lookup precompute | Normal — subsequent calls also ~13 s (the per-plan precompute always runs) |
| Connection refused on `:8001` | Sidecar not started | `python scripts/local_model_server.py` |
| `ModuleNotFoundError: No module named 'fastapi'` | Wrong venv | `source .venv/bin/activate && pip install fastapi uvicorn` |
| `summary_md` starts with `❌ Error optimizando: boolean value of NA is ambiguous` | Old engine version | `git pull` (fixed in commit 77bc201) |
| Empty `data[3]` (`swap_tbl`) | Optimizer found nothing to improve | Not an error — the input plan is already optimal |
| Very long latency (>30 s) | Plan too large or wrong engine config | Check `top_k_prevs` (default 10 in `web/src/server/analysis.ts`) |

### When to restart the sidecar

- After changing any `engine/*.py` file
- After re-training models (`python scripts/07_train_oee_quantile.py`)
- After updating `app.py`
- **Not** needed when you only edit `web/` code (Next.js hot-reloads server modules)

---

## 11 · Quick test commands

```bash
# Liveness
curl -s http://localhost:8001/healthz

# Predict only (fast, ~5s)
curl -s -X POST -F "file=@Repte operacions/Diario Hl_Planif.xlsx" \
     http://localhost:8001/predict | jq '.data[0]' | head -20

# Full optimize (the one /validar uses)
curl -s -X POST -F "file=@Repte operacions/Diario Hl_Planif.xlsx" \
     -F "aggressive=false" \
     http://localhost:8001/optimize_v3 | jq '.duration_ms'

# Through the Next.js Route Handler (the realistic path)
curl -s -X POST -F "file=@Repte operacions/Diario Hl_Planif.xlsx" \
     http://localhost:3000/api/planes | jq '.meta'
# → {"source": "linewise", "via": "local", "spaceLatencyMs": 13391}
```

Demo plans live in `juego_de_pruebas/` (`01_baseline_real.xlsx` through
`11_replan_midweek.xlsx`). They're in **Planificado** format though — the
current parser in `web/src/server/parser.ts` only handles **Diario Hl**.
For local testing use `Repte operacions/Diario Hl_Planif.xlsx`.

---

## 12 · Cross-references

| Source of truth | What you'll find there |
|---|---|
| `web/src/server/linewise-client.ts` | Production-quality TypeScript client (local-first + HF fallback) |
| `web/src/server/analysis.ts` | How to translate the sidecar response into your domain types |
| `web/src/app/api/planes/route.ts` | Working Next.js Route Handler example |
| `web/src/app/validar/view.tsx` | A full React surface that consumes everything above |
| `scripts/local_model_server.py` | The sidecar itself (~110 lines, read it for ground truth) |
| `docs/FRONTEND_API_CONTRACT.md` | The HF Space contract (v1.3.0) — same shapes, different transport |
| `app.py` | The Gradio callbacks the sidecar imports |
| `STYLE.md` | UI tokens, components, vocabulary — read before designing |

---

## 13 · Two-line setup for a friend with `git clone`

```bash
# In two terminals after cloning the repo and `pnpm/npm install`'ing web/
cd damm-hack && source .venv/bin/activate && python scripts/local_model_server.py
cd damm-hack/web && npm run dev
```

Then upload an `.xlsx` to whatever frontend page calls the sidecar. Latency
is one number to budget for: **~13 seconds per upload**. Everything else is
synchronous on that single round-trip.

---

**Doc version:** `1.0.0` · matches `scripts/local_model_server.py` 1.0.0 ·
last updated 2026-05-24
