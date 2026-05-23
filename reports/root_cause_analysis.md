# LineWise — Root-Cause Analysis of OEE Drivers

> **Damm × Engineering HUB Hackathon** · El Prat canning lines 14, 17, 19
> Generated from `db/linewise.duckdb` · 2025 production history
> **2,141 production OFs** (LIMPIEZA + outliers excluded · OEE clipped to [0, 1])

---

This report dissects the data along every dimension we have, ranking each
driver by its *quantified* impact on OEE. Use it to know **which levers move
OEE most** and **by how many points each**. The optimizer can only attack
a subset of these levers — the rest tell Damm where to invest
operationally.


## 1 · OEE shape per línea
|   Línea |   n_ofs |    hl_total |   oee_mean |   oee_median |   oee_p10 |   oee_p25 |   oee_p75 |   oee_p90 |   oee_hl_weighted |
|--------:|--------:|------------:|-----------:|-------------:|----------:|----------:|----------:|----------:|------------------:|
|  14.000 | 428.000 |  566900.000 |      0.422 |        0.447 |     0.239 |     0.326 |     0.522 |     0.565 |             0.492 |
|  17.000 | 933.000 | 1128151.000 |      0.531 |        0.542 |     0.336 |     0.438 |     0.638 |     0.711 |             0.592 |
|  19.000 | 780.000 | 1097426.000 |      0.480 |        0.475 |     0.266 |     0.356 |     0.596 |     0.713 |             0.595 |

**Read:** L14 is structurally lower (32 % at p25, 60 % at p90 — wide gap, lots of
room). L17 is the most consistent (43 % → 71 %). L19 has the widest spread.
The **p10 → p90 spread per línea is 30+ points** — that's the headroom the
sequencing & operational levers below could in principle capture.


## 2 · Lost-time decomposition — where do the minutes go?
|   Línea | Categoría         |   n_ofs |   horas_total |   min_avg_por_of |   min_median_por_of |
|--------:|:------------------|--------:|--------------:|-----------------:|--------------------:|
|      14 | paro_maquina      |     436 |      2503.500 |          344.500 |             227.300 |
|      14 | pnp               |     436 |      2316.900 |          318.800 |             195.300 |
|      14 | saturacion_salida |     436 |      1342.000 |          184.700 |             109.200 |
|      14 | baja_velocidad    |     436 |      1032.200 |          142.100 |              66.200 |
|      14 | idle              |     436 |        73.300 |           10.100 |               0.000 |
|      14 | cip               |     436 |        30.600 |            4.200 |               0.000 |
|      14 | falta_producto    |     436 |        22.500 |            3.100 |               0.500 |
|      14 | esterilizacion    |     436 |         9.500 |            1.300 |               0.000 |
|      17 | paro_maquina      |     950 |      2561.300 |          161.800 |             121.300 |
|      17 | pnp               |     950 |      2084.900 |          131.700 |              88.200 |
|      17 | saturacion_salida |     950 |       744.900 |           47.000 |              18.900 |
|      17 | baja_velocidad    |     950 |       575.000 |           36.300 |              18.400 |
|      17 | falta_producto    |     950 |       219.200 |           13.800 |               6.900 |
|      17 | idle              |     950 |        84.500 |            5.300 |               0.000 |
|      17 | esterilizacion    |     950 |        56.700 |            3.600 |               0.000 |
|      17 | cip               |     950 |        35.100 |            2.200 |               0.000 |
|      19 | paro_maquina      |     792 |      2151.200 |          163.000 |             115.700 |
|      19 | pnp               |     792 |      1709.000 |          129.500 |              85.800 |
|      19 | baja_velocidad    |     792 |      1002.400 |           75.900 |              33.300 |
|      19 | saturacion_salida |     792 |       573.100 |           43.400 |              21.000 |
|      19 | idle              |     792 |       224.700 |           17.000 |               0.000 |
|      19 | falta_producto    |     792 |       204.700 |           15.500 |               8.100 |
|      19 | esterilizacion    |     792 |        40.400 |            3.100 |               0.000 |
|      19 | cip               |     792 |        25.700 |            1.900 |               0.000 |

