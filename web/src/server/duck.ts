import path from 'node:path';
import {
  DuckDBInstance,
  type DuckDBConnection,
  type DuckDBValue,
} from '@duckdb/node-api';

const DB_PATH = path.resolve(process.cwd(), '..', 'db', 'linewise.duckdb');

const globalForDuck = globalThis as unknown as {
  duck?: Promise<DuckDBConnection>;
};

async function open(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.fromCache(DB_PATH, {
    access_mode: 'READ_ONLY',
  });
  return instance.connect();
}

function conn(): Promise<DuckDBConnection> {
  return (globalForDuck.duck ??= open());
}

type Json =
  | null
  | string
  | number
  | boolean
  | Json[]
  | { [k: string]: Json };

export async function query<T = Record<string, Json>>(
  sql: string,
  params?: Record<string, unknown>,
): Promise<T[]> {
  const c = await conn();
  const reader = params
    ? await c.runAndReadAll(sql, params as Record<string, DuckDBValue>)
    : await c.runAndReadAll(sql);
  return reader.getRowObjectsJson() as T[];
}

export async function queryOne<T = Record<string, Json>>(
  sql: string,
  params?: Record<string, unknown>,
): Promise<T | undefined> {
  const rows = await query<T>(sql, params);
  return rows[0];
}

export function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === 'bigint') return Number(v);
  return 0;
}

export function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}
