// Servicio de análisis. TODA la inteligencia vive aquí — heurística + DB hoy,
// modelo ML mañana. La UI nunca conoce la implementación: consume tipos.

import * as XLSX from 'xlsx';

import { prisma } from './db';
import {
  callLineWise,
  parseHeadlineOee,
  parseDecomposicion,
  parseDayTable,
  parseBloqueosMant,
  parseSwapTable,
  type SwapRow,
} from './linewise-client';
import type {
  AnalisisPlan,
  BloqueoMant,
  CategoriaRecomendacion,
  FilaPlan,
  Linea,
  PlanRecomendado,
  PlanResumen,
  PostMortemResumen,
  Recomendacion,
  RecomendacionDetalle,
  RecomendacionSemana,
  SemanaPostMortem,
  TipoCambio,
  Veredicto,
  WeekBrief,
  WeekBriefKpi,
} from '@/types';

// ---------- POST MORTEM ----------

export async function postMortemResumen(): Promise<PostMortemResumen> {
  // Real computation over the ingested OfHecho table. Falls back to the
  // historical p80 by (SKU, línea) when SkuLineaBaseline has no row for the
  // pair, matching the convention used by postMortemBrief.
  const rows = await prisma.ofHecho.findMany({});
  if (rows.length === 0) {
    return {
      perdidaEvitablePts: 0,
      ofsPorDebajoPct: 0,
      hlLatente: 0,
      ofsAnalizadas: 0,
      porLinea: [],
    };
  }
  const baselines = await prisma.skuLineaBaseline.findMany();
  const baselineIdx = new Map(baselines.map((b) => [`${b.skuCodigo}|${b.linea}`, b]));
  const fallbackIdx = buildSkuLineaP80Fallback(rows);

  let hlConCeiling = 0;
  let perdidaWeighted = 0;
  let nBajo = 0;
  let hlLatente = 0;
  for (const r of rows) {
    const key = `${r.sku}|${r.linea}`;
    const alc = baselineIdx.get(key)?.oeeAlcanzable ?? fallbackIdx.get(key);
    if (alc === undefined) continue; // unknown ceiling — exclude from loss math
    hlConCeiling += r.hl;
    const gap = Math.max(0, alc - r.oee);
    perdidaWeighted += gap * r.hl;
    if (r.oee < alc) {
      nBajo += 1;
      hlLatente += gap * r.hl;
    }
  }
  const perdidaEvitablePts = hlConCeiling > 0 ? (perdidaWeighted / hlConCeiling) * 100 : 0;
  const ofsPorDebajoPct = Math.round((nBajo / rows.length) * 100);

  const porLinea: PostMortemResumen['porLinea'] = [];
  for (const ln of [14, 17, 19] as Linea[]) {
    const lineaRows = rows.filter((r) => r.linea === ln);
    if (lineaRows.length === 0) continue;
    const lAct = hlWeighted(lineaRows);
    const lAlc = alcanzableHlWeighted(lineaRows, baselineIdx, fallbackIdx);
    porLinea.push({
      linea: ln,
      perdidaPts: Math.round(Math.max(0, (lAlc - lAct) * 100) * 10) / 10,
      oeeEjecutado: Math.round(lAct * 1000) / 1000,
      oeeAlcanzable: Math.round(lAlc * 1000) / 1000,
    });
  }

  return {
    perdidaEvitablePts: Math.round(perdidaEvitablePts * 10) / 10,
    ofsPorDebajoPct,
    hlLatente: Math.round(hlLatente),
    ofsAnalizadas: rows.length,
    porLinea,
  };
}

export async function postMortemCambios(linea?: Linea) {
  const rows = await prisma.cambioIneficiente.findMany({
    where: linea ? { linea } : undefined,
    orderBy: { ptsPerdidos: 'desc' },
    take: 20,
  });
  return rows.map((r) => ({
    of: r.of,
    linea: r.linea as Linea,
    fecha: r.fecha,
    skuAnterior: r.skuAnterior,
    skuActual: r.skuActual,
    tipoCambio: r.tipoCambio as 'formato' | 'cerveza' | 'mantenimiento' | 'otro',
    oeeReal: r.oeeReal,
    oeeAlcanzable: r.oeeAlcanzable,
    ptsPerdidos: r.ptsPerdidos,
    motivo: r.motivo,
  }));
}

export async function postMortemDistribucion(sku: string, linea: Linea) {
  const [skuRow, baseline, obs, ofs] = await Promise.all([
    prisma.sku.findUnique({ where: { codigo: sku } }),
    prisma.skuLineaBaseline.findUnique({ where: { skuCodigo_linea: { skuCodigo: sku, linea } } }),
    prisma.oeeObservacion.findMany({ where: { skuCodigo: sku, linea }, orderBy: { id: 'asc' } }),
    prisma.ofHecho.findMany({ where: { sku, linea }, orderBy: { fechaFin: 'asc' } }),
  ]);
  if (!skuRow || !baseline) return null;
  const valoresOee = obs.map((o) => o.oee);

  const tendenciaSemanal = buildWeeklyTrend(ofs);
  const histograma = buildHistogram(valoresOee);
  const percentilesRaw = computePercentiles(valoresOee, [0.25, 0.5, 0.75, 0.9]);

  return {
    sku,
    nombre: skuRow.nombre,
    linea,
    valoresOee,
    mediana: baseline.oeeMediana,
    alcanzable: baseline.oeeAlcanzable,
    histograma,
    tendenciaSemanal,
    percentiles: {
      p25: percentilesRaw[0],
      p50: percentilesRaw[1],
      p75: percentilesRaw[2],
      p90: percentilesRaw[3],
    },
  };
}

// ---- Weekly explorer (Feature 1) + brief (Feature 2) ----

const MESES_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function weekLabel(semana: number, anio: number, desde: Date, hasta: Date): string {
  const d1 = desde.getUTCDate();
  const d2 = hasta.getUTCDate();
  const m1 = MESES_ES[desde.getUTCMonth()];
  const m2 = MESES_ES[hasta.getUTCMonth()];
  if (m1 === m2) return `Sem ${semana} · ${d1}-${d2} ${m1} ${anio}`;
  return `Sem ${semana} · ${d1} ${m1} a ${d2} ${m2} ${anio}`;
}

function buildHistogram(values: number[]): { bucket: string; desde: number; hasta: number; count: number }[] {
  const buckets = Array.from({ length: 10 }, (_, i) => ({
    bucket: `${i * 10}-${(i + 1) * 10}%`,
    desde: i * 0.1,
    hasta: (i + 1) * 0.1,
    count: 0,
  }));
  for (const v of values) {
    if (v < 0 || v > 1) continue;
    const i = Math.min(9, Math.floor(v * 10));
    if (i >= 0) buckets[i].count++;
  }
  return buckets;
}

function computePercentiles(values: number[], quantiles: number[]): number[] {
  if (values.length === 0) return quantiles.map(() => 0);
  const sorted = [...values].sort((a, b) => a - b);
  return quantiles.map((q) => {
    const idx = q * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  });
}

function buildWeeklyTrend(
  ofs: { anio: number; semanaIso: number; oee: number; hl: number }[],
): { semana: number; anio: number; oee: number; n: number }[] {
  const m = new Map<string, { anio: number; semana: number; oeeSum: number; hlSum: number; n: number }>();
  for (const o of ofs) {
    const k = `${o.anio}|${o.semanaIso}`;
    let cur = m.get(k);
    if (!cur) {
      cur = { anio: o.anio, semana: o.semanaIso, oeeSum: 0, hlSum: 0, n: 0 };
      m.set(k, cur);
    }
    cur.oeeSum += o.oee * o.hl;
    cur.hlSum += o.hl;
    cur.n += 1;
  }
  return [...m.values()]
    .map((w) => ({
      semana: w.semana,
      anio: w.anio,
      oee: w.hlSum > 0 ? w.oeeSum / w.hlSum : 0,
      n: w.n,
    }))
    .sort((a, b) => a.anio - b.anio || a.semana - b.semana);
}

interface OfRow {
  anio: number;
  semanaIso: number;
  linea: number;
  sku: string;
  oee: number;
  hl: number;
  tieneCambio: boolean;
  fechaFin: Date;
}

function hlWeighted(rows: OfRow[]): number {
  const total = rows.reduce((a, r) => a + r.hl, 0);
  if (total <= 0) return 0;
  return rows.reduce((a, r) => a + r.oee * r.hl, 0) / total;
}

