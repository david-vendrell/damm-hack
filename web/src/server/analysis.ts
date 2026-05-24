// Servicio de análisis. TODA la inteligencia vive aquí — heurística + DB hoy,
// modelo ML mañana. La UI nunca conoce la implementación: consume tipos.

import { prisma } from './db';
import type {
  AccionUrgencia,
  AnalisisPlan,
  AnalisisUrgencia,
  FilaPlan,
  Linea,
  ModoUrgencia,
  PlanRecomendado,
  PlanResumen,
  PostMortemResumen,
  Recomendacion,
  RecomendacionSemana,
  SemanaPostMortem,
  TipoCambio,
  Urgencia,
  Veredicto,
  WeekBrief,
  WeekBriefKpi,
} from '@/types';

// ---------- POST MORTEM ----------

export async function postMortemResumen(): Promise<PostMortemResumen> {
  // Datos sembrados: hallazgos reales declarados en el brief.
  const porLinea = [
    { linea: 14 as Linea, perdidaPts: 5.5, oeeEjecutado: 0.485, oeeAlcanzable: 0.54 },
    { linea: 17 as Linea, perdidaPts: 8.3, oeeEjecutado: 0.587, oeeAlcanzable: 0.67 },
    { linea: 19 as Linea, perdidaPts: 7.8, oeeEjecutado: 0.592, oeeAlcanzable: 0.67 },
  ];
  return {
    perdidaEvitablePts: 7.5,
    ofsPorDebajoPct: 73,
    hlLatente: 162_000,
    ofsAnalizadas: 2_217,
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
    });
  }

  // Sort by potential gain and cap at 4
  recomendaciones.sort((a, b) => b.gananciaPotencialPts - a.gananciaPotencialPts);
  const top = recomendaciones.slice(0, 4);

  // Summary prose (deterministic)
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
  if (top.length > 0) {
    summaryParts.push(`Se detectan ${top.length} palancas para la próxima semana similar.`);
  }
  const summary = summaryParts.join(' ');

  const kpis: WeekBriefKpi[] = [
    { label: 'OEE actual', value: pctEs(oeeActual) },
    { label: 'Alcanzable', value: pctEs(oeeAlcanzable), accent: 'moss' },
    { label: 'Pérdida', value: `${perdidaPts.toFixed(1)} pp`, accent: 'damm' },
    { label: 'HL totales', value: hlEs(hlTotal) },
  ];

  return {
    semana,
    anio,
    semanaLabel,
    summary,
    kpis,
    recomendaciones: top,
  };
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

// ---- Subrutinas por tipo (placeholder) ----

