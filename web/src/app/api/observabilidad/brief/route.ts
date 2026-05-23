import { NextResponse } from 'next/server';
import { getBrief } from '@/server/brief';

const LINEAS = new Set([14, 17, 19]);
const TURNOS = new Set(['M', 'T', 'N']);
const PERIODOS = new Set(['today', 'wtd', 'mtd', 'ytd', 'last7', 'last30', 'custom']);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const lineaRaw = url.searchParams.get('linea');
  const linea = lineaRaw && LINEAS.has(Number(lineaRaw)) ? (Number(lineaRaw) as 14 | 17 | 19) : undefined;
  const turnoRaw = url.searchParams.get('turno');
  const turno = turnoRaw && TURNOS.has(turnoRaw) ? turnoRaw : undefined;
  const periodoRaw = url.searchParams.get('periodo') ?? 'mtd';
  const periodo = PERIODOS.has(periodoRaw) ? periodoRaw : 'mtd';

  const data = await getBrief({
    linea,
    turno,
    periodo,
    desde: url.searchParams.get('desde') ?? undefined,
    hasta: url.searchParams.get('hasta') ?? undefined,
  });

  return NextResponse.json(data);
}
