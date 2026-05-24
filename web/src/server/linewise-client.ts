// Thin server-side wrapper around the LineWise HF Space (gradio).
// Contract: docs/FRONTEND_API_CONTRACT.md v1.3.0
//
// Returns the raw 4-tuple from /optimize_v3 plus a normalised view of
// the per-block predictions (extracted from the swap log + day table +
// summary_md markdown). The caller (analizarPlanConLineWise) maps that
// into our AnalisisPlan / FilaPlan shape.
//
// Never throws on Space failure: the caller falls back to heuristics.

import { Client } from '@gradio/client';

const SPACE_ID = 'marcaguilar/linewise-demo';
const ENV_TOKEN = process.env.HF_TOKEN;

export interface LineWiseRawResult {
  summary_md: string;
  day_tbl: GradioDataframe;
  line_tbl: GradioDataframe;
  swap_tbl: GradioDataframe;
  latencyMs: number;
}

export interface GradioDataframe {
  headers: string[];
  data: (string | number | boolean | null)[][];
  metadata?: { dtype?: string[] };
}

/**
 * Call /optimize_v3 on the LineWise HF Space.
 * Returns null when HF_TOKEN is missing OR the Space is unreachable —
 * the caller must fall back to the heuristic path.
 */
export async function callLineWise(
  fileBuffer: Buffer,
  fileName: string,
  opts: {
    aggressive?: boolean;
    outages?: unknown[];
    priority_ofs?: unknown[];
    replan_from_ts?: string;
  } = {},
): Promise<LineWiseRawResult | null> {
  if (!ENV_TOKEN) {
    console.warn('[linewise] HF_TOKEN not set; skipping Space call');
    return null;
  }
  const t0 = Date.now();
  try {
    const client = await Client.connect(SPACE_ID, {
      token: ENV_TOKEN as `hf_${string}`,
    });
    // @gradio/client accepts a Blob for file inputs in Node 18+ (global Blob)
    const blob = new Blob([new Uint8Array(fileBuffer)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    // Add the original filename via the wrapper (Gradio uses .name internally)
    const fileLike = Object.assign(blob, { name: fileName });

    const result = await client.predict('/optimize_v3', {
      file_obj: fileLike,
      aggressive: opts.aggressive ?? false,
      outages_json: opts.outages ? JSON.stringify(opts.outages) : '',
      priority_ofs_json: opts.priority_ofs ? JSON.stringify(opts.priority_ofs) : '',
      replan_from_ts: opts.replan_from_ts ?? '',
    });

    const data = result.data as unknown[];
    if (!Array.isArray(data) || data.length < 4) {
      console.warn('[linewise] unexpected response shape from /optimize_v3');
      return null;
    }
    return {
      summary_md: String(data[0] ?? ''),
      day_tbl:   data[1] as GradioDataframe,
      line_tbl:  data[2] as GradioDataframe,
      swap_tbl:  data[3] as GradioDataframe,
      latencyMs: Date.now() - t0,
    };
  } catch (err) {
    console.warn('[linewise] Space call failed, falling back to heuristic:', err);
    return null;
  }
}

/* -----------------------------------------------------------------------
 * Helpers to parse pieces of the response.
 * The contract documents the markdown format; we extract the structured
 * numbers from it with permissive regex so small format drift doesn't break.
 * ----------------------------------------------------------------------- */

/** Extract factory-wide OEE pXX values from the headline table in summary_md. */
export function parseHeadlineOee(md: string): { p50?: number; p90?: number } {
  // Both "Plan actual" and "Plan optimizado" rows; we use Plan actual (= baseline prediction)
  const p50 = md.match(/Plan actual\s*\|\s*\*\*([\d.]+)\s*%\*\*/);
  const p90 = md.match(/Plan optimizado\s*\|\s*\*\*([\d.]+)\s*%\*\*/);
  return {
    p50: p50 ? Number(p50[1]) / 100 : undefined,
    p90: p90 ? Number(p90[1]) / 100 : undefined,
  };
}

/** Extract Disp × Rend × Cal from the OEE decomposition table. */
export function parseDecomposicion(md: string):
  | { disp: number; rend: number; cal: number }
  | undefined {
  const disp = md.match(/Disponibilidad\s*\|\s*\*\*([\d.]+)\s*%/);
  const rend = md.match(/Rendimiento\s*\|\s*\*\*([\d.]+)\s*%/);
  const cal  = md.match(/Calidad\s*\|\s*\*\*([\d.]+)\s*%/);
  if (!disp || !rend || !cal) return undefined;
  return {
    disp: Number(disp[1]) / 100,
    rend: Number(rend[1]) / 100,
    cal:  Number(cal[1])  / 100,
  };
}

/**
 * Parse the per-día factory table into a map keyed by ISO date.
 * Columns observed (v1.3.0): Día · Bloques (act→opt) · HL del día · OEE actual (pXX) ·
 *                            OEE optimizada · Δ pts · Mantenimiento
 */
export interface DayTableRow {
  dia: string;            // ISO yyyy-mm-dd
  hlDia: number;
  oeeActual: number;      // fraction
  oeeOptimizada: number;
  mantenimiento: string;  // raw string from the cell (may be empty or contain 🛠 ... LIMPIEZA ...)
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

/** "Lun 2026-05-25" → "2026-05-25"  */
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
 * Parse mantenimiento badges from the per-day table into a flat list of
 * (linea, dia, event) tuples. The badge format is "🛠 L17 LIMPIEZA · L19 MANTENIMIENTO".
 * Turno is unknown from this view; we default to 'M' (CF Prat events start in mañana).
 */
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
    // e.g. "🛠 L17 LIMPIEZA · L19 LIMPIEZA"
    const segments = r.mantenimiento.split('·').map((s) => s.trim());
    for (const seg of segments) {
      const m = seg.match(/L(\d{2})\s+(LIMPIEZA|MANTENIMIENTO|OUTAGE)/i);
      if (!m) continue;
      const linea = Number(m[1]) as 14 | 17 | 19;
      const event = m[2].toUpperCase() as 'LIMPIEZA' | 'MANTENIMIENTO' | 'OUTAGE';
      // LIMPIEZA spans M + T (per CF Prat 11.5h); MANTENIMIENTO + OUTAGE just M.
      // We emit per-turno entries downstream by enumerating turnos in the caller.
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
