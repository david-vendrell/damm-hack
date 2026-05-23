import { NextRequest, NextResponse } from 'next/server';
import { recomendarPlan } from '@/server/analysis';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const data = await recomendarPlan(params.id);
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: 'plan_not_found' }, { status: 404 });
  }
}
