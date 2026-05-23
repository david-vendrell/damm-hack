import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import type { ChartConfig, SavedChartDTO } from '@/types';

function toDto(c: {
  id: string;
  nombre: string;
  config: string;
  creadoEn: Date;
  actualEn: Date;
}): SavedChartDTO {
  let parsed: ChartConfig;
  try {
    parsed = JSON.parse(c.config) as ChartConfig;
  } catch {
    parsed = {
      measure: 'oee',
      aggregation: 'avg',
      filters: [],
      dateRange: {},
      granularity: 'month',
      viz: 'auto',
    };
  }
  return {
    id: c.id,
    nombre: c.nombre,
    config: parsed,
    creadoEn: c.creadoEn.toISOString(),
    actualEn: c.actualEn.toISOString(),
  };
}

export async function GET() {
  const rows = await prisma.savedChart.findMany({ orderBy: { creadoEn: 'desc' } });
  return NextResponse.json({ charts: rows.map(toDto) });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    nombre?: string;
    config?: ChartConfig;
  };
  const nombre = (body.nombre ?? '').trim();
  if (!nombre) return NextResponse.json({ error: 'nombre_required' }, { status: 400 });
  if (!body.config) return NextResponse.json({ error: 'config_required' }, { status: 400 });
  const row = await prisma.savedChart.create({
    data: { nombre, config: JSON.stringify(body.config) },
  });
  return NextResponse.json(toDto(row));
}
