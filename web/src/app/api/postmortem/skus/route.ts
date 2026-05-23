import { NextResponse } from 'next/server';
import { listarSkusConBaselines } from '@/server/analysis';

export async function GET() {
  return NextResponse.json(await listarSkusConBaselines());
}
