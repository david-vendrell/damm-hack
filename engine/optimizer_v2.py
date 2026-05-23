"""LineWise V2 optimizer — flexible-scheduling solver.

Frees up the line / día / turno assignment per OF (constrained only by the
OF's deadline + Damm's LINE_FORMAT_COMPAT + historical feasibility). Pursues
the OEE ceiling far more aggressively than V1, which was limited to swaps
within the planner's original slot grid.

API:
    optimize_plan_v2(blocks, lookups_dir, models_dir,
                     objective="p50" | "p90",
                     time_budget_sec=90) -> dict
"""

from __future__ import annotations

import time
from copy import deepcopy
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .build_features import build_feature_rows
from .constraints import (
    Job, Slot,
    can_place,
    full_audit,
)
from .precompute import build_jobs_and_slots, precompute_intrinsic_scores
from .predict_oee import predict_blocks


# ============================================================
# Public API
# ============================================================
def optimize_plan_v2(
    blocks: pd.DataFrame,
    lookups_dir: str | Path,
    models_dir: str | Path = "models",
    objective: str = "p50",            # "p50" (expected) | "p90" (aggressive ceiling)
    time_budget_sec: float = 90.0,
    max_local_search_iter: int = 40,
) -> dict[str, Any]:
    """Search for the highest-OEE feasible re-assignment of the uploaded plan
    subject to: each OF's deadline, the LINE_FORMAT_COMPAT rule, and historical
    sku-line feasibility (≥3 runs)."""
    t0 = time.time()

    # ------------------------------------------------------------------ Setup
    if blocks.empty:
        return _empty_result()
    jobs, slots, jobs_by_id, slots_by_id = build_jobs_and_slots(blocks, lookups_dir)
    if not jobs or not slots:
        return _empty_result()

    # ------------------------------------------------------------------ Baseline
    base_preds = _score_full(blocks, lookups_dir, models_dir)
    baseline_score = _weighted_mean(base_preds, blocks, objective)

    # ------------------------------------------------------------------ Precompute
    lookup = precompute_intrinsic_scores(jobs, slots, blocks, lookups_dir, models_dir)
    if not lookup:
        return _empty_result()

    def lookup_score(j: Job, s: Slot) -> float:
        v = lookup.get((j.job_id, s.slot_id))
        return float(v[objective]) if v is not None else float("-inf")

    # ------------------------------------------------------------------ Phase B: start from baseline
    assignment, capacity_used = _baseline_assignment(blocks, slots, slots_by_id)

    # ------------------------------------------------------------------ Phase C: local search
    _local_search(jobs, slots, jobs_by_id, slots_by_id, lookup, objective,
                  assignment, capacity_used,
                  time_budget_sec=max(0.0, time_budget_sec - (time.time() - t0) - 8),
                  max_iter=max_local_search_iter,
                  blocks=blocks, lookups_dir=str(lookups_dir), models_dir=str(models_dir))

    # ------------------------------------------------------------------ Build final plan + audit
    best_blocks = _materialise_blocks(blocks, assignment, jobs_by_id, slots_by_id)
    best_preds = _score_full(best_blocks, lookups_dir, models_dir)
    final_score = _weighted_mean(best_preds, best_blocks, objective)

    # ----- Safety guard: the precompute is prev_sku-blind. After full re-score
    # the proposed plan may be worse than baseline. In that case, fall back to
    # the original plan and emit zero-change (do-no-harm semantics).
    fallback_to_baseline = False
    if final_score < baseline_score - 1e-4:
        fallback_to_baseline = True
        # Reset to the baseline state
        assignment = {row["block_id"]: _slot_id_from_raw(row, slots_by_id) or list(slots_by_id.keys())[0]
                      for _, row in blocks.iterrows()}
        best_blocks = blocks.copy()
        best_preds = base_preds.copy()
        final_score = baseline_score

    audit = full_audit(blocks, best_blocks, assignment, jobs_by_id, slots_by_id)

    # Build the swap log: any job whose (línea, fecha, turno) changed from original
    if fallback_to_baseline:
        swap_log = []
    else:
        swap_log = _build_swap_log(blocks, best_blocks, assignment, jobs_by_id, slots_by_id,
                                   lookup, objective)

    per_line = _per_line_breakdown(blocks, base_preds, best_blocks, best_preds, objective)

    return {
        "objective":              objective,
        "baseline_score":         float(baseline_score),
        "optimized_score":        float(final_score),
        "delta_oee_pts":          round((final_score - baseline_score) * 100, 3),
        "n_changes":              len(swap_log),
        "best_blocks":            best_blocks,
        "best_preds":             best_preds,
        "swap_log":               swap_log,
        "per_line":               per_line,
        "elapsed_sec":            round(time.time() - t0, 2),
        "truncated":              bool((time.time() - t0) > time_budget_sec),
        "audit":                  audit,
        "n_jobs":                 len(jobs),
        "n_feasible_slot_options": int(np.mean([len([s for s in slots if can_place(j, s)]) for j in jobs])),
        "fallback_to_baseline":   fallback_to_baseline,
    }