async function analizarAveria(u: Urgencia, ctx: ContextoPlan | null): Promise<{ acciones: AccionUrgencia[]; filas: FilaPlan[]; resumen: string }> {
  if (!u.linea || !u.dia || !u.duracionHoras) {
    return { acciones: [], filas: [], resumen: 'Faltan datos de la avería.' };
  }
  const dias = rangoDias(u.dia, u.duracionHoras);
  const acciones: AccionUrgencia[] = [];
  const filasAfectadas: FilaPlan[] = [];

  if (ctx) {
    for (const dia of dias) {
      const filas = ctx.filasPorLineaDia.get(`${u.linea}|${dia}`) ?? [];
      for (const f of filas) {
        filasAfectadas.push(f);
        const candidatas = await rankearLineasParaSku({ sku: f.sku, dia, excluirLinea: u.linea, filasPorLineaDia: ctx.filasPorLineaDia });
        const top = candidatas[0];
        if (!top) continue;
        const prioridad: 1 | 2 | 3 = !top.cambioFormatoRequerido ? 1 : top.oeeAlcanzable > 0.6 ? 2 : 3;
        const impactoOeePts = Math.round((top.oeeAlcanzable - 0.0) * 100 - (top.cambioFormatoRequerido ? 25 : 0));
        acciones.push({
          id: `av-${f.linea}-${f.secuencia}`,
          tipo: 'mover',
          prioridad,
          titulo: `Mover ${f.nombre} a L${top.linea}`,
          descripcion: top.cambioFormatoRequerido
            ? `L${top.linea} corre otro formato (${top.formatoActual ?? '—'}), requeriría un cambio de formato. Aun así su baseline (${pctStr(top.oeeAlcanzable)}) es la mejor alternativa.`
            : `L${top.linea} ya corre el mismo formato ese día (${top.formatoActual ?? '—'}). Solo cambio de cerveza (~40 min). Baseline ${pctStr(top.oeeAlcanzable)}.`,
          ofAfectada: f.of,
          lineaOrigen: u.linea,
          lineaDestino: top.linea,
          impactoHl: f.hlPlan,
          impactoOeePts: Math.max(5, impactoOeePts),
        });
      }
    }
  } else {
    // Modo libre: ranking general para el SKU típico de la línea afectada.
    const candidatas = await rankearLineasParaSku({ sku: 'ED13LTNN', excluirLinea: u.linea });
    candidatas.slice(0, 3).forEach((c, i) => {
      const prioridad: 1 | 2 | 3 = i === 0 ? 1 : i === 1 ? 2 : 3;
      acciones.push({
        id: `av-libre-${c.linea}`,
        tipo: 'mover',
        prioridad,
        titulo: `Redirigir producción a L${c.linea}`,
        descripcion: `Baseline alcanzable ${pctStr(c.oeeAlcanzable)} · ritmo ${Math.round(c.rateHlH / 1000)}k Hl/h. Verificar compatibilidad de formato antes del cambio.`,
        lineaOrigen: u.linea,
        lineaDestino: c.linea,
        impactoOeePts: Math.round(c.oeeAlcanzable * 100),
      });
    });
  }

  const resumen = ctx
    ? `Avería en L${u.linea} durante ${u.duracionHoras}h: ${filasAfectadas.length} OFs afectadas, ${acciones.filter((a) => a.prioridad === 1).length} con alternativa limpia.`
    : `Avería en L${u.linea}: ranking de líneas alternativas según baseline histórico.`;
  return { acciones, filas: filasAfectadas, resumen };
}

async function analizarPedidoUrgente(u: Urgencia, ctx: ContextoPlan | null): Promise<{ acciones: AccionUrgencia[]; filas: FilaPlan[]; resumen: string }> {
  if (!u.sku || !u.hl) {
    return { acciones: [], filas: [], resumen: 'Faltan SKU o cantidad.' };
  }
  const candidatas = await rankearLineasParaSku({ sku: u.sku, dia: u.deadline, filasPorLineaDia: ctx?.filasPorLineaDia });
  const acciones: AccionUrgencia[] = [];
  const filasAfectadas: FilaPlan[] = [];

  const top = candidatas[0];
  if (top) {
    const horas = u.hl / top.rateHlH;
    acciones.push({
      id: `pu-priorizar-${top.linea}`,
      tipo: 'priorizar',
      prioridad: 1,
      titulo: `Inyectar ${u.hl.toLocaleString('es-ES')} Hl en L${top.linea}`,
      descripcion: `L${top.linea} ${top.cambioFormatoRequerido ? 'requiere cambio de formato' : 'ya corre el formato'} (${pctStr(top.oeeAlcanzable)} alcanzable). Tiempo estimado ${horas.toFixed(1)} h al ritmo histórico.`,
      lineaDestino: top.linea,
      impactoHl: u.hl,
      impactoOeePts: Math.round(top.oeeAlcanzable * 100),
    });

    if (ctx && u.deadline) {
      const filas = ctx.filasPorLineaDia.get(`${top.linea}|${u.deadline}`) ?? [];
      const menor = [...filas].sort((a, b) => a.hlPlan - b.hlPlan)[0];
      if (menor && menor.hlPlan < u.hl) {
        filasAfectadas.push(menor);
        acciones.push({
          id: `pu-reprogramar-${menor.linea}-${menor.secuencia}`,
          tipo: 'reprogramar',
          prioridad: 2,
          titulo: `Aplazar ${menor.nombre}`,
          descripcion: `Su volumen (${menor.hlPlan.toLocaleString('es-ES')} Hl) es el menor de L${menor.linea} ese día. Cede hueco al pedido urgente; reubicarla al día siguiente.`,
          ofAfectada: menor.of,
          lineaOrigen: menor.linea,
          impactoHl: menor.hlPlan,
          impactoOeePts: -3,
        });
      }
    }
  }

  candidatas.slice(1, 3).forEach((c, i) => {
    acciones.push({
      id: `pu-alt-${c.linea}`,
      tipo: 'mover',
      prioridad: 3,
      titulo: `Alternativa: L${c.linea}`,
      descripcion: `${c.cambioFormatoRequerido ? 'Requiere cambio de formato' : 'Mismo formato corriendo'}. Baseline ${pctStr(c.oeeAlcanzable)}.`,
      lineaDestino: c.linea,
      impactoOeePts: Math.round(c.oeeAlcanzable * 100),
    });
  });

  const resumen = ctx
    ? `Pedido urgente: ${u.hl?.toLocaleString('es-ES')} Hl de ${u.sku}. Línea óptima L${top?.linea ?? '?'} (${pctStr(top?.oeeAlcanzable ?? 0)}).`
    : `Pedido urgente: ${u.hl?.toLocaleString('es-ES')} Hl de ${u.sku}. Sin plan cargado se evalúa solo por baseline histórico.`;
  return { acciones, filas: filasAfectadas, resumen };
}

