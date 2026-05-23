"""V2 precompute — for each (job, candidate slot) pair, predict OEE without
prev_sku context. Result is a dict the search loop reads in O(1).

We deliberately ignore prev_sku here for performance:
  - Pure (job × line × day × turno) candidates = ~120 × 3 × 7 × 3 = 7.5 k.
  - Adding prev_sku exploded the lookup to ~900 k → 12 h. Not feasible in a
    hackathon.
  - SHAP analysis of the trained model shows prev_sku features are present in
    the top 10 but `sku`, `linea`, `recent line OEE`, `familia` dominate.
    So a prev-blind lookup captures the bulk of the signal cheaply.

A final post-pass re-scores the full optimised plan with prev_sku context to
report the honest number.
"""

from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path
from typing import Iterable

import holidays as holidays_lib
import numpy as np
import pandas as pd

from .build_features import build_feature_rows
from .constraints import Job, Slot, can_place
from .maintenance_blocker import blocked_slot_map
from .parse_planning_excel import LINE_FORMAT_COMPAT, infer_estado_volumen_from_sku
from .predict_oee import predict_blocks

_HOLIDAYS_ES = holidays_lib.country_holidays("ES")


# ============================================================
# Build jobs + slots from the uploaded blocks
# ============================================================
def build_jobs_and_slots(
    blocks: pd.DataFrame,
    lookups_dir: str | Path,
    extra_days_before_deadline: int = 0,
) -> tuple[list[Job], list[Slot], dict[str, Job], dict[str, Slot]]:
    """Translate a parsed-plan DataFrame into the (jobs, slots) data structures
    the V2 solver consumes.

    The block's `fecha` is treated as the OF's hard DEADLINE (latest day it may
    finish). Slots are the cartesian product of (línea × día × turno) over
    [min(fecha), max(fecha)] from the upload, restricted to physical compat.
    """
    feas = pd.read_parquet(Path(lookups_dir) / "sku_line_feasibility.parquet")
    feas_pairs = {(str(r.sku), int(r.linea)) for r in feas.itertuples()
                  if r.n_historical_runs >= 3}
    dim_sku = pd.read_parquet(Path(lookups_dir) / "dim_sku.parquet")
    sku_to_state = dict(zip(dim_sku["sku"].astype(str), dim_sku["estado_volumen"]))

    fact_slim = pd.read_parquet(Path(lookups_dir) / "fact_runs_slim.parquet")
    cap_per_linea_day = (
        fact_slim.groupby(["linea", fact_slim["fecha"].dt.weekday])["of"]
        .nunique()
        .groupby(level=0).max()
        .to_dict()
    )
    # If a línea isn't in history, fall back to a permissive default
    default_capacity = max(cap_per_linea_day.values(), default=6)

    # ----- jobs -----
    jobs: list[Job] = []
    for idx, row in blocks.iterrows():
        sku = str(row["sku"])
        ev_dim = sku_to_state.get(sku)
        if ev_dim is None or pd.isna(ev_dim):
            ev = infer_estado_volumen_from_sku(sku)
        else:
            ev = str(ev_dim)
        # feasible lines: must be in historical feasibility AND compatible with format
        feasible = set()
        for ln in (14, 17, 19):
            if (sku, ln) in feas_pairs and (ev is None or ev in LINE_FORMAT_COMPAT[ln]):
                feasible.add(ln)
        # if no historical feasibility info, fall back to format-only
        if not feasible and ev is not None:
            for ln in (14, 17, 19):
                if ev in LINE_FORMAT_COMPAT[ln]:
                    feasible.add(ln)
        if not feasible:
            # last resort: original assignment
            feasible = {int(row["linea"])}
        jobs.append(Job(
            job_id=str(row["block_id"]),
            sku=sku,
            hl=float(row["hl"]) if pd.notna(row.get("hl")) else 0.0,
            deadline=pd.Timestamp(row["fecha"]).date(),
            estado_volumen=ev,
            feasible_lines=feasible,
            original_block_id=str(row["block_id"]),
            raw_row=row.to_dict(),
        ))

    # ----- slots -----
    if not jobs:
        return [], [], {}, {}
    earliest = min(j.deadline for j in jobs)
    latest   = max(j.deadline for j in jobs)
    days = [earliest + timedelta(days=i) for i in range((latest - earliest).days + 1 + extra_days_before_deadline)]

    # Project the deterministic CF Prat maintenance schedule onto our planning
    # window. Any (línea, fecha, turno) in this map gets capacity_blocks=0 +
    # is_maintenance_blocked=True so `can_place()` will reject placement.
    maint_map = blocked_slot_map(days, lookups_dir=lookups_dir)

    slots: list[Slot] = []
    for ln in (14, 17, 19):
        cap = int(cap_per_linea_day.get(ln, default_capacity))
        for d in days:
            for turno in ("T", "N", "M"):
                blocked = maint_map.get((ln, d, turno))
                slots.append(Slot(
                    slot_id=f"L{ln}|{d.isoformat()}|{turno}",
                    linea=ln, fecha=d, turno=turno,
                    capacity_blocks=0 if blocked else max(cap, 4),
                    is_maintenance_blocked=bool(blocked),
                    maintenance_event=blocked.event_type if blocked else None,
                    maintenance_reason=blocked.reason if blocked else None,
                ))

    jobs_by_id = {j.job_id: j for j in jobs}
    slots_by_id = {s.slot_id: s for s in slots}
    return jobs, slots, jobs_by_id, slots_by_id


