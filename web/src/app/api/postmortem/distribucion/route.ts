import { NextRequest, NextResponse } from 'next/server';
import { postMortemDistribucion } from '@/server/analysis';
import type { Linea } from '@/types';

export async function GET(req: NextRequest) {
  const sku = req.nextUrl.searchParams.get('sku');
  const linea = req.nextUrl.searchParams.get('linea');
  if (!sku || !linea) return NextResponse.json({ error: 'missing_params' }, { status: 400 });
  const data = await postMortemDistribucion(sku, Number(linea) as Linea);
  if (!data) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json(data);
}
