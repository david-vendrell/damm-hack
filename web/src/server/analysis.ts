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
  AccionUrgencia,
  AnalisisPlan,
  AnalisisUrgencia,
  BloqueoMant,
  CategoriaRecomendacion,
  FilaPlan,
  Linea,
  ModoUrgencia,
  PlanRecomendado,
  PlanResumen,
  PostMortemResumen,
  Recomendacion,
  TipoCambio,
  Turno,
  Urgencia,
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
  // 1. Heuristic baseline (always runs — never blocks on the Space)
  const base = await analizarPlan(planId, nombre, items);

  // 2. Try the LineWise model in parallel with the heuristic
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

  // 3. Extract model headline + per-día numbers from the response
  const headline = parseHeadlineOee(lw.summary_md);
  const decomp   = parseDecomposicion(lw.summary_md);
  const dayRows  = parseDayTable(lw.day_tbl);
  const bloqueos = parseBloqueosMant(dayRows) as BloqueoMant[];

  // Total HL across all OFs in the plan (use heuristic baseline — same parsed file)
  const totalHl = base.filas.reduce((acc, f) => acc + f.hlPlan, 0);

  // 4. Augment each FilaPlan with model fields by matching (línea, día, sku).
  //    Per-OF predictions live only in the swap_log; here we approximate by
  //    distributing the per-día factory OEE proportionally to each OF and
  //    apply the model's verdict heuristic (cleaner mapping than today's
  //    heuristic predecirOEE → still based on model output).
  const dayIdx = new Map(dayRows.map((r) => [r.dia, r]));
  const filasAug: FilaPlan[] = base.filas.map((f) => {
    const dr = dayIdx.get(f.dia);
    // model p50 / p90 per OF: factory-wide for that día (better than per-línea due
    // to Simpson's paradox; per-OF would require the model's swap_log which we
    // can fetch later via /predict instead of /optimize_v3 if needed).
    const oeeP50 = dr?.oeeActual ?? f.oeePrevisto;
    const oeeP90 = dr?.oeeOptimizada ?? f.oeePrevisto;
    const oeeP10 = Math.max(0.1, oeeP50 - (oeeP90 - oeeP50));
    // Verdict from model OEE + tipoCambio (same rule as today but on real numbers)
    const veredicto = veredictoDe(oeeP50, f.tipoCambio, isOnBlock(f, bloqueos));
    const feasReason = matchFeasReason(f, bloqueos);
    return {
      ...f,
      oeePrevisto: round3(oeeP50),
      oeeP10: round3(oeeP10),
      oeeP90: round3(oeeP90),
      disp:   decomp ? round3(decomp.disp) : undefined,
      rend:   decomp ? round3(decomp.rend) : undefined,
      cal:    decomp ? round3(decomp.cal)  : undefined,
      veredicto,
      feasReason,
      // motivo: prefer the explicit feas_reason when present, otherwise keep
      // the heuristic narrative — both auditable.
      motivo: feasReason ?? f.motivo,
    };
  });

  // 5. Recompute banderas + headline numbers from the augmented rows
  const banderas = { evitar: 0, revisar: 0, procede: 0 };
  for (const f of filasAug) banderas[f.veredicto]++;
  const oeeP50Plan = headline.p50 ?? base.oeePrevistoPlan;
  const oeeP90Plan = headline.p90 ?? oeeP50Plan;

  // 6. Build the embedded PlanRecomendado from the optimizer's swap_log.
  //    `Plan actual` in summary_md is the model's baseline prediction;
  //    `Plan optimizado` is what the optimizer achieves after applying every
  //    swap. The diff = total ganancia. Avoids a second round-trip from the
  //    frontend to /api/planes/[id]/recomendaciones (which only has heuristics).
  const swapRows = parseSwapTable(lw.swap_tbl);
  const planRecomendado = buildPlanRecomendadoFromSwapLog(
    swapRows,
    oeeP50Plan,
    oeeP90Plan,
  );

  return {
    ...base,
    filas: filasAug,
    oeePrevistoPlan: round3(oeeP50Plan),
    banderas,
    oeeP10Plan: round3(Math.max(0.1, oeeP50Plan - (oeeP90Plan - oeeP50Plan))),
    oeeP90Plan: round3(oeeP90Plan),
    decomposicion: decomp,
    bloqueosMant: bloqueos,
    totalHl,
    meta: { source: 'linewise', via: lw.via, spaceLatencyMs: lw.latencyMs },
    planRecomendado,
  };
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
  return `Slot bloqueado: ${b.event} programada en L${b.linea} (${b.dia}, turno ${b.turno}) ${b.reason}`;
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