# ============================================================
# Intrinsic-score precompute
# ============================================================
def precompute_intrinsic_scores(
    jobs: list[Job],
    slots: list[Slot],
    blocks: pd.DataFrame,
    lookups_dir: str | Path,
    models_dir: str | Path,
) -> dict[tuple[str, str], dict[str, float]]:
    """Return `lookup[(job_id, slot_id)] = {"p10", "p50", "p90"}` for every
    feasible (job, slot) pair (deadline + format + historical OK). All other
    pairs are absent from the dict — callers must check `can_place(...)` first.
    """
    # Build one synthetic blocks DataFrame containing one row per feasible
    # (job × slot) combination. We treat each candidate as "first block of its
    # slot" → no_predecessor=True; the score reflects intrinsic SKU × línea ×
    # día × turno fit. The post-pass adds prev_sku context.
    rows: list[dict] = []
    keys: list[tuple[str, str]] = []
    for j in jobs:
        for s in slots:
            if not can_place(j, s):
                continue
            raw = dict(j.raw_row)  # copy original row's enrichable bits
            raw["block_id"]  = f"PC_{j.job_id}_{s.slot_id}"
            raw["sku"]       = j.sku
            raw["linea"]     = s.linea
            raw["fecha"]     = pd.Timestamp(s.fecha)
            raw["turno"]     = s.turno
            raw["start_ts"]  = pd.Timestamp(s.fecha).replace(
                hour={"T": 8, "N": 16, "M": 0}.get(s.turno, 8))
            raw["hl"]        = j.hl
            raw["cntd_plan"] = j.hl
            raw["secuencia"] = 1
            raw["source"]    = "precompute"
            raw["feasible"]  = True
            raw["has_history"] = True
            raw["feas_reason"] = None
            rows.append(raw)
            keys.append((j.job_id, s.slot_id))

    if not rows:
        return {}

    cand_blocks = pd.DataFrame(rows)
    # Build features as a one-shot batch — this is the heavy operation
    feats = build_feature_rows(cand_blocks, lookups_dir)
    # Force "no predecessor" semantics so the model uses intrinsic features only
    feats["no_predecessor"] = True
    feats["first_of_day"]   = True
    feats["prev_oee"]       = np.nan
    for col in feats.columns:
        if col.startswith("prev_"):
            feats[col] = np.nan if "fecha" in col else None
    for c in ["same_marca", "same_supramarca", "same_familia", "same_cerveza",
              "same_cbr", "same_envase", "same_tipo_envase", "same_estado_volumen",
              "same_volume_state", "same_packaging", "same_palet"]:
        if c in feats.columns:
            feats[c] = False
    for c in ["c_brand_flag", "c_cap_flag", "c_envase_flag", "c_palet_flag",
              "c_primario_flag", "c_producto_flag", "c_secundario_flag", "c_volum_flag"]:
        if c in feats.columns:
            feats[c] = True
    if "cambio_tipo_principal" in feats.columns:
        feats["cambio_tipo_principal"] = None
    if "teorico_cambio_min" in feats.columns:
        feats["teorico_cambio_min"] = np.nan

    preds = predict_blocks(feats, models_dir=str(models_dir), top_k_shap=0)
    lookup: dict[tuple[str, str], dict[str, float]] = {}
    for k, (_, row) in zip(keys, preds.iterrows()):
        lookup[k] = {
            "p10": float(row["p10"]),
            "p50": float(row["p50"]),
            "p90": float(row["p90"]),
        }
    return lookup