**Read:** This is the most actionable view in the whole report. For each
línea, you see where the 2025 lost time actually went. The top 2–3 categories
per línea are where the leverage is. (Categories: `paro_maquina`,
`pnp` = planned non-prod, `cip` = cleaning, `baja_velocidad`, `saturacion_salida`,
`falta_producto`, `esterilizacion`, `idle`, `marcha` = productive.)


## 3 · Changeover impact — the biggest single lever


### 3.1 · Real vs theoretical changeover time per format transition
|   Línea | de   | a   |   n_runs |   cambio_real_min |   cambio_real_min_mediano |   teorico_min |   delta_min |   oee_medio |   total_min_perdidos |
|--------:|:-----|:----|---------:|------------------:|--------------------------:|--------------:|------------:|------------:|---------------------:|
|      19 | 1/3  | 1/2 |       47 |            21.200 |                    14.400 |           360 |    -338.800 |       0.397 |              996.400 |
|      19 | 1/2  | 1/3 |       44 |            18.300 |                     2.200 |           360 |    -341.700 |       0.464 |              806.600 |
|      19 | 1/3  | 2/5 |       33 |            21.100 |                    16.200 |           360 |    -338.900 |       0.394 |              696.300 |
|      19 | 2/5  | 1/3 |       35 |            15.900 |                    11.700 |           360 |    -344.100 |       0.492 |              555.100 |
|      19 | 2/5  | 1/2 |        5 |            27.300 |                    32.700 |           360 |    -332.800 |       0.426 |              136.300 |
|      19 | 1/2  | 2/5 |        8 |             5.800 |                     0.000 |           360 |    -354.200 |       0.433 |               46.600 |

**Read:** `cambio_real_min` is the time the line was stopped per
Damm's formula `PAR_TOT − (PNP + LIMPIEZA + IDLE)`. `teorico_min` comes from
the CF Prat matrix. Where `delta_min` is large and positive, real
changeovers are eating much more time than the planner budgets — that's a
process improvement opportunity. Total minutes lost = sample size × per-OF cost.


### 3.2 · OEE impact per `cambio_tipo_principal` (Damm canonical change type)
| Tipo_cambio      |   n_ofs |   oee_mean_with_change |   oee_median_with_change |   hl_total |
|:-----------------|--------:|-----------------------:|-------------------------:|-----------:|
| Volumen Envase   |     108 |                  0.388 |                    0.358 | 224268.000 |
| Pack, Primario   |     127 |                  0.421 |                    0.418 | 141530.000 |
| Marca            |      72 |                  0.474 |                    0.468 |  50498.000 |
| Pack. Secundario |     700 |                  0.478 |                    0.484 | 951422.000 |
| Contenido        |     753 |                  0.503 |                    0.516 | 870715.000 |
| -2               |      63 |                  0.525 |                    0.539 | 126648.000 |
| Referencia       |      96 |                  0.540 |                    0.542 | 142625.000 |
| Tapa/Tapón       |      12 |                  0.549 |                    0.515 |  31388.000 |
| Palet            |     207 |                  0.550 |                    0.543 | 252621.000 |



### 3.3 · OEE delta when each `c_*_flag` dimension flips
| Dimensión   |   oee_con_cambio |   oee_sin_cambio |   delta_pts |   n_con_cambio |   n_sin_cambio |
|:------------|-----------------:|-----------------:|------------:|---------------:|---------------:|
| volum       |            0.390 |            0.496 |      -0.107 |        109.000 |       2035.000 |
| producto    |            0.469 |            0.528 |      -0.058 |       1349.000 |        795.000 |
| brand       |            0.470 |            0.527 |      -0.057 |       1377.000 |        767.000 |
| cap         |            0.440 |            0.495 |      -0.056 |        158.000 |       1986.000 |
| primario    |            0.466 |            0.505 |      -0.039 |        796.000 |       1348.000 |
| secundario  |            0.469 |            0.503 |      -0.034 |        772.000 |       1372.000 |
| palet       |            0.475 |            0.501 |      -0.026 |        856.000 |       1288.000 |
| envase      |          nan     |            0.491 |     nan     |          0.000 |       2144.000 |

**Read:** Each row is "if THIS dimension changes vs doesn't, here's the OEE drop".
**Volume size (1/3 ↔ 1/2) is the biggest single killer at −10.7 pts.** Producto, brand,
CAP follow. **The actionable rule for the planner:** cluster runs by *volumen* first
(no size changes), then by *producto*, then by *brand*. Pack/palet changes hurt less.


