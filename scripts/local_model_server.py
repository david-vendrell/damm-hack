"""Local LineWise model server (FastAPI sidecar).

Replaces the HF Space round-trip for the Next.js frontend with a same-host
Python process. Loads the 12 LightGBM models once at startup and exposes
the exact same /optimize_v3 contract as the Space (request shape and
response 4-tuple identical so web/src/server/linewise-client.ts works
unchanged).

Run from the repo root:
    source .venv/bin/activate
    python scripts/local_model_server.py

Or with the Next.js `npm run dev:full` script (see web/package.json) which
starts both this server and `next dev` concurrently.

Endpoints:
    GET  /healthz                        → {"status":"ok"} (instant)
    POST /optimize_v3                    → 4-tuple JSON matching HF Space
    POST /predict                        → 4-tuple JSON for the /predict tab

Both POST endpoints accept multipart with:
    file                (required, the planning Excel)
    aggressive          (optional, default 'false')
    outages_json        (optional, JSON string)
    priority_ofs_json   (optional, JSON string)
    replan_from_ts      (optional, ISO timestamp)
"""

from __future__ import annotations

import io
import sys
import tempfile
import time
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# Allow imports from the repo root regardless of where uvicorn is run from
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Import the Gradio app's callbacks directly so the response is identical
# to the HF Space. `app` initialises the models on import (lazy via the
# predict_oee module's @lru_cache loader on first call).
import app as linewise_app  # noqa: E402

API_VERSION = "1.0.0"

app = FastAPI(title="LineWise local model server", version=API_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# ============================================================
# Helpers
# ============================================================
def _df_to_gradio(df: pd.DataFrame) -> dict:
    """Serialise a pandas DataFrame in the same shape Gradio uses on the wire:
        {headers: [...], data: [[...]], metadata: {dtype: [...]}}.
    This keeps web/src/server/linewise-client.ts's parsers working unchanged.
    """
    if df is None or df.empty:
        return {"headers": [], "data": [], "metadata": {"dtype": []}}
    return {
        "headers": list(df.columns.astype(str)),
        "data": df.where(pd.notna(df), None).values.tolist(),
        "metadata": {"dtype": [str(d) for d in df.dtypes.astype(str)]},
    }


async def _spool_upload(file: UploadFile) -> str:
    """Persist the uploaded file to a temp path so the engine parser
    (which calls pd.ExcelFile on a path) can read it. Returns the path.
    """
    suffix = ".xlsx"
    if file.filename and file.filename.lower().endswith((".xlsx", ".xls")):
        suffix = "." + file.filename.rsplit(".", 1)[1]
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tf:
        contents = await file.read()
        tf.write(contents)
        return tf.name


# ============================================================
# Routes
# ============================================================
@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok", "version": API_VERSION}


@app.post("/predict")
async def predict_route(file: UploadFile = File(...)):
    """Run the predict callback. Returns the same 4-tuple shape as Gradio:
        [summary_md, line_tbl, blocks_tbl, drivers_tbl]
    """
    t0 = time.time()
    path = await _spool_upload(file)
    try:
        summary_md, line_tbl, blocks_tbl, drivers_tbl = linewise_app.predict(path)
    except Exception as exc:
        return JSONResponse(status_code=500, content={"error": str(exc)})
    return {
        "data": [
            summary_md,
            _df_to_gradio(line_tbl),
            _df_to_gradio(blocks_tbl),
            _df_to_gradio(drivers_tbl),
        ],
        "duration_ms": int((time.time() - t0) * 1000),
    }


@app.post("/optimize_v3")
async def optimize_v3_route(
    file: UploadFile = File(...),
    aggressive: str = Form("false"),
    outages_json: str = Form(""),
    priority_ofs_json: str = Form(""),
    replan_from_ts: str = Form(""),
):
    """Run the optimize_v3 callback. Returns the same 4-tuple shape as Gradio:
        [summary_md, day_tbl, line_tbl, swap_tbl]
    """
    t0 = time.time()
    path = await _spool_upload(file)
    is_aggressive = str(aggressive).lower() in ("true", "1", "yes", "on")
    try:
        summary_md, day_tbl, line_tbl, swap_tbl = linewise_app.optimize_v3(
            path,
            is_aggressive,
            outages_json,
            priority_ofs_json,
            replan_from_ts,
        )
    except Exception as exc:
        return JSONResponse(status_code=500, content={"error": str(exc)})
    return {
        "data": [
            summary_md,
            _df_to_gradio(day_tbl),
            _df_to_gradio(line_tbl),
            _df_to_gradio(swap_tbl),
        ],
        "duration_ms": int((time.time() - t0) * 1000),
    }


# ============================================================
# Entry point
# ============================================================
if __name__ == "__main__":
    import uvicorn

    print(f"==> LineWise local model server v{API_VERSION}")
    print(f"==> Repo root: {ROOT}")
    print(f"==> Models:    {ROOT / 'models'}")
    print(f"==> Listening on http://localhost:8001")
    uvicorn.run(
        "scripts.local_model_server:app",
        host="0.0.0.0",
        port=8001,
        reload=False,
        log_level="info",
    )
