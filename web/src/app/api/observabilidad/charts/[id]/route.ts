import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import type { ChartConfig } from '@/types';

export async function PUT(req: Request, ctx: { params: { id: string } }) {
  const body = (await req.json().catch(() => ({}))) as {
    nombre?: string;
    config?: ChartConfig;
  };
  const data: { nombre?: string; config?: string } = {};
  if (typeof body.nombre === 'string' && body.nombre.trim()) data.nombre = body.nombre.trim();
  if (body.config) data.config = JSON.stringify(body.config);
  if (!Object.keys(data).length) {
    return NextResponse.json({ error: 'nothing_to_update' }, { status: 400 });
  }
  try {
    const row = await prisma.savedChart.update({ where: { id: ctx.params.id }, data });
    return NextResponse.json({ id: row.id });
  } catch {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
}

export async function DELETE(_req: Request, ctx: { params: { id: string } }) {
  try {
    await prisma.savedChart.delete({ where: { id: ctx.params.id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
}
