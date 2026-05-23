# LineWise — Input / Output Schema

This is the **single source of truth** for what the platform accepts and what it returns. Every engine endpoint, frontend component, and Claude tool must conform.

---

## Damm data model (as encoded by Damm in their diagram)

```
                ┌────────────┐                ┌────────────┐
                │  CAMBIO    │                │  CAMBIOS   │
                │  FORMATO   │                │  (per-OF)  │
                └─────┬──────┘                └─────┬──────┘
                      │ red dashed                  │
                ┌─────▼──────────┐                  │  ┌────────────────┐
                │ TIEMPO CAMBIO  │                  └──► TIPO DE CAMBIO │
                │ TEÓRICO        │                     │ (REVISAR OFs   │
                └─────┬──────────┘                     │  ANTERIORES!!) │
                      │                                └────────────────┘
                ┌─────▼──────────┐                              │
                │ MANTENIMIENTO  │                  ┌───────────▼───────────┐
                │ LIMPIEZAS      │      ◄────────►  │      MES / OF         │
                └────────────────┘      red bidir   │   (NEXO CENTRAL)      │
                                                    └───────┬───┬───┬───────┘
                                                            │   │   │
                                              ┌─────────────┘   │   └─────────┐
                                              │                 │             │
                                         ┌────▼────┐       ┌────▼─────┐  ┌────▼──────┐
                                         │  TIEMPO │       │   OEE    │  │  VOLUMEN  │
                                         │ H_TOT,  │       │ %OEE     │  │ HL, UDS,  │
                                         │ PAR_TOT │       │ %REND    │  │  OEE      │
                                         │ PNP,    │       │ CAMBIO   │  └───────────┘
                                         │ LIMPIEZA│       │ SI/NO    │
                                         │ IDLE    │       └──────────┘
                                         └─────────┘
```

### Formulas (encoded in `_meta_formulas`)

| Concept | Formula |
|---|---|
| **OEE** | `OEE = Disponibilidad × Rendimiento × Calidad` |
| Disponibilidad | `T_funcionamiento / T_planificado` |
| Rendimiento | `(T_ciclo_ideal × Producción_total) / T_funcionamiento` |
| Calidad | `Producción_buena / Producción_total` |
| **Tiempo cambio (real)** | `PAR_TOT − (PNP + LIMPIEZA + IDLE)` |
| IDLE | **Does NOT affect OEE** |

---

## Inputs the platform accepts

### I1 — Urgent demand

```jsonc
POST /api/recommend
{
  "sku": "ED13LTW",                    // SKU code
  "volume_uds": 200000,                // OR volume_hl, exactly one of the two
  "volume_hl": null,
  "deadline_ts": "2026-05-23T18:00",   // ISO 8601, local El Prat time
  "preferred_lines": [17, 19],          // optional: hard preference
  "excluded_lines": [],                 // optional: hard exclusion
  "locked_blocks": [                    // optional: don't move these
    {"of": "0000793838-1", "linea": 14, "start_ts": "2026-05-19T08:00"}
  ]
}
```

### I2 — Manual schedule override (drag-and-drop)

```jsonc
POST /api/override
{
  "block_id": "TMP_001",
  "linea": 19,
  "start_ts": "2026-05-22T16:00"
}
```

### I3 — Time Machine query

```jsonc
POST /api/time_machine
{
  "mode": "compare",                   // "replay" | "compare"
  "window": { "from": "2025-09-01", "to": "2025-12-31" }
}
```

### I4 — Diagnostic query

```jsonc
POST /api/diagnostics
{
  "linea": 17,                          // optional
  "sku": null,                          // optional
  "window": { "from": "2025-01-01", "to": "2025-12-31" },
  "top_n": 10
}
```

### I5 — Conversational query (Claude)

```jsonc
POST /api/chat                          // SSE stream
{
  "prompt": "¿Por qué L17 rindió peor el martes pasado?",
  "context": { "current_view": "gantt", "selected_of": "0000676483-1" }
}
```

