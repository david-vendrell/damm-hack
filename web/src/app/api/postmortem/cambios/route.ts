import { NextRequest, NextResponse } from 'next/server';
import { postMortemCambios } from '@/server/analysis';
import type { Linea } from '@/types';

export async function GET(req: NextRequest) {
  const linea = req.nextUrl.searchParams.get('linea');
  const l = linea ? (Number(linea) as Linea) : undefined;
  const data = await postMortemCambios(l);
  return NextResponse.json(data);
}
