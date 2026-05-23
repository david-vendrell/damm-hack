/**
 * LineWise ingest: reads the real Damm Excel files from `Repte operacions/`,
 * cleans and joins them, and (re)populates the `OfHecho` table.
 *
 * Run: `npm run ingest` from `web/`.
 * Override the data directory with `DATA_DIR=/abs/path npm run ingest`.
 */
import * as XLSX from 'xlsx';
import path from 'node:path';
import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DATA_DIR =
  process.env.DATA_DIR ?? path.resolve(process.cwd(), '..', 'Repte operacions');

const FILES = {
  oee: 'OEE 14_17_19_ 2025.xlsx',
  volumen: 'Volumen 14_17_19_ 2025.xlsx',
  tiempo: 'Tiempo 14_17_19_ 2025.xlsx',
  cambios: 'Cambios 14_17_19_ 2025.xlsx',
  mantto: 'Mantenimiento 14_17_19_ 2025.xlsx',
} as const;

type Row = Record<string, unknown>;

function readSheet(file: string): Row[] {
  const full = path.join(DATA_DIR, file);
  if (!fs.existsSync(full)) throw new Error(`Excel not found: ${full}`);
  const wb = XLSX.readFile(full);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Row>(ws, { defval: null });
  if (rows.length === 0) throw new Error(`Excel is empty: ${file}`);
  return rows;
}