function alcanzableHlWeighted(
  rows: OfRow[],
  baselineIdx: Map<string, { oeeAlcanzable: number }>,
  fallbackIdx?: Map<string, number>,
): number {
  let total = 0;
  let w = 0;
  for (const r of rows) {
    const key = `${r.sku}|${r.linea}`;
    const b = baselineIdx.get(key);
    const alc = b?.oeeAlcanzable ?? fallbackIdx?.get(key);
    if (alc === undefined) continue;
    w += alc * r.hl;
    total += r.hl;
  }
  return total > 0 ? w / total : 0;
}

/** Per-(sku, línea) historical p80 from the OfHecho table — used as the
 * "alcanzable" fallback when SkuLineaBaseline has no row for the pair.
 * Returns a Map keyed by `${sku}|${linea}`. */
function buildSkuLineaP80Fallback(rows: OfRow[]): Map<string, number> {
  const grouped = new Map<string, number[]>();
  for (const r of rows) {
    const k = `${r.sku}|${r.linea}`;
    const arr = grouped.get(k) ?? [];
    arr.push(r.oee);
    grouped.set(k, arr);
  }
  const out = new Map<string, number>();
  for (const [k, values] of grouped) {
    if (values.length < 3) continue; // need a few points to call it a "ceiling"
    const [p80] = computePercentiles(values, [0.8]);
    out.set(k, p80);
  }
  return out;
}

export async function postMortemWeekly(linea?: Linea): Promise<SemanaPostMortem[]> {
  const rows = await prisma.ofHecho.findMany({
    where: linea ? { linea } : undefined,
    orderBy: [{ anio: 'desc' }, { semanaIso: 'desc' }],
  });
  if (rows.length === 0) return [];

  const baselines = await prisma.skuLineaBaseline.findMany();
  const baselineIdx = new Map(baselines.map((b) => [`${b.skuCodigo}|${b.linea}`, b]));
  // Fallback p80 from the historical OFs themselves (covers SKUs without a
  // seeded SkuLineaBaseline row — common in the dev DB after `npm run ingest`).
  const fallbackIdx = buildSkuLineaP80Fallback(rows);

  const buckets = new Map<
    string,
    { anio: number; semana: number; rows: OfRow[]; dateMin: Date; dateMax: Date }
  >();
  for (const r of rows) {
    const k = `${r.anio}|${r.semanaIso}`;
    let cur = buckets.get(k);
    if (!cur) {
      cur = { anio: r.anio, semana: r.semanaIso, rows: [], dateMin: r.fechaFin, dateMax: r.fechaFin };
      buckets.set(k, cur);
    }
    cur.rows.push(r);
    if (r.fechaFin < cur.dateMin) cur.dateMin = r.fechaFin;
    if (r.fechaFin > cur.dateMax) cur.dateMax = r.fechaFin;
  }

  const out: SemanaPostMortem[] = [];
  for (const b of buckets.values()) {
    const hlTotal = b.rows.reduce((a, r) => a + r.hl, 0);
    const oeeActual = hlWeighted(b.rows);
    const oeeAlcanzable = alcanzableHlWeighted(b.rows, baselineIdx, fallbackIdx);

    const porLinea: SemanaPostMortem['porLinea'] = [];
    for (const ln of [14, 17, 19] as Linea[]) {
      const lineaRows = b.rows.filter((r) => r.linea === ln);
      if (lineaRows.length === 0) continue;
      const lAct = hlWeighted(lineaRows);
      const lAlc = alcanzableHlWeighted(lineaRows, baselineIdx, fallbackIdx);
      porLinea.push({
        linea: ln,
        oeeActual: lAct,
        oeeAlcanzable: lAlc,
        perdidaPts: Math.max(0, (lAlc - lAct) * 100),
        nOfs: lineaRows.length,
      });
    }

    out.push({
      semana: b.semana,
      anio: b.anio,
      semanaLabel: weekLabel(b.semana, b.anio, b.dateMin, b.dateMax),
      desde: b.dateMin.toISOString().slice(0, 10),
      hasta: b.dateMax.toISOString().slice(0, 10),
      oeeActual,
      oeeAlcanzable,
      perdidaPts: Math.max(0, (oeeAlcanzable - oeeActual) * 100),
      hlTotal,
      nOfs: b.rows.length,
      porLinea,
    });
  }

  out.sort((a, b) => b.anio - a.anio || b.semana - a.semana);
  return out;
}