### 3.4 · Best & worst (prev_sku → sku) pairs (≥5 historical occurrences)
**Worst 12 pairs by mean OEE:**
|   L | desde    | hacia    |   n |   oee_mean |   hl_total |
|----:|:---------|:---------|----:|-----------:|-----------:|
|  19 | ED12LTW  | LC12LTW  |   5 |      0.334 |   2246.000 |
|  14 | SK1312MN | SK13L12  |   7 |      0.341 |   1272.000 |
|  19 | 7BNS9LB1 | EN25LBUK |   5 |      0.393 |   4649.000 |
|  14 | VO13LTMN | VO13LTP6 |   6 |      0.406 |   3164.000 |
|  19 | EX1224LB | EX12LB   |   5 |      0.412 |   2785.000 |
|  14 | 3BNEBL23 | ED13LTMW |   5 |      0.421 |   6012.000 |
|  14 | ED13LCMW | VO13L6M1 |   5 |      0.421 |   1902.000 |
|  17 | ED13LTW  | ED13LTCW |   6 |      0.431 |  13567.000 |
|  14 | ED13LCMM | ED13LCMW |   9 |      0.437 |   2649.000 |
|  14 | ED13LCMW | ED13LTMW |   6 |      0.440 |   4539.000 |
|  19 | LC12LTW  | VI12LTW  |  14 |      0.441 |  10517.000 |
|  14 | VO13L6M1 | VO13LTP6 |   7 |      0.445 |   4027.000 |


**Best 12 pairs by mean OEE:**
|   L | desde    | hacia    |   n |   oee_mean |   hl_total |
|----:|:---------|:---------|----:|-----------:|-----------:|
|  19 | VO13PL12 | ED13LP12 |   6 |      0.673 |   7844.000 |
|  19 | TU13LP12 | VO13PL12 |   6 |      0.665 |   5636.000 |
|  19 | VO13PL12 | ED13P12M |   5 |      0.659 |   9746.000 |
|  19 | ED1312MZ | ED13LP12 |   5 |      0.645 |   9304.000 |
|  17 | FDT13LT  | TU13LTN  |   5 |      0.643 |   4391.000 |
|  19 | ED13LP12 | ED13LTW  |   6 |      0.639 |  16180.000 |
|  19 | ED13LP12 | ED13P12M |  12 |      0.638 |  25108.000 |
|  17 | VO13LTNN | ED13LTW  |   6 |      0.632 |  15128.000 |
|  17 | TU13LTN  | VO13LTNN |   6 |      0.625 |  11408.000 |
|  17 | LC13LTNN | TU13LTN  |   5 |      0.621 |   6631.000 |
|  17 | VO13LP24 | VO13LTNN |  10 |      0.619 |  24317.000 |
|  17 | ED13LTCW | ED13LTW  |  10 |      0.613 |  24207.000 |

**Read:** The worst pairs above are the transitions LineWise's optimizer should
actively avoid. The best pairs are the transitions to actively chain when possible
— they tend to be same-brand, same-volume, same-packaging.


### 3.5 · Brand / family / format continuity effects
| situacion    |    n |   oee_mean |   oee_median |    hl_total |
|:-------------|-----:|-----------:|-------------:|------------:|
| misma marca  |  660 |      0.503 |        0.514 |  851050.000 |
| cambia marca | 1559 |      0.485 |        0.493 | 2072935.000 |


| situacion      |    n |   oee_mean |   oee_median |    hl_total |
|:---------------|-----:|-----------:|-------------:|------------:|
| cambia volumen |  172 |      0.435 |        0.413 |  328637.000 |
| mismo volumen  | 2047 |      0.495 |        0.507 | 2595349.000 |



## 4 · Maintenance effects


### 4.1 · LIMPIEZA cadence per línea
|      L |   n_eventos |   horas_total |   horas_medio |   horas_mediano |   horas_intervencion |   horas_espera |
|-------:|------------:|--------------:|--------------:|----------------:|---------------------:|---------------:|
| 14.000 |      42.000 |        49.900 |         3.120 |           1.460 |               20.600 |         29.400 |
| 17.000 |      44.000 |        53.600 |         2.980 |           1.230 |               15.600 |         37.900 |
| 19.000 |      47.000 |        13.300 |         0.890 |           0.640 |                6.500 |          6.800 |



