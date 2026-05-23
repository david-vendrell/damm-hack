"""V3 precompute — prev_sku-AWARE lookup builder.

For each (job, slot, candidate prev_sku) triple, predict OEE. The lookup is
keyed by (job_id, slot_id, prev_sku_or_None) → {p10, p50, p90}.

Why: V2's prev-blind lookup over-estimates moves whose real prev_sku turns
out badly. V3 includes the prev as a key dimension so the optimizer can
evaluate every candidate move under its REAL cascade context in O(1).

Size management:
    naive       = jobs × slots × all_skus = 120 × 60 × 170 ≈ 1.2 M predictions
    pruned      = jobs × slots × (top-20 prev_sku per línea + None) ≈ 150 k
    + adaptive  = drop top-K to 10 when total > 100 k

Coverage: the top-20 active SKUs per línea cover >90 % of all 2025
transitions on that línea, so the pruning loses very little signal.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from .build_features import build_feature_rows
from .constraints import Job, Slot, can_place
from .predict_oee import predict_blocks


# ============================================================
# Top-K prev_sku candidates per línea
# ============================================================
def _top_k_prev_skus_per_linea(
    lookups_dir: str | Path,
    top_k: int = 20,
) -> dict[int, list[str]]:
    """Return {línea: [top-K SKUs by HL produced in 2025 on that línea]}.

    The top SKUs cover the bulk of historical activity → they are the
    realistic prev_sku candidates the optimizer will actually encounter.
    """
    fact = pd.read_parquet(Path(lookups_dir) / "fact_runs_slim.parquet")
    out: dict[int, list[str]] = {}
    for linea, sub in fact.groupby("linea"):
        ranked = (
            sub.groupby("sku")["hl"].sum().sort_values(ascending=False)
            .head(top_k).index.tolist()
        )
        out[int(linea)] = [str(s) for s in ranked]
    return out


# ============================================================
# Build per-(job, slot) features for a given hypothetical prev_sku
# ============================================================
def _enrich_with_prev(
    candidate_block: dict,
    prev_sku: str | None,
    dim_sku: pd.DataFrame,
    matrix_dict: dict[tuple[int, str, str], int],
) -> dict:
    """Add the prev_* columns for a single candidate row. Mirrors what
    build_features.py / engine.optimizer._override_prev_features do, but
    starts from raw block + chosen prev_sku."""
    row = dict(candidate_block)
    if prev_sku is None:
        row["no_predecessor"] = True
        row["first_of_day"] = True
        for col in ("sku", "marca", "supramarca", "familia", "cerveza", "cbr",
                    "envase", "tipo_envase", "estado_volumen"):
            row[f"prev_{col}"] = None
        row["prev_oee"] = np.nan
        row["prev_fecha"] = pd.NaT
        for dim in ("marca", "supramarca", "familia", "cerveza", "cbr",
                    "envase", "tipo_envase", "estado_volumen"):
            row[f"same_{dim}"] = False
        row["same_volume_state"] = False
        row["same_packaging"] = False
        row["same_palet"] = False
        for c in ("c_brand_flag", "c_envase_flag", "c_cap_flag", "c_palet_flag",
                  "c_primario_flag", "c_producto_flag", "c_secundario_flag", "c_volum_flag"):
            row[c] = True
        row["cambio_tipo_principal"] = None
        row["teorico_cambio_min"] = np.nan
        return row

    # prev SKU is set: enrich from dim_sku
    prev_attrs_df = dim_sku[dim_sku["sku"] == prev_sku]
    if prev_attrs_df.empty:
        # unknown prev → fall back to no_predecessor semantics
        return _enrich_with_prev(candidate_block, None, dim_sku, matrix_dict)
    prev_attrs = prev_attrs_df.iloc[0]

    for col in ("sku", "marca", "supramarca", "familia", "cerveza", "cbr",
                "envase", "tipo_envase", "estado_volumen"):
        row[f"prev_{col}"] = prev_attrs.get(col)
    row["prev_oee"] = np.nan
    row["prev_fecha"] = pd.Timestamp(candidate_block["fecha"])  # rough — same day
    row["no_predecessor"] = False
    row["first_of_day"] = False

    for dim in ("marca", "supramarca", "familia", "cerveza", "cbr",
                "envase", "tipo_envase", "estado_volumen"):
        v_cur = row.get(dim)
        v_prev = row.get(f"prev_{dim}")
        row[f"same_{dim}"] = (
            pd.notna(v_cur) and pd.notna(v_prev) and v_cur == v_prev
        )
    row["same_volume_state"] = row["same_estado_volumen"]
    row["same_packaging"]    = bool(row["same_envase"]) and bool(row["same_tipo_envase"])
    row["same_palet"] = bool(pd.notna(prev_attrs.get("palet"))
                              and row.get("palet") == prev_attrs.get("palet"))

    row["c_brand_flag"]      = not bool(row["same_marca"])
    row["c_envase_flag"]     = not bool(row["same_envase"])
    row["c_cap_flag"]        = not bool(row["same_envase"])
    row["c_palet_flag"]      = not bool(row["same_palet"])
    row["c_primario_flag"]   = not bool(row["same_packaging"])
    row["c_producto_flag"]   = not bool(row["same_familia"])
    row["c_secundario_flag"] = not bool(row["same_tipo_envase"])
    row["c_volum_flag"]      = not bool(row["same_volume_state"])

    if not bool(row["same_volume_state"]):      row["cambio_tipo_principal"] = "Volumen Envase"
    elif not bool(row["same_marca"]):           row["cambio_tipo_principal"] = "Marca"
    elif not bool(row["same_familia"]):         row["cambio_tipo_principal"] = "Contenido"
    elif not bool(row["same_packaging"]):       row["cambio_tipo_principal"] = "Pack. Primario"
    elif not bool(row["same_tipo_envase"]):     row["cambio_tipo_principal"] = "Pack. Secundario"
    elif not bool(row["same_palet"]):           row["cambio_tipo_principal"] = "Palet"
    else:                                       row["cambio_tipo_principal"] = None

    key = (
        int(row["linea"]) if pd.notna(row.get("linea")) else None,
        str(row["prev_estado_volumen"]) if pd.notna(row.get("prev_estado_volumen")) else None,
        str(row["estado_volumen"])      if pd.notna(row.get("estado_volumen"))      else None,
    )
    row["teorico_cambio_min"] = matrix_dict.get(key, np.nan)
    return row


# ============================================================
# Main: build the lookup
# ============================================================
def build_prev_aware_lookup(
    jobs: list[Job],
    slots: list[Slot],
    blocks: pd.DataFrame,
    lookups_dir: str | Path,
    models_dir: str | Path,
    top_k_prevs: int = 20,
    adaptive_limit: int = 120_000,
) -> tuple[dict[tuple[str, str, str | None], dict[str, float]], dict[int, list[str]]]:
    """Build the prev-aware lookup.

    Returns:
        lookup        : {(job_id, slot_id, prev_sku_or_None) : {p10, p50, p90}}
        prev_pool     : {línea : [SKUs used as prev candidates]}
    """
    # Discover candidate prev_skus per línea
    prev_pool = _top_k_prev_skus_per_linea(lookups_dir, top_k=top_k_prevs)
    # Adaptive: if the cartesian explodes, drop top_k to keep batch reasonable
    feasible_pairs = sum(1 for j in jobs for s in slots if can_place(j, s))
    estimated = feasible_pairs * (top_k_prevs + 1)
    if estimated > adaptive_limit:
        scale = adaptive_limit / estimated
        new_k = max(5, int(top_k_prevs * scale))
        prev_pool = {k: v[:new_k] for k, v in prev_pool.items()}

    # Base features for every block (uses dim_sku + recent aggregates + maintenance proxies)
    base = build_feature_rows(blocks.drop(columns=["__pos"], errors="ignore"), lookups_dir)
    base = base.set_index("block_id", drop=False)

    dim_sku = pd.read_parquet(Path(lookups_dir) / "dim_sku.parquet")
    matrix_df = pd.read_parquet(Path(lookups_dir) / "dim_theoretical_changeover_matrix.parquet")
    matrix_dict = {
        (int(r.linea), str(r.from_state), str(r.to_state)): int(r.minutes)
        for r in matrix_df.itertuples()
    }

    # For each (job, feasible slot), build candidate rows for each (prev_sku ∈ pool + None)
    # The "base candidate block" inherits the JOB's enriched attributes but is placed in
    # the SLOT's (línea, fecha, turno). We start from base.loc[job_id] which already has
    # SKU enrichment + Group D + E + F.
    cand_rows: list[dict] = []
    cand_keys: list[tuple[str, str, str | None]] = []
    for j in jobs:
        # Pre-build the base row for this job (we'll override línea/fecha/turno per slot)
        try:
            job_base = base.loc[j.job_id]
        except KeyError:
            continue
        job_base = dict(job_base) if isinstance(job_base, pd.Series) else dict(job_base.iloc[0])

        for s in slots:
            if not can_place(j, s):
                continue
            # Override slot-tied fields
            cb = dict(job_base)
            cb["linea"]   = int(s.linea)
            cb["fecha"]   = pd.Timestamp(s.fecha)
            cb["turno"]   = s.turno
            cb["start_ts"] = pd.Timestamp(s.fecha).replace(
                hour={"T": 8, "N": 16, "M": 0}.get(s.turno, 8))
            # Recompute calendar features for the new fecha
            cb["dia_semana"] = pd.Timestamp(s.fecha).weekday() + 1
            cb["mes"]        = pd.Timestamp(s.fecha).month
            cb["week_iso"]   = int(pd.Timestamp(s.fecha).isocalendar()[1])

            # Generate one candidate per prev_sku option for this slot's línea
            prev_options: list[str | None] = [None] + list(prev_pool.get(int(s.linea), []))
            for prev_sku in prev_options:
                row = _enrich_with_prev(cb, prev_sku, dim_sku, matrix_dict)
                row["__cand_id"] = f"{j.job_id}__{s.slot_id}__{prev_sku or 'NONE'}"
                cand_rows.append(row)
                cand_keys.append((j.job_id, s.slot_id, prev_sku))

    if not cand_rows:
        return {}, prev_pool

    cand_df = pd.DataFrame(cand_rows).reset_index(drop=True)
    preds = predict_blocks(cand_df, models_dir=str(models_dir), top_k_shap=0)

    lookup: dict[tuple[str, str, str | None], dict[str, float]] = {}
    for k, (_, row) in zip(cand_keys, preds.iterrows()):
        lookup[k] = {
            "p10": float(row["p10"]),
            "p50": float(row["p50"]),
            "p90": float(row["p90"]),
        }

    return lookup, prev_pool
