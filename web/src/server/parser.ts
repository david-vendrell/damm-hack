// Parsers de los dos formatos de Excel que Damm sube:
//   · Diario Hl Planif:       cross-tab por día (bloques de 12 columnas)
//   · Planificado producciones: columnar per-shift (Material / Tren / Fecha
//                               / Turno / Cntd plan / etc.)
//
// El dispatcher parsePlanningExcel() detecta cuál es el formato según las
// columnas presentes en la primera hoja y devuelve la lista unificada.
import * as XLSX from 'xlsx';

export interface ParsedItem {
  linea: number;
  sku: string;
  dia: string;        // ISO yyyy-mm-dd
  hlPlan: number;     // redondeado (en HL para Diario Hl; en CAJ para Planificado — proxy de cantidad)
}

const HEADER_PREFIX_DIA = 'Programa Prod.';

function parseDdMmYyyy(s: string): string | null {
  // "18/05/2025" → "2025-05-18"
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function detectarLineaDesdeTren(s: string): number | null {
  const m = s.match(/Tren\s+(\d+)/);
  return m ? Number(m[1]) : null;
}

function isFilaSku(celda: string): boolean {
  // SKUs vienen muy indentados y son códigos sin espacios largos.
  const trimmed = celda.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('-')) return false;          // jerarquías "-  Centro" / "    -  Tren"
  if (trimmed.toLowerCase().startsWith('total')) return false;
  if (trimmed.toLowerCase().startsWith('centro')) return false;
  // Códigos típicos: empiezan por letra y mezclan letras+dígitos sin espacios
  return /^[A-Z0-9][A-Z0-9_\-]{2,}$/i.test(trimmed);
}

/* ─────────────────────────── Dispatcher ─────────────────────────── */

/**
 * Auto-detecta el formato del Excel y devuelve la lista de items.
 * Soporta Diario Hl Planif (cross-tab por día) y Planificado producciones
 * (columnar per-shift). Se intentan ambos parsers; gana el que devuelva
 * filas. Si los dos fallan, devuelve []. */
export function parsePlanningExcel(buffer: ArrayBuffer | Buffer): ParsedItem[] {
  // Sniff the first sheet to decide the format
  const wb = XLSX.read(buffer, { type: buffer instanceof Buffer ? 'buffer' : 'array' });
  const firstSheet = wb.Sheets[wb.SheetNames[0]];
  const headerRow = XLSX.utils.sheet_to_json<unknown[]>(firstSheet, {
    header: 1, defval: null, raw: true, range: 0,
  })[0] ?? [];
  const headerStrs = headerRow
    .filter((v): v is string => typeof v === 'string')
    .map((s) => s.toLowerCase());

  const looksPlanificado = headerStrs.some((h) => h === 'material')
    && headerStrs.some((h) => h.startsWith('tren'))
    && headerStrs.some((h) => h.includes('definici') && h.includes('turno'));
  const looksDiarioHl = headerStrs.some((h) => h.startsWith('programa prod'));

  if (looksPlanificado) {
    const out = parsePlanificado(buffer);
    if (out.length) return out;
  }
  if (looksDiarioHl) {
    const out = parseDiarioHl(buffer);
    if (out.length) return out;
  }
  // Last resort: try both blindly
  const a = parseDiarioHl(buffer);
  if (a.length) return a;
  return parsePlanificado(buffer);
}


/* ─────────────────────────── Planificado parser ─────────────────────────── */

const PLANIFICADO_COLS = {
  material: ['material'],
  tren:     ['tren'],
  fecha:    ['fecha ini.', 'fecha_ini', 'fecha ini'],
  turno:    ['definición de turno', 'definicion de turno'],
  cntd:     ['cntd plan', 'cntd_plan', 'cntd jda', 'cntd_jda'],
};

