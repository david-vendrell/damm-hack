import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { parsePlanningExcel } from '@/server/parser';
import { analizarPlanConLineWise } from '@/server/analysis';

export const runtime = 'nodejs';
// LineWise model on the HF Space can take up to ~90 s on a cold start; give
// the route enough budget to wait without timing out. Vercel limits this to
// 300 s on Pro plans; local dev (`next dev`) has no enforced cap.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'missing_file' }, { status: 400 });
  }
  const buf = Buffer.from(await file.arrayBuffer());
  // Auto-detects Diario Hl Planif vs Planificado producciones formats
  const parsed = parsePlanningExcel(buf);
  if (!parsed.length) {
    return NextResponse.json(
      {
        error: 'empty_parse',
        detail:
          'No se detectaron filas válidas. Comprueba que el Excel sea Diario Hl Planif ' +
          'o Planificado producciones (columnas: Material, Tren, Fecha ini., Definición ' +
          'de turno, Cntd plan).',
      },
      { status: 400 },
    );
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

  // Primary path: LineWise model on HF Space. Falls back to heuristics
  // transparently when HF_TOKEN is missing or the Space is offline. The
  // response always carries `meta.source` so the UI can surface either.
  const analisis = await analizarPlanConLineWise(
    plan.id,
    plan.nombre,
    parsed,
    buf,
    file.name,
  );
  return NextResponse.json(analisis);
}
