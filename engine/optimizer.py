"""LineWise optimizer — backend-only search loop that wraps `engine.predict_blocks`
to find the best feasible arrangement of an uploaded plan.

Public API:
    optimize_plan(blocks, lookups_dir, models_dir, ...) -> dict
    optimizer_result_to_json(result) -> JSON-serializable dict


The model scores ONE combination. This module enumerates feasible alternatives
(within-line 2-opt swaps + cross-line moves for cross-line-capable SKUs),
scores each one with the same model, and returns the best plan + a delta vs
the original.

Key implementation choice — incremental scoring:
    Naive: full re-feature + predict per candidate swap → ~3200 × 5 s on a
    132-block plan = 4 hours. Unusable.
    Smart: pre-compute, for each (block, alternative prev_sku) pair, the
    model prediction ONCE up front. Then evaluating any swap is O(1) — just
    look up the new p50 for the 2-4 blocks whose features change. ~10 s
    total for the precompute, <100 ms for the optimisation loop.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .build_features import build_feature_rows
from .parse_planning_excel import LINE_FORMAT_COMPAT
from .predict_oee import predict_blocks


# ============================================================
# Public API
# ============================================================
def optimize_plan(
    blocks: pd.DataFrame,
    lookups_dir: str | Path,
    models_dir: str | Path = "models",
    max_iter: int = 8,
    enable_cross_line: bool = True,
    time_budget_sec: float = 90.0,
) -> dict[str, Any]:
    """Search for a better arrangement of the uploaded plan.

    Returns a dict with baseline / optimized scores, the best blocks, the
    log of swaps applied, and per-line breakdown. See module docstring.
    """
    t0 = time.time()

    # Stable ordering per line
    blocks = blocks.copy()
    if "start_ts" not in blocks.columns:
        blocks["start_ts"] = pd.to_datetime(blocks["fecha"])
    blocks["start_ts"] = pd.to_datetime(blocks["start_ts"])
    blocks = blocks.sort_values(["linea", "start_ts", "secuencia"], na_position="last").reset_index(drop=True)
    blocks["__pos"] = blocks.groupby("linea").cumcount()

    # Baseline score
    base_preds = _score_plan(blocks, lookups_dir, models_dir)
    baseline_score = _hl_weighted_p50(base_preds, blocks)

    best_blocks = blocks.copy()
    best_preds = base_preds.copy()
    best_score = baseline_score
    swap_log: list[dict] = []
    tabu: set[frozenset] = set()      # frozen pairs we've already swapped this run

    # Minimum improvement to bother applying a swap (in score units).
    # 0.001 = 0.1 OEE percentage points — anything below is numerical noise.
    MIN_IMPROVEMENT = 1e-3

    for it in range(max_iter):
        if time.time() - t0 > time_budget_sec:
            break

        # ---- Pre-compute (block × alt-prev) lookup for ALL feasible swaps
        lookup, base_attrs = _precompute_within_line_lookup(
            best_blocks, best_preds, lookups_dir, models_dir,
        )

        # ---- Evaluate every within-line swap candidate via lookup (O(1) each)
        best_cand = None
        best_delta = MIN_IMPROVEMENT

        for linea, line_blocks in best_blocks.groupby("linea"):
            line_blocks = line_blocks.sort_values("__pos").reset_index(drop=True)
            n = len(line_blocks)
            ids = line_blocks["block_id"].tolist()
            skus = line_blocks["sku"].tolist()
            cur_p50 = {bid: float(best_preds.loc[best_preds["block_id"] == bid, "p50"].iloc[0])
                       for bid in ids}
            cur_hl = {bid: float(line_blocks.loc[line_blocks["block_id"] == bid, "hl"].iloc[0])
                      for bid in ids}

            # For each pair (i, j) with i < j, compute the delta if we swap
            # the blocks at positions i and j. Only 2–4 blocks' p50 change.
            for i in range(n):
                for j in range(i + 1, n):
                    # Skip same-SKU pairs — swapping identical SKUs is a no-op.
                    if skus[i] == skus[j]:
                        continue
                    # Skip tabu pairs — we've already tried (and possibly undone) this swap.
                    if frozenset({ids[i], ids[j]}) in tabu:
                        continue
                    delta = _swap_delta(line_blocks, i, j, lookup, cur_p50, cur_hl)
                    if delta > best_delta:
                        best_delta = delta
                        best_cand = ("within_line_swap", linea, ids[i], ids[j])

        # ---- Cross-line moves
        if enable_cross_line and (time.time() - t0) < time_budget_sec * 0.7:
            cross_delta, cross_cand = _eval_cross_line_moves(
                best_blocks, best_preds, lookups_dir, models_dir,
            )
            if cross_delta > best_delta:
                best_delta = cross_delta
                best_cand = cross_cand

        if best_cand is None:
            break  # converged

        # Apply best candidate and full re-score
        best_blocks = _apply_candidate(best_blocks, best_cand)
        best_preds = _score_plan(best_blocks, lookups_dir, models_dir)
        new_score = _hl_weighted_p50(best_preds, best_blocks)
        actual_delta = new_score - best_score

        # Add to tabu (in either direction) so we don't propose the same swap again
        if best_cand[0] == "within_line_swap":
            tabu.add(frozenset({best_cand[2], best_cand[3]}))

        # Sanity: if the real delta is non-positive (lookup over-estimated),
        # roll back to avoid cycling, and continue.
        if actual_delta < MIN_IMPROVEMENT:
            best_blocks = _apply_candidate(best_blocks, best_cand)   # swap back
            best_preds = _score_plan(best_blocks, lookups_dir, models_dir)
            continue

        swap_log.append({
            "iteration": it + 1,
            "kind": best_cand[0],
            "linea": int(best_cand[1]),
            "block_a": best_cand[2],
            "block_b": best_cand[3] if len(best_cand) > 3 else None,
            "delta_pts_global": round(actual_delta * 100, 3),
            "elapsed_sec": round(time.time() - t0, 2),
        })
        best_score = new_score

    # Per-line breakdown
    per_line = _per_line_breakdown(blocks, base_preds, best_blocks, best_preds)

    # Enrich the swap log with human-readable descriptions
    swap_log_rich = _enrich_swap_log(swap_log, blocks, best_blocks, base_preds, best_preds)

    return {
        "baseline_score":   float(baseline_score),
        "optimized_score":  float(best_score),
        "delta_oee_pts":    round((best_score - baseline_score) * 100, 3),
        "best_blocks":      best_blocks.drop(columns="__pos"),
        "best_preds":       best_preds,
        "swap_log":         swap_log_rich,
        "per_line":         per_line,
        "elapsed_sec":      round(time.time() - t0, 2),
        "n_iterations":     len(swap_log),
        "truncated":        bool((time.time() - t0) > time_budget_sec),
    }


def _enrich_swap_log(swap_log, blocks_before, blocks_after, preds_before, preds_after):
    """Add human-readable description, before/after p50, and HL to each swap log entry."""
    enriched = []
    by_id_before = blocks_before.set_index("block_id")
    by_id_after  = blocks_after.set_index("block_id")
    p_by_id_before = preds_before.set_index("block_id")
    p_by_id_after  = preds_after.set_index("block_id")

    for s in swap_log:
        e = dict(s)
        kind = s["kind"]
        a = s["block_a"]
        b = s["block_b"]
        if kind == "within_line_swap":
            sku_a = by_id_before.at[a, "sku"]
            sku_b = by_id_before.at[b, "sku"]
            fecha_a = pd.Timestamp(by_id_before.at[a, "fecha"]).strftime("%Y-%m-%d")
            fecha_b = pd.Timestamp(by_id_before.at[b, "fecha"]).strftime("%Y-%m-%d")
            turno_a = by_id_before.at[a, "turno"] or "?"
            turno_b = by_id_before.at[b, "turno"] or "?"
            e["description"] = (
                f"Línea {s['linea']}: intercambiar bloques "
                f"({sku_a} en {fecha_a} {turno_a})  ↔  ({sku_b} en {fecha_b} {turno_b})"
            )
            e["sku_a"] = sku_a; e["sku_b"] = sku_b
            e["p50_a_before"] = float(p_by_id_before.at[a, "p50"])
            e["p50_b_before"] = float(p_by_id_before.at[b, "p50"])
            e["p50_a_after"]  = float(p_by_id_after.at[a, "p50"])
            e["p50_b_after"]  = float(p_by_id_after.at[b, "p50"])
        elif kind == "cross_line_move":
            block = by_id_before.loc[a]
            new_linea = s["block_b"]
            e["description"] = (
                f"Mover {block['sku']} ({pd.Timestamp(block['fecha']).strftime('%Y-%m-%d')} "
                f"{block.get('turno','?')}) de L{int(block['linea'])} → L{int(new_linea)}"
            )
            e["sku_a"] = block["sku"]
            e["p50_before"] = float(p_by_id_before.at[a, "p50"])
            e["p50_after"]  = float(p_by_id_after.at[a, "p50"])
        enriched.append(e)
    return enriched


# ============================================================
# Scoring
# ============================================================
def _score_plan(blocks: pd.DataFrame, lookups_dir, models_dir) -> pd.DataFrame:
    """Build features + run the model on the entire plan. Returns preds DataFrame
    with at least: block_id, p10, p50, p90, hl, linea."""
    feats = build_feature_rows(blocks.drop(columns=["__pos"], errors="ignore"), lookups_dir)
    preds = predict_blocks(feats, models_dir=models_dir, top_k_shap=0)
    # Make sure block_id is present (build_features carries it through)
    if "block_id" not in preds.columns and "block_id" in blocks.columns:
        preds = preds.reset_index(drop=True).copy()
        preds["block_id"] = blocks["block_id"].values
    return preds


def _hl_weighted_p50(preds: pd.DataFrame, blocks: pd.DataFrame) -> float:
    df = preds.merge(blocks[["block_id", "hl"]], on="block_id", suffixes=("", "_b"))
    hl = df["hl"].clip(lower=0).fillna(0)
    if hl.sum() == 0:
        return float(df["p50"].mean()) if len(df) else 0.0
    return float((df["p50"] * hl).sum() / hl.sum())


# ============================================================
# Pre-compute within-line (block, alt-prev) prediction lookup
# ============================================================
def _precompute_within_line_lookup(
    blocks: pd.DataFrame,
    base_preds: pd.DataFrame,
    lookups_dir,
    models_dir,
) -> tuple[dict, pd.DataFrame]:
    """For each block × each alternative prev block on the same line, return
    `{(block_id, prev_block_id_or_None): {"p10","p50","p90"}}`.
    Also returns the base enriched attributes DataFrame for re-use.
    """
    # 1. Build baseline enriched features (includes dim_sku merge, calendar, etc.)
    base = build_feature_rows(blocks.drop(columns=["__pos"], errors="ignore"), lookups_dir)
    base = base.set_index("block_id", drop=False)

    # 2. Load theoretical changeover matrix once
    matrix = pd.read_parquet(Path(lookups_dir) / "dim_theoretical_changeover_matrix.parquet")
    matrix_dict = {
        (int(r.linea), str(r.from_state), str(r.to_state)): int(r.minutes)
        for r in matrix.itertuples()
    }

    # 3. For each block × each alternative prev (on same line) + "no predecessor",
    #    synthesize the feature row
    candidate_rows = []
    candidate_ids: list[tuple] = []
    for linea, line_blocks in blocks.groupby("linea"):
        line_ids = line_blocks["block_id"].tolist()
        for bid in line_ids:
            block_row = base.loc[bid].copy()
            # "no predecessor" case
            cand = _override_no_predecessor(block_row)
            candidate_rows.append(cand)
            candidate_ids.append((bid, None))
            # each other block on the same line as a hypothetical prev
            for prev_bid in line_ids:
                if prev_bid == bid:
                    continue
                prev_attrs = base.loc[prev_bid]
                prev_pred = base_preds.loc[base_preds["block_id"] == prev_bid, "p50"]
                prev_oee = float(prev_pred.iloc[0]) if len(prev_pred) else np.nan
                cand = _override_prev_features(block_row, prev_attrs, prev_oee, matrix_dict)
                candidate_rows.append(cand)
                candidate_ids.append((bid, prev_bid))

    cand_df = pd.DataFrame(candidate_rows).reset_index(drop=True)
    preds = predict_blocks(cand_df, models_dir=models_dir, top_k_shap=0)
    lookup: dict[tuple, dict[str, float]] = {}
    for (bid, prev_bid), (_, row) in zip(candidate_ids, preds.iterrows()):
        lookup[(bid, prev_bid)] = {
            "p10": float(row["p10"]),
            "p50": float(row["p50"]),
            "p90": float(row["p90"]),
        }
    return lookup, base


def _override_prev_features(row: pd.Series, prev_attrs: pd.Series,
                            prev_oee: float, matrix_dict: dict) -> pd.Series:
    """Return a copy of `row` with prev_* and derived flags overridden to
    treat `prev_attrs` as the immediately-preceding block.

    Must produce the SAME feature row that `build_features` would produce if
    the LAG had pointed to `prev_attrs`. Mismatches cause the optimizer to
    propose swaps the full re-score won't honour.
    """
    out = row.copy()
    # Direct prev_ overrides
    for col in ["sku", "marca", "supramarca", "familia", "cerveza", "cbr",
                "envase", "tipo_envase", "estado_volumen"]:
        out[f"prev_{col}"] = prev_attrs.get(col)
    # Match build_features.py: prev_oee is NaN for uploaded blocks (only the
    # very first block on each línea gets a value from history, which we
    # handle in _override_no_predecessor).
    out["prev_oee"] = np.nan
    out["prev_fecha"] = prev_attrs.get("fecha")
    out["no_predecessor"] = False
    # first_of_day: True iff fecha day differs from prev's fecha day
    f_cur = out.get("fecha")
    f_prev = prev_attrs.get("fecha")
    if pd.notna(f_cur) and pd.notna(f_prev):
        out["first_of_day"] = pd.Timestamp(f_cur).date() != pd.Timestamp(f_prev).date()
    else:
        out["first_of_day"] = True

    # same_* flags
    for dim in ["marca", "supramarca", "familia", "cerveza", "cbr",
                "envase", "tipo_envase", "estado_volumen"]:
        out[f"same_{dim}"] = (
            pd.notna(out[f"prev_{dim}"]) and pd.notna(out.get(dim)) and
            out[dim] == out[f"prev_{dim}"]
        )
    out["same_volume_state"] = out["same_estado_volumen"]
    out["same_packaging"] = bool(out["same_envase"]) and bool(out["same_tipo_envase"])
    out["same_palet"] = (
        pd.notna(prev_attrs.get("palet")) and out.get("palet") == prev_attrs.get("palet")
    )

    # cambio_*_flag (boolean — True when the dimension changed)
    out["c_brand_flag"]      = not bool(out["same_marca"])
    out["c_envase_flag"]     = not bool(out["same_envase"])
    out["c_cap_flag"]        = not bool(out["same_envase"])
    out["c_palet_flag"]      = not bool(out["same_palet"])
    out["c_primario_flag"]   = not bool(out["same_packaging"])
    out["c_producto_flag"]   = not bool(out["same_familia"])
    out["c_secundario_flag"] = not bool(out["same_tipo_envase"])
    out["c_volum_flag"]      = not bool(out["same_volume_state"])

    # cambio_tipo_principal (Damm canonical change type, same heuristic as build_features.py)
    if not bool(out["same_volume_state"]):       out["cambio_tipo_principal"] = "Volumen Envase"
    elif not bool(out["same_marca"]):            out["cambio_tipo_principal"] = "Marca"
    elif not bool(out["same_familia"]):          out["cambio_tipo_principal"] = "Contenido"
    elif not bool(out["same_packaging"]):        out["cambio_tipo_principal"] = "Pack. Primario"
    elif not bool(out["same_tipo_envase"]):      out["cambio_tipo_principal"] = "Pack. Secundario"
    elif not bool(out["same_palet"]):            out["cambio_tipo_principal"] = "Palet"
    else:                                        out["cambio_tipo_principal"] = None

    # teorico_cambio_min — lookup the matrix on (linea, prev_estado_volumen, estado_volumen)
    key = (
        int(out["linea"]) if pd.notna(out.get("linea")) else None,
        str(out["prev_estado_volumen"]) if pd.notna(out.get("prev_estado_volumen")) else None,
        str(out["estado_volumen"]) if pd.notna(out.get("estado_volumen")) else None,
    )
    out["teorico_cambio_min"] = matrix_dict.get(key, np.nan)

    # hours_since_same_*: build_features.py derives these from HISTORICAL last
    # runs only — independent of the prev block in the uploaded plan. Leave the
    # baseline value unchanged so the lookup matches the full re-score.

    return out


def _override_no_predecessor(row: pd.Series) -> pd.Series:
    out = row.copy()
    out["no_predecessor"] = True
    out["first_of_day"] = True
    for col in ["sku", "marca", "supramarca", "familia", "cerveza", "cbr",
                "envase", "tipo_envase", "estado_volumen"]:
        out[f"prev_{col}"] = None
    out["prev_oee"] = np.nan
    out["prev_fecha"] = pd.NaT
    for dim in ["marca", "supramarca", "familia", "cerveza", "cbr",
                "envase", "tipo_envase", "estado_volumen"]:
        out[f"same_{dim}"] = False
    out["same_volume_state"] = False
    out["same_packaging"] = False
    out["same_palet"] = False
    for c in ["c_brand_flag", "c_envase_flag", "c_cap_flag", "c_palet_flag",
              "c_primario_flag", "c_producto_flag", "c_secundario_flag", "c_volum_flag"]:
        out[c] = True   # everything is "changed" since no predecessor
    out["cambio_tipo_principal"] = None
    out["teorico_cambio_min"] = np.nan
    return out


# ============================================================
# Swap delta via the precomputed lookup
# ============================================================
def _swap_delta(line_blocks: pd.DataFrame, i: int, j: int,
                lookup: dict, cur_p50: dict, cur_hl: dict) -> float:
    """If we swap positions i and j on a single line, what is the change in
    HL-weighted sum of p50 (not yet normalised by total HL)? Positive = better.
    We compute the change attributable to the up-to-4 positions whose features change.
    """
    n = len(line_blocks)
    ids = line_blocks["block_id"].tolist()
    # Identify affected positions: i, j, i+1 (if exists), j+1 (if exists)
    affected: list[int] = sorted({i, j, i + 1 if i + 1 < n else -1, j + 1 if j + 1 < n else -1} - {-1})

    def prev_id_after_swap(pos: int) -> str | None:
        """After swapping (i, j), the block at pos-1 is whoever now sits at pos-1.
        We model the swap by: positions i and j exchange their block_id."""
        if pos == 0:
            return None
        p = pos - 1
        # The block at any position is:
        if p == i:   return ids[j]
        if p == j:   return ids[i]
        return ids[p]

    def block_id_after_swap(pos: int) -> str:
        if pos == i:   return ids[j]
        if pos == j:   return ids[i]
        return ids[pos]

    # Delta sum of (p50 * hl)
    delta = 0.0
    for pos in affected:
        new_bid = block_id_after_swap(pos)
        new_prev = prev_id_after_swap(pos)
        # New score:
        key = (new_bid, new_prev)
        if key not in lookup:
            # Couldn't precompute (e.g. block_id mismatch); fall back to current
            return 0.0
        new_p50 = lookup[key]["p50"]
        # Old score: at position `pos`, the block_id was ids[pos] with prev = ids[pos-1] (or None)
        old_bid = ids[pos]
        old_p50 = cur_p50.get(old_bid)
        if old_p50 is None:
            return 0.0
        # HL travels with the BLOCK, so HL at this position post-swap = HL of new_bid
        new_hl = cur_hl.get(new_bid, 0.0)
        old_hl = cur_hl.get(old_bid, 0.0)
        delta += new_p50 * new_hl - old_p50 * old_hl

    return delta


def _apply_candidate(blocks: pd.DataFrame, cand: tuple) -> pd.DataFrame:
    """Apply a swap/move candidate to the working blocks DataFrame.

    For within_line_swap, we exchange the (sku, hl, and all SKU-tied attributes)
    of the two blocks but keep (fecha, turno, start_ts, __pos, linea) tied to
    each slot. In practice this means we exchange the block_ids' rows entirely
    and re-derive __pos from start_ts.
    """
    kind = cand[0]
    out = blocks.copy()
    if kind == "within_line_swap":
        _, linea, bid_a, bid_b = cand
        # Find positions in the line
        line_mask = out["linea"] == linea
        line_sub = out[line_mask].sort_values("__pos").reset_index()
        idx_a = int(line_sub.loc[line_sub["block_id"] == bid_a, "__pos"].iloc[0])
        idx_b = int(line_sub.loc[line_sub["block_id"] == bid_b, "__pos"].iloc[0])
        # Get the actual row-indices in `out`
        row_a = out.index[(line_mask) & (out["__pos"] == idx_a)][0]
        row_b = out.index[(line_mask) & (out["__pos"] == idx_b)][0]
        # Swap the SKU-bearing fields (everything EXCEPT slot-tied fields)
        slot_tied = {"linea", "fecha", "turno", "start_ts", "secuencia", "__pos"}
        for col in out.columns:
            if col in slot_tied:
                continue
            tmp = out.at[row_a, col]
            out.at[row_a, col] = out.at[row_b, col]
            out.at[row_b, col] = tmp
    elif kind == "cross_line_move":
        _, new_linea, block_id, _ = cand
        # Change the linea of this block; reset __pos within new line
        out.loc[out["block_id"] == block_id, "linea"] = new_linea
        out["__pos"] = out.sort_values(["linea", "start_ts", "secuencia"]).groupby("linea").cumcount()
    return out


# ============================================================
# Cross-line moves
# ============================================================
def _eval_cross_line_moves(blocks: pd.DataFrame, base_preds: pd.DataFrame,
                           lookups_dir, models_dir) -> tuple[float, tuple | None]:
    """For each SKU that has historical runs on multiple lines, try moving its
    blocks to each compatible alternative line. Score each move with a full
    re-score (small number of candidates). Returns (best_delta, best_cand)."""
    sku_line_feas = pd.read_parquet(Path(lookups_dir) / "sku_line_feasibility.parquet")
    # SKUs feasible on ≥2 lines with n≥3 runs each
    eligible = (
        sku_line_feas[sku_line_feas["n_historical_runs"] >= 3]
        .groupby("sku")["linea"]
        .apply(lambda s: set(int(x) for x in s.unique()))
    )
    cross_line_skus = eligible[eligible.apply(len) >= 2].to_dict()
    if not cross_line_skus:
        return 0.0, None

    candidates: list[tuple] = []
    for _, row in blocks.iterrows():
        sku = row["sku"]
        cur_line = int(row["linea"])
        if sku not in cross_line_skus:
            continue
        alt_lines = cross_line_skus[sku] - {cur_line}
        # Filter by LINE_FORMAT_COMPAT too
        ev = row.get("estado_volumen")
        if ev is not None and not pd.isna(ev):
            alt_lines = {ln for ln in alt_lines if ev in LINE_FORMAT_COMPAT.get(ln, set())}
        for new_line in alt_lines:
            candidates.append(("cross_line_move", new_line, row["block_id"], cur_line))

    if not candidates:
        return 0.0, None

    # Score each candidate via full re-score (this set is small: <30 in practice)
    base_score = _hl_weighted_p50(base_preds, blocks)
    best_delta = 0.0
    best_cand = None
    for cand in candidates:
        new_blocks = _apply_candidate(blocks, cand)
        new_preds = _score_plan(new_blocks, lookups_dir, models_dir)
        new_score = _hl_weighted_p50(new_preds, new_blocks)
        delta = new_score - base_score
        if delta > best_delta + 1e-4:
            best_delta = delta
            best_cand = cand
    # delta is in "weighted p50 units" — same scale as the within-line lookup
    return best_delta, best_cand


# ============================================================
# JSON-serialisable export (for backend → frontend consumption)
# ============================================================
def optimizer_result_to_json(result: dict[str, Any]) -> dict:
    """Return the optimizer output in a fully JSON-serialisable form.
    DataFrames become list-of-dicts; numpy types become Python native types."""
    def _df_to_records(df: pd.DataFrame) -> list[dict]:
        if df is None or df.empty:
            return []
        cols_with_dates = [c for c in df.columns if pd.api.types.is_datetime64_any_dtype(df[c])]
        d = df.copy()
        for c in cols_with_dates:
            d[c] = d[c].dt.strftime("%Y-%m-%dT%H:%M:%S")
        # drop non-serialisable columns gracefully (e.g. lists of dicts already OK)
        d = d.where(pd.notna(d), None)
        return d.to_dict(orient="records")

    return {
        "baseline_oee_p50_hl_weighted":   float(result["baseline_score"]),
        "optimized_oee_p50_hl_weighted":  float(result["optimized_score"]),
        "delta_oee_pts":                  float(result["delta_oee_pts"]),
        "n_swaps_applied":                int(result["n_iterations"]),
        "elapsed_sec":                    float(result["elapsed_sec"]),
        "truncated":                      bool(result["truncated"]),
        "per_line":                       {str(k): v for k, v in result["per_line"].items()},
        "swap_log":                       result["swap_log"],
        "optimized_blocks":               _df_to_records(result["best_blocks"]),
        "optimized_predictions":          _df_to_records(result["best_preds"]),
    }


# ============================================================
# Per-line breakdown
# ============================================================
def _per_line_breakdown(blocks_base, preds_base, blocks_opt, preds_opt) -> dict:
    out = {}
    for linea in sorted(blocks_base["linea"].unique()):
        b = preds_base.merge(blocks_base[["block_id", "linea", "hl"]], on="block_id", suffixes=("", "_b"))
        o = preds_opt.merge(blocks_opt[["block_id", "linea", "hl"]], on="block_id", suffixes=("", "_b"))
        bl = b[b["linea"] == linea]
        ol = o[o["linea"] == linea]
        base = float((bl["p50"] * bl["hl"]).sum() / max(bl["hl"].sum(), 1.0)) if len(bl) else 0.0
        opti = float((ol["p50"] * ol["hl"]).sum() / max(ol["hl"].sum(), 1.0)) if len(ol) else 0.0
        out[int(linea)] = {
            "baseline": round(base, 4),
            "optimized": round(opti, 4),
            "delta_pts": round((opti - base) * 100, 2),
        }
    return out
