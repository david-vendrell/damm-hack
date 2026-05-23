import { NextResponse } from 'next/server';
import { obtenerPlanLatest } from '@/server/analysis';

export async function GET() {
  const data = await obtenerPlanLatest();
  if (!data) return NextResponse.json({ error: 'no_plan' }, { status: 404 });
  return NextResponse.json(data);
}
