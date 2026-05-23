import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { parseDiarioHl } from '@/server/parser';
import { analizarPlan } from '@/server/analysis';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'missing_file' }, { status: 400 });
  }
  const buf = Buffer.from(await file.arrayBuffer());
  const parsed = parseDiarioHl(buf);
  if (!parsed.length) {
    return NextResponse.json({ error: 'empty_parse', detail: 'No se detectaron filas válidas en el Excel.' }, { status: 400 });
  }

  const plan = await prisma.plan.create({
    data: {
      nombre: file.name.replace(/\.xlsx$/i, ''),
      items: {
        create: parsed.map((p, i) => ({
          linea: p.linea,
          secuencia: i,
          dia: p.dia,
          sku: p.sku,
          hlPlan: p.hlPlan,
        })),
      },
    },
  });

  const analisis = await analizarPlan(plan.id, plan.nombre, parsed);
  return NextResponse.json(analisis);
}
