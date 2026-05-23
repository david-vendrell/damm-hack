'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  PERIODO_LABEL,
  TURNO_LABEL,
  useScope,
  type Linea,
  type Periodo,
  type Turno,
} from './scope-provider';
import { ChevronDown, Compass } from './icons';

const LINEAS: Linea[] = [14, 17, 19];
const TURNOS: Turno[] = ['M', 'T', 'N'];
const PERIODOS: Periodo[] = ['today', 'wtd', 'mtd', 'ytd', 'last7', 'last30'];

export function ScopeBar() {
  const { scope, setScope, reset } = useScope();
  const lineaLabel = scope.linea ? `Línea ${scope.linea}` : 'Todas las líneas';
  const turnoLabel = scope.turno ? `Turno ${TURNO_LABEL[scope.turno]}` : 'Todos los turnos';
  const periodoLabel = PERIODO_LABEL[scope.periodo];

  const hasFilters = Boolean(scope.linea || scope.turno) || scope.periodo !== 'mtd';

  return (
    <div className="flex items-center gap-1.5 rounded-pill border border-hairline bg-surface/80 pl-2 pr-1 py-1 backdrop-blur-sm shadow-card">
      <Compass className="h-3.5 w-3.5 text-ink-3" strokeWidth={1.75} />
      <ScopeSegment
        label={lineaLabel}
        active={!!scope.linea}
        options={[
          { v: '', l: 'Todas las líneas' },
          ...LINEAS.map((l) => ({ v: String(l), l: `Línea ${l}` })),
        ]}
        value={scope.linea ? String(scope.linea) : ''}
        onChange={(v) => setScope({ linea: v ? (Number(v) as Linea) : undefined })}
      />
      <Dot />
      <ScopeSegment
        label={turnoLabel}
        active={!!scope.turno}
        options={[
          { v: '', l: 'Todos los turnos' },
          ...TURNOS.map((t) => ({ v: t, l: `Turno ${TURNO_LABEL[t]}` })),
        ]}
        value={scope.turno ?? ''}
        onChange={(v) => setScope({ turno: v ? (v as Turno) : undefined })}
      />
      <Dot />
      <ScopeSegment
        label={periodoLabel}
        active={scope.periodo !== 'mtd'}
        options={PERIODOS.map((p) => ({ v: p, l: PERIODO_LABEL[p] }))}
        value={scope.periodo}
        onChange={(v) => setScope({ periodo: v as Periodo })}
      />
      {hasFilters && (
        <button
          type="button"
          onClick={reset}
          className="ml-1 rounded-pill border border-hairline px-2.5 py-1 text-[10px] uppercase tracking-wider text-ink-3 hover:bg-linen hover:text-ink"
        >
          Limpiar
        </button>
      )}
    </div>
  );
}

function Dot() {
  return <span className="text-ink-4">·</span>;
}

interface SegmentProps {
  label: string;
  value: string;
  active: boolean;
  options: { v: string; l: string }[];
  onChange: (v: string) => void;
}

function ScopeSegment({ label, value, active, options, onChange }: SegmentProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', handle);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-xs transition-colors',
          active ? 'bg-ink text-surface font-medium' : 'text-ink-2 hover:bg-linen',
        )}
      >
        {label}
        <ChevronDown className="h-3 w-3" strokeWidth={2} />
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-50 min-w-[180px] overflow-hidden rounded-card border border-hairline bg-surface shadow-elevated animate-fade-in">
          <ul className="py-1">
            {options.map((opt) => {
              const sel = opt.v === value;
              return (
                <li key={opt.v || 'all'}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(opt.v);
                      setOpen(false);
                    }}
                    className={cn(
                      'block w-full px-3 py-1.5 text-left text-xs transition-colors',
                      sel
                        ? 'bg-linen text-ink font-medium'
                        : 'text-ink-2 hover:bg-cream',
                    )}
                  >
                    {opt.l}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
