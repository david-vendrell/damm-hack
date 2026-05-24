import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';

export const runtime = 'nodejs';

/**
 * Returns the cached AnalisisPlan JSON for the most recently uploaded plan.
 * Used by /validar to rehydrate state when the user returns to the page
 * after navigating away. Avoids re-running the optimizer (~13 s).
 *
 *   200 → the parsed AnalisisPlan
 *   404 → no plans uploaded yet, or the latest plan has no cached analysis
 */
export async function GET() {
  const plan = await prisma.plan.findFirst({
    orderBy: { creadoEn: 'desc' },
    select: { id: true, analisisJson: true },
  });
  if (!plan || !plan.analisisJson) {
    return NextResponse.json({ error: 'no_plan' }, { status: 404 });
  }
  try {
    return NextResponse.json(JSON.parse(plan.analisisJson));
  } catch {
    // Cached JSON is corrupt — surface as 404 so the user goes back to the upload flow
    return NextResponse.json({ error: 'corrupt_cache' }, { status: 404 });
  }
}
