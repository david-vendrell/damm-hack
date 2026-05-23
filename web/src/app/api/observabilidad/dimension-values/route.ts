import { NextResponse } from 'next/server';
import { query } from '@/server/duck';
import { DIMENSIONS } from '@/server/query';
import type { DimensionKey } from '@/types';

const SUPPORTED: DimensionKey[] = [
  'linea',
  'formato',
  'marca',
  'familia',
  'tipoEnvase',
  'canal',
  'sku',
  'cambioPrincipal',
  'turno',
];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get('key') as DimensionKey | null;
  if (!key || !DIMENSIONS[key] || !SUPPORTED.includes(key)) {
    return NextResponse.json({ values: [] });
  }
  const expr = DIMENSIONS[key].sql;
  const sql = `
    SELECT DISTINCT ${expr} AS v
    FROM fact_runs r
    LEFT JOIN raw_oee o ON o.of = r.of
    WHERE ${expr} IS NOT NULL
    ORDER BY 1
    LIMIT 500
  `;
  try {
    const rows = await query<{ v: unknown }>(sql);
    const values = rows
      .map((r) => (r.v === null || r.v === undefined ? null : String(r.v)))
      .filter((v): v is string => v !== null && v !== '');
    return NextResponse.json({ key, values });
  } catch (err) {
    return NextResponse.json({ key, values: [], error: String(err) }, { status: 200 });
  }
}