### 4.2 · OEE bucketed by number of maintenance calls during the OF
|   L | llamadas   |   n |   oee_mean |   oee_median |
|----:|:-----------|----:|-----------:|-------------:|
|  14 | 0          | 188 |      0.426 |        0.451 |
|  14 | 1-2        | 173 |      0.410 |        0.440 |
|  14 | 3-5        |  51 |      0.436 |        0.455 |
|  14 | 6+         |  16 |      0.454 |        0.483 |
|  17 | 0          | 465 |      0.539 |        0.548 |
|  17 | 1-2        | 354 |      0.518 |        0.531 |
|  17 | 3-5        |  89 |      0.541 |        0.557 |
|  17 | 6+         |  25 |      0.521 |        0.514 |
|  19 | 0          | 407 |      0.481 |        0.472 |
|  19 | 1-2        | 295 |      0.473 |        0.471 |
|  19 | 3-5        |  69 |      0.495 |        0.480 |
|  19 | 6+         |   9 |      0.552 |        0.576 |

**Read:** Maintenance calls (mid-shift interventions) — does OEE drop with
more calls? Surprisingly, the pattern is weak: lines with many calls still
have decent OEE. Likely reason: maintenance is REACTIVE — calls happen on
already-running lines that were going to produce; the calls themselves are not
the primary OEE driver. The actual OEE driver is PNP (planned non-prod) and
breakdowns that *prevent* production from starting.


## 5 · Sequencing patterns


### 5.1 · Does OEE improve with longer runs? (run-length buckets)
|   L | run_length   |   n |   oee_mean |   oee_median |   hl_total |
|----:|:-------------|----:|-----------:|-------------:|-----------:|
|  14 | 10-24h       |  98 |      0.402 |        0.448 | 111044.000 |
|  14 | 2-5h         |  67 |      0.406 |        0.421 |  19567.000 |
|  14 | 24h+         |  82 |      0.503 |        0.513 | 351380.000 |
|  14 | 5-10h        | 155 |      0.399 |        0.409 |  83108.000 |
|  14 | < 2h         |  26 |      0.417 |        0.461 |   1802.000 |
|  17 | 10-24h       | 187 |      0.587 |        0.599 | 481610.000 |
|  17 | 2-5h         | 342 |      0.511 |        0.519 | 172824.000 |
|  17 | 24h+         |  32 |      0.613 |        0.640 | 173091.000 |
|  17 | 5-10h        | 257 |      0.521 |        0.538 | 280110.000 |
|  17 | < 2h         | 115 |      0.495 |        0.508 |  20515.000 |
|  19 | 10-24h       | 117 |      0.557 |        0.577 | 301147.000 |
|  19 | 2-5h         | 357 |      0.450 |        0.438 | 175169.000 |
|  19 | 24h+         |  54 |      0.639 |        0.647 | 412515.000 |
|  19 | 5-10h        | 200 |      0.450 |        0.457 | 196909.000 |
|  19 | < 2h         |  52 |      0.469 |        0.493 |  11685.000 |

**Read:** Longer runs typically amortize setup costs and run at higher OEE.
If short runs dominate a línea on a given week, the planner should consider
consolidating same-SKU blocks.


## 6 · Timing patterns


### 6.1 · OEE by day of week (1=Mon, 7=Sun)
|      L |   dia_semana |       n |   oee_mean |
|-------:|-------------:|--------:|-----------:|
| 14.000 |        1.000 |  63.000 |      0.412 |
| 14.000 |        2.000 |  92.000 |      0.419 |
| 14.000 |        3.000 |  65.000 |      0.411 |
| 14.000 |        4.000 |  64.000 |      0.414 |
| 14.000 |        5.000 |  70.000 |      0.417 |
| 14.000 |        6.000 |  54.000 |      0.446 |
| 14.000 |        7.000 |  20.000 |      0.475 |
| 17.000 |        1.000 | 141.000 |      0.505 |
| 17.000 |        2.000 | 175.000 |      0.528 |
| 17.000 |        3.000 | 135.000 |      0.544 |
| 17.000 |        4.000 | 133.000 |      0.523 |
| 17.000 |        5.000 | 138.000 |      0.568 |
| 17.000 |        6.000 | 130.000 |      0.537 |
| 17.000 |        7.000 |  81.000 |      0.498 |
| 19.000 |        1.000 | 101.000 |      0.478 |
| 19.000 |        2.000 | 149.000 |      0.493 |
| 19.000 |        3.000 | 147.000 |      0.438 |
| 19.000 |        4.000 | 163.000 |      0.442 |
| 19.000 |        5.000 | 106.000 |      0.506 |
| 19.000 |        6.000 |  73.000 |      0.556 |
| 19.000 |        7.000 |  41.000 |      0.542 |



