// Server-side LineWise model proxy.
//
// Strategy (v2): call the local Python sidecar first (fast, no network,
// no auth), fall back to the HF Space when the sidecar is down. This
// matches what the planner actually wants at the demo: a single click,
// answer in 3-8s, no token management, works offline.
//
// Local sidecar URL is configurable via LINEWISE_URL env var (default
// http://localhost:8001). See scripts/local_model_server.py.
//
// HF Space fallback uses @gradio/client with HF_TOKEN. Returns null
// when both paths fail — caller falls back to heuristic.

import { Client } from '@gradio/client';

const LOCAL_URL = process.env.LINEWISE_URL ?? 'http://localhost:8001';
const SPACE_ID = 'marcaguilar/linewise-demo';
const HF_TOKEN = process.env.HF_TOKEN;
const LOCAL_TIMEOUT_MS = 120_000;     // local model: max 2 min per request

export interface LineWiseRawResult {
  summary_md: string;
  day_tbl: GradioDataframe;
  line_tbl: GradioDataframe;
  swap_tbl: GradioDataframe;
  /** Per-OF prediction table from /predict. ONLY populated when calling the
   *  local sidecar (which runs predict in addition to optimize_v3). When the
   *  HF Space served the call, this is undefined and per-OF verdicts fall back
   *  to the heuristic.  Columns: linea, sku, marca, fecha, turno, p10, p50, p90,
   *  confidence, feasible, feas_reason. */
  blocks_tbl?: GradioDataframe;
  latencyMs: number;
  via: 'local' | 'hf_space';
}

export interface GradioDataframe {
  headers: string[];
  data: (string | number | boolean | null)[][];
  metadata?: { dtype?: string[] };
}

interface CallOpts {
  aggressive?: boolean;
  outages?: unknown[];
  priority_ofs?: unknown[];
  replan_from_ts?: string;
}

/**
 * Call /optimize_v3 on whichever backend is reachable. Tries the local
 * sidecar first (fast path), falls back to HF Space. Returns null when
 * both fail — the caller must fall back to the heuristic path.
 */
export async function callLineWise(
  fileBuffer: Buffer,
  fileName: string,
  opts: CallOpts = {},
): Promise<LineWiseRawResult | null> {
  // ---- Local sidecar (fast path) ----
  const local = await callLocal(fileBuffer, fileName, opts).catch(() => null);
  if (local) return local;

  // ---- HF Space fallback ----
  if (HF_TOKEN) {
    const hf = await callHfSpace(fileBuffer, fileName, opts).catch(() => null);
    if (hf) return hf;
  }
  return null;
}


/* ─────────────────────────── Local sidecar ─────────────────────────── */

async function callLocal(
  fileBuffer: Buffer,
  fileName: string,
  opts: CallOpts,
): Promise<LineWiseRawResult | null> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCAL_TIMEOUT_MS);
  try {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(fileBuffer)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    form.append('file', blob, fileName);
    form.append('aggressive', String(opts.aggressive ?? false));
    form.append('outages_json', opts.outages ? JSON.stringify(opts.outages) : '');
    form.append('priority_ofs_json', opts.priority_ofs ? JSON.stringify(opts.priority_ofs) : '');
    form.append('replan_from_ts', opts.replan_from_ts ?? '');

    const resp = await fetch(`${LOCAL_URL}/optimize_v3`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    if (!resp.ok) {
      console.warn(`[linewise] local sidecar returned ${resp.status}`);
      return null;
    }
    const body = (await resp.json()) as { data: unknown[] };
    if (!Array.isArray(body.data) || body.data.length < 4) {
      console.warn('[linewise] local sidecar: unexpected response shape');
      return null;
    }
    const summary_md = String(body.data[0] ?? '');
    if (summary_md.startsWith('❌')) {
      console.warn('[linewise] local sidecar returned engine error:', summary_md.slice(0, 200));
      return null;
    }
    return {
      summary_md,
      day_tbl:    body.data[1] as GradioDataframe,
      line_tbl:   body.data[2] as GradioDataframe,
      swap_tbl:   body.data[3] as GradioDataframe,
      blocks_tbl: body.data[4] as GradioDataframe | undefined,
      latencyMs: Date.now() - t0,
      via: 'local',
    };
  } catch (err) {
    // Connection refused (sidecar not started) → fall through to HF
    return null;
  } finally {
    clearTimeout(timer);
  }
}


