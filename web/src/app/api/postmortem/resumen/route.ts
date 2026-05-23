import { NextResponse } from 'next/server';
import { postMortemResumen } from '@/server/analysis';

export async function GET() {
  const data = await postMortemResumen();
  return NextResponse.json(data);
}
