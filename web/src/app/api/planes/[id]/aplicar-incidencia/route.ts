import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import type { AnalisisPlan } from '@/types';

export const runtime = 'nodejs';

/**
 * POST /api/planes/[id]/aplicar-incidencia
 * body: { analisis: AnalisisPlan }
 *
 * Overwrites the cached AnalisisPlan on the Plan row. The frontend already
 * has the new analisis from the /api/urgencias preview, so no recomputation
 * needed — we just persist. After this, /validar's /api/planes/latest/full
 * rehydration returns the post-incident plan.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: { id: string } },
) {
  const { id } = ctx.params;
  let body: { analisis?: AnalisisPlan };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 });
  }
  if (!body.analisis) {
    return NextResponse.json(
      { error: 'missing_analisis', detail: 'Falta el cuerpo { analisis: AnalisisPlan }.' },
      { status: 400 },
    );
  }
  try {
    await prisma.plan.update({
      where: { id },
      data: { analisisJson: JSON.stringify(body.analisis) },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'persist_failed', detail: (err as Error).message },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, planId: id });
}
