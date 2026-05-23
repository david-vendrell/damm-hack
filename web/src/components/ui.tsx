'use client';

import { cn } from '@/lib/utils';
import type { Veredicto } from '@/types';

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-soft border border-hairline bg-surface', className)}>{children}</div>
  );
}

export function CardHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between border-b border-hairline px-5 py-4">
      <div>
        <h3 className="text-sm font-medium text-ink">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function KPI({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: boolean }) {
  return (
    <div className="rounded-soft border border-hairline bg-surface px-5 py-4">
      <div className="text-xs text-muted">{label}</div>
      <div className={cn('mt-1 text-3xl font-semibold tracking-tight num', accent && 'text-damm')}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function VeredictoBadge({ v }: { v: Veredicto }) {
  const map = {
    procede: { label: 'Procede', cls: 'bg-good-soft text-good border-good/40' },
    revisar: { label: 'Revisar', cls: 'bg-warn-soft text-warn border-warn/40' },
    evitar: { label: 'Evitar', cls: 'bg-damm-soft text-damm border-damm/40' },
  } as const;
  const s = map[v];
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium', s.cls)}>{s.label}</span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-hairline/60', className)} />;
}

export function Pill({ children, active, onClick }: { children: React.ReactNode; active?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1 text-xs transition-colors',
        active
          ? 'border-ink bg-ink text-surface'
          : 'border-hairline bg-surface text-muted hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

export function SectionTitle({ children, subtitle }: { children: React.ReactNode; subtitle?: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-xl font-semibold tracking-tight">{children}</h2>
      {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
    </div>
  );
}
