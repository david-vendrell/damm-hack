'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

export type Linea = 14 | 17 | 19;
export type Turno = 'M' | 'T' | 'N';
export type Periodo = 'today' | 'wtd' | 'mtd' | 'ytd' | 'custom' | 'last7' | 'last30';

export interface Scope {
  linea?: Linea;
  turno?: Turno;
  periodo: Periodo;
  desde?: string; // ISO date if periodo='custom'
  hasta?: string;
}

interface ScopeContextValue {
  scope: Scope;
  setScope: (patch: Partial<Scope>) => void;
  reset: () => void;
  toQuery: () => string;
}

const ScopeContext = createContext<ScopeContextValue | null>(null);

const DEFAULT_SCOPE: Scope = { periodo: 'mtd' };

function readScopeFromURL(sp: URLSearchParams): Scope {
  const linea = sp.get('linea');
  const turno = sp.get('turno');
  const periodo = (sp.get('periodo') as Periodo) || DEFAULT_SCOPE.periodo;
  const desde = sp.get('desde') ?? undefined;
  const hasta = sp.get('hasta') ?? undefined;
  return {
    linea: linea && [14, 17, 19].includes(Number(linea)) ? (Number(linea) as Linea) : undefined,
    turno: turno && ['M', 'T', 'N'].includes(turno) ? (turno as Turno) : undefined,
    periodo,
    desde,
    hasta,
  };
}

export function ScopeProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const scope = useMemo(
    () => readScopeFromURL(new URLSearchParams(searchParams?.toString() ?? '')),
    [searchParams],
  );

  const setScope = useCallback(
    (patch: Partial<Scope>) => {
      const next = { ...scope, ...patch };
      const sp = new URLSearchParams(searchParams?.toString() ?? '');
      const setOrDel = (k: string, v?: string | number) => {
        if (v === undefined || v === null || v === '') sp.delete(k);
        else sp.set(k, String(v));
      };
      setOrDel('linea', next.linea);
      setOrDel('turno', next.turno);
      // periodo is required; keep default off URL when it equals default
      if (next.periodo && next.periodo !== DEFAULT_SCOPE.periodo) sp.set('periodo', next.periodo);
      else sp.delete('periodo');
      setOrDel('desde', next.desde);
      setOrDel('hasta', next.hasta);
      const q = sp.toString();
      router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
    },
    [pathname, router, scope, searchParams],
  );

  const reset = useCallback(() => {
    router.replace(pathname, { scroll: false });
  }, [pathname, router]);

  const toQuery = useCallback(() => {
    const sp = new URLSearchParams();
    if (scope.linea) sp.set('linea', String(scope.linea));
    if (scope.turno) sp.set('turno', scope.turno);
    if (scope.periodo) sp.set('periodo', scope.periodo);
    if (scope.desde) sp.set('desde', scope.desde);
    if (scope.hasta) sp.set('hasta', scope.hasta);
    const s = sp.toString();
    return s ? `?${s}` : '';
  }, [scope]);

  return (
    <ScopeContext.Provider value={{ scope, setScope, reset, toQuery }}>
      {children}
    </ScopeContext.Provider>
  );
}

export function useScope() {
  const ctx = useContext(ScopeContext);
  if (!ctx) throw new Error('useScope must be used within ScopeProvider');
  return ctx;
}

export const PERIODO_LABEL: Record<Periodo, string> = {
  today: 'Hoy',
  wtd: 'Esta semana',
  mtd: 'Este mes',
  ytd: 'Este año',
  last7: 'Últimos 7 días',
  last30: 'Últimos 30 días',
  custom: 'Personalizado',
};

export const TURNO_LABEL: Record<Turno, string> = {
  M: 'Mañana',
  T: 'Tarde',
  N: 'Noche',
};
