import { NextRequest, NextResponse } from 'next/server';
import { postMortemBrief } from '@/server/analysis';
import type { Linea } from '@/types';

export async function GET(req: NextRequest) {
  const semana = Number(req.nextUrl.searchParams.get('semana'));
  const anio = Number(req.nextUrl.searchParams.get('anio') ?? '2025');
  const lineaParam = req.nextUrl.searchParams.get('linea');
  if (!semana || !anio) {
    return NextResponse.json({ error: 'missing_params' }, { status: 400 });
  }
  const linea = lineaParam ? (Number(lineaParam) as Linea) : undefined;
  const data = await postMortemBrief(semana, anio, linea);
  return NextResponse.json(data);
}