### I6 — Sequence to score (internal)

```jsonc
POST /api/score_sequence
{
  "blocks": [
    {"linea": 17, "sku": "ED13LTW",   "start_ts": "2026-05-19T06:00", "duration_h": 8.0},
    {"linea": 17, "sku": "ED13LTCW",  "start_ts": "2026-05-19T14:00", "duration_h": 6.0}
  ]
}
```

### I7 — Plan refresh (ETL)

Drop a new `Planificado` or `Diario Hl_Planif` Excel into `Repte operacions/`, then:

```bash
python3 scripts/01_ingest.py && python3 scripts/03_derived_tables.py
```

---

## Outputs the platform returns

### O1 — Ranked recommendations (response to I1)

```jsonc
{
  "recommendations": [
    {
      "rank": 1,
      "linea": 17,
      "start_ts": "2026-05-23T06:00",
      "sequence_position": 3,
      "predicted_oee": 0.82,
      "oee_band": [0.78, 0.85],
      "n_analogs": 14,                  // similar historical runs used
      "expected_minutes_saved": 47,
      "evidence": [
        {
          "claim": "Changeover 0.5L→0.33L on L17 averaged 28 min (n=14, σ=4)",
          "source_ofs": ["0000620488-1", "0000676483-1", "..."]
        }
      ],
      "risk_flags": [
        {"type": "maintenance_proximity", "severity": "low", "detail": "Last maint 18h ago"}
      ]
    },
    { "rank": 2, "linea": 19, "predicted_oee": 0.78, "...": "..." },
    { "rank": 3, "linea": 14, "predicted_oee": 0.71, "...": "..." }
  ],
  "current_plan_baseline_oee": 0.74
}
```

### O2 — OEE estimate (response to I6)

```jsonc
{
  "blocks": [
    {
      "linea": 17, "sku": "ED13LTW", "start_ts": "...",
      "predicted_oee": 0.82,
      "oee_band": [0.78, 0.85],
      "top_features": [
        {"name": "prev_sku_match_brand", "shap": +0.04},
        {"name": "no_maintenance_24h",    "shap": +0.02},
        {"name": "weekend_shift",         "shap": -0.01}
      ],
      "cited_runs": ["0000676483-1", "0000620488-1"]
    }
  ],
  "aggregate_oee_estimate": 0.80,
  "expected_minutes_saved_vs_baseline": 47
}
```

### O3 — Diagnostic feed (response to I4)

```jsonc
{
  "leaks": [
    {
      "linea": 17,
      "category": "changeover_0.5L_to_0.33L",
      "impact_minutes": 1020,            // total minutes lost in window
      "impact_uds": 153000,              // estimated lost units
      "impact_eur": 9180.0,              // optional
      "exemplar_ofs": ["0000620488-1", "0000676483-1"],
      "suggestion": "Cluster 0.33L runs before 0.5L; expected save ~17min per change."
    }
  ]
}
```

### O4 — Backtest result (response to I3 mode=compare)

```jsonc
{
  "window": { "from": "2025-09-01", "to": "2025-12-31" },
  "baseline_oee_weighted": 0.481,
  "linewise_oee_weighted": 0.505,
  "delta_oee_points": 2.4,
  "extra_uds": 1408923,
  "extra_hl": 4639.2,
  "extra_eur": 84551,
  "n_weeks": 13,
  "per_week": [ { "week_iso": "2025-W36", "delta": 0.018 }, "..." ]
}
```

### O5 — Conversational answer (response to I5, streamed)

Server-Sent Events stream of `{type, data}` tokens:

```jsonc
{ "type": "text",     "data": "L17 rindió peor el martes principalmente por..." }
{ "type": "citation", "data": { "claim": "...", "ofs": ["0000689263-1"] } }
{ "type": "chart",    "data": { "type": "bar", "data": [/*...*/] } }
{ "type": "done" }
```

### O6 — Updated Gantt (response to I2)

