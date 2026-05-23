import { NextResponse } from 'next/server';
import { DIMENSION_LIST, MEASURE_LIST } from '@/server/query';

export async function GET() {
  return NextResponse.json({ measures: MEASURE_LIST, dimensions: DIMENSION_LIST });
}