function pctEs(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function hlEs(n: number): string {
  return `${Math.round(n).toLocaleString('es-ES')} Hl`;
}

/** Synthesise a Planificado-format Excel from a week's historical OFs so the
 *  LineWise sidecar can run /optimize_v3 over it. The parser detects the
 *  format by the presence of `Material` AND `Definición de turno` columns,
 *  so we emit those names exactly.
 *
 *  Turno is inferred from `fechaFin` hour when present (T 8-16, N 16-24,
 *  M 0-8); otherwise defaults to T. The model's turno feature is one of many
 *  and a default doesn't break inference. */
function synthesizeWeekExcel(rows: OfRow[]): Buffer {
  const records = rows.map((r, i) => {
    const d = r.fechaFin;
    const h = d.getUTCHours();
    const turno = h < 8 ? 'M' : h < 16 ? 'T' : 'N';
    return {
      Material: r.sku,
      Tren: r.linea,
      Fecha_Ini: d,
      'Definición de turno': turno,
      'Cntd Plan': Math.max(1, Math.round(r.hl)),
      'Cntd JDA': Math.max(1, Math.round(r.hl)),
      'Hora Ini': { M: '00:00', T: '08:00', N: '16:00' }[turno],
      Secuencia: i + 1,
    };
  });
  const ws = XLSX.utils.json_to_sheet(records);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Planificado');
  const arr = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return arr;
}

/** Convert the optimizer's swap log into the brief's recommendation shape.
 *  Each swap is a concrete counterfactual ("had you placed X at Y, OEE
 *  would have been Z"). Sorted by potential gain, capped at `maxRecos`.
 *
 *  The HL gain is approximated as `gananciaPts/100 × hlTotal` — that is, the
 *  per-move factory-OEE contribution times the week's total HL. It double-counts
 *  if every swap is applied, but as a per-move headline it answers "what would
 *  this one move have produced extra" honestly. */
function swapsToRecomendaciones(
  swaps: SwapRow[],
  hlTotal: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _hlBySku: Map<string, number>,
  maxRecos = 4,
): RecomendacionSemana[] {
  const sorted = [...swaps].sort((a, b) => Math.abs(b.gananciaPts) - Math.abs(a.gananciaPts));
  const out: RecomendacionSemana[] = [];
  for (const s of sorted) {
    if (out.length >= maxRecos) break;
    if (Math.abs(s.gananciaPts) < 0.05) continue;
    const fromLabel = s.fromLinea !== null
      ? `L${s.fromLinea} · ${s.fromDia ?? ''} · ${s.fromTurno ?? ''}`.trim()
      : 'inserción nueva';
    const toLabel = s.toLinea !== null
      ? `L${s.toLinea} · ${s.toDia ?? ''} · ${s.toTurno ?? ''}`.trim()
      : 'sin destino';
    const tituloBase = s.categoria === 'prioritario'
      ? `Insertar ${s.sku} en ${toLabel}`
      : s.categoria === 'desplazado'
        ? `Desplazar ${s.sku} de ${fromLabel}`
        : `Mover ${s.sku} a ${toLabel}`;
    const detalles: string[] = [];
    if (Math.abs(s.deltaCambioMin) >= 1) {
      detalles.push(
        s.deltaCambioMin < 0
          ? `ahorra ${Math.abs(Math.round(s.deltaCambioMin))} min de cambio`
          : `añade ${Math.round(s.deltaCambioMin)} min de cambio`,
      );
    }
    if (Math.abs(s.deltaMantHoras) >= 1) {
      detalles.push(
        s.deltaMantHoras > 0
          ? `se aleja ${Math.round(s.deltaMantHoras)} h de mantenimiento`
          : `se acerca ${Math.abs(Math.round(s.deltaMantHoras))} h al mantenimiento`,
      );
    }
    if (s.agrupaFormato) detalles.push('agrupa formato');
    const descripcion = detalles.length > 0
      ? `Desde ${fromLabel}. ${detalles.join(' · ')}.`
      : `Desde ${fromLabel}. ${s.descripcion || 'Ajuste de cascada que mejora el OEE de la semana.'}`;

    const gananciaHl = Math.round((Math.abs(s.gananciaPts) / 100) * hlTotal);

    const categoriaLabel: Record<SwapRow['categoria'], string> = {
      obligatorio: 'Obligatorio (slot bloqueado)',
      opcional: 'Mejora opcional',
      prioritario: 'OF prioritario',
      desplazado: 'Desplazamiento por prioritario',
      realojo: 'Realojo del desplazado',
    };

    out.push({
      titulo: tituloBase,
      descripcion,
      gananciaPotencialPts: Math.round(Math.abs(s.gananciaPts) * 10) / 10,
      gananciaPotencialHl: gananciaHl,
      evidencia: `${categoriaLabel[s.categoria]} · modelo LightGBM (p90)`,
      detalle: detalleFromSwap(s, gananciaHl, categoriaLabel[s.categoria]),
    });
  }
  return out;
}

function detalleFromSwap(
  s: SwapRow,
  gananciaHl: number,
  categoriaText: string,
): RecomendacionDetalle {
  const fromLabel = s.fromLinea !== null
    ? `L${s.fromLinea} · ${s.fromDia ?? ''} · ${s.fromTurno ?? ''}`.trim()
    : 'Inserción nueva (no existía)';
  const toLabel = s.toLinea !== null
    ? `L${s.toLinea} · ${s.toDia ?? ''} · ${s.toTurno ?? ''}`.trim()
    : 'Sin destino (desplazamiento)';

  const cambios = [
    {
      etiqueta: `OF ${s.sku}`,
      antes: fromLabel,
      despues: toLabel,
    },
  ];

  const metricas: RecomendacionDetalle['metricas'] = [
    {
      label: 'ΔOEE (semanal)',
      value: `+${Math.abs(s.gananciaPts).toFixed(2)} pp`,
      sentido: 'positivo',
    },
    {
      label: 'HL recuperados',
      value: `+${gananciaHl.toLocaleString('es-ES')} Hl`,
      sentido: 'positivo',
    },
  ];
  if (Math.abs(s.deltaCambioMin) >= 1) {
    const positivo = s.deltaCambioMin < 0;
    metricas.push({
      label: 'Minutos de cambio',
      value: `${positivo ? '−' : '+'}${Math.abs(Math.round(s.deltaCambioMin))} min`,
      sentido: positivo ? 'positivo' : 'negativo',
    });
  }
  if (Math.abs(s.deltaMantHoras) >= 1) {
    const positivo = s.deltaMantHoras > 0;
    metricas.push({
      label: 'Distancia a mantenimiento',
      value: `${positivo ? '+' : '−'}${Math.abs(Math.round(s.deltaMantHoras))} h`,
      sentido: positivo ? 'positivo' : 'negativo',
    });
  }
  if (s.agrupaFormato) {
    metricas.push({ label: 'Agrupación de formato', value: 'Sí', sentido: 'positivo' });
  }

  const pasos: string[] = [];
  if (s.categoria === 'prioritario') {
    pasos.push(`Reservar el slot ${toLabel} para la OF prioritaria ${s.sku}.`);
    pasos.push(`Si está ocupado, desplazar la OF de menor OEE × HL al pool de pendientes.`);
    pasos.push(`Lanzar la producción priorizando el cumplimiento del plazo.`);
  } else if (s.categoria === 'desplazado') {
    pasos.push(`Liberar la OF ${s.sku} del slot ${fromLabel} (queda pendiente de realojo).`);
    pasos.push(`Combinar con la siguiente recomendación de realojo (↪) para no perder el volumen.`);
  } else {
    pasos.push(`Confirmar que el slot ${toLabel} tiene capacidad disponible.`);
    pasos.push(`Trasladar la OF ${s.sku} desde ${fromLabel} al destino.`);
    pasos.push(`Reordenar las OFs adyacentes para mantener la secuencia operativa.`);
    pasos.push(`Validar con el supervisor de turno que el cambio respeta los plazos.`);
  }

  const riesgos: string[] = [];
  if (s.deltaCambioMin > 0) {
    riesgos.push(
      `Añade ${Math.round(s.deltaCambioMin)} min de cambio respecto a la posición original.`,
    );
  }
  if (s.deltaMantHoras < -1) {
    riesgos.push(
      `Se acerca ${Math.abs(Math.round(s.deltaMantHoras))} h al mantenimiento más cercano.`,
    );
  }
  if (s.categoria === 'obligatorio') {
    riesgos.push('El slot de origen estaba bloqueado (LIMPIEZA / MANT / OUTAGE) — el cambio no es opcional.');
  }
  if (s.categoria === 'prioritario' && !s.fromLinea) {
    riesgos.push('Suma HL al plan original; revisar capacidad total de la línea destino.');
  }
  riesgos.push(`Categoría: ${categoriaText}.`);

  return { cambios, metricas, pasos, riesgos };
}

/** In-memory cache keyed by `${semana}-${anio}-${linea ?? 'all'}`. The model
 *  call takes ~13 s, so caching the result of a click avoids re-running it
 *  if the user navigates back to the same week within the session. */
const briefCache = new Map<string, WeekBrief>();

export async function postMortemBrief(
  semana: number,
  anio: number,
  linea?: Linea,
): Promise<WeekBrief> {
  const rows = await prisma.ofHecho.findMany({
    where: linea ? { semanaIso: semana, anio, linea } : { semanaIso: semana, anio },
    orderBy: { fechaFin: 'asc' },
  });

  if (rows.length === 0) {
    return {
      semana,
      anio,
      semanaLabel: `Sem ${semana} · ${anio}`,
      summary: 'Sin OFs registradas para esta semana en el ámbito seleccionado.',
      kpis: [],
      recomendaciones: [],
    };
  }

  const dateMin = rows.reduce((a, r) => (r.fechaFin < a ? r.fechaFin : a), rows[0].fechaFin);
  const dateMax = rows.reduce((a, r) => (r.fechaFin > a ? r.fechaFin : a), rows[0].fechaFin);
  const semanaLabel = weekLabel(semana, anio, dateMin, dateMax);

  const pairs = new Set<string>(rows.map((r) => `${r.sku}|${r.linea}`));
  const baselines = await prisma.skuLineaBaseline.findMany({
    where: { OR: [...pairs].map((p) => {
      const [skuCodigo, ln] = p.split('|');
      return { skuCodigo, linea: Number(ln) };
    }) },
  });
  const baselineIdx = new Map(baselines.map((b) => [`${b.skuCodigo}|${b.linea}`, b]));

  // Historical fallback p80 for SKU+línea pairs not in SkuLineaBaseline.
  // Pull all OFs for these pairs (any week) to compute a meaningful ceiling.
  const skusInWeek = [...new Set(rows.map((r) => r.sku))];
  const lineasInWeek = [...new Set(rows.map((r) => r.linea))];
  const historicalRows = await prisma.ofHecho.findMany({
    where: { sku: { in: skusInWeek }, linea: { in: lineasInWeek } },
  });
  const fallbackIdx = buildSkuLineaP80Fallback(historicalRows);

  const hlTotal = rows.reduce((a, r) => a + r.hl, 0);
  const oeeActual = hlWeighted(rows);
  const oeeAlcanzable = alcanzableHlWeighted(rows, baselineIdx, fallbackIdx);
  const perdidaPts = Math.max(0, (oeeAlcanzable - oeeActual) * 100);

  // Compare to previous week of the same year
  const previousWeek = await prisma.ofHecho.findMany({
    where: linea ? { semanaIso: semana - 1, anio, linea } : { semanaIso: semana - 1, anio },
  });
  const oeePrev = previousWeek.length > 0 ? hlWeighted(previousWeek) : null;
  const deltaPrev = oeePrev !== null ? (oeeActual - oeePrev) * 100 : null;

  const recomendaciones: RecomendacionSemana[] = [];

  // Recommendation source A: per-línea brecha vs alcanzable
  for (const ln of [14, 17, 19] as Linea[]) {
    if (linea && ln !== linea) continue;
    const lineaRows = rows.filter((r) => r.linea === ln);
    if (lineaRows.length === 0) continue;
    const lAct = hlWeighted(lineaRows);
    const lAlc = alcanzableHlWeighted(lineaRows, baselineIdx, fallbackIdx);
    const gap = (lAlc - lAct) * 100;
    if (gap < 3) continue;
    const lhl = lineaRows.reduce((a, r) => a + r.hl, 0);
    const lostHl = Math.round((gap / 100) * lhl);
    recomendaciones.push({
      titulo: `Subir L${ln} hacia su techo alcanzable`,
      descripcion: `L${ln} produjo ${pctEs(lAct)} frente al alcanzable ${pctEs(lAlc)}. La brecha es de ${gap.toFixed(1)} pp.`,
      gananciaPotencialPts: Math.round(gap * lhl / hlTotal * 10) / 10,
      gananciaPotencialHl: lostHl,
      evidencia: `${lineaRows.length} OFs · ${hlEs(lhl)} en L${ln}`,
      detalle: {
        cambios: [
          { etiqueta: `L${ln} esta semana`, antes: pctEs(lAct), despues: pctEs(lAlc) + ' (techo)' },
        ],
        metricas: [
          { label: 'Brecha actual', value: `${gap.toFixed(1)} pp`, sentido: 'negativo' },
          { label: 'HL latentes', value: hlEs(lostHl), sentido: 'negativo' },
          { label: 'OFs analizadas', value: `${lineaRows.length}` },
        ],
        pasos: [
          `Identificar las OFs de L${ln} esta semana con OEE por debajo de su mediana histórica.`,
          `Comparar el mix de SKUs vs semanas con mejor resultado en L${ln}.`,
          `Revisar si hubo más cambios de formato o mantenimientos no programados.`,
          `Aplicar las correcciones en la planificación de la próxima semana similar.`,
        ],
        riesgos: [
          'El techo (p80) asume condiciones operativas razonables; eventos puntuales pueden hacerlo inalcanzable.',
        ],
      },
    });
  }

  // Recommendation source B: cambios penalizan
  const conCambio = rows.filter((r) => r.tieneCambio);
  const sinCambio = rows.filter((r) => !r.tieneCambio);
  if (conCambio.length > 0 && sinCambio.length > 0) {
    const oeeConCambio = hlWeighted(conCambio);
    const oeeSinCambio = hlWeighted(sinCambio);
    const diffPts = (oeeSinCambio - oeeConCambio) * 100;
    if (diffPts > 4) {
      const hlConCambio = conCambio.reduce((a, r) => a + r.hl, 0);
      const lostHl = Math.round((diffPts / 100) * hlConCambio);
      const fraction = hlConCambio / hlTotal;
      recomendaciones.push({
        titulo: 'Agrupar OFs para reducir cambios',
        descripcion: `Las OFs con cambio rindieron ${pctEs(oeeConCambio)} frente a las sin cambio ${pctEs(oeeSinCambio)}. La brecha es de ${diffPts.toFixed(1)} pp.`,
        gananciaPotencialPts: Math.round(diffPts * fraction * 10) / 10,
        gananciaPotencialHl: lostHl,
        evidencia: `${conCambio.length} OFs con cambio · ${sinCambio.length} sin cambio`,
        detalle: {
          cambios: [
            { etiqueta: 'OFs con cambio',  antes: pctEs(oeeConCambio), despues: pctEs(oeeSinCambio) + ' (objetivo)' },
            { etiqueta: 'OFs sin cambio',  antes: pctEs(oeeSinCambio), despues: 'mantener' },
          ],
          metricas: [
            { label: 'Penalización por cambio', value: `${diffPts.toFixed(1)} pp`,                 sentido: 'negativo' },
            { label: 'OFs con cambio',         value: `${conCambio.length}` },
            { label: 'OFs sin cambio',         value: `${sinCambio.length}` },
            { label: 'HL potenciales',         value: hlEs(lostHl),                                sentido: 'positivo' },
          ],
          pasos: [
            'Listar los cambios de formato, marca y CAP que ocurrieron esta semana.',
            'Reordenar la secuencia para concentrar SKUs del mismo formato en bloques largos.',
            'Negociar con el plant manager corridas mínimas (p. ej. 8 h) por formato.',
            'Validar que el orden no choca con plazos de entrega ni con las ventanas de mantenimiento.',
          ],
          riesgos: [
            'Los plazos pueden forzar cambios; priorizar primero las OFs con vencimiento corto.',
            'Algunas dimensiones (CAP, bandeja) pueden seguir requiriendo cambios aunque el formato sea el mismo.',
          ],
        },
      });
    }
  }

  // Recommendation source C: SKUs muy por debajo de su alcanzable
  interface SkuPerf {
    sku: string;
    linea: Linea;
    actMean: number;
    alcMean: number;
    gap: number;
    hl: number;
    n: number;
  }
  const bySku = new Map<string, { rows: OfRow[]; linea: Linea }>();
  for (const r of rows) {
    const k = `${r.sku}|${r.linea}`;
    let cur = bySku.get(k);
    if (!cur) {
      cur = { rows: [], linea: r.linea as Linea };
      bySku.set(k, cur);
    }
    cur.rows.push(r);
  }
  const skuPerf: SkuPerf[] = [];
  for (const [k, v] of bySku) {
    const [sku] = k.split('|');
    const baselineAlc = baselineIdx.get(k)?.oeeAlcanzable;
    const fallbackAlc = fallbackIdx.get(k);
    const alcMean = baselineAlc ?? fallbackAlc;
    if (alcMean === undefined) continue;
    const hl = v.rows.reduce((a, r) => a + r.hl, 0);
    if (hl < 500) continue;
    const actMean = hlWeighted(v.rows);
    const gap = (alcMean - actMean) * 100;
    if (gap < 8) continue;
    skuPerf.push({
      sku,
      linea: v.linea,
      actMean,
      alcMean,
      gap,
      hl,
      n: v.rows.length,
    });
  }
  skuPerf.sort((a, b) => b.gap * b.hl - a.gap * a.hl);
  for (const s of skuPerf.slice(0, 2)) {
    const lostHl = Math.round((s.gap / 100) * s.hl);
    recomendaciones.push({
      titulo: `Revisar SKU ${s.sku} en L${s.linea}`,
      descripcion: `Rindió ${pctEs(s.actMean)} (${s.n} OFs, ${hlEs(s.hl)}) frente al alcanzable ${pctEs(s.alcMean)}. La brecha es de ${s.gap.toFixed(1)} pp.`,
      gananciaPotencialPts: Math.round((s.gap * s.hl / hlTotal) * 10) / 10,
      gananciaPotencialHl: lostHl,
      evidencia: `Baseline histórico p80 ${pctEs(s.alcMean)}`,
      detalle: {
        cambios: [
          { etiqueta: `SKU ${s.sku} en L${s.linea}`, antes: pctEs(s.actMean), despues: pctEs(s.alcMean) + ' (techo)' },
        ],
        metricas: [
          { label: 'Brecha actual', value: `${s.gap.toFixed(1)} pp`,    sentido: 'negativo' },
          { label: 'HL latentes',   value: hlEs(lostHl),                sentido: 'negativo' },
          { label: 'OFs analizadas', value: `${s.n}` },
          { label: 'HL totales SKU',  value: hlEs(s.hl) },
        ],
        pasos: [
          `Repasar las OFs de ${s.sku} en L${s.linea} con OEE por debajo de ${pctEs(s.alcMean)}.`,
          `Identificar el predecesor que se repite en los peores casos.`,
          `Estudiar si el SKU encaja mejor en otra línea con baseline más alto.`,
          `Pedir al equipo de cambio una guía específica para este SKU.`,
        ],
        riesgos: [
          `El histórico p80 viene del mismo (SKU, línea), no es genérico.`,
          `Si el SKU acaba de incorporarse al portafolio, el baseline puede no estar consolidado.`,
        ],
      },
    });
  }

  // Watchout: peor que la semana anterior
  if (deltaPrev !== null && deltaPrev < -2) {
    recomendaciones.push({
      titulo: 'Vigilancia: peor que la semana anterior',
      descripcion: `El OEE cayó ${Math.abs(deltaPrev).toFixed(1)} pp respecto a la semana ${semana - 1}. Revisar qué cambió en el mix de OFs.`,
      gananciaPotencialPts: Math.round(Math.abs(deltaPrev) * 10) / 10,
      gananciaPotencialHl: Math.round((Math.abs(deltaPrev) / 100) * hlTotal),
      evidencia: `Sem ${semana - 1}: ${pctEs(oeePrev!)} · Sem ${semana}: ${pctEs(oeeActual)}`,
      detalle: {
        cambios: [
          { etiqueta: `Sem ${semana - 1}`, antes: pctEs(oeePrev!), despues: pctEs(oeeActual) },
        ],
        metricas: [
          { label: 'Caída intersemanal', value: `${Math.abs(deltaPrev).toFixed(1)} pp`, sentido: 'negativo' },
          { label: 'HL afectados',       value: hlEs(Math.round((Math.abs(deltaPrev) / 100) * hlTotal)) },
        ],
        pasos: [
          `Diff por SKU del mix entre la sem ${semana - 1} y la sem ${semana}.`,
          'Aislar SKUs nuevos o con HL anómalo respecto a la semana anterior.',
          'Revisar si hubo mantenimientos correctivos o averías declaradas.',
          'Confirmar que los cambios en el mix justifican la caída antes de actuar.',
        ],
      },
    });
  }

  // Sort deterministic recs by potential gain
  recomendaciones.sort((a, b) => b.gananciaPotencialPts - a.gananciaPotencialPts);
  const deterministicTop = recomendaciones.slice(0, 4);

  // ---- Try the LineWise model (local sidecar first, HF fallback) ----
  // Synthesise the week's OFs into a Planificado xlsx and ask the optimizer
  // for concrete counterfactual moves. When the sidecar is offline we fall
  // back to the deterministic rules computed above.
  const cacheKey = `${anio}-${semana}-${linea ?? 'all'}`;
  const cached = briefCache.get(cacheKey);
  if (cached) return cached;

  let modelTop: RecomendacionSemana[] = [];
  let modelMeta: WeekBrief['meta'] = { source: 'heuristic_fallback' };
  let modelOptimizado: number | undefined;
  try {
    const xlsxBuf = synthesizeWeekExcel(rows);
    const fileName = `postmortem_sem${semana}_${anio}${linea ? `_L${linea}` : ''}.xlsx`;
    const lw = await callLineWise(xlsxBuf, fileName, { aggressive: true });
    if (lw) {
      const swaps = parseSwapTable(lw.swap_tbl);
      const headline = parseHeadlineOee(lw.summary_md);
      modelOptimizado = headline.optimizado;
      const hlBySku = new Map<string, number>();
      for (const r of rows) hlBySku.set(r.sku, (hlBySku.get(r.sku) ?? 0) + r.hl);
      modelTop = swapsToRecomendaciones(swaps, hlTotal, hlBySku, 4);
      modelMeta = { source: 'linewise', via: lw.via, latencyMs: lw.latencyMs };
    }
  } catch (err) {
    // Sidecar threw or network fault — keep heuristic fallback silently.
    console.warn('[postMortemBrief] model call failed:', err);
  }

  const top = modelTop.length > 0 ? modelTop : deterministicTop;

  // Summary prose (mentions the model when it surfaced extra gain)
  const summaryParts: string[] = [];
  if (perdidaPts >= 5) {
    summaryParts.push(`La semana ${semana} perdió ${perdidaPts.toFixed(1)} pp frente al alcanzable.`);
  } else if (perdidaPts >= 1) {
    summaryParts.push(`La semana ${semana} estuvo cerca de su techo (brecha ${perdidaPts.toFixed(1)} pp).`);
  } else {
    summaryParts.push(`La semana ${semana} alcanzó su techo.`);
  }
  if (deltaPrev !== null) {
    if (deltaPrev > 1) summaryParts.push(`Mejora de ${deltaPrev.toFixed(1)} pp respecto a la semana anterior.`);
    else if (deltaPrev < -1) summaryParts.push(`Cae ${Math.abs(deltaPrev).toFixed(1)} pp respecto a la semana anterior.`);
  }
  if (modelMeta.source === 'linewise' && modelOptimizado !== undefined && modelOptimizado > oeeActual) {
    const gainPts = (modelOptimizado - oeeActual) * 100;
    summaryParts.push(`El modelo identifica ${top.length} reasignaciones que habrían añadido ${gainPts.toFixed(1)} pp.`);
  } else if (top.length > 0) {
    summaryParts.push(`Se detectan ${top.length} palancas para la próxima semana similar.`);
  }
  const summary = summaryParts.join(' ');

  const kpis: WeekBriefKpi[] = [
    { label: 'OEE actual', value: pctEs(oeeActual) },
    { label: 'Alcanzable', value: pctEs(oeeAlcanzable), accent: 'moss' },
    { label: 'Pérdida', value: `${perdidaPts.toFixed(1)} pp`, accent: 'damm' },
    { label: 'HL totales', value: hlEs(hlTotal) },
  ];
  if (modelMeta.source === 'linewise' && modelOptimizado !== undefined) {
    kpis.splice(2, 0, { label: 'Optimizado (modelo)', value: pctEs(modelOptimizado), accent: 'moss' });
  }

  const brief: WeekBrief = {
    semana,
    anio,
    semanaLabel,
    summary,
    kpis,
    recomendaciones: top,
    meta: modelMeta,
  };
  briefCache.set(cacheKey, brief);
  return brief;
}

export async function listarSkusConBaselines() {
  const skus = await prisma.sku.findMany({ include: { baselines: true } });
  return skus.map((s) => ({
    codigo: s.codigo,
    nombre: s.nombre,
    marca: s.marca,
    formato: s.formato,
    lineas: s.baselines.map((b) => ({
      linea: b.linea as Linea,
      oeeAlcanzable: b.oeeAlcanzable,
      oeeMediana: b.oeeMediana,
      rateHlH: b.rateHlH,
    })),
  }));
}

// ---------- PLAN: análisis fila a fila ----------

interface RawItem {
  linea: number;
  sku: string;
  dia: string;
  hlPlan: number;
}

// TODO: reemplazar por el modelo. Hoy: baseline alcanzable - penalizaciones.
async function predecirOEE(args: {
  linea: number;
  sku: string;
  skuAnterior: string | null;
  tipoCambio: TipoCambio;
  hayMantenimientoCerca: boolean;
}): Promise<number> {
  const baseline = await prisma.skuLineaBaseline.findUnique({
    where: { skuCodigo_linea: { skuCodigo: args.sku, linea: args.linea } },
  });
  // Si no hay baseline, fallback al promedio de la línea (el SKU aún sería operable).
  const fallbackPorLinea: Record<number, number> = { 14: 0.54, 17: 0.67, 19: 0.67 };
  let oee = baseline?.oeeAlcanzable ?? fallbackPorLinea[args.linea] ?? 0.55;
  if (args.tipoCambio === 'formato') oee -= 0.32; // ~32 pts: la palanca grande
  else if (args.tipoCambio === 'cerveza') oee -= 0.06;
  else if (args.tipoCambio === 'mantenimiento') oee -= 0.18;
  if (args.hayMantenimientoCerca) oee -= 0.08;
  return Math.max(0.1, Math.min(0.95, oee));
}

// TODO: reemplazar por el modelo.
function veredictoDe(oee: number, tipo: TipoCambio, hayMantos: boolean): Veredicto {
  if (tipo === 'formato' || oee < 0.5) return 'evitar';
  if (hayMantos || oee < 0.62) return 'revisar';
  return 'procede';
}

function motivoDe(tipo: TipoCambio, oee: number, hayMantos: boolean, skuAnt: string | null, sku: string) {
  const parts: string[] = [];
  if (tipo === 'formato') parts.push(`cambio de formato ${skuAnt}→${sku} (palanca grande de disponibilidad)`);
  else if (tipo === 'cerveza') parts.push(`cambio de cerveza dentro de mismo formato (~40 min)`);
  else if (tipo === 'inicio') parts.push(`inicio de jornada`);
  if (hayMantos) parts.push(`mantenimiento próximo en la línea`);
  parts.push(`OEE previsto ${(oee * 100).toFixed(0)}%`);
  return parts.join(' · ');
}

// Fallback: extrae formato del código del SKU. Patrón Damm: tras 2 letras de marca,
// vienen 2 dígitos que indican formato (13 → 1/3, 12 → 1/2).
function formatoDesdeCodigo(codigo: string): string | null {
  const m = codigo.match(/^[A-Z]{2}(\d{2})/i);
  if (!m) return null;
  if (m[1] === '13') return '1/3';
  if (m[1] === '12') return '1/2';
  return null;
}

function marcaDesdeCodigo(codigo: string): string | null {
  const m = codigo.match(/^([A-Z]{2})/i);
  return m ? m[1].toUpperCase() : null;
}

async function infoSku(codigo: string): Promise<{ formato: string | null; marca: string | null }> {
  const row = await prisma.sku.findUnique({ where: { codigo } });
  if (row) return { formato: row.formato, marca: row.marca };
  return { formato: formatoDesdeCodigo(codigo), marca: marcaDesdeCodigo(codigo) };
}

async function clasificarTipoCambio(linea: number, skuAnt: string | null, sku: string): Promise<TipoCambio> {
  if (!skuAnt) return 'inicio';
  const [a, b] = await Promise.all([infoSku(skuAnt), infoSku(sku)]);
  if (!a.formato || !b.formato) return 'otro';
  if (a.formato !== b.formato) return 'formato';
  if (a.marca && b.marca && a.marca !== b.marca) return 'cerveza';
  return 'otro';
}

async function tieneMantenimientoCerca(linea: number, dia: string) {
  const m = await prisma.mantenimiento.findFirst({ where: { linea, dia } });
  return !!m;
}

export async function analizarPlan(planId: string, nombre: string, items: RawItem[]): Promise<AnalisisPlan> {
  // Ordena por línea y secuencia tal cual vino del Excel (mantenemos la posición).
  const porLinea = new Map<number, RawItem[]>();
  for (const it of items) {
    const arr = porLinea.get(it.linea) ?? [];
    arr.push(it);
    porLinea.set(it.linea, arr);
  }

  const filas: FilaPlan[] = [];
  let secuenciaGlobal = 0;
  for (const [linea, arr] of porLinea) {
    let secuencia = 0;
    let skuAnterior: string | null = null;
    for (const it of arr) {
      secuencia++;
      secuenciaGlobal++;
      const tipo = await clasificarTipoCambio(linea, skuAnterior, it.sku);
      const mant = await tieneMantenimientoCerca(linea, it.dia);
      const oee = await predecirOEE({ linea, sku: it.sku, skuAnterior, tipoCambio: tipo, hayMantenimientoCerca: mant });
      const ver = veredictoDe(oee, tipo, mant);
      const motivo = motivoDe(tipo, oee, mant, skuAnterior, it.sku);
      const skuRow = await prisma.sku.findUnique({ where: { codigo: it.sku } });
      filas.push({
        of: `OF-${linea}-${secuenciaGlobal.toString().padStart(4, '0')}`,
        linea: linea as Linea,
        secuencia,
        dia: it.dia,
        sku: it.sku,
        nombre: skuRow?.nombre ?? it.sku,
        hlPlan: Math.round(it.hlPlan),
        skuAnterior,
        tipoCambio: tipo,
        oeePrevisto: round3(oee),
        veredicto: ver,
        motivo,
      });
      skuAnterior = it.sku;
    }
  }

  const banderas = { evitar: 0, revisar: 0, procede: 0 };
  for (const f of filas) banderas[f.veredicto]++;
  const oeePrevistoPlan = filas.length
    ? filas.reduce((a, f) => a + f.oeePrevisto * f.hlPlan, 0) / Math.max(1, filas.reduce((a, f) => a + f.hlPlan, 0))
    : 0;

  // pérdida evitable: diferencia con el "todo en alcanzable de su SKU-línea"
  let perdidaPts = 0;
  if (filas.length) {
    const baselines = await prisma.skuLineaBaseline.findMany({});
    const idx = new Map(baselines.map((b) => [`${b.skuCodigo}|${b.linea}`, b]));
    let wAlc = 0;
    let totalHl = 0;
    for (const f of filas) {
      const b = idx.get(`${f.sku}|${f.linea}`);
      const alc = b?.oeeAlcanzable ?? 0.5;
      wAlc += alc * f.hlPlan;
      totalHl += f.hlPlan;
    }
    const oeeAlcWeighted = totalHl ? wAlc / totalHl : 0;
    perdidaPts = Math.max(0, (oeeAlcWeighted - oeePrevistoPlan) * 100);
  }

  return {
    planId,
    nombre,
    oeePrevistoPlan: round3(oeePrevistoPlan),
    perdidaEvitablePts: Math.round(perdidaPts * 10) / 10,
    banderas,
    filas,
  };
}

// ---------- RECOMENDACIONES ----------
// TODO: reemplazar por el modelo. Heurística:
//   (a) cambio de formato evitable → mover_linea a otra línea ya en ese formato
//   (b) consecutivos del mismo formato dispersos → reordenar para agrupar
//   (c) OF en día de mantenimiento → reprogramar

export async function recomendarPlan(planId: string): Promise<PlanRecomendado> {
  const plan = await prisma.plan.findUnique({ where: { id: planId }, include: { items: { orderBy: { secuencia: 'asc' } } } });
  if (!plan) throw new Error('plan_not_found');

  const items = plan.items.map((it) => ({ linea: it.linea, sku: it.sku, dia: it.dia, hlPlan: it.hlPlan, secuencia: it.secuencia }));
  const baselines = await prisma.skuLineaBaseline.findMany();
  const baseIdx = new Map(baselines.map((b) => [`${b.skuCodigo}|${b.linea}`, b]));
  const skus = await prisma.sku.findMany();
  const skuIdx = new Map(skus.map((s) => [s.codigo, s]));
  const fmtOf = (codigo: string): string => skuIdx.get(codigo)?.formato ?? formatoDesdeCodigo(codigo) ?? '';
  const nameOf = (codigo: string): string => skuIdx.get(codigo)?.nombre ?? codigo;

  const original = await analizarPlan(planId, plan.nombre, items);

  const recos: Recomendacion[] = [];

  // (a) Cambios de formato evitables
  const grupos = new Map<number, typeof items>();
  for (const it of items) {
    const arr = grupos.get(it.linea) ?? [];
    arr.push(it);
    grupos.set(it.linea, arr);
  }

  for (const [linea, arr] of grupos) {
    for (let i = 1; i < arr.length; i++) {
      const fa = fmtOf(arr[i - 1].sku);
      const fb = fmtOf(arr[i].sku);
      if (!fa || !fb) continue;
      if (fa !== fb) {
        // ¿hay otra línea ya corriendo el formato fb ese día?
        const candidatas = [14, 17, 19].filter((l) => l !== linea);
        for (const lcand of candidatas) {
          const itemsLineaCand = grupos.get(lcand) ?? [];
          const enFormatoB = itemsLineaCand.find((x) => fmtOf(x.sku) === fb);
          if (!enFormatoB) continue;
          const baselineEnDestino = baseIdx.get(`${arr[i].sku}|${lcand}`);
          const fallback = lcand === 14 ? 0.54 : 0.67;
          const oeeDestino = baselineEnDestino?.oeeAlcanzable ?? fallback;
          const gananciaPts = Math.round((oeeDestino - (linea === 14 ? 0.54 : 0.67) + 0.25) * 100);
          if (gananciaPts <= 3) continue;
          recos.push({
            id: `mov-${linea}-${i}`,
            tipo: 'mover_linea',
            titulo: `Mover ${nameOf(arr[i].sku)} de L${linea} a L${lcand}`,
            descripcion: `En L${linea} obliga a cambiar de ${fa} a ${fb} (palanca grande). L${lcand} ya está corriendo ${fb} ese día, así que el cambio es solo de cerveza (~40 min).`,
            skusAfectados: [arr[i].sku],
            gananciaPts: Math.min(15, gananciaPts),
            antes: { linea: linea as Linea, secuencia: arr.map((x) => x.sku) },
            despues: { linea: lcand as Linea, secuencia: [...(itemsLineaCand.map((x) => x.sku)), arr[i].sku] },
          });
          break;
        }
      }
    }

    // (b) Reordenar para agrupar mismo formato
    const formatos = arr.map((it) => fmtOf(it.sku));
    let transiciones = 0;
    for (let i = 1; i < formatos.length; i++) if (formatos[i] !== formatos[i - 1] && formatos[i] && formatos[i - 1]) transiciones++;
    const optimo = new Set(formatos).size - 1;
    if (transiciones > optimo) {
      const reordenado = [...arr].sort((x, y) => fmtOf(x.sku).localeCompare(fmtOf(y.sku)));
      recos.push({
        id: `reord-${linea}`,
        tipo: 'reordenar',
        titulo: `Reordenar L${linea} para agrupar formatos`,
        descripcion: `La secuencia actual alterna formatos ${transiciones} veces; agrupándolos quedan solo ${optimo} cambios de formato (el resto pasan a ser de cerveza, ~40 min).`,
        skusAfectados: arr.map((x) => x.sku),
        gananciaPts: Math.min(12, (transiciones - optimo) * 4),
        antes: { linea: linea as Linea, secuencia: arr.map((x) => x.sku) },
        despues: { linea: linea as Linea, secuencia: reordenado.map((x) => x.sku) },
      });
    }
  }

  // (c) Mantenimiento próximo
  const mantos = await prisma.mantenimiento.findMany();
  const mantIdx = new Set(mantos.map((m) => `${m.linea}|${m.dia}`));
  for (const it of items) {
    if (mantIdx.has(`${it.linea}|${it.dia}`)) {
      recos.push({
        id: `repr-${it.linea}-${it.secuencia}`,
        tipo: 'reprogramar',
        titulo: `Reprogramar ${nameOf(it.sku)} en L${it.linea}`,
        descripcion: `El día ${it.dia} hay mantenimiento programado en L${it.linea}. Mover esta OF al día siguiente recupera arranque limpio.`,
        skusAfectados: [it.sku],
        gananciaPts: 8,
        antes: { linea: it.linea as Linea, secuencia: [it.sku] },
        despues: { linea: it.linea as Linea, secuencia: [it.sku] },
      });
    }
  }

  // dedupe y ordena por ganancia
  const uniq = new Map<string, Recomendacion>();
  for (const r of recos) if (!uniq.has(r.id)) uniq.set(r.id, r);
  const lista = [...uniq.values()].sort((a, b) => b.gananciaPts - a.gananciaPts).slice(0, 8);

  const gananciaTotal = Math.min(15, lista.reduce((a, r) => a + r.gananciaPts, 0) * 0.55); // diminishing returns
  const oeePlanRecomendado = Math.min(0.92, original.oeePrevistoPlan + gananciaTotal / 100);

  return {
    oeePlanOriginal: original.oeePrevistoPlan,
    oeePlanRecomendado: round3(oeePlanRecomendado),
    gananciaPts: Math.round(gananciaTotal * 10) / 10,
    recomendaciones: lista,
  };
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

/* ─────────────────────────────────────────────────────────────────────
 * LineWise model integration — primary path for /api/planes
 *
 * Strategy: always compute the heuristic AnalisisPlan first (it's fast
 * and provides the structural skeleton: per-OF rows, recommendations,
 * banderas). Then, in parallel, call the HF Space. When the Space
 * responds, augment each FilaPlan with the model's OEE prediction +
 * decomposition + drivers, and recompute the headline numbers.
 *
 * If the Space is unreachable or HF_TOKEN is missing, the heuristic
 * result is returned as-is with meta.source='heuristic_fallback'.
 * The UI shows a small amber badge when this happens.
 * ───────────────────────────────────────────────────────────────────── */

export async function analizarPlanConLineWise(
  planId: string,
  nombre: string,
  items: RawItem[],
  fileBuffer: Buffer,
  fileName: string,
): Promise<AnalisisPlan> {
  const base = await analizarPlan(planId, nombre, items);
  const lw = await callLineWise(fileBuffer, fileName, { aggressive: false });
  if (!lw) {
    return {
      ...base,
      meta: {
        source: 'heuristic_fallback',
        warning: 'Modelo LineWise no disponible (sin HF_TOKEN o Space offline). Predicciones por heurística local.',
      },
    };
  }
  return mapLineWiseToAnalisisPlan(base, lw);
}

/**
 * NEW — analyze the cached plan with an INCIDENT (outage or priority OF)
 * applied. Reuses the same LineWise pipeline as /api/planes but with the
 * incident parameters passed to optimize_v3 + replan_from_ts=now (so any
 * OFs scheduled before now are pinned).
 */
import type { LineWiseRawResult } from './linewise-client';

export async function analizarConIncidencia(
  planId: string,
  nombre: string,
  items: RawItem[],
  fileBuffer: Buffer,
  fileName: string,
  incident: {
    outages?: { linea: number; fecha: string; turno: string; reason?: string }[];
    priority_ofs?: { sku: string; hl: number; deadline: string; preferred_linea?: number; reason?: string }[];
  },
): Promise<AnalisisPlan | null> {
  const base = await analizarPlan(planId, nombre, items);
  const lw = await callLineWise(fileBuffer, fileName, {
    aggressive: false,
    outages: incident.outages,
    priority_ofs: incident.priority_ofs,
    replan_from_ts: new Date().toISOString(),
  });
  if (!lw) return null;   // caller surfaces the model-down error
  return mapLineWiseToAnalisisPlan(base, lw);
}

/** Shared post-processing: turn a LineWise raw response + heuristic baseline
 *  into the AnalisisPlan shape the frontend expects. */
function mapLineWiseToAnalisisPlan(
  base: AnalisisPlan,
  lw: LineWiseRawResult,
): AnalisisPlan {
  const headline = parseHeadlineOee(lw.summary_md);
  const decomp   = parseDecomposicion(lw.summary_md);
  const dayRows  = parseDayTable(lw.day_tbl);
  const bloqueos = parseBloqueosMant(dayRows) as BloqueoMant[];
  const totalHl = base.filas.reduce((acc, f) => acc + f.hlPlan, 0);

  const filasAug: FilaPlan[] = base.filas.map((f) => {
    const feasReasonBloqueo = matchFeasReason(f, bloqueos);
    if (feasReasonBloqueo) {
      return {
        ...f,
        veredicto: 'evitar' as Veredicto,
        feasReason: feasReasonBloqueo,
        motivo: feasReasonBloqueo,
      };
    }
    return f;
  });

  const banderas = { evitar: 0, revisar: 0, procede: 0 };
  for (const f of filasAug) banderas[f.veredicto]++;
  const oeeBaseline   = headline.actual     ?? base.oeePrevistoPlan;
  const oeeOptimizado = headline.optimizado ?? oeeBaseline;

  const swapRows = parseSwapTable(lw.swap_tbl);
  const planRecomendado = buildPlanRecomendadoFromSwapLog(
    swapRows,
    oeeBaseline,
    oeeOptimizado,
  );
  const filasOptimizadas = applyOptimizerSwapsToFilas(filasAug, swapRows);

  return {
    ...base,
    filas: filasAug,
    oeePrevistoPlan: round3(oeeBaseline),
    banderas,
    oeeP10Plan: round3(Math.max(0.1, oeeBaseline - 0.10)),
    oeeP90Plan: round3(Math.min(0.95, oeeOptimizado + 0.05)),
    decomposicion: decomp,
    bloqueosMant: bloqueos,
    totalHl,
    meta: { source: 'linewise', via: lw.via, spaceLatencyMs: lw.latencyMs },
    planRecomendado,
    filasOptimizadas,
  };
}

/**
 * Materialize the "plan optimizado" view of the OFs by applying each swap
 * from the optimizer's swap_log to a copy of the input filas. Each swap
 * row carries (sku, fromLinea/Dia/Turno) → (toLinea/Dia/Turno); we find
 * the matching OF and update its slot. When multiple OFs match the source
 * slot (same SKU same shift), the first unswapped one is picked.
 *
 * Approximation, but visually faithful: the resulting per-cell content of
 * the calendar reflects exactly which OF the optimizer recommends placing
 * where. Priority inserts (from === null) get a synthetic OF added.
 */
function applyOptimizerSwapsToFilas(filas: FilaPlan[], swaps: SwapRow[]): FilaPlan[] {
  const copy = filas.map((f) => ({ ...f }));
  const swapped = new Set<string>();   // block_ids already moved (don't double-move)

  for (const swap of swaps) {
    // Priority insert (no source slot) → append a synthetic OF
    if (!swap.fromLinea && swap.toLinea) {
      copy.push({
        of: `PRIO-${swap.sku}-${swap.toDia}`,
        linea: swap.toLinea,
        secuencia: copy.length + 1,
        dia: swap.toDia ?? '',
        turno: swap.toTurno ?? undefined,
        sku: swap.sku,
        nombre: swap.sku,
        hlPlan: 0,
        skuAnterior: null,
        tipoCambio: 'inicio',
        oeePrevisto: 0,
        veredicto: 'procede',
        motivo: swap.descripcion,
      });
      continue;
    }
    // Eviction (no target slot) → drop the OF from the materialized view
    if (swap.fromLinea && !swap.toLinea) {
      const idx = copy.findIndex(
        (f) =>
          !swapped.has(f.of) &&
          f.sku === swap.sku &&
          f.linea === swap.fromLinea &&
          f.dia === swap.fromDia &&
          (!swap.fromTurno || !f.turno || f.turno === swap.fromTurno),
      );
      if (idx >= 0) {
        swapped.add(copy[idx].of);
        copy.splice(idx, 1);
      }
      continue;
    }
    // Normal move
    const idx = copy.findIndex(
      (f) =>
        !swapped.has(f.of) &&
        f.sku === swap.sku &&
        f.linea === swap.fromLinea &&
        f.dia === swap.fromDia &&
        (!swap.fromTurno || !f.turno || f.turno === swap.fromTurno),
    );
    if (idx >= 0) {
      swapped.add(copy[idx].of);
      const moved = copy[idx];
      if (swap.toLinea) moved.linea = swap.toLinea;
      if (swap.toDia)   moved.dia   = swap.toDia;
      if (swap.toTurno) moved.turno = swap.toTurno;
      // The maintenance-conflict reason was about the ORIGINAL slot. After
      // the optimizer moves the OF out, the warning no longer applies.
      moved.feasReason = undefined;
      // Veredicto also defaults back to procede; if the new slot is still
      // problematic that would have been caught when re-scoring the plan,
      // but for the calendar display the obvious "this was moved here" is
      // the operational truth.
      moved.veredicto = 'procede';
    }
  }
  return copy;
}

/** Turn the optimizer's per-move swap log into the Recomendacion shape the
 *  existing RecomendacionesPanel renders. Each move becomes one recommendation. */
function buildPlanRecomendadoFromSwapLog(
  swaps: SwapRow[],
  oeeOriginal: number,
  oeeOptimizado: number,
): PlanRecomendado {
  const recomendaciones: Recomendacion[] = swaps.map((s, i) => {
    // Classify under the existing 3 buckets so the RecomendacionesPanel
    // styling keeps working: línea change → mover_linea; día change → reprogramar;
    // turno-only change → reordenar.
    let tipo: Recomendacion['tipo'] = 'reordenar';
    if (s.fromLinea !== null && s.toLinea !== null && s.fromLinea !== s.toLinea) tipo = 'mover_linea';
    else if (s.fromDia !== null && s.toDia !== null && s.fromDia !== s.toDia)    tipo = 'reprogramar';

    const fromLabel = s.fromLinea
      ? `L${s.fromLinea} ${s.fromDia ?? ''} ${s.fromTurno ?? ''}`.trim()
      : 'inserción';
    const toLabel = s.toLinea
      ? `L${s.toLinea} ${s.toDia ?? ''} ${s.toTurno ?? ''}`.trim()
      : 'desplazado';

    const titulo = (s.categoria === 'prioritario')
      ? `Insertar ${s.sku} en ${toLabel}`
      : (s.categoria === 'desplazado')
        ? `Desplazar ${s.sku} de ${fromLabel}`
        : `Mover ${s.sku}: ${fromLabel} → ${toLabel}`;

    return {
      id: `opt-${i}-${s.sku}`,
      tipo,
      titulo,
      descripcion: s.descripcion,
      skusAfectados: [s.sku],
      gananciaPts: s.gananciaPts,
      categoria: s.categoria as CategoriaRecomendacion,
      deltaCambioMin: s.deltaCambioMin,
      deltaMantHoras: s.deltaMantHoras,
      agrupaFormato: s.agrupaFormato,
      antes:   { linea: (s.fromLinea ?? 14) as Linea, secuencia: [fromLabel] },
      despues: { linea: (s.toLinea   ?? s.fromLinea ?? 14) as Linea, secuencia: [toLabel] },
    };
  });

  // Sort: required first (operator must apply these), then optional sorted by ganancia desc
  recomendaciones.sort((a, b) => {
    const aReq = a.categoria === 'obligatorio' || a.categoria === 'prioritario' || a.categoria === 'desplazado' || a.categoria === 'realojo';
    const bReq = b.categoria === 'obligatorio' || b.categoria === 'prioritario' || b.categoria === 'desplazado' || b.categoria === 'realojo';
    if (aReq !== bReq) return aReq ? -1 : 1;
    return b.gananciaPts - a.gananciaPts;
  });

  return {
    oeePlanOriginal:     round3(oeeOriginal),
    oeePlanRecomendado:  round3(oeeOptimizado),
    gananciaPts:         Math.round((oeeOptimizado - oeeOriginal) * 100 * 10) / 10,
    recomendaciones,
    source: 'linewise',
  };
}

function isOnBlock(f: FilaPlan, bloqueos: BloqueoMant[]): boolean {
  return bloqueos.some(
    (b) => b.linea === f.linea && b.dia === f.dia && (!f.turno || b.turno === f.turno),
  );
}

function matchFeasReason(f: FilaPlan, bloqueos: BloqueoMant[]): string | undefined {
  const b = bloqueos.find(
    (x) => x.linea === f.linea && x.dia === f.dia && (!f.turno || x.turno === f.turno),
  );
  if (!b) return undefined;
  // b.reason already reads "LIMPIEZA programada en L17 (2026-05-18)" — don't
  // double-wrap it. Just prepend the "Slot bloqueado:" tag.
  return `Slot bloqueado · ${b.event} en L${b.linea} ${b.dia} turno ${b.turno}`;
}

// ============================================================
// URGENCIAS
// ============================================================

const FALLBACK_OEE_LINEA: Record<number, number> = { 14: 0.54, 17: 0.67, 19: 0.67 };

export async function obtenerPlanLatest(): Promise<PlanResumen | null> {
  const plan = await prisma.plan.findFirst({
    orderBy: { creadoEn: 'desc' },
    include: { items: { orderBy: { secuencia: 'asc' } } },
  });
  if (!plan) return null;
  const rawItems = plan.items.map((it) => ({ linea: it.linea, sku: it.sku, dia: it.dia, hlPlan: it.hlPlan }));
  const analisis = await analizarPlan(plan.id, plan.nombre, rawItems);
  const dias = [...new Set(plan.items.map((i) => i.dia))].sort();
  return {
    id: plan.id,
    nombre: plan.nombre,
    creadoEn: plan.creadoEn.toISOString(),
    nOfs: plan.items.length,
    dias,
    oeePrevisto: analisis.oeePrevistoPlan,
  };
}

interface ContextoPlan {
  planId: string;
  planNombre: string;
  analisis: AnalisisPlan;
  filasPorLineaDia: Map<string, FilaPlan[]>; // key `${linea}|${dia}`
}

async function cargarContextoPlan(): Promise<ContextoPlan | null> {
  const plan = await prisma.plan.findFirst({
    orderBy: { creadoEn: 'desc' },
    include: { items: { orderBy: { secuencia: 'asc' } } },
  });
  if (!plan) return null;
  const items = plan.items.map((it) => ({ linea: it.linea, sku: it.sku, dia: it.dia, hlPlan: it.hlPlan }));
  const analisis = await analizarPlan(plan.id, plan.nombre, items);
  const filasPorLineaDia = new Map<string, FilaPlan[]>();
  for (const f of analisis.filas) {
    const k = `${f.linea}|${f.dia}`;
    const arr = filasPorLineaDia.get(k) ?? [];
    arr.push(f);
    filasPorLineaDia.set(k, arr);
  }
  return { planId: plan.id, planNombre: plan.nombre, analisis, filasPorLineaDia };
}

function rangoDias(dia: string, duracionHoras: number): string[] {
  // Aproximación: cada día son 24 h. Devuelve los días afectados.
  const dias: string[] = [];
  const base = new Date(dia + 'T00:00:00Z');
  const n = Math.max(1, Math.ceil(duracionHoras / 24));
  for (let i = 0; i < n; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    dias.push(d.toISOString().slice(0, 10));
  }
  return dias;
}

function pesoOeeFila(f: FilaPlan): number {
  return f.oeePrevisto * f.hlPlan;
}

// TODO: reemplazar por el modelo.
// Re-evalúa el OEE del plan después de excluir / sustituir filas.
function reevaluarOEE(filas: FilaPlan[], excluidasIds: Set<string>, sustituciones: Map<string, FilaPlan>): number {
  let suma = 0;
  let totalHl = 0;
  for (const f of filas) {
    const key = `${f.linea}|${f.secuencia}`;
    if (excluidasIds.has(key)) continue;
    const efectiva = sustituciones.get(key) ?? f;
    suma += pesoOeeFila(efectiva);
    totalHl += efectiva.hlPlan;
  }
  return totalHl ? suma / totalHl : 0;
}

interface LineaCandidata {
  linea: Linea;
  oeeAlcanzable: number;
  rateHlH: number;
  formatoActual: string | null; // último formato corriendo ese día (si aplica)
  cambioFormatoRequerido: boolean;
}

async function rankearLineasParaSku(args: {
  sku: string;
  dia?: string;
  excluirLinea?: Linea;
  filasPorLineaDia?: Map<string, FilaPlan[]>;
}): Promise<LineaCandidata[]> {
  const baselines = await prisma.skuLineaBaseline.findMany({ where: { skuCodigo: args.sku } });
  const baseIdx = new Map(baselines.map((b) => [b.linea, b]));
  const fmtSku = formatoDesdeCodigo(args.sku);
  const cand: LineaCandidata[] = [];
  for (const linea of [14, 17, 19] as Linea[]) {
    if (args.excluirLinea === linea) continue;
    const b = baseIdx.get(linea);
    const oeeAlcanzable = b?.oeeAlcanzable ?? FALLBACK_OEE_LINEA[linea] ?? 0.55;
    const rateHlH = b?.rateHlH ?? (fmtSku === '1/3' ? 95_000 : 78_000);
    // ¿qué formato está corriendo esa línea ese día? (último SKU del día)
    let formatoActual: string | null = null;
    if (args.dia && args.filasPorLineaDia) {
      const filas = args.filasPorLineaDia.get(`${linea}|${args.dia}`) ?? [];
      const ultima = filas[filas.length - 1];
      if (ultima) formatoActual = formatoDesdeCodigo(ultima.sku);
    }
    const cambioFormatoRequerido = !!(fmtSku && formatoActual && fmtSku !== formatoActual);
    cand.push({ linea, oeeAlcanzable, rateHlH, formatoActual, cambioFormatoRequerido });
  }
  cand.sort((a, b) => {
    if (a.cambioFormatoRequerido !== b.cambioFormatoRequerido) return a.cambioFormatoRequerido ? 1 : -1;
    return b.oeeAlcanzable - a.oeeAlcanzable;
  });
  return cand;
}


function pctStr(n: number): string {
  return `${Math.round(n * 100)}%`;
}