# ============================================================
# Phase B: greedy constructive
# ============================================================
def _baseline_assignment(
    blocks: pd.DataFrame,
    slots: list[Slot],
    slots_by_id: dict[str, Slot],
) -> tuple[dict[str, str], dict[str, int]]:
    """Initial assignment = the planner's original (línea, fecha, turno) for
    every block. The local search starts from here and only applies improving
    moves; if no improving move exists we return the planner's original plan
    unchanged."""
    assignment: dict[str, str] = {}
    capacity_used: dict[str, int] = {s.slot_id: 0 for s in slots}
    fallback_sid = next(iter(slots_by_id))
    for _, row in blocks.iterrows():
        sid = _slot_id_from_raw(row.to_dict(), slots_by_id) or fallback_sid
        assignment[str(row["block_id"])] = sid
        capacity_used[sid] = capacity_used.get(sid, 0) + 1
    return assignment, capacity_used


def _greedy_assign(
    jobs: list[Job],
    slots: list[Slot],
    slots_by_id: dict[str, Slot],
    lookup: dict[tuple[str, str], dict[str, float]],
    objective: str,
) -> tuple[dict[str, str], dict[str, int]]:
    """For each job (sorted by deadline asc, then by hl desc), pick the
    best-scoring feasible slot with remaining capacity."""
    assignment: dict[str, str] = {}
    capacity_used: dict[str, int] = {s.slot_id: 0 for s in slots}

    ordered_jobs = sorted(jobs, key=lambda j: (j.deadline, -j.hl))
    for j in ordered_jobs:
        feasible = [(s, lookup.get((j.job_id, s.slot_id), {}).get(objective, float("-inf")))
                    for s in slots if can_place(j, s)]
        feasible.sort(key=lambda x: x[1], reverse=True)
        placed = False
        for s, score in feasible:
            if capacity_used[s.slot_id] < s.capacity_blocks:
                assignment[j.job_id] = s.slot_id
                capacity_used[s.slot_id] += 1
                placed = True
                break
        if not placed and feasible:
            # All feasible slots over capacity — pick highest-scoring anyway (soft overflow)
            assignment[j.job_id] = feasible[0][0].slot_id
            capacity_used[feasible[0][0].slot_id] += 1
        elif not placed:
            # No feasible slot — keep original assignment as fallback
            assignment[j.job_id] = (
                _slot_id_from_raw(j.raw_row, slots_by_id) or list(slots_by_id.keys())[0]
            )
            capacity_used[assignment[j.job_id]] += 1
    return assignment, capacity_used


def _slot_id_from_raw(raw_row: dict, slots_by_id: dict[str, Slot]) -> str | None:
    try:
        ln = int(raw_row["linea"])
        d = pd.Timestamp(raw_row["fecha"]).date().isoformat()
        t = raw_row.get("turno") or "T"
        sid = f"L{ln}|{d}|{t}"
        return sid if sid in slots_by_id else None
    except Exception:
        return None