function findCol(headers: string[], candidates: string[]): number {
  const norm = headers.map((h) => (h ?? '').toString().trim().toLowerCase());
  for (const want of candidates) {
    const i = norm.indexOf(want.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

function excelDateToIso(v: unknown): string | null {
  if (v == null || v === '') return null;
  // Strings already in YYYY-MM-DD or similar
  if (typeof v === 'string') {
    const m = v.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    const m2 = v.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m2) {
      const dd = m2[1].padStart(2, '0');
      const mm = m2[2].padStart(2, '0');
      return `${m2[3]}-${mm}-${dd}`;
    }
    return null;
  }
  // Native Date (XLSX cellDates: true would produce these)
  if (v instanceof Date) {
    return v.toISOString().slice(0, 10);
  }
  // Excel serial (number of days since 1899-12-30)
  if (typeof v === 'number' && Number.isFinite(v)) {
    const utc = new Date(Date.UTC(1899, 11, 30) + v * 86_400_000);
    return utc.toISOString().slice(0, 10);
  }
  return null;
}

export function parsePlanificado(buffer: ArrayBuffer | Buffer): ParsedItem[] {
  const wb = XLSX.read(buffer, {
    type: buffer instanceof Buffer ? 'buffer' : 'array',
    cellDates: true,
  });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1, defval: null, raw: true,
  });
  if (!rows.length) return [];

  const headers = rows[0].map((v) => (v ?? '').toString());
  const iMat   = findCol(headers, PLANIFICADO_COLS.material);
  const iTren  = findCol(headers, PLANIFICADO_COLS.tren);
  const iFecha = findCol(headers, PLANIFICADO_COLS.fecha);
  const iTurno = findCol(headers, PLANIFICADO_COLS.turno);
  const iCntd  = findCol(headers, PLANIFICADO_COLS.cntd);
  if (iMat < 0 || iTren < 0 || iFecha < 0 || iCntd < 0) return [];

  const out: ParsedItem[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const sku = row[iMat];
    if (typeof sku !== 'string' || !sku.trim()) continue;
    const tren = Number(row[iTren]);
    if (!Number.isFinite(tren) || ![14, 17, 19].includes(tren)) continue;
    const dia = excelDateToIso(row[iFecha]);
    if (!dia) continue;
    const cntdRaw = row[iCntd];
    const cntd = typeof cntdRaw === 'number' ? cntdRaw : Number(cntdRaw);
    if (!Number.isFinite(cntd) || cntd <= 0) continue;
    out.push({
      linea: tren,
      sku: sku.trim(),
      dia,
      // Planificado is in CAJ (cajas) not HL. We pass the number through as
      // the quantity proxy — same convention the Python engine uses. The
      // model handles both unit systems internally because it learns from
      // historical OFs that carry both.
      hlPlan: Math.round(cntd),
    });
  }
  return out;
}


/* ─────────────────────────── Diario Hl parser (existing) ─────────────────────────── */

/**
 * Devuelve filas {linea, sku, dia, hlPlan}. Solo entradas con hlPlan > 0.
 */
export function parseDiarioHl(buffer: ArrayBuffer | Buffer): ParsedItem[] {
  const wb = XLSX.read(buffer, { type: buffer instanceof Buffer ? 'buffer' : 'array' });
  // Hoja "Diario Hl" o la primera disponible.
  const sheetName = wb.SheetNames.find((n) => n.toLowerCase().includes('diario')) ?? wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, raw: true }) as unknown[][];
  if (!rows.length) return [];

  // Detecta los índices de columna que son "Programa Prod." de cada bloque-día.
  const header = rows[0] ?? [];
  const bloques: { col: number; dia: string }[] = [];
  for (let c = 0; c < header.length; c++) {
    const cell = header[c];
    if (typeof cell !== 'string') continue;
    if (cell.startsWith(HEADER_PREFIX_DIA)) {
      // Multilínea: "Programa Prod.\n18/05/2025" o "Programa Prod.\nTOTAL"
      const rest = cell.replace(HEADER_PREFIX_DIA, '').trim();
      const dia = parseDdMmYyyy(rest);
      if (dia) bloques.push({ col: c, dia });
      // si es TOTAL lo ignoramos
    }
  }
  if (!bloques.length) return [];

  const out: ParsedItem[] = [];
  let lineaActual: number | null = null;

  // Empezamos desde fila 1 (saltamos cabecera)
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const celdaA = (row[0] ?? '') as unknown;
    if (typeof celdaA !== 'string') continue;
    const raw = celdaA;
    const tren = detectarLineaDesdeTren(raw);
    if (tren) {
      lineaActual = tren;
      continue;
    }
    if (raw.trim().toLowerCase().startsWith('total tren')) continue;
    if (!isFilaSku(raw)) continue;
    if (lineaActual === null) continue;
    const sku = raw.trim();
    for (const b of bloques) {
      const v = row[b.col];
      if (v == null || v === '') continue;
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n) || n <= 0) continue;
      out.push({ linea: lineaActual, sku, dia: b.dia, hlPlan: Math.round(n) });
    }
  }
  return out;
}
