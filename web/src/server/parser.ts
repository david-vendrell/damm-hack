// Parser de Diario_Hl_Planif.xlsx. Formato pivote jerárquico con cabecera de
// bloques de 12 columnas por día.
import * as XLSX from 'xlsx';

export interface ParsedItem {
  linea: number;
  sku: string;
  dia: string;        // ISO yyyy-mm-dd
  hlPlan: number;     // redondeado
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