async function analizarIncidenciaCalidad(u: Urgencia, ctx: ContextoPlan | null): Promise<{ acciones: AccionUrgencia[]; filas: FilaPlan[]; resumen: string }> {
  if (!u.sku || !u.hl) return { acciones: [], filas: [], resumen: 'Faltan datos de la incidencia.' };
  const candidatas = await rankearLineasParaSku({ sku: u.sku, dia: u.deadline, excluirLinea: u.linea, filasPorLineaDia: ctx?.filasPorLineaDia });
  const acciones: AccionUrgencia[] = [];
  const top = candidatas.find((c) => !c.cambioFormatoRequerido) ?? candidatas[0];
  if (top) {
    const horas = u.hl / top.rateHlH;
    acciones.push({
      id: `iq-reprogramar-${top.linea}`,
      tipo: 'reprogramar',
      prioridad: 1,
      titulo: `Reproducir ${u.hl.toLocaleString('es-ES')} Hl en L${top.linea}`,
      descripcion: top.cambioFormatoRequerido
        ? `No hay hueco sin cambio de formato. L${top.linea} es la mejor opción (${pctStr(top.oeeAlcanzable)}); coordinar cambio en la próxima parada.`
        : `Insertar en L${top.linea} en el primer hueco compatible (mismo formato). ${horas.toFixed(1)} h al ritmo histórico (${pctStr(top.oeeAlcanzable)}).`,
      lineaDestino: top.linea,
      impactoHl: u.hl,
      impactoOeePts: Math.round(top.oeeAlcanzable * 100),
    });
  }
  candidatas.filter((c) => c !== top).slice(0, 2).forEach((c) => {
    acciones.push({
      id: `iq-alt-${c.linea}`,
      tipo: 'mover',
      prioridad: c.cambioFormatoRequerido ? 3 : 2,
      titulo: `Alternativa: L${c.linea}`,
      descripcion: `${c.cambioFormatoRequerido ? 'Requiere cambio de formato' : 'Mismo formato'}. Baseline ${pctStr(c.oeeAlcanzable)}.`,
      lineaDestino: c.linea,
      impactoOeePts: Math.round(c.oeeAlcanzable * 100),
    });
  });
  const resumen = `Incidencia de calidad: reproducir ${u.hl.toLocaleString('es-ES')} Hl de ${u.sku}${u.deadline ? ` antes de ${u.deadline}` : ''}.`;
  return { acciones, filas: [], resumen };
}

