import { NextRequest, NextResponse } from 'next/server';
import { postMortemWeekly } from '@/server/analysis';
import type { Linea } from '@/types';

export async function GET(req: NextRequest) {
  const lineaParam = req.nextUrl.searchParams.get('linea');
  const linea = lineaParam ? (Number(lineaParam) as Linea) : undefined;
  const data = await postMortemWeekly(linea);
  return NextResponse.json(data);
}