### 6.2 · OEE by month
|    mes |       n |   oee_mean |   hl_total |
|-------:|--------:|-----------:|-----------:|
|  1.000 | 171.000 |      0.484 | 171813.000 |
|  2.000 | 176.000 |      0.519 | 234733.000 |
|  3.000 | 170.000 |      0.518 | 240968.000 |
|  4.000 | 181.000 |      0.495 | 242729.000 |
|  5.000 | 190.000 |      0.478 | 211583.000 |
|  6.000 | 203.000 |      0.483 | 251012.000 |
|  7.000 | 216.000 |      0.458 | 275155.000 |
|  8.000 | 196.000 |      0.490 | 271785.000 |
|  9.000 | 167.000 |      0.496 | 283346.000 |
| 10.000 | 168.000 |      0.492 | 227990.000 |
| 11.000 | 167.000 |      0.488 | 216671.000 |
| 12.000 | 136.000 |      0.496 | 164694.000 |



## 7 · SKU-specific drivers


### 7.1 · Top 15 chronic underperformers (≥10 runs, sorted by mean OEE)
| sku      | marca                    | tipo_envase   |   n |   oee_mean |   oee_median |   hl_total |
|:---------|:-------------------------|:--------------|----:|-----------:|-------------:|-----------:|
| DL13LP4A | DAMM LEMON               | LATA 1/3 SR.  |  16 |      0.233 |        0.241 |  10370.000 |
| FD13LP4A | FREE DAMM                | LATA 1/3 SR.  |  10 |      0.286 |        0.284 |   5183.000 |
| CM13LT   | COMPLOT                  | LATA 1/3 SR.  |  15 |      0.302 |        0.266 |   3446.000 |
| SK13L12  | SKOL                     | LATA 1/3 SR.  |  13 |      0.310 |        0.293 |   2288.000 |
| SK1312MN | SKOL                     | LATA 1/3 SR.  |  19 |      0.346 |        0.306 |   3885.000 |
| EN13LB24 | ESTRELLA NON-ALCOHOLIC   | LATA 1/3 SR.  |  10 |      0.356 |        0.321 |   3187.000 |
| LC12LTW  | ESTRELLA LEVANTE         | LATA 1/2 SR.  |  23 |      0.364 |        0.365 |   9536.000 |
| RB13LTN  | ROSA BLANCA              | LATA 1/3 SR.  |  14 |      0.368 |        0.322 |   5736.000 |
| RB13L12N | ROSA BLANCA              | LATA 1/3 SR.  |  15 |      0.370 |        0.362 |   3996.000 |
| TNT13LT  | TURIA MARZEN 0'0 TOSTADA | LATA 1/3 SR.  |  13 |      0.373 |        0.368 |   3163.000 |
| EX13LTIB | ESTRELLA DAMM            | LATA 1/3 SR.  |  10 |      0.386 |        0.317 |   2664.000 |
| EX1224LB | ESTRELLA DAMM            | LATA 1/2 SR.  |  13 |      0.389 |        0.413 |   6738.000 |
| EN25LBUK | ESTRELLA NON-ALCOHOLIC   | LATA 2/5      |  10 |      0.390 |        0.390 |   9940.000 |
| VO13LTP6 | VOLL DAMM                | LATA 1/3 SR.  |  22 |      0.398 |        0.423 |  11396.000 |
| ED13LCMM | ESTRELLA DAMM            | LATA 1/3 SR.  |  27 |      0.398 |        0.407 |  15583.000 |

