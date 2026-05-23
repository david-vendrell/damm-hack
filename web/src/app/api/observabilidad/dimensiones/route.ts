import { NextResponse } from 'next/server';
import { getDimensiones } from '@/server/observabilidad';

export async function GET() {
  const data = await getDimensiones();
  return NextResponse.json(data);
}