/* ─────────────────────────── HF Space fallback ─────────────────────────── */

async function callHfSpace(
  fileBuffer: Buffer,
  fileName: string,
  opts: CallOpts,
): Promise<LineWiseRawResult | null> {
  const t0 = Date.now();
  try {
    const client = await Client.connect(SPACE_ID, {
      token: HF_TOKEN as `hf_${string}`,
    });
    const blob = new Blob([new Uint8Array(fileBuffer)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const fileLike = Object.assign(blob, { name: fileName });

    const result = await client.predict('/optimize_v3', {
      file_obj: fileLike,
      aggressive: opts.aggressive ?? false,
      outages_json: opts.outages ? JSON.stringify(opts.outages) : '',
      priority_ofs_json: opts.priority_ofs ? JSON.stringify(opts.priority_ofs) : '',
      replan_from_ts: opts.replan_from_ts ?? '',
    });

    const data = result.data as unknown[];
    if (!Array.isArray(data) || data.length < 4) return null;
    return {
      summary_md: String(data[0] ?? ''),
      day_tbl:   data[1] as GradioDataframe,
      line_tbl:  data[2] as GradioDataframe,
      swap_tbl:  data[3] as GradioDataframe,
      latencyMs: Date.now() - t0,
      via: 'hf_space',
    };
  } catch (err) {
    console.warn('[linewise] HF Space call failed:', err);
    return null;
  }
}


/* ─────────────────────────────────────────────────────────────────────
 * Helpers to parse pieces of the response.
 * The contract documents the markdown format; we extract the structured
 * numbers from it with permissive regex so small format drift doesn't break.
 * ───────────────────────────────────────────────────────────────────── */

/** Extract factory-wide OEE values from the headline table in summary_md.
 *  `actual` is the model's baseline prediction for the input plan; `optimizado`
 *  is what the optimizer projects after applying every swap. The diff is the
 *  total ganancia attainable.
 *  Markdown row format: `| **Plan actual** | **47.5%** |` (note the closing **). */
export function parseHeadlineOee(md: string): { actual?: number; optimizado?: number } {
  const actual     = md.match(/Plan actual\*\*\s*\|\s*\*\*([\d.]+)\s*%\*\*/);
  const optimizado = md.match(/Plan optimizado\*\*\s*\|\s*\*\*([\d.]+)\s*%\*\*/);
  return {
    actual:     actual     ? Number(actual[1])     / 100 : undefined,
    optimizado: optimizado ? Number(optimizado[1]) / 100 : undefined,
  };
}

/** Extract Disp × Rend × Cal from the OEE decomposition table. Same `**...**`
 *  closing pattern as the headline. */
export function parseDecomposicion(md: string):
  | { disp: number; rend: number; cal: number }
  | undefined {
  const disp = md.match(/Disponibilidad\*\*\s*\|\s*\*\*([\d.]+)\s*%/);
  const rend = md.match(/Rendimiento\*\*\s*\|\s*\*\*([\d.]+)\s*%/);
  const cal  = md.match(/Calidad\*\*\s*\|\s*\*\*([\d.]+)\s*%/);
  if (!disp || !rend || !cal) return undefined;
  return {
    disp: Number(disp[1]) / 100,
    rend: Number(rend[1]) / 100,
    cal:  Number(cal[1])  / 100,
  };
}

export interface DayTableRow {
  dia: string;            // ISO yyyy-mm-dd
  hlDia: number;
  oeeActual: number;      // fraction
  oeeOptimizada: number;
  mantenimiento: string;
}

export function parseDayTable(df: GradioDataframe): DayTableRow[] {
  if (!df?.headers || !df?.data) return [];
  const idx = (name: string) => df.headers.findIndex((h) => h.includes(name));
  const iDia  = idx('Día');
  const iHl   = idx('HL');
  const iAct  = df.headers.findIndex((h) => h.startsWith('OEE actual'));
  const iOpt  = idx('OEE optimizada');
  const iMant = idx('Mantenimiento');
  if (iDia < 0 || iHl < 0 || iAct < 0 || iOpt < 0) return [];
  const out: DayTableRow[] = [];
  for (const row of df.data) {
    const diaRaw = String(row[iDia] ?? '');
    const dia = isoFromDayLabel(diaRaw);
    if (!dia) continue;
    out.push({
      dia,
      hlDia: numberFrom(row[iHl]),
      oeeActual:     pctFrom(row[iAct]),
      oeeOptimizada: pctFrom(row[iOpt]),
      mantenimiento: iMant >= 0 ? String(row[iMant] ?? '') : '',
    });
  }
  return out;
}

function isoFromDayLabel(label: string): string | null {
  const m = label.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function numberFrom(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[^\d.\-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function pctFrom(v: unknown): number {
  if (typeof v === 'string') {
    const m = v.match(/([\d.]+)\s*%/);
    if (m) return Number(m[1]) / 100;
  }
  return numberFrom(v);
}

/**
 * Parse the swap_tbl returned by /optimize_v3 into a normalised structure
 * the analysis layer can map onto our Recomendacion type.
 *
 * Tipo column tags (post-v1.3.0): `🔧 Obligatorio`, `💡 Opcional`,
 * `⭐ Prioritario`, `⚠️ Desplazado`, `↪️ Realojo`.
 *
 * Desde / Hacia format: `L17 / 2026-05-18 / N` (línea, ISO date, turno).
 *                       `—` when from/to is null (priority insert / eviction).
 */
export interface SwapRow {
  categoria: 'obligatorio' | 'opcional' | 'prioritario' | 'desplazado' | 'realojo';
  sku: string;
  fromLinea: 14 | 17 | 19 | null;
  fromDia: string | null;
  fromTurno: 'M' | 'T' | 'N' | null;
  toLinea: 14 | 17 | 19 | null;
  toDia: string | null;
  toTurno: 'M' | 'T' | 'N' | null;
  gananciaPts: number;
  deltaCambioMin: number;
  deltaMantHoras: number;
  agrupaFormato: boolean;
  descripcion: string;
}

/**
 * Per-OF predictions from /predict's blocks_tbl. Keyed by (línea, sku, día,
 * turno) so callers can look up each FilaPlan's predicted OEE individually
 * instead of falling back to the factory-wide per-día number.
 *
 * The Gradio table from predict() uses Title-Cased column names because
 * _block_table() in app.py calls `.title()` on each column. So 'linea' →
 * 'Linea', 'feas_reason' → 'Feas Reason'.  We look for both spellings.
 */
export interface BlockPrediction {
  linea: 14 | 17 | 19;
  sku: string;
  dia: string;            // ISO yyyy-mm-dd
  turno: 'M' | 'T' | 'N' | null;
  p10: number;
  p50: number;
  p90: number;
  confidence: string;
  feasible: boolean;
  feasReason: string | null;
}

export function parseBlocksTable(df?: GradioDataframe): BlockPrediction[] {
  if (!df?.headers || !df?.data) return [];
  const find = (name: string) =>
    df.headers.findIndex(
      (h) => h.toLowerCase().replace(/\s+/g, '_') === name.toLowerCase(),
    );
  const iLinea = find('linea');
  const iSku   = find('sku');
  const iDia   = find('fecha');
  const iTurno = find('turno');
  const iP10   = find('p10');
  const iP50   = find('p50');
  const iP90   = find('p90');
  const iConf  = find('confidence');
  const iFeas  = find('feasible');
  const iReas  = find('feas_reason');
  if (iLinea < 0 || iSku < 0 || iDia < 0 || iP50 < 0) return [];

  const out: BlockPrediction[] = [];
  for (const row of df.data) {
    const lineaNum = Number(row[iLinea]);
    if (!Number.isFinite(lineaNum)) continue;
    out.push({
      linea: lineaNum as 14 | 17 | 19,
      sku: String(row[iSku] ?? ''),
      dia: String(row[iDia] ?? '').slice(0, 10),
      turno: (row[iTurno] as 'M' | 'T' | 'N' | null) ?? null,
      p10: pctFrom(row[iP10]),
      p50: pctFrom(row[iP50]),
      p90: pctFrom(row[iP90]),
      confidence: String(row[iConf] ?? ''),
      feasible: row[iFeas] === true || String(row[iFeas]).toLowerCase() === 'true',
      feasReason: row[iReas] != null && row[iReas] !== ''
        ? String(row[iReas])
        : null,
    });
  }
  return out;
}

export function parseSwapTable(df: GradioDataframe): SwapRow[] {
  if (!df?.headers || !df?.data) return [];
  const find = (name: string) => df.headers.findIndex((h) => h.startsWith(name));
  const iTipo  = find('Tipo');
  const iSku   = find('SKU');
  const iFrom  = find('Desde');
  const iTo    = find('Hacia');
  const iOee   = find('ΔOEE');
  const iCamb  = find('Δ cambio');
  const iMant  = find('Δ mant');
  const iFmt   = find('Agrupa');
  const iDesc  = find('Descripción');

  const out: SwapRow[] = [];
  for (const row of df.data) {
    const tipoRaw = String(row[iTipo] ?? '');
    const cat = parseTipoCategoria(tipoRaw);
    if (!cat) continue;
    const from = parseSlotLabel(row[iFrom]);
    const to   = parseSlotLabel(row[iTo]);
    out.push({
      categoria: cat,
      sku: String(row[iSku] ?? ''),
      fromLinea: from.linea, fromDia: from.dia, fromTurno: from.turno,
      toLinea:   to.linea,   toDia:   to.dia,   toTurno:   to.turno,
      gananciaPts: numberFrom(row[iOee]),
      deltaCambioMin: numberFrom(row[iCamb]),
      deltaMantHoras: numberFrom(row[iMant]),
      agrupaFormato: String(row[iFmt] ?? '').toLowerCase() === 'sí',
      descripcion: String(row[iDesc] ?? ''),
    });
  }
  return out;
}

function parseTipoCategoria(s: string): SwapRow['categoria'] | null {
  if (s.includes('Obligatorio')) return 'obligatorio';
  if (s.includes('Opcional'))    return 'opcional';
  if (s.includes('Prioritario')) return 'prioritario';
  if (s.includes('Desplazado'))  return 'desplazado';
  if (s.includes('Realojo'))     return 'realojo';
  return null;
}

function parseSlotLabel(v: unknown): {
  linea: 14 | 17 | 19 | null;
  dia: string | null;
  turno: 'M' | 'T' | 'N' | null;
} {
  const s = String(v ?? '').trim();
  if (!s || s === '—') return { linea: null, dia: null, turno: null };
  const m = s.match(/L(\d{2})\s*\/\s*(\d{4}-\d{2}-\d{2})\s*\/\s*([MTN])/);
  if (!m) return { linea: null, dia: null, turno: null };
  return {
    linea: Number(m[1]) as 14 | 17 | 19,
    dia: m[2],
    turno: m[3] as 'M' | 'T' | 'N',
  };
}

export function parseBloqueosMant(dayRows: DayTableRow[]): {
  linea: 14 | 17 | 19;
  dia: string;
  turno: 'M' | 'T' | 'N';
  event: 'LIMPIEZA' | 'MANTENIMIENTO' | 'OUTAGE';
  reason: string;
}[] {
  const out: ReturnType<typeof parseBloqueosMant> = [];
  for (const r of dayRows) {
    if (!r.mantenimiento) continue;
    const segments = r.mantenimiento.split('·').map((s) => s.trim());
    for (const seg of segments) {
      const m = seg.match(/L(\d{2})\s+(LIMPIEZA|MANTENIMIENTO|OUTAGE)/i);
      if (!m) continue;
      const linea = Number(m[1]) as 14 | 17 | 19;
      const event = m[2].toUpperCase() as 'LIMPIEZA' | 'MANTENIMIENTO' | 'OUTAGE';
      out.push({
        linea, dia: r.dia, turno: 'M', event,
        reason: `${event} programada en L${linea} (${r.dia})`,
      });
      if (event === 'LIMPIEZA') {
        out.push({
          linea, dia: r.dia, turno: 'T', event,
          reason: `${event} programada en L${linea} (${r.dia}, overflow turno T)`,
        });
      }
    }
  }
  return out;
}