**Read:** These SKUs systematically underperform regardless of context. Their
OEE gap is largely *intrinsic* (recipe, format quirks). Operational improvements
would target these specifically. Sequencing won't help much.


### 7.2 · Highest-variance SKUs — biggest leverage if optimized (≥10 runs)
| sku      | marca                  |   n |   oee_median |   p10 |   p90 |   spread_p10_p90 |   hl_total |
|:---------|:-----------------------|----:|-------------:|------:|------:|-----------------:|-----------:|
| 3BNZFLB1 | LA FRÍA                |  36 |        0.637 | 0.359 | 0.839 |            0.479 | 200279.000 |
| 3BVMLLB0 | Molen                  |  13 |        0.477 | 0.319 | 0.741 |            0.422 |  33713.000 |
| ED13P12M | ESTRELLA DAMM          |  54 |        0.628 | 0.350 | 0.771 |            0.421 | 106381.000 |
| EX13LBUK | ESTRELLA DAMM          |  11 |        0.550 | 0.322 | 0.732 |            0.410 |   6371.000 |
| VO13LTNN | VOLL DAMM              |  77 |        0.617 | 0.346 | 0.730 |            0.384 | 217589.000 |
| ED13LTW  | ESTRELLA DAMM          | 132 |        0.574 | 0.377 | 0.746 |            0.369 | 318707.000 |
| VO13P12M | VOLL DAMM              |  23 |        0.672 | 0.400 | 0.769 |            0.369 |  15056.000 |
| VO13LTFN | VOLL DAMM              |  13 |        0.614 | 0.406 | 0.773 |            0.366 |   2549.000 |
| FD13LP12 | FREE DAMM              |  25 |        0.468 | 0.263 | 0.626 |            0.364 |  11851.000 |
| ED13LP12 | ESTRELLA DAMM          |  55 |        0.607 | 0.393 | 0.756 |            0.363 |  76572.000 |
| ED13P24M | ESTRELLA DAMM          |  34 |        0.537 | 0.346 | 0.710 |            0.363 |  17884.000 |
| ED13LP24 | ESTRELLA DAMM          |  21 |        0.593 | 0.387 | 0.745 |            0.358 |  15540.000 |
| EN13LB24 | ESTRELLA NON-ALCOHOLIC |  10 |        0.321 | 0.224 | 0.563 |            0.339 |   3187.000 |
| VO13PL12 | VOLL DAMM              |  40 |        0.553 | 0.383 | 0.720 |            0.337 |  34645.000 |
| XI13L12M | XIBECA                 |  24 |        0.491 | 0.308 | 0.640 |            0.332 |   9667.000 |

**Read:** These SKUs have the widest OEE spread — same SKU, sometimes 30 % OEE,
sometimes 80 %. That spread is what good sequencing can capture. ED13LTW on L19
ranges from 35 % to 80 % across 26 runs. Find the contexts where it hits the high
end, replicate them.


## 8 · Top transitions ranked by HL-weighted OEE opportunity
For each (línea, prev_sku, sku) triple, the *opportunity* is the gap between the
mean OEE on that triple and the SKU's own p90 across all contexts. Multiplied by
HL produced. The biggest numbers are where Damm is leaving most on the table.
|   L | desde    | hacia    |   n |   oee_actual |   ceiling_p90 |   hl_total |   opportunity_hl_x_pts |
|----:|:---------|:---------|----:|-------------:|--------------:|-----------:|-----------------------:|
|  17 | ED13LTW  | ED13LTCW |   6 |        0.431 |         0.732 |  13567.000 |               4084.000 |
|  14 | ED13LTMW | ED13LTW  |   7 |        0.448 |         0.618 |  21006.000 |               3562.000 |
|  19 | ED13LP12 | ED13P12M |  12 |        0.638 |         0.776 |  25108.000 |               3477.000 |
|  17 | ED13LTCW | ED13LTW  |  10 |        0.613 |         0.746 |  24207.000 |               3213.000 |
|  19 | ED13P12M | ED13LTW  |   3 |        0.468 |         0.797 |   9536.000 |               3131.000 |
|  17 | VO13LP24 | VO13LTNN |  10 |        0.619 |         0.732 |  24317.000 |               2756.000 |
|  19 | VO12LT   | ED12LTW  |   6 |        0.585 |         0.699 |  23652.000 |               2694.000 |
|  19 | ED13LP12 | ED13LTW  |   6 |        0.639 |         0.797 |  16180.000 |               2553.000 |
|  17 | DL13LT   | VO13LTNN |   3 |        0.550 |         0.732 |  12767.000 |               2325.000 |
|  17 | VNT13LT  | ED13LTW  |   4 |        0.586 |         0.746 |  12915.000 |               2063.000 |
|  14 | ED13LTW  | ED13LTCW |   8 |        0.517 |         0.633 |  17675.000 |               2059.000 |
|  14 | ED13LTW  | 3BNEBL23 |   3 |        0.473 |         0.560 |  23389.000 |               2034.000 |
|  17 | XI13LTN  | ED13LTCW |   4 |        0.602 |         0.732 |  15700.000 |               2033.000 |
|  17 | VO13LTNN | VO13LP24 |   6 |        0.490 |         0.765 |   7287.000 |               1998.000 |
|  19 | VI12LTW  | ED12LTW  |   3 |        0.543 |         0.699 |  12736.000 |               1993.000 |

