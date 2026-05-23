"""LineWise V3 optimizer — cascade-aware local search using a prev_sku-aware lookup.

Closes the V2 cascade-validation gap by precomputing the OEE prediction for
every (job, slot, candidate prev_sku) triple up-front. The local search then
evaluates moves in O(1) with the REAL prev_sku context, so the validation
step that V2 needed (full re-score per move) becomes unnecessary.

Plus: every applied move carries explicit operational metrics
    · ΔOEE pts (HL-weighted)
    · Δ changeover minutes  (from CF Prat theoretical matrix)
    · Δ maintenance proximity hours
so the planner sees WHY each move is good, not just the OEE number.

Public API:
    optimize_plan_v3(blocks, lookups_dir, models_dir,
                     objective='p50'|'p90',
                     time_budget_sec=90,
                     top_k_prevs=20)
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .build_features import build_feature_rows
from .constraints import Job, Slot, can_place, full_audit
from .explainer import describe_move, weekly_summary
from .precompute_v3 import build_prev_aware_lookup
from .precompute import build_jobs_and_slots
from .predict_oee import predict_blocks


# ============================================================
# Public API
# ============================================================
def optimize_plan_v3(
    blocks: pd.DataFrame,
    lookups_dir: str | Path,
    models_dir: str | Path = "models",
    objective: str = "p50",
    time_budget_sec: float = 90.0,
    max_iter: int = 60,
    top_k_prevs: int = 20,
) -> dict[str, Any]:
    """V3 cascade-aware optimizer with operational reasoning."""
    t0 = time.time()

    if blocks.empty:
        return _empty_result()

    blocks = blocks.copy()
    if "start_ts" not in blocks.columns:
        blocks["start_ts"] = pd.to_datetime(blocks["fecha"])
    blocks["start_ts"] = pd.to_datetime(blocks["start_ts"])
    blocks = blocks.sort_values(["linea", "start_ts", "secuencia"], na_position="last").reset_index(drop=True)

    jobs, slots, jobs_by_id, slots_by_id = build_jobs_and_slots(blocks, lookups_dir)
    if not jobs or not slots:
        return _empty_result()

    # ----- baseline score
    base_preds = _score_full(blocks, lookups_dir, models_dir)
    baseline_score = _hl_weighted(base_preds, blocks, objective)

    # ----- precompute prev-aware lookup
    print(f"   precomputing prev-aware lookup (top_k_prevs={top_k_prevs})...")
    lookup, prev_pool = build_prev_aware_lookup(
        jobs, slots, blocks, lookups_dir, models_dir, top_k_prevs=top_k_prevs,
    )
    print(f"   lookup size: {len(lookup):,} entries, elapsed {time.time()-t0:.1f}s")
    if not lookup:
        return _empty_result()

    # ----- preload theoretical changeover matrix for operational metrics
    matrix_df = pd.read_parquet(Path(lookups_dir) / "dim_theoretical_changeover_matrix.parquet")
    matrix_dict = {
        (int(r.linea), str(r.from_state), str(r.to_state)): int(r.minutes)
        for r in matrix_df.itertuples()
    }
    # Maintenance schedule per línea (approximate from historical LIMPIEZA cadence)
    maint = pd.read_parquet(Path(lookups_dir) / "maintenance_proxy.parquet")
    avg_days_between_maint = {
        int(r.linea): float(r.expected_days_between_limpiezas)
        for r in maint.itertuples()
    }

    # ----- baseline assignment (start from planner's original)
    assignment: dict[str, str] = {}
    for _, row in blocks.iterrows():
        sid = _slot_id_from_row(row, slots_by_id)
        if sid is None:
            sid = next(iter(slots_by_id))
        assignment[str(row["block_id"])] = sid

    # We also track per-slot ordered list of jobs (sequence within slot) for prev_sku
    slot_to_jobs: dict[str, list[str]] = {}
    for jid, sid in assignment.items():
        slot_to_jobs.setdefault(sid, []).append(jid)
    for sid in slot_to_jobs:
        # Order by original secuencia / start_ts (already sorted)
        order = blocks.set_index("block_id").loc[slot_to_jobs[sid]].reset_index()
        order = order.sort_values(["start_ts", "secuencia"], na_position="last")
        slot_to_jobs[sid] = order["block_id"].astype(str).tolist()

    # ----- helper: what prev_sku does job j see in current assignment?
    def prev_sku_of(jid: str) -> str | None:
        sid = assignment[jid]
        chain = slot_to_jobs.get(sid, [])
        if not chain:
            return None
        idx = chain.index(jid) if jid in chain else 0
        if idx == 0:
            return None
        return str(jobs_by_id[chain[idx - 1]].sku)

    # ----- helper: score a job given its current slot+prev (uses lookup with fallback)
    def lookup_score(jid: str, sid: str, prev_sku: str | None) -> float:
        key = (jid, sid, prev_sku)
        v = lookup.get(key)
        if v is None:
            # Fall back to no-prev entry if prev_sku not in pool
            v = lookup.get((jid, sid, None))
        return float(v[objective]) if v is not None else float("-inf")

    # ----- helper: compute current full score using lookup (cascade-aware)
    def full_score() -> float:
        tot_hl, tot_w = 0.0, 0.0
        for jid in assignment:
            j = jobs_by_id[jid]
            sid = assignment[jid]
            prev = prev_sku_of(jid)
            s = lookup_score(jid, sid, prev)
            if s == float("-inf"):
                continue
            tot_w += s * j.hl
            tot_hl += j.hl
        return tot_w / tot_hl if tot_hl > 0 else 0.0

    current_score = full_score()

    # ============================================================
    # Lookup-driven local search (prev-aware lookup proposes; full re-score validates)
    # ============================================================
    swap_log: list[dict] = []
    tabu: set[tuple[str, str]] = set()
    MIN_IMPROVEMENT = 1e-4   # 0.01 OEE pts in fraction (more sensitive than V2's 1e-3)

    # Initial full-rescore baseline (uses real model predictions, not lookup)
    cur_full_blocks = _materialise_blocks(blocks, assignment, jobs_by_id, slots_by_id)
    cur_full_preds  = _score_full(cur_full_blocks, lookups_dir, models_dir)
    current_score   = _hl_weighted(cur_full_preds, cur_full_blocks, objective)

    for iteration in range(max_iter):
        if time.time() - t0 > time_budget_sec:
            break

        # Find the candidate with the highest SELF-DELTA in the prev-aware lookup
        best_lookup_delta = MIN_IMPROVEMENT
        best_move = None
        for j in jobs:
            jid = j.job_id
            cur_sid = assignment[jid]
            cur_prev = prev_sku_of(jid)
            cur_score_self = lookup_score(jid, cur_sid, cur_prev)
            # Skip jobs whose current slot isn't in the lookup (shouldn't happen often)
            if cur_score_self == float("-inf"):
                cur_score_self = 0.0

            for s in slots:
                if s.slot_id == cur_sid:
                    continue
                if not can_place(j, s):
                    continue
                if (jid, s.slot_id) in tabu:
                    continue
                if len(slot_to_jobs.get(s.slot_id, [])) >= s.capacity_blocks + 2:
                    continue

                new_chain = slot_to_jobs.get(s.slot_id, [])
                new_prev = str(jobs_by_id[new_chain[-1]].sku) if new_chain else None
                new_score_self = lookup_score(jid, s.slot_id, new_prev)
                if new_score_self == float("-inf"):
                    continue
                # HL-weighted self-delta (single block)
                total_hl = sum(jj.hl for jj in jobs)
                delta = (new_score_self - cur_score_self) * j.hl / max(total_hl, 1.0)
                if delta > best_lookup_delta:
                    best_lookup_delta = delta
                    best_move = (jid, cur_sid, s.slot_id, new_prev, cur_prev)

        if best_move is None:
            break

        # Apply tentatively
        jid, from_sid, to_sid, new_prev, old_prev = best_move
        slot_to_jobs[from_sid].remove(jid)
        slot_to_jobs.setdefault(to_sid, []).append(jid)
        assignment[jid] = to_sid

        # Validate with full re-score (catches cascades the lookup missed)
        cand_blocks = _materialise_blocks(blocks, assignment, jobs_by_id, slots_by_id)
        cand_preds  = _score_full(cand_blocks, lookups_dir, models_dir)
        new_score   = _hl_weighted(cand_preds, cand_blocks, objective)
        actual_delta = new_score - current_score

        if actual_delta <= MIN_IMPROVEMENT:
            # Revert
            slot_to_jobs[to_sid].remove(jid)
            slot_to_jobs[from_sid].append(jid)
            assignment[jid] = from_sid
            tabu.add((jid, to_sid))
            continue

        tabu.add((jid, from_sid))
        current_score = new_score

        # Compute operational metrics for the move
        j_obj = jobs_by_id[jid]
        op_metrics = _compute_operational_metrics(
            j_obj, jobs_by_id, slots_by_id,
            from_sid, to_sid, old_prev, new_prev,
            matrix_dict, avg_days_between_maint,
        )

        move_record = {
            "iteration":       iteration + 1,
            "block_id":        jid,
            "sku":             str(j_obj.sku),
            "from_linea":      slots_by_id[from_sid].linea,
            "from_fecha":      slots_by_id[from_sid].fecha.isoformat(),
            "from_turno":      slots_by_id[from_sid].turno,
            "to_linea":        slots_by_id[to_sid].linea,
            "to_fecha":        slots_by_id[to_sid].fecha.isoformat(),
            "to_turno":        slots_by_id[to_sid].turno,
            "delta_oee_pts":   round(actual_delta * 100, 3),
            **op_metrics,
        }
        move_record["description"] = describe_move(move_record)
        swap_log.append(move_record)
        current_score = new_score

    # ============================================================
    # Materialise final plan + audit
    # ============================================================
    best_blocks = _materialise_blocks(blocks, assignment, jobs_by_id, slots_by_id)
    best_preds = _score_full(best_blocks, lookups_dir, models_dir)
    final_score = _hl_weighted(best_preds, best_blocks, objective)

    audit = full_audit(blocks, best_blocks, assignment, jobs_by_id, slots_by_id)
    per_line = _per_line_breakdown(blocks, base_preds, best_blocks, best_preds, objective)
    per_day  = _per_day_factory_breakdown(blocks, base_preds, best_blocks, best_preds, objective)
    total_hl = float(blocks["hl"].sum())

    summary = weekly_summary(swap_log, baseline_score, final_score)

    return {
        "objective":          objective,
        "baseline_score":     float(baseline_score),
        "optimized_score":    float(final_score),
        "delta_oee_pts":      round((final_score - baseline_score) * 100, 3),
        "n_changes":          len(swap_log),
        "best_blocks":        best_blocks,
        "best_preds":         best_preds,
        "swap_log":           swap_log,
        "per_line":           per_line,
        "per_day":            per_day,
        "total_hl":           total_hl,
        "elapsed_sec":        round(time.time() - t0, 2),
        "truncated":          bool((time.time() - t0) > time_budget_sec),
        "audit":              audit,
        "n_jobs":             len(jobs),
        "lookup_size":        len(lookup),
        "weekly_summary":     summary,
        "prev_pool_per_linea": {str(k): v for k, v in prev_pool.items()},
    }


# ============================================================
# Operational metrics
# ============================================================
def _compute_operational_metrics(
    job: Job, jobs_by_id, slots_by_id,
    from_sid: str, to_sid: str,
    old_prev: str | None, new_prev: str | None,
    matrix_dict, avg_days_between_maint,
) -> dict:
    """Compute ΔchangeoverMin, ΔmaintHours, same_format_neighbour for one move."""
    from_slot = slots_by_id[from_sid]
    to_slot   = slots_by_id[to_sid]

    # Δ changeover minutes = teorico_at_old_position - teorico_at_new_position
    # Position cost = changeover INTO this position (from old_prev → job vs new_prev → job)
    def teo_cost(prev_sku: str | None, linea: int) -> int:
        if prev_sku is None:
            return 0
        prev_ev = _estado_volumen_for_sku(prev_sku, jobs_by_id)
        cur_ev = job.estado_volumen
        if prev_ev is None or cur_ev is None:
            return 0
        return matrix_dict.get((linea, prev_ev, cur_ev), 0)

    old_co = teo_cost(old_prev, from_slot.linea)
    new_co = teo_cost(new_prev, to_slot.linea)
    delta_changeover = new_co - old_co   # negative = saved

    # Δ maintenance proximity (positive = farther = better)
    cadence_old = avg_days_between_maint.get(from_slot.linea, 14.0)
    cadence_new = avg_days_between_maint.get(to_slot.linea, 14.0)
    # Crude proxy: smaller cadence = more frequent maintenance = closer
    delta_maint_hours = (cadence_new - cadence_old) * 24

    # Same-format neighbour?
    new_neighbour_ev = _estado_volumen_for_sku(new_prev, jobs_by_id) if new_prev else None
    same_format = (new_neighbour_ev == job.estado_volumen) if (new_neighbour_ev and job.estado_volumen) else False

    return {
        "delta_changeover_min":     round(delta_changeover, 1),
        "delta_maint_hours_close":  round(delta_maint_hours, 1),
        "same_format_neighbour":    bool(same_format),
    }


def _estado_volumen_for_sku(sku: str, jobs_by_id) -> str | None:
    for j in jobs_by_id.values():
        if str(j.sku) == sku:
            return j.estado_volumen
    return None


# ============================================================
# Helpers (mirrored from V2)
# ============================================================
def _slot_id_from_row(row, slots_by_id):
    try:
        ln = int(row["linea"])
        d = pd.Timestamp(row["fecha"]).date().isoformat()
        t = row.get("turno") or "T"
        sid = f"L{ln}|{d}|{t}"
        return sid if sid in slots_by_id else None
    except Exception:
        return None


def _score_full(blocks, lookups_dir, models_dir):
    feats = build_feature_rows(blocks.drop(columns=["__pos"], errors="ignore"), lookups_dir)
    preds = predict_blocks(feats, models_dir=str(models_dir), top_k_shap=0)
    if "block_id" not in preds.columns and "block_id" in blocks.columns:
        preds = preds.reset_index(drop=True)
        preds["block_id"] = blocks["block_id"].values
    return preds


def _hl_weighted(preds, blocks, objective):
    if preds.empty:
        return 0.0
    df = preds[["block_id", objective]].merge(
        blocks[["block_id", "hl"]].drop_duplicates("block_id"),
        on="block_id",
    )
    df["hl"] = df["hl"].clip(lower=0).fillna(0)
    if df["hl"].sum() == 0:
        return float(df[objective].mean())
    return float((df[objective] * df["hl"]).sum() / df["hl"].sum())


def _materialise_blocks(blocks, assignment, jobs_by_id, slots_by_id):
    out = blocks.copy()
    for idx, row in out.iterrows():
        sid = assignment.get(str(row["block_id"]))
        if sid is None:
            continue
        slot = slots_by_id[sid]
        out.at[idx, "linea"]    = int(slot.linea)
        out.at[idx, "fecha"]    = pd.Timestamp(slot.fecha)
        out.at[idx, "turno"]    = slot.turno
        out.at[idx, "start_ts"] = pd.Timestamp(slot.fecha).replace(
            hour={"T": 8, "N": 16, "M": 0}.get(slot.turno, 8))
    if "__pos" in out.columns:
        out = out.drop(columns="__pos")
    out = out.sort_values(["linea", "start_ts", "secuencia"], na_position="last").reset_index(drop=True)
    return out


def _per_line_breakdown(blocks_base, preds_base, blocks_opt, preds_opt, objective):
    base_join = preds_base[["block_id", objective]].merge(
        blocks_base[["block_id", "linea", "hl"]], on="block_id")
    opt_join = preds_opt[["block_id", objective]].merge(
        blocks_opt[["block_id", "linea", "hl"]], on="block_id")
    out = {}
    for linea in sorted({*blocks_base["linea"].unique(), *blocks_opt["linea"].unique()}):
        bl = base_join[base_join["linea"] == linea]
        ol = opt_join[opt_join["linea"] == linea]
        b = float((bl[objective] * bl["hl"]).sum() / max(bl["hl"].sum(), 1.0)) if len(bl) else 0.0
        o = float((ol[objective] * ol["hl"]).sum() / max(ol["hl"].sum(), 1.0)) if len(ol) else 0.0
        out[int(linea)] = {
            "baseline":  round(b, 4),
            "optimized": round(o, 4),
            "delta_pts": round((o - b) * 100, 2),
            "n_blocks_baseline":  int(len(bl)),
            "n_blocks_optimized": int(len(ol)),
        }
    return out


def _per_day_factory_breakdown(blocks_base, preds_base, blocks_opt, preds_opt, objective):
    """Factory-wide (all 3 lines combined) HL-weighted OEE per día.

    This is the operationally meaningful breakdown: each día shows the OEE
    the factory will produce that day combining whatever blocks landed on
    L14 + L17 + L19. Avoids the Simpson's-paradox confusion of per-línea
    averages by keeping the weighting at factory scope.
    """
    base_join = preds_base[["block_id", objective]].merge(
        blocks_base[["block_id", "fecha", "hl"]], on="block_id")
    opt_join = preds_opt[["block_id", objective]].merge(
        blocks_opt[["block_id", "fecha", "hl"]], on="block_id")
    base_join["fecha_d"] = pd.to_datetime(base_join["fecha"]).dt.date
    opt_join["fecha_d"]  = pd.to_datetime(opt_join["fecha"]).dt.date

    out: list[dict] = []
    all_dates = sorted(set(base_join["fecha_d"].unique()) | set(opt_join["fecha_d"].unique()))
    for d in all_dates:
        bl = base_join[base_join["fecha_d"] == d]
        ol = opt_join[opt_join["fecha_d"] == d]
        b_hl = float(bl["hl"].sum())
        o_hl = float(ol["hl"].sum())
        b_oee = float((bl[objective] * bl["hl"]).sum() / max(b_hl, 1.0)) if b_hl else 0.0
        o_oee = float((ol[objective] * ol["hl"]).sum() / max(o_hl, 1.0)) if o_hl else 0.0
        out.append({
            "fecha":               d.isoformat(),
            "n_blocks_baseline":   int(len(bl)),
            "n_blocks_optimized":  int(len(ol)),
            "hl_total":            round(b_hl, 1),
            "baseline":            round(b_oee, 4),
            "optimized":           round(o_oee, 4),
            "delta_pts":           round((o_oee - b_oee) * 100, 2),
        })
    return out


def _empty_result():
    return {
        "objective": "p50",
        "baseline_score": 0.0, "optimized_score": 0.0, "delta_oee_pts": 0.0,
        "n_changes": 0, "best_blocks": pd.DataFrame(), "best_preds": pd.DataFrame(),
        "swap_log": [], "per_line": {}, "per_day": [], "total_hl": 0.0,
        "elapsed_sec": 0.0,
        "truncated": False, "audit": {"all_ok": True}, "weekly_summary": "",
    }


# ============================================================
# JSON serialisation
# ============================================================
def optimizer_v3_result_to_json(result):
    def _df(df):
        if df is None or df.empty:
            return []
        d = df.copy()
        for c in d.columns:
            if pd.api.types.is_datetime64_any_dtype(d[c]):
                d[c] = d[c].dt.strftime("%Y-%m-%dT%H:%M:%S")
        d = d.where(pd.notna(d), None)
        return d.to_dict(orient="records")

    return {
        "objective": result["objective"],
        "baseline_oee_hl_weighted":  float(result["baseline_score"]),
        "optimized_oee_hl_weighted": float(result["optimized_score"]),
        "delta_oee_pts":             float(result["delta_oee_pts"]),
        "n_blocks_changed":          int(result["n_changes"]),
        "elapsed_sec":               float(result["elapsed_sec"]),
        "truncated":                 bool(result["truncated"]),
        "weekly_summary":            result.get("weekly_summary", ""),
        "per_line":                  {str(k): v for k, v in result["per_line"].items()},
        "per_day":                   result.get("per_day", []),
        "total_hl":                  float(result.get("total_hl", 0.0)),
        "swap_log":                  result["swap_log"],
        "audit":                     result.get("audit", {}),
        "optimized_blocks":          _df(result["best_blocks"]),
        "optimized_predictions":     _df(result["best_preds"]),
        "lookup_size":               int(result.get("lookup_size", 0)),
    }