function requireCols(file: string, sample: Row, cols: string[]): void {
  for (const c of cols) {
    if (!(c in sample)) throw new Error(`Column "${c}" missing in ${file}`);
  }
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(n: number | null, decimals = 4): number | null {
  if (n === null) return null;
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

function parseExcelDate(serial: unknown): Date | null {
  if (serial === null || serial === undefined || serial === '') return null;
  if (typeof serial === 'number') {
    const d = XLSX.SSF.parse_date_code(serial);
    if (!d) return null;
    return new Date(Date.UTC(d.y, d.m - 1, d.d, d.H ?? 0, d.M ?? 0, Math.floor(d.S ?? 0)));
  }
  const d = new Date(String(serial));
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function derivarFormato(tipoEnvase: string | null): string | null {
  if (!tipoEnvase) return null;
  const m = tipoEnvase.match(/(\d+\/\d+)/);
  return m ? m[1] : 'OTRO';
}

function derivarCanal(canalRaw: string | null): string | null {
  if (!canalRaw) return null;
  // "Canal distrib.MARCA" → "MARCA"; "Canal distrib.MDD" → "MDD"
  const m = canalRaw.match(/Canal\s*distrib\.?\s*(.+)$/i);
  return m ? m[1].trim() : canalRaw.trim();
}

function indexBy<T extends Row>(rows: T[], key: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const r of rows) {
    const k = r[key];
    if (k === null || k === undefined) continue;
    map.set(String(k), r);
  }
  return map;
}

async function main() {
  console.log(`[ingest] DATA_DIR=${DATA_DIR}`);

  // ---- READ ----
  const oeeRows = readSheet(FILES.oee);
  const volumenRows = readSheet(FILES.volumen);
  const tiempoRows = readSheet(FILES.tiempo);
  const cambiosRows = readSheet(FILES.cambios);
  const manttoRows = readSheet(FILES.mantto);

  requireCols(FILES.oee, oeeRows[0], [
    'OF',
    'Fecha Fin',
    'SKU',
    'TREN',
    'OEE',
    'Disponibilidad',
    'Rendimiento',
    'Cambios',
    'Marca',
    'Familia',
    'Tipo Envase',
    'Canal distribución',
  ]);
  requireCols(FILES.volumen, volumenRows[0], ['OF', 'UDS', 'HL']);
  requireCols(FILES.tiempo, tiempoRows[0], [
    'WOID',
    'MAQUINA',
    'H. Tot.',
    'PNP',
    'Limpieza',
    'IDLE',
    'Tiempo Máquina en Marcha',
    'Tiempo Máquina en paro',
    'Tiempo Baja Velocidad',
    'Tiempo Paro por Saturación a la Salida',
    'Tiempo Paro por Falta Producto',
    'Tiempo de CIP',
    'Tiempo de esterilización',
  ]);
  requireCols(FILES.cambios, cambiosRows[0], ['OF', 'Nº de Cambios']);
  requireCols(FILES.mantto, manttoRows[0], ['OF']);

  console.log(
    `[ingest] read   oee=${oeeRows.length} vol=${volumenRows.length} ` +
      `tiempo=${tiempoRows.length} cambios=${cambiosRows.length} mantto=${manttoRows.length}`,
  );

  // ---- INDEX ----
  const volumenByOf = indexBy(volumenRows, 'OF');
  // Tiempo: only LLENAD (master measurement machine), one row per OF
  const tiempoByOf = indexBy(
    tiempoRows.filter((r) => r.MAQUINA === 'LLENAD'),
    'WOID',
  );
  const cambiosByOf = indexBy(cambiosRows, 'OF');
  // Mantto map (in case there are duplicates we keep first)
  const manttoByOf = indexBy(manttoRows, 'OF');

  // ---- CLEAN + JOIN ----
  const stats = {
    total: oeeRows.length,
    excludedLimpieza: 0,
    excludedOeeRange: 0,
    excludedNoDate: 0,
    excludedNoTren: 0,
    excludedDupe: 0,
    excludedCambiosAtipicos: 0,
    kept: 0,
  };

  const seen = new Set<string>();
  const records: Array<Parameters<typeof prisma.ofHecho.create>[0]['data']> = [];

  for (const r of oeeRows) {
    const sku = r.SKU as string | null;
    if (sku === 'LIMPIEZA') {
      stats.excludedLimpieza++;
      continue;
    }

    const oee = num(r.OEE);
    if (oee === null || oee <= 0 || oee > 1) {
      stats.excludedOeeRange++;
      continue;
    }

    const fechaFin = parseExcelDate(r['Fecha Fin']);
    if (!fechaFin) {
      stats.excludedNoDate++;
      continue;
    }

    const linea = parseInt(String(r.TREN), 10);
    if (!Number.isFinite(linea) || ![14, 17, 19].includes(linea)) {
      stats.excludedNoTren++;
      continue;
    }

    const of = String(r.OF);
    if (seen.has(of)) {
      stats.excludedDupe++;
      continue;
    }
    seen.add(of);

    const vol = volumenByOf.get(of);
    const tie = tiempoByOf.get(of);
    const cam = cambiosByOf.get(of);
    void manttoByOf.get(of); // currently unused but kept for future fiability KPIs

    const nCambiosRaw = cam ? num(cam['Nº de Cambios']) : null;
    let tieneCambio = String(r.Cambios ?? '').toUpperCase() === 'SI';
    if (nCambiosRaw !== null && nCambiosRaw > 50) {
      stats.excludedCambiosAtipicos++;
      tieneCambio = false;
    }

    const tipoEnvase = (r['Tipo Envase'] as string | null) ?? null;

    records.push({
      of,
      fechaFin,
      anio: fechaFin.getUTCFullYear(),
      mes: fechaFin.getUTCMonth() + 1,
      semanaIso: isoWeek(fechaFin),
      linea,
      sku: sku ?? '',
      marca: (r.Marca as string | null) ?? null,
      familia: (r.Familia as string | null) ?? null,
      tipoEnvase,
      formato: derivarFormato(tipoEnvase),
      canal: derivarCanal((r['Canal distribución'] as string | null) ?? null),
      oee: round(oee)!,
      disp: round(num(r.Disponibilidad)) ?? 0,
      rend: round(num(r.Rendimiento)) ?? 0,
      inef: round(num(r.Ineficiencia)),
      hl: round(vol ? num(vol.HL) : null) ?? 0,
      uds: round(vol ? num(vol.UDS) : null) ?? 0,
      tieneCambio,
      hTotales: round(tie ? num(tie['H. Tot.']) : null),
      hMarcha: round(tie ? num(tie['Tiempo Máquina en Marcha']) : null),
      hParo: round(tie ? num(tie['Tiempo Máquina en paro']) : null),
      hPnp: round(tie ? num(tie['PNP']) : null),
      hLimpieza: round(tie ? num(tie['Limpieza']) : null),
      hIdle: round(tie ? num(tie['IDLE']) : null),
      hBajaVelocidad: round(tie ? num(tie['Tiempo Baja Velocidad']) : null),
      hSaturacionSal: round(tie ? num(tie['Tiempo Paro por Saturación a la Salida']) : null),
      hFaltaProducto: round(tie ? num(tie['Tiempo Paro por Falta Producto']) : null),
      hCip: round(tie ? num(tie['Tiempo de CIP']) : null),
      hEsterilizacion: round(tie ? num(tie['Tiempo de esterilización']) : null),
    });

    stats.kept++;
  }

  console.log('[ingest] cleaning stats:', stats);

  // ---- WRITE ----
  console.log('[ingest] truncating OfHecho…');
  await prisma.ofHecho.deleteMany({});

  console.log(`[ingest] inserting ${records.length} rows…`);
  const BATCH = 500;
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    await prisma.ofHecho.createMany({ data: batch });
  }

  const finalCount = await prisma.ofHecho.count();
  console.log(`[ingest] done. OfHecho rows = ${finalCount}`);
}

main()
  .catch((e) => {
    console.error('[ingest] FAILED:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
