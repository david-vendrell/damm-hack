'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AnalisisPlan } from '@/types';

// Shared React Query key so /validar and /urgencias hit the same cache entry.
// When one page primes it (upload, apply-incidencia), the other reads it
// instantly on mount — no Skeleton flash, no re-fetch round-trip.
export const LATEST_PLAN_KEY = ['latestPlan'] as const;

async function fetchLatestPlan(): Promise<AnalisisPlan | null> {
  const r = await fetch('/api/planes/latest/full');
  if (!r.ok) return null;
  const data = await r.json();
  if (!data || 'error' in data) return null;
  return data as AnalisisPlan;
}

export function useLatestPlan() {
  return useQuery<AnalisisPlan | null>({
    queryKey: LATEST_PLAN_KEY,
    queryFn: fetchLatestPlan,
    staleTime: 5 * 60_000,
  });
}

export function useSetLatestPlan() {
  const qc = useQueryClient();
  return (plan: AnalisisPlan | null) => qc.setQueryData(LATEST_PLAN_KEY, plan);
}
