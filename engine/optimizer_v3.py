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

V3.1 — Incidencias (`outages`, `priority_ofs`):
    · `outages`      = list[{linea, fecha, turno, reason?}] — slots hard-blocked
                       at runtime (broken línea / declared incident). Treated
                       identically to scheduled maintenance.
    · `priority_ofs` = list[{sku, hl, deadline, preferred_linea?, reason?}] —
                       extra urgent OFs that MUST be placed before their deadline.
                       Pre-placement evicts the lowest-(p50×HL) existing OF from
                       the chosen slot if at capacity (single-level eviction;
                       displaced OF is reassigned by the standard local search).

Public API:
    optimize_plan_v3(blocks, lookups_dir, models_dir,
                     objective='p50'|'p90',
                     time_budget_sec=90,
                     top_k_prevs=20,
                     outages=None,
                     priority_ofs=None)
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .build_features import build_feature_rows
from .constraints import Job, Slot, can_place, full_audit
from .explainer import (
    describe_eviction,
    describe_move,
    describe_priority_insert,
    weekly_summary,
)
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
    outages: list[dict] | None = None,
    priority_ofs: list[dict] | None = None,
    replan_from_ts: str | pd.Timestamp | None = None,
) -> dict[str, Any]:
    """V3 cascade-aware optimizer with operational reasoning + incidencias.

    `replan_from_ts`: when set, OFs whose scheduled start_ts is before this
    timestamp are pinned to their original slot (mid-week replan — already
    produced or in-progress, cannot be moved). When None (default), every OF
    is rearrangeable (initial planning mode)."""
    t0 = time.time()

    if blocks.empty:
        return _empty_result()

    blocks = blocks.copy()
    if "start_ts" not in blocks.columns:
        blocks["start_ts"] = pd.to_datetime(blocks["fecha"])
    blocks["start_ts"] = pd.to_datetime(blocks["start_ts"])
    blocks = blocks.sort_values(["linea", "start_ts", "secuencia"], na_position="last").reset_index(drop=True)
    # Tag baseline rows so the augmented frame can distinguish them from
    # priority-injected rows added later (used by hl_invariance_ok).
    if "_is_priority" not in blocks.columns:
        blocks["_is_priority"] = False

    jobs, slots, jobs_by_id, slots_by_id = build_jobs_and_slots(
        blocks, lookups_dir, outages=outages, priority_ofs=priority_ofs,
        replan_from_ts=replan_from_ts,
    )
    if not jobs or not slots:
        return _empty_result()

    priority_jobs = [j for j in jobs if j.is_priority]
    base_jobs     = [j for j in jobs if not j.is_priority]

    # ----- baseline score (input plan only — priority OFs not counted in baseline)
    base_preds = _score_full(blocks, lookups_dir, models_dir)
    baseline_score = _hl_weighted(base_preds, blocks, objective)

    # ----- precompute prev-aware lookup (over ALL jobs including priority)
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
    maint = pd.read_parquet(Path(lookups_dir) / "maintenance_proxy.parquet")
    avg_days_between_maint = {
        int(r.linea): float(r.expected_days_between_limpiezas)
        for r in maint.itertuples()
    }

    # ----- baseline assignment (start from planner's original; priority OFs unassigned)
    assignment: dict[str, str | None] = {}
    for _, row in blocks.iterrows():
        sid = _slot_id_from_row(row, slots_by_id)
        if sid is None:
            sid = next(iter(slots_by_id))
        assignment[str(row["block_id"])] = sid
    for j in priority_jobs:
        assignment[j.job_id] = None    # placed by pre-placement phase below

    pinned: set[str]   = set()
    displaced: set[str] = set()      # baseline jobs ejected by priority insert
    swap_log: list[dict] = []

    # Mid-week replan: pin every OF that started before replan_from_ts so the
    # local search and eviction logic cannot touch it. Frozen jobs keep their
    # original assignment and contribute to scores as-is.
    frozen_jobs = [j for j in jobs if j.is_frozen]
    for fj in frozen_jobs:
        pinned.add(fj.job_id)

    incidencias: dict[str, Any] = {
        "outages_applied":          list(outages or []),
        "priority_ofs_requested":   list(priority_ofs or []),
        "priority_ofs_placed":      0,
        "priority_ofs_failed":      [],
        "evictions":                0,
        "frozen_count":             len(frozen_jobs),
        "frozen_hl":                int(sum(j.hl for j in frozen_jobs)),
        "replan_from_ts":           (pd.Timestamp(replan_from_ts).isoformat()
                                     if replan_from_ts else None),
    }

    # ============================================================
    # PHASE 2 — Pre-place priority OFs (hard insert + single-level eviction)
    # ============================================================
    if priority_jobs:
        # Process by deadline asc, then hl desc — tightest constraint first
        order = sorted(priority_jobs, key=lambda j: (j.deadline, -j.hl))
        for pj in order:
            best_sid, evicted_jid = _place_priority_job(
                pj, slots, jobs_by_id, assignment, lookup, objective,
            )
            if best_sid is None:
                incidencias["priority_ofs_failed"].append({
                    "sku":      pj.sku,
                    "hl":       pj.hl,
                    "deadline": pj.deadline.isoformat(),
                    "reason":   "no_feasible_slot",
                })
                continue
            # Apply placement
            if evicted_jid is not None:
                # Single-level eviction: displaced OF goes into the pool;
                # local search will find it a new slot.
                assignment[evicted_jid] = None
                displaced.add(evicted_jid)
                incidencias["evictions"] += 1
                victim = jobs_by_id[evicted_jid]
                victim_slot = slots_by_id[best_sid]
                swap_log.append({
                    "iteration":     0,
                    "move_type":     "eviction",
                    "is_required":   True,        # forced by priority insert
                    "block_id":      evicted_jid,
                    "sku":           str(victim.sku),
                    "from_linea":    victim_slot.linea,
                    "from_fecha":    victim_slot.fecha.isoformat(),
                    "from_turno":    victim_slot.turno,
                    "to_linea":      None,
                    "to_fecha":      None,
                    "to_turno":      None,
                    "delta_oee_pts": 0.0,
                    "displaced_by":  pj.job_id,
                    "displaced_by_sku": pj.sku,
                    "description":   describe_eviction(victim, victim_slot, pj),
                })
            assignment[pj.job_id] = best_sid
            pinned.add(pj.job_id)
            incidencias["priority_ofs_placed"] += 1
            target_slot = slots_by_id[best_sid]
            swap_log.append({
                "iteration":     0,
                "move_type":     "priority_insert",
                "is_required":   True,        # caller demanded it
                "block_id":      pj.job_id,
                "sku":           str(pj.sku),
                "from_linea":    None,
                "from_fecha":    None,
                "from_turno":    None,
                "to_linea":      target_slot.linea,
                "to_fecha":      target_slot.fecha.isoformat(),
                "to_turno":      target_slot.turno,
                "delta_oee_pts": 0.0,
                "priority_reason": str(pj.raw_row.get("priority_reason") or ""),
                "description":   describe_priority_insert(pj, target_slot),
            })

    # ============================================================
    # Rebuild slot_to_jobs from current assignment for downstream helpers
    # ============================================================
    def _rebuild_slot_chains() -> dict[str, list[str]]:
        chains: dict[str, list[str]] = {}
        for jid, sid in assignment.items():
            if sid is None:
                continue
            chains.setdefault(sid, []).append(jid)
        # Order each chain: baseline rows by start_ts, priority OFs appended last
        # (priority OFs have synthetic secuencia 9000+ already).
        def _seq_int(v) -> int:
            # Defensive against pd.NA / NaN coming from the Diario Hl parser:
            # `pd.NA or 0` raises 'boolean value of NA is ambiguous'.
            if v is None or (isinstance(v, float) and v != v) or pd.isna(v):
                return 0
            try:
                return int(v)
            except (TypeError, ValueError):
                return 0
        order_index = {str(r["block_id"]): (pd.Timestamp(r["start_ts"]),
                                            _seq_int(r.get("secuencia")))
                       for _, r in blocks.iterrows()}
        for sid, chain in chains.items():
            def _k(jid):
                if jid in order_index:
                    return order_index[jid]
                # priority — sort last
                return (pd.Timestamp.max, jobs_by_id[jid].deadline.toordinal() + 9000)
            chains[sid] = sorted(chain, key=_k)
        return chains

    slot_to_jobs = _rebuild_slot_chains()

    def prev_sku_of(jid: str) -> str | None:
        sid = assignment.get(jid)
        if sid is None:
            return None
        chain = slot_to_jobs.get(sid, [])
        if not chain:
            return None
        idx = chain.index(jid) if jid in chain else 0
        if idx == 0:
            return None
        return str(jobs_by_id[chain[idx - 1]].sku)

    def lookup_score(jid: str, sid: str, prev_sku: str | None) -> float:
        key = (jid, sid, prev_sku)
        v = lookup.get(key)
        if v is None:
            v = lookup.get((jid, sid, None))
        return float(v[objective]) if v is not None else float("-inf")

    # ============================================================
    # PHASE 2.5 — Re-place displaced OFs (highest priority in local search)
    # ============================================================
    for jid in list(displaced):
        j = jobs_by_id[jid]
        best_s = None
        best_score = float("-inf")
        for s in slots:
            if not can_place(j, s):
                continue
            current = slot_to_jobs.get(s.slot_id, [])
            if len(current) >= s.capacity_blocks:
                continue
            new_prev = str(jobs_by_id[current[-1]].sku) if current else None
            score = lookup_score(jid, s.slot_id, new_prev)
            if score > best_score:
                best_score = score
                best_s = s
        if best_s is None:
            # Could not re-place the evicted OF — leave unassigned; priority_audit
            # will surface the issue. We DO NOT roll back the priority insert.
            incidencias.setdefault("displaced_unplaceable", []).append({
                "block_id": jid, "sku": str(j.sku),
                "reason": "no feasible slot with spare capacity after eviction",
            })
            continue
        assignment[jid] = best_s.slot_id
        slot_to_jobs.setdefault(best_s.slot_id, []).append(jid)
        displaced.discard(jid)
        new_slot = slots_by_id[best_s.slot_id]
        swap_log.append({
            "iteration":     0,
            "move_type":     "displaced_reassignment",
            "is_required":   True,        # follow-up to a required eviction
            "block_id":      jid,
            "sku":           str(j.sku),
            "from_linea":    None,
            "from_fecha":    None,
            "from_turno":    None,
            "to_linea":      new_slot.linea,
            "to_fecha":      new_slot.fecha.isoformat(),
            "to_turno":      new_slot.turno,
            "delta_oee_pts": 0.0,
            "description":   f"OF {j.sku} desplazado por OF prioritario · "
                             f"realojado en L{new_slot.linea}/{new_slot.fecha.isoformat()}/{new_slot.turno}",
        })

    slot_to_jobs = _rebuild_slot_chains()

    # ============================================================
    # PHASE 3 — Lookup-driven local search (skips pinned priority OFs)
    # ============================================================
    tabu: set[tuple[str, str]] = set()
    MIN_IMPROVEMENT = 1e-4

    cur_full_blocks = _materialise_blocks(blocks, assignment, jobs_by_id, slots_by_id)
    cur_full_preds  = _score_full(cur_full_blocks, lookups_dir, models_dir)
    current_score   = _hl_weighted(cur_full_preds, cur_full_blocks, objective)

    for iteration in range(max_iter):
        if time.time() - t0 > time_budget_sec:
            break

        best_lookup_delta = MIN_IMPROVEMENT
        best_move = None
        for j in jobs:
            jid = j.job_id
            if jid in pinned:
                continue
            cur_sid = assignment.get(jid)
            if cur_sid is None:
                continue
            cur_prev = prev_sku_of(jid)
            cur_score_self = lookup_score(jid, cur_sid, cur_prev)
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
                total_hl = sum(jj.hl for jj in jobs)
                delta = (new_score_self - cur_score_self) * j.hl / max(total_hl, 1.0)
                if delta > best_lookup_delta:
                    best_lookup_delta = delta
                    best_move = (jid, cur_sid, s.slot_id, new_prev, cur_prev)

        if best_move is None:
            break

        jid, from_sid, to_sid, new_prev, old_prev = best_move
        slot_to_jobs[from_sid].remove(jid)
        slot_to_jobs.setdefault(to_sid, []).append(jid)
        assignment[jid] = to_sid

        cand_blocks = _materialise_blocks(blocks, assignment, jobs_by_id, slots_by_id)
        cand_preds  = _score_full(cand_blocks, lookups_dir, models_dir)
        new_score   = _hl_weighted(cand_preds, cand_blocks, objective)
        actual_delta = new_score - current_score

        if actual_delta <= MIN_IMPROVEMENT:
            slot_to_jobs[to_sid].remove(jid)
            slot_to_jobs[from_sid].append(jid)
            assignment[jid] = from_sid
            tabu.add((jid, to_sid))
            continue

        tabu.add((jid, from_sid))
        current_score = new_score

        j_obj = jobs_by_id[jid]
        op_metrics = _compute_operational_metrics(
            j_obj, jobs_by_id, slots_by_id,
            from_sid, to_sid, old_prev, new_prev,
            matrix_dict, avg_days_between_maint,
        )

        # Classify as required-by-incident vs optional improvement: a move
        # from a blocked slot (LIMPIEZA / MANTENIMIENTO / OUTAGE) is required
        # because the OF couldn't stay there anyway. Otherwise it's an
        # opportunistic OEE gain the planner could decline.
        from_slot = slots_by_id[from_sid]
        is_required = bool(getattr(from_slot, "is_blocked", False))
        move_record = {
            "iteration":       iteration + 1,
            "move_type":       "optimization",
            "is_required":     is_required,
            "block_id":        jid,
            "sku":             str(j_obj.sku),
            "from_linea":      from_slot.linea,
            "from_fecha":      from_slot.fecha.isoformat(),
            "from_turno":      from_slot.turno,
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
    # Drop any priority OFs that ended up unassigned from the assignment
    final_assignment = {jid: sid for jid, sid in assignment.items() if sid is not None}
    best_blocks = _materialise_blocks(blocks, final_assignment, jobs_by_id, slots_by_id)
    best_preds = _score_full(best_blocks, lookups_dir, models_dir)
    final_score = _hl_weighted(best_preds, best_blocks, objective)

    # Required-only score: simulate the plan that would result if we had
    # applied ONLY the moves with is_required=True (i.e., only the changes
    # forced by the declared incidents) and reverted every optional
    # improvement the optimizer found.
    n_required = sum(1 for m in swap_log if m.get("is_required"))
    n_optional = len(swap_log) - n_required
    if n_optional == 0:
        # Nothing optional was applied → required-only IS the final score
        score_required_only = float(final_score)
    else:
        required_assignment: dict[str, str | None] = {}
        # Start from baseline (planner's original) assignment
        for _, row in blocks.iterrows():
            sid = _slot_id_from_row(row, slots_by_id)
            required_assignment[str(row["block_id"])] = sid
        # Apply required swap_log entries in iteration order
        for m in swap_log:
            if not m.get("is_required"):
                continue
            jid = m.get("block_id")
            to_sid = (f"L{m['to_linea']}|{m['to_fecha']}|{m['to_turno']}"
                      if m.get("to_linea") is not None else None)
            if jid and to_sid and to_sid in slots_by_id:
                required_assignment[jid] = to_sid
            elif jid and m.get("to_linea") is None:
                # Eviction: the displaced OF was kicked out — leave it
                # unassigned for the simulated required-only plan
                required_assignment[jid] = None
        required_assignment = {j: s for j, s in required_assignment.items() if s is not None}
        try:
            req_blocks = _materialise_blocks(blocks, required_assignment, jobs_by_id, slots_by_id)
            req_preds  = _score_full(req_blocks, lookups_dir, models_dir)
            score_required_only = float(_hl_weighted(req_preds, req_blocks, objective))
        except Exception:
            # Defensive: if simulation fails, report the optimized score
            # rather than crashing the whole call.
            score_required_only = float(final_score)

    audit = full_audit(blocks, best_blocks, final_assignment, jobs_by_id, slots_by_id)
    per_line = _per_line_breakdown(blocks, base_preds, best_blocks, best_preds, objective)
    per_day  = _per_day_factory_breakdown(blocks, base_preds, best_blocks, best_preds, objective)
    total_hl = float(best_blocks["hl"].sum())

    summary = weekly_summary(
        swap_log, baseline_score, final_score,
        n_outages=len(outages or []),
        n_priority_placed=incidencias["priority_ofs_placed"],
        n_priority_failed=len(incidencias["priority_ofs_failed"]),
        n_evictions=incidencias["evictions"],
    )

    return {
        "objective":          objective,
        "baseline_score":     float(baseline_score),
        "optimized_score":    float(final_score),
        "score_required_only": score_required_only,
        "n_required_moves":   n_required,
        "n_optional_moves":   n_optional,
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
        "incidencias":        incidencias,
    }


# ============================================================
# Priority OF placement (single-level eviction)
# ============================================================
def _place_priority_job(
    pj: Job,
    slots: list[Slot],
    jobs_by_id: dict[str, Job],
    assignment: dict[str, str | None],
    lookup: dict,
    objective: str,
) -> tuple[str | None, str | None]:
    """Choose the best feasible slot for a priority OF.

    Returns `(slot_id, evicted_job_id)`. If `slot_id` is None, the OF cannot be
    placed (no feasible slot before deadline). If `evicted_job_id` is None, the
    slot had spare capacity; otherwise the named job must be displaced.

    Strategy:
        1. Enumerate every (línea × día × turno) slot satisfying can_place(pj, s)
           and s.fecha <= pj.deadline.
        2. Rank by intrinsic OEE p50 from the prev-blind lookup (prev=None) —
           the cheapest signal that orders the candidates well enough.
        3. Among feasible slots, prefer ones with spare capacity. If none has
           capacity, evict from the highest-scoring at-capacity slot.
        4. Eviction target = min(p50 × hl) of the existing OFs in that slot,
           tie-broken by job_id lexicographic.
    """
    candidates: list[tuple[float, Slot]] = []
    for s in slots:
        if not can_place(pj, s):
            continue
        if s.fecha > pj.deadline:
            continue
        v = lookup.get((pj.job_id, s.slot_id, None))
        score = float(v[objective]) if v is not None else 0.0
        candidates.append((score, s))
    if not candidates:
        return None, None
    candidates.sort(key=lambda t: (-t[0], t[1].slot_id))

    # Recompute current per-slot counts
    slot_counts: dict[str, int] = {}
    for sid in assignment.values():
        if sid is None:
            continue
        slot_counts[sid] = slot_counts.get(sid, 0) + 1

    # First pass: any slot with spare capacity?
    for _, s in candidates:
        if slot_counts.get(s.slot_id, 0) < s.capacity_blocks:
            return s.slot_id, None

    # Second pass: evict from the highest-scoring candidate slot
    target_score, target_slot = candidates[0]
    occupants = [jid for jid, sid in assignment.items() if sid == target_slot.slot_id]
    # Pick lowest-(score × hl) occupant; skip priority OFs AND frozen OFs
    # (frozen = already produced or in-progress, cannot be evicted)
    occupants = [
        jid for jid in occupants
        if not jobs_by_id[jid].is_priority and not jobs_by_id[jid].is_frozen
    ]
    if not occupants:
        return target_slot.slot_id, None
    def _victim_key(jid: str) -> tuple[float, str]:
        j = jobs_by_id[jid]
        v = lookup.get((jid, target_slot.slot_id, None))
        s50 = float(v[objective]) if v is not None else 0.0
        return (s50 * max(j.hl, 0.0), jid)   # lower = worse to keep
    victim = min(occupants, key=_victim_key)
    return target_slot.slot_id, victim


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
    delta_changeover = new_co - old_co

    cadence_old = avg_days_between_maint.get(from_slot.linea, 14.0)
    cadence_new = avg_days_between_maint.get(to_slot.linea, 14.0)
    delta_maint_hours = (cadence_new - cadence_old) * 24

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
    """Build the full blocks DataFrame reflecting current assignment.

    Baseline rows come from `blocks` (slot fields updated to reflect assignment).
    Priority OFs are NOT in `blocks` — they're synthesised here from each
    priority job's raw_row, then placed at their assigned slot.
    """
    out = blocks.copy()
    # Update baseline rows
    for idx, row in out.iterrows():
        jid = str(row["block_id"])
        sid = assignment.get(jid)
        if sid is None:
            continue
        slot = slots_by_id[sid]
        out.at[idx, "linea"]    = int(slot.linea)
        out.at[idx, "fecha"]    = pd.Timestamp(slot.fecha)
        out.at[idx, "turno"]    = slot.turno
        out.at[idx, "start_ts"] = pd.Timestamp(slot.fecha).replace(
            hour={"T": 8, "N": 16, "M": 0}.get(slot.turno, 8))

    # Append priority OF rows (if any have a slot assigned)
    priority_rows = []
    for jid, job in jobs_by_id.items():
        if not job.is_priority:
            continue
        sid = assignment.get(jid)
        if sid is None:
            continue
        slot = slots_by_id[sid]
        rr = dict(job.raw_row)
        rr["linea"]       = int(slot.linea)
        rr["fecha"]       = pd.Timestamp(slot.fecha)
        rr["turno"]       = slot.turno
        rr["start_ts"]    = pd.Timestamp(slot.fecha).replace(
            hour={"T": 8, "N": 16, "M": 0}.get(slot.turno, 8))
        rr["_is_priority"] = True
        priority_rows.append(rr)
    if priority_rows:
        pri_df = pd.DataFrame(priority_rows)
        # Align columns to baseline (add missing ones as NaN)
        for c in out.columns:
            if c not in pri_df.columns:
                pri_df[c] = pd.NA
        for c in pri_df.columns:
            if c not in out.columns:
                out[c] = pd.NA
        out = pd.concat([out, pri_df[out.columns]], ignore_index=True)

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
    """Factory-wide (all 3 lines combined) HL-weighted OEE per día."""
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
        "incidencias": {"outages_applied": [], "priority_ofs_requested": [],
                        "priority_ofs_placed": 0, "priority_ofs_failed": [],
                        "evictions": 0},
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
        "incidencias":               result.get("incidencias", {}),
    }
