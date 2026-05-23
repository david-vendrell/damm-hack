import { NextResponse } from 'next/server';
import { getObservabilidad } from '@/server/observabilidad';

const LINEAS = new Set([14, 17, 19]);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const anio = url.searchParams.get('anio');
  const linea = url.searchParams.get('linea');

  const parsedLinea = linea ? Number(linea) : undefined;

  const data = await getObservabilidad({
    anio: anio ? Number(anio) : undefined,
    linea:
      parsedLinea && LINEAS.has(parsedLinea)
        ? (parsedLinea as 14 | 17 | 19)
        : undefined,
    marca: url.searchParams.get('marca') ?? undefined,
    formato: url.searchParams.get('formato') ?? undefined,
    canal: url.searchParams.get('canal') ?? undefined,
  });

  return NextResponse.json(data);
}
