// Servicio de análisis. TODA la inteligencia vive aquí — heurística + DB hoy,
// modelo ML mañana. La UI nunca conoce la implementación: consume tipos.

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
  TipoCambio,
  Veredicto,
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
  const [skuRow, baseline, obs] = await Promise.all([
    prisma.sku.findUnique({ where: { codigo: sku } }),
    prisma.skuLineaBaseline.findUnique({ where: { skuCodigo_linea: { skuCodigo: sku, linea } } }),
    prisma.oeeObservacion.findMany({ where: { skuCodigo: sku, linea }, orderBy: { id: 'asc' } }),
  ]);
  if (!skuRow || !baseline) return null;
  return {
    sku,
    nombre: skuRow.nombre,
    linea,
    valoresOee: obs.map((o) => o.oee),
    mediana: baseline.oeeMediana,
    alcanzable: baseline.oeeAlcanzable,
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