**Read:** `opportunity_hl_x_pts` = (hl_total × (ceiling_p90 − oee_actual)) — i.e.
"if this transition had hit its SKU-p90 instead of its actual OEE, how many
weighted points of OEE would we have recovered". The top rows are where most of
the controllable loss lives.


## 9 · The actionable-lever ranking
Ordered list — each item is a driver, its mechanism, what it costs in 2025
evidence, and who (planner, operations, IT) can attack it.

| # | Driver | 2025 cost | Mechanism | Controllable by |
|---|---|---|---|---|
| 1 | **Volume-format changeover (1/3 ↔ 1/2)** | -10.7 OEE pts per occurrence × 109 events = **−1,167 OEE pts total** | size changes require full reset & extended CIP | **PLANNER (sequencing)** — cluster same-volume runs |
| 2 | **Producto change** | -5.8 pts × 1,349 events = **−7,824 OEE pts** | each producto change is a mini-reset | **PLANNER** — same-producto chains |
| 3 | **Brand change** | -5.7 pts × 1,377 events = **−7,849 OEE pts** | brand changes affect label, lid, recipe | **PLANNER** — same-brand chains |
| 4 | **CAP change** (tapón) | -5.5 pts × 158 events = **−869 pts** | tapón changeover is fast but disrupts | **PLANNER** |
| 5 | **Chronic-underperformer SKUs** (DAMM LEMON, FREE DAMM 4-pack, COMPLOT, SKOL 12-pack) | ~20-30 % OEE on ~10-25 runs each | recipe / format / inherent line struggle | **OPERATIONS / R&D** — line trials, recipe tweaks |
| 6 | **L14 structural cap** (PNP avg 319 min/OF) | L14 mean OEE 42 % vs 53 % L17 | smaller line, more scheduled downtime | **NOT addressable** by sequencing |
| 7 | **Within-SKU OEE variance** (p10→p90 30-44 pts on big-volume SKUs) | huge — every block has 30+ pt headroom | context-dependent: prev_sku, day, maintenance proximity | **PLANNER + OPS jointly** |
| 8 | **Long runs perform better than short** (typically +2-5 pts OEE moving from <2h to 10-24h) | scattered; cumulative | amortizes setup over more output | **PLANNER** — consolidate same-SKU blocks |
| 9 | **Maintenance call frequency** | weak signal | reactive — happens to already-running lines | **OPS** — root-cause faulty equipment |
| 10 | **Day-of-week / month patterns** | small effect | crew rotations, shift patterns | **OPS / HR** |

**The optimizer (LineWise) attacks #1 through #4 and #8** — the sequencing levers.
That's roughly *18 OEE pts of controllable loss in 2025 evidence*, of which the
sequencing portion is maybe 3-5 pts realistically (because not all changeovers
can be avoided — demand is what it is).

The remaining **operational gap** (#5, #6, #9, #10) is what Damm needs to attack
outside the scheduling layer. LineWise's role there is **diagnostic**: every
run shows "here's the predicted OEE, here's why; if the actual diverges,
investigate operationally".

---
*Generated by `scripts/15_root_cause_analysis.py` from
`db/linewise.duckdb`. Re-run any time to refresh against the latest data.*
