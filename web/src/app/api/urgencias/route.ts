import { NextRequest, NextResponse } from 'next/server';
import { analizarUrgencia } from '@/server/analysis';
import type { ModoUrgencia, Urgencia } from '@/types';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { urgencia?: Urgencia; modo?: ModoUrgencia };
  if (!body.urgencia || !body.modo) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
  }
  try {
    const data = await analizarUrgencia(body.urgencia, body.modo);
    return NextResponse.json(data);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'no_plan') {
      return NextResponse.json({ error: 'no_plan', detail: 'No hay plan cargado. Sube uno en /validar o cambia a modo escenario libre.' }, { status: 409 });
    }
    throw e;
  }
}