# ============================================================
# Phase C: local search
# ============================================================
def _local_search(
    jobs: list[Job],
    slots: list[Slot],
    jobs_by_id: dict[str, Job],
    slots_by_id: dict[str, Slot],
    lookup: dict[tuple[str, str], dict[str, float]],
    objective: str,
    assignment: dict[str, str],
    capacity_used: dict[str, int],
    time_budget_sec: float,
    max_iter: int,
    blocks: pd.DataFrame | None = None,
    lookups_dir: str | None = None,
    models_dir: str | None = None,
) -> None:
    """Validated local search.

    Uses the lookup as a fast HEURISTIC to rank candidate moves, but each
    accepted move is verified against the FULL model score (with real
    prev_sku context). Only moves that strictly improve the full score are
    kept; otherwise reverted and tabu'd to prevent cycling.

    The lookup is prev-blind so it tends to overestimate. The validation
    step ensures we never make the plan worse than baseline.
    """
    if time_budget_sec <= 0 or blocks is None:
        return
    t0 = time.time()
    tabu: set[tuple[str, str]] = set()

    # Score the current full plan once
    current_blocks = _materialise_blocks(blocks, assignment, jobs_by_id, slots_by_id)
    current_preds  = _score_full(current_blocks, lookups_dir, models_dir)
    current_score  = _weighted_mean(current_preds, current_blocks, objective)

    for iteration in range(max_iter):
        if time.time() - t0 > time_budget_sec:
            break

        # ----- find the best candidate move by LOOKUP score (fast)
        best_lookup_delta = 1e-3   # require ≥ 0.1 pts on the lookup metric
        best_move = None
        for j in jobs:
            cur_sid = assignment[j.job_id]
            cur_lk = lookup.get((j.job_id, cur_sid), {}).get(objective, float("-inf"))
            for s in slots:
                if s.slot_id == cur_sid:
                    continue
                if (j.job_id, s.slot_id) in tabu:
                    continue
                if not can_place(j, s):
                    continue
                if capacity_used[s.slot_id] >= s.capacity_blocks:
                    continue
                new_lk = lookup.get((j.job_id, s.slot_id), {}).get(objective, float("-inf"))
                delta = new_lk - cur_lk
                if delta > best_lookup_delta:
                    best_lookup_delta = delta
                    best_move = (j.job_id, cur_sid, s.slot_id)

        if best_move is None:
            break

        # ----- validate against the FULL model
        jid, from_sid, to_sid = best_move
        capacity_used[from_sid] -= 1
        capacity_used[to_sid]   += 1
        assignment[jid]          = to_sid

        cand_blocks = _materialise_blocks(blocks, assignment, jobs_by_id, slots_by_id)
        cand_preds  = _score_full(cand_blocks, lookups_dir, models_dir)
        cand_score  = _weighted_mean(cand_preds, cand_blocks, objective)

        if cand_score > current_score + 1e-4:
            # Accept
            current_blocks, current_preds, current_score = cand_blocks, cand_preds, cand_score
            tabu.add((jid, from_sid))   # don't oscillate
        else:
            # Reject — revert
            capacity_used[to_sid]   -= 1
            capacity_used[from_sid] += 1
            assignment[jid]          = from_sid
            tabu.add((jid, to_sid))     # don't propose this dead-end again


# ============================================================
# Materialise blocks DataFrame from final assignment
# ============================================================
def _materialise_blocks(
    blocks: pd.DataFrame,
    assignment: dict[str, str],
    jobs_by_id: dict[str, Job],
    slots_by_id: dict[str, Slot],
) -> pd.DataFrame:
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
    # Re-derive __pos within each new (línea, día, turno)
    if "__pos" in out.columns:
        out = out.drop(columns="__pos")
    out = out.sort_values(["linea", "start_ts", "secuencia"], na_position="last").reset_index(drop=True)
    return out


# ============================================================
# Scoring helpers
# ============================================================
def _score_full(blocks: pd.DataFrame, lookups_dir, models_dir) -> pd.DataFrame:
    feats = build_feature_rows(blocks.drop(columns=["__pos"], errors="ignore"), lookups_dir)
    preds = predict_blocks(feats, models_dir=str(models_dir), top_k_shap=0)
    if "block_id" not in preds.columns and "block_id" in blocks.columns:
        preds = preds.reset_index(drop=True)
        preds["block_id"] = blocks["block_id"].values
    return preds


def _weighted_mean(preds: pd.DataFrame, blocks: pd.DataFrame, objective: str) -> float:
    if preds.empty:
        return 0.0
    df = preds[["block_id", objective]].merge(
        blocks[["block_id", "hl"]].drop_duplicates(subset="block_id"),
        on="block_id",
    )
    df["hl"] = df["hl"].clip(lower=0).fillna(0)
    if df["hl"].sum() == 0:
        return float(df[objective].mean())
    return float((df[objective] * df["hl"]).sum() / df["hl"].sum())


# ============================================================
# Per-line breakdown
# ============================================================
def _per_line_breakdown(
    blocks_base, preds_base, blocks_opt, preds_opt, objective: str,
) -> dict:
    out = {}
    base_join = preds_base[["block_id", objective]].merge(
        blocks_base[["block_id", "linea", "hl"]], on="block_id")
    opt_join = preds_opt[["block_id", objective]].merge(
        blocks_opt[["block_id", "linea", "hl"]], on="block_id")
    for linea in sorted({*blocks_base["linea"].unique(), *blocks_opt["linea"].unique()}):
        bl = base_join[base_join["linea"] == linea]
        ol = opt_join[opt_join["linea"] == linea]
        baseline = float((bl[objective] * bl["hl"]).sum() / max(bl["hl"].sum(), 1.0)) if len(bl) else 0.0
        optimized = float((ol[objective] * ol["hl"]).sum() / max(ol["hl"].sum(), 1.0)) if len(ol) else 0.0
        out[int(linea)] = {
            "baseline":   round(baseline, 4),
            "optimized":  round(optimized, 4),
            "delta_pts":  round((optimized - baseline) * 100, 2),
            "n_blocks_baseline":  int(len(bl)),
            "n_blocks_optimized": int(len(ol)),
        }
    return out