```jsonc
{
  "blocks": [
    {
      "block_id": "0000793838-1",
      "linea": 14,
      "start_ts": "2026-05-19T08:00",
      "end_ts":   "2026-05-19T17:30",
      "sku": "ED13LTNN",
      "color": "#c8102e",
      "status": "locked"                  // "locked" | "movable" | "recommended" | "manual"
    }
  ],
  "predicted_oee_per_line": { "14": 0.46, "17": 0.55, "19": 0.51 }
}
```

### O7 — Evidence cards (embedded in chat / recommendations)

```jsonc
{
  "claim": "Changeover 0.5L→0.33L on L17 averaged 28 min (n=14, σ=4)",
  "citation_runs": [
    {"of": "0000676483-1", "fecha": "2025-10-17", "horas_cambio_min": 26},
    {"of": "0000620488-1", "fecha": "2025-07-19", "horas_cambio_min": 31}
  ],
  "stats_summary": { "mean": 28.1, "std": 4.2, "median": 27.5, "n": 14 },
  "confidence": "high"
}
```

---

## Query patterns the Claude tools must call

These map straight to DuckDB queries against the canonical layer.

### `query_history(filters)`

```sql
SELECT * FROM fact_runs
WHERE linea = :linea
  AND sku   = :sku
  AND (prev_sku = :prev_sku OR :prev_sku IS NULL)
  AND fecha_fin BETWEEN :date_from AND :date_to
  AND NOT outlier
ORDER BY fecha_fin DESC
LIMIT :limit;
```

### `find_analogs(of_id, k)`

Build feature vector from `fact_runs` for `of_id`, then run k-NN over the in-memory normalised matrix:

```python
vec = build_vector(of_id)                       # 10-ish features
distances = (feature_matrix - vec).pow(2).sum(axis=1)
return top_k_indices_by_distance
```

### `score_sequence(blocks)`

For each block: lookup analog OEE distribution from `fact_runs` + return point + band + cited OFs. Optional LightGBM blend.

### `list_diagnostics(linea, window)`

```sql
SELECT linea, categoria,
       SUM(minutos) / 60                  AS horas,
       COUNT(DISTINCT of)                 AS n_ofs
FROM fact_lost_time
WHERE linea = :linea
  AND fecha_fin BETWEEN :date_from AND :date_to
  AND categoria NOT IN ('marcha')
GROUP BY linea, categoria
ORDER BY horas DESC;
```

### `get_theoretical_changeover(linea, from_state, to_state)`

```sql
SELECT minutes
FROM dim_theoretical_changeover_matrix
WHERE linea = :linea AND from_state = :from_state AND to_state = :to_state;
```

### `get_plan_vs_acordado(linea, fecha)`

```sql
SELECT metric, value
FROM fact_diario_hl_planif
WHERE linea = :linea AND fecha = :fecha;
```

---

## Critical rules (encoded in DB at `_meta_formulas` and `_meta_relationships`)

1. **MES / OF is the central key.** Every fact table joins to a single OF identifier.
2. **`Tipo de cambio` requires looking at the previous OF.** Use `fact_changeovers` (LAG over `(linea, fecha_fin, of)`).
3. **Use the real changeover formula**, not `horas_cip` alone:
   `horas_cambio = PAR_TOT − (PNP + LIMPIEZA + IDLE)`
4. **IDLE does not affect OEE.** Keep it informational only.
5. **Theoretical changeover** is fed by two sources: `CAMBIO FORMATO` (size/format matrix) AND `MANTENIMIENTO LIMPIEZAS`. Both surface in `dim_theoretical_changeover_matrix` + `fact_limpieza`.
6. **OEE outlier clipping:** apply `oee = clip(oee, 0, 1)` before training; flag rows where original was outside `[0, 1]`.
7. **`fact_runs.outlier`** (= `H_TOT > 100 h`) **must be filtered** in all OEE statistics, never silently included.

Any code path that violates these is a bug.
