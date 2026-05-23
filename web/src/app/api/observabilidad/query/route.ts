import { NextResponse } from 'next/server';
import { DIMENSIONS, MEASURES, resolveRange, runQuery } from '@/server/query';
import type {
  Aggregation,
  ChartConfig,
  DimensionKey,
  Filter,
  Granularity,
  MeasureKey,
} from '@/types';

function asDim(v: unknown): DimensionKey | undefined {
  return typeof v === 'string' && DIMENSIONS[v as DimensionKey] ? (v as DimensionKey) : undefined;
}

function asMeasure(v: unknown): MeasureKey | undefined {
  return typeof v === 'string' && MEASURES[v as MeasureKey] ? (v as MeasureKey) : undefined;
}

function asFilters(v: unknown): Filter[] {
  if (!Array.isArray(v)) return [];
  const out: Filter[] = [];
  for (const f of v) {
    if (f && typeof f === 'object') {
      const dim = asDim((f as Filter).dim);
      const values = Array.isArray((f as Filter).values)
        ? (f as Filter).values.filter((x) => typeof x === 'string')
        : [];
      if (dim && values.length) out.push({ dim, values });
    }
  }
  return out;
}

function shiftRange(from?: string, to?: string): { from?: string; to?: string } {
  if (!from || !to) return {};
  const f = new Date(from);
  const t = new Date(to);
  const days = Math.max(1, Math.round((t.getTime() - f.getTime()) / 86400000));
  const prevTo = new Date(f);
  prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setDate(prevFrom.getDate() - days);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(prevFrom), to: iso(prevTo) };
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Partial<ChartConfig> & {
    withPrevious?: boolean;
  };

  const measure = asMeasure(body.measure);
  if (!measure) return NextResponse.json({ error: 'invalid_measure' }, { status: 400 });

  const aggregation = (body.aggregation as Aggregation) || MEASURES[measure].defaultAgg;
  if (!MEASURES[measure].allowedAggs.includes(aggregation)) {
    return NextResponse.json({ error: 'invalid_aggregation' }, { status: 400 });
  }

  const dimension = asDim(body.dimension);
  const breakdown = asDim(body.breakdown);
  const filters = asFilters(body.filters);
  const range = resolveRange(body.dateRange ?? {});
  const topN = typeof body.topN === 'number' && body.topN > 0 ? Math.floor(body.topN) : undefined;
  const previousRange = body.withPrevious ? shiftRange(range.from, range.to) : undefined;

  const data = await runQuery({
    measure,
    aggregation,
    dimension,
    breakdown,
    filters,
    dateFrom: range.from,
    dateTo: range.to,
    topN,
    previousRange,
  });
  return NextResponse.json(data);
}

// Legacy GET kept for backward compatibility with existing dashboard widgets.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const measure = asMeasure(url.searchParams.get('measure'));
  const dimension = asDim(url.searchParams.get('dimension'));
  if (!measure) return NextResponse.json({ error: 'invalid_measure' }, { status: 400 });
  if (!dimension) return NextResponse.json({ error: 'invalid_dimension' }, { status: 400 });
  const breakdown = asDim(url.searchParams.get('breakdown'));

  const anio = url.searchParams.get('anio');
  const linea = url.searchParams.get('linea');
  const marca = url.searchParams.get('marca');
  const formato = url.searchParams.get('formato');
  const canal = url.searchParams.get('canal');
  const filters: Filter[] = [];
  const dateFrom = anio ? `${anio}-01-01` : undefined;
  const dateTo = anio ? `${anio}-12-31` : undefined;
  if (linea) filters.push({ dim: 'linea', values: [linea] });
  if (marca) filters.push({ dim: 'marca', values: [marca] });
  if (formato) filters.push({ dim: 'formato', values: [formato] });
  if (canal) filters.push({ dim: 'canal', values: [canal] });

  const data = await runQuery({
    measure,
    dimension,
    breakdown,
    filters: filters.filter((f) => f.values.length),
    dateFrom,
    dateTo,
  });
  return NextResponse.json(data);
}