async function analizarFaltaMaterial(u: Urgencia, ctx: ContextoPlan | null): Promise<{ acciones: AccionUrgencia[]; filas: FilaPlan[]; resumen: string }> {
  if (!u.formato || !u.duracionHoras) return { acciones: [], filas: [], resumen: 'Faltan datos del material.' };
  const dias = rangoDias(u.dia ?? new Date().toISOString().slice(0, 10), u.duracionHoras);
  const acciones: AccionUrgencia[] = [];
  const filasAfectadas: FilaPlan[] = [];

  if (ctx) {
    for (const dia of dias) {
      for (const linea of [14, 17, 19] as Linea[]) {
        const filas = ctx.filasPorLineaDia.get(`${linea}|${dia}`) ?? [];
        for (const f of filas) {
          if (formatoDesdeCodigo(f.sku) === u.formato) filasAfectadas.push(f);
        }
      }
    }
  }

  // SKUs alternativos del otro formato con baseline alto por línea
  const otroFmt = u.formato === '1/3' ? '1/2' : '1/3';
  const baselines = await prisma.skuLineaBaseline.findMany({ include: { sku: true } });
  const alt = baselines
    .filter((b) => b.sku.formato === otroFmt)
    .sort((a, b) => b.oeeAlcanzable - a.oeeAlcanzable)
    .slice(0, 4);
  alt.forEach((b, i) => {
    acciones.push({
      id: `fm-${b.skuCodigo}-${b.linea}`,
      tipo: 'sustituir',
      prioridad: i === 0 ? 1 : i < 2 ? 2 : 3,
      titulo: `Sustituir por ${b.sku.nombre} en L${b.linea}`,
      descripcion: `Formato ${otroFmt} (no afectado) con baseline ${pctStr(b.oeeAlcanzable)}. Concentra producción mientras no haya material de ${u.formato}.`,
      lineaDestino: b.linea as Linea,
      impactoOeePts: Math.round(b.oeeAlcanzable * 100),
    });
  });

  const resumen = `Falta material formato ${u.formato} durante ${u.duracionHoras}h: ${filasAfectadas.length} OFs en riesgo, ${alt.length} sustitutos viables.`;
  return { acciones, filas: filasAfectadas, resumen };
}

// ---- Entrada pública ----

export async function analizarUrgencia(u: Urgencia, modo: ModoUrgencia): Promise<AnalisisUrgencia> {
  const ctx = modo === 'plan_activo' ? await cargarContextoPlan() : null;
  if (modo === 'plan_activo' && !ctx) {
    throw Object.assign(new Error('no_plan'), { code: 'no_plan' });
  }

  let result: { acciones: AccionUrgencia[]; filas: FilaPlan[]; resumen: string };
  switch (u.tipo) {
    case 'averia': result = await analizarAveria(u, ctx); break;
    case 'pedido_urgente': result = await analizarPedidoUrgente(u, ctx); break;
    case 'incidencia_calidad': result = await analizarIncidenciaCalidad(u, ctx); break;
    case 'falta_material': result = await analizarFaltaMaterial(u, ctx); break;
  }

  const hlEnRiesgo = result.filas.reduce((a, f) => a + f.hlPlan, 0);

  let oeePlanOriginal: number | undefined;
  let oeePlanPostIncidencia: number | undefined;
  let oeePlanRecomendado: number;

  if (ctx) {
    oeePlanOriginal = ctx.analisis.oeePrevistoPlan;
    const excl = new Set(result.filas.map((f) => `${f.linea}|${f.secuencia}`));
    oeePlanPostIncidencia = round3(reevaluarOEE(ctx.analisis.filas, excl, new Map()));
    // estimación con acciones: damos un boost ponderado por prioridad e impacto.
    const boost = result.acciones.reduce((acc, a) => {
      const w = a.prioridad === 1 ? 1 : a.prioridad === 2 ? 0.5 : 0.2;
      return acc + (a.impactoOeePts ?? 0) * w * (a.impactoHl ?? 1000);
    }, 0);
    const totalW = result.acciones.reduce((acc, a) => acc + (a.impactoHl ?? 1000), 0);
    const promedio = totalW ? boost / totalW : 0;
    const target = Math.min(0.92, oeePlanOriginal + Math.max(0, (promedio / 100 - 0.45) * 0.4));
    oeePlanRecomendado = round3(target);
  } else {
    const mejorPts = result.acciones[0]?.impactoOeePts ?? 50;
    oeePlanRecomendado = round3(Math.min(0.92, mejorPts / 100));
  }

  const gananciaPts = ctx
    ? Math.max(0, Math.round(((oeePlanRecomendado - (oeePlanPostIncidencia ?? 0)) * 100) * 10) / 10)
    : Math.round((oeePlanRecomendado - 0.5) * 100 * 10) / 10;

  return {
    modo,
    planId: ctx?.planId,
    planNombre: ctx?.planNombre,
    urgencia: u,
    resumen: result.resumen,
    kpis: {
      hlEnRiesgo,
      oeePlanOriginal,
      oeePlanPostIncidencia,
      oeePlanRecomendado,
      gananciaPts,
    },
    acciones: result.acciones.sort((a, b) => a.prioridad - b.prioridad),
    filasAfectadas: result.filas,
  };
}

function pctStr(n: number): string {
  return `${Math.round(n * 100)}%`;
}