# ============================================================
# Swap log (record per-block changes)
# ============================================================
def _build_swap_log(
    blocks_before: pd.DataFrame,
    blocks_after: pd.DataFrame,
    assignment: dict[str, str],
    jobs_by_id: dict[str, Job],
    slots_by_id: dict[str, Slot],
    lookup: dict[tuple[str, str], dict[str, float]],
    objective: str,
) -> list[dict]:
    before_idx = blocks_before.set_index("block_id")
    after_idx  = blocks_after.set_index("block_id")
    log = []
    for bid, new_sid in assignment.items():
        if bid not in before_idx.index or bid not in after_idx.index:
            continue
        b = before_idx.loc[bid]
        a = after_idx.loc[bid]
        if (int(b["linea"]) == int(a["linea"])
                and pd.Timestamp(b["fecha"]).date() == pd.Timestamp(a["fecha"]).date()
                and (b.get("turno") or "") == (a.get("turno") or "")):
            continue
        slot = slots_by_id[new_sid]
        score = lookup.get((bid, new_sid), {}).get(objective)
        log.append({
            "block_id":         bid,
            "sku":              str(a["sku"]),
            "from_linea":       int(b["linea"]),
            "from_fecha":       pd.Timestamp(b["fecha"]).strftime("%Y-%m-%d"),
            "from_turno":       (b.get("turno") or "") or "",
            "to_linea":         int(slot.linea),
            "to_fecha":         slot.fecha.isoformat(),
            "to_turno":         slot.turno,
            "predicted_score":  round(float(score), 4) if score is not None else None,
            "description":      _describe_change(b, slot, str(a["sku"])),
        })
    log.sort(key=lambda x: (x["to_linea"], x["to_fecha"], x["to_turno"]))
    return log


def _describe_change(before_row: pd.Series, slot: Slot, sku: str) -> str:
    fb = pd.Timestamp(before_row["fecha"]).strftime("%Y-%m-%d")
    tb = before_row.get("turno") or "?"
    return (f"Mover {sku}  L{int(before_row['linea'])}/{fb}/{tb}  →  "
            f"L{slot.linea}/{slot.fecha.isoformat()}/{slot.turno}")


# ============================================================
# Empty result for degenerate inputs
# ============================================================
def _empty_result() -> dict:
    return {
        "objective": "p50",
        "baseline_score":   0.0,
        "optimized_score":  0.0,
        "delta_oee_pts":    0.0,
        "n_changes":        0,
        "best_blocks":      pd.DataFrame(),
        "best_preds":       pd.DataFrame(),
        "swap_log":         [],
        "per_line":         {},
        "elapsed_sec":      0.0,
        "truncated":        False,
        "audit":            {"all_ok": True},
    }


# ============================================================
# JSON-friendly export
# ============================================================
def optimizer_v2_result_to_json(result: dict[str, Any]) -> dict:
    def _df(df: pd.DataFrame) -> list[dict]:
        if df is None or df.empty:
            return []
        d = df.copy()
        for c in d.columns:
            if pd.api.types.is_datetime64_any_dtype(d[c]):
                d[c] = d[c].dt.strftime("%Y-%m-%dT%H:%M:%S")
        d = d.where(pd.notna(d), None)
        return d.to_dict(orient="records")

    return {
        "objective":                      result["objective"],
        "baseline_oee_hl_weighted":       float(result["baseline_score"]),
        "optimized_oee_hl_weighted":      float(result["optimized_score"]),
        "delta_oee_pts":                  float(result["delta_oee_pts"]),
        "n_blocks_changed":               int(result["n_changes"]),
        "elapsed_sec":                    float(result["elapsed_sec"]),
        "truncated":                      bool(result["truncated"]),
        "per_line":                       {str(k): v for k, v in result["per_line"].items()},
        "swap_log":                       result["swap_log"],
        "audit":                          result.get("audit", {}),
        "optimized_blocks":               _df(result["best_blocks"]),
        "optimized_predictions":          _df(result["best_preds"]),
    }
