'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useScope } from './scope-provider';
import { ArrowUpRight, ChevronDown, Sparkles, TrendingDown, TrendingUp, Triangle } from './icons';
import { cn } from '@/lib/utils';
import { DeltaPill, Skeleton } from './ui';
import type { BriefCallout, BriefData, BriefSeverity } from '@/server/brief';

const BRIEF_COLLAPSED_KEY = 'damm:brief-collapsed';

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch_failed');
  return r.json();
}

export function BriefHero() {
  const { scope, toQuery } = useScope();
  const q = useQuery({
    queryKey: ['brief', scope],
    queryFn: () => jget<BriefData>(`/api/observabilidad/brief${toQuery()}`),
    staleTime: 60_000,
  });

  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(BRIEF_COLLAPSED_KEY) === '1');
    } catch {}
  }, []);
  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(BRIEF_COLLAPSED_KEY, next ? '1' : '0');
      } catch {}
      return next;
    });
  };

  if (q.isLoading) return <BriefSkeleton />;
  const data = q.data;
  if (!data) return null;
  if (!data.callouts.length) return null;

  const visibleCount = Math.min(data.callouts.length, 3);
  const sevCounts = data.callouts.slice(0, 3).reduce(
    (acc, c) => {
      acc[c.severity] = (acc[c.severity] ?? 0) + 1;
      return acc;
    },
    {} as Record<BriefSeverity, number>,
  );

  return (
    <section
      aria-label="Brief de turno"
      className="relative overflow-hidden rounded-card border border-hairline bg-surface shadow-card animate-fade-in"
    >
      {/* Top eyebrow band */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-controls="brief-callouts"
        className={cn(
          'flex w-full items-center justify-between gap-3 bg-bone/60 px-6 py-3 text-left transition-colors hover:bg-bone',
          !collapsed && 'border-b border-hairline',
        )}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-ink text-surface">
            <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
          </div>
          <div>
            <div className="eyebrow text-ink-2">Brief de turno</div>
            <div className="mt-0.5 text-[11px] text-ink-3">
              {data.scopeLabel} · {data.periodLabel} ·{' '}
              <span className="num">
                {new Date(data.asOf).toLocaleString('es-ES', {
                  day: '2-digit',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {collapsed ? (
            <div className="flex items-center gap-3 text-[11px] text-ink-3">
              {sevCounts.critical ? (
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-damm" />
                  <span className="num">{sevCounts.critical}</span> crítico
                </span>
              ) : null}
              {sevCounts.warning ? (
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-gold" />
                  <span className="num">{sevCounts.warning}</span> atención
                </span>
              ) : null}
              {sevCounts.positive ? (
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-moss" />
                  <span className="num">{sevCounts.positive}</span> positivo
                </span>
              ) : null}
              {!sevCounts.critical && !sevCounts.warning && !sevCounts.positive ? (
                <span>
                  <span className="num">{visibleCount}</span> destacados
                </span>
              ) : null}
            </div>
          ) : (
            <div className="hidden md:flex items-center gap-4 text-[11px] text-ink-3">
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-damm" />
                Crítico
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-gold" />
                Atención
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-moss" />
                Positivo
              </span>
            </div>
          )}
          <span
            className="flex h-6 w-6 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-ink/5 hover:text-ink"
            aria-hidden
          >
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', collapsed && '-rotate-90')}
              strokeWidth={2}
            />
          </span>
          <span className="sr-only">{collapsed ? 'Expandir brief' : 'Contraer brief'}</span>
        </div>
      </button>

      {/* Callouts grid */}
      {!collapsed && (
        <div
          id="brief-callouts"
          className={cn(
            'grid divide-x divide-hairline',
            data.callouts.length === 1 && 'grid-cols-1',
            data.callouts.length === 2 && 'md:grid-cols-2',
            data.callouts.length >= 3 && 'md:grid-cols-3',
          )}
        >
          {data.callouts.slice(0, 3).map((c, i) => (
            <CalloutCell key={c.id} callout={c} index={i + 1} total={visibleCount} />
          ))}
        </div>
      )}
    </section>
  );
}

function CalloutCell({ callout, index, total }: { callout: BriefCallout; index: number; total: number }) {
  const sev = severityStyles(callout.severity);
  return (
    <article className="group relative flex flex-col gap-3 px-6 py-5">
      {/* corner ornament */}
      <div className={cn('absolute right-4 top-4 opacity-60', sev.ornamentColor)}>
        <Triangle className="h-2.5 w-2.5" strokeWidth={2.5} fill="currentColor" />
      </div>

      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-3">
          {String(index).padStart(2, '0')} / {String(total).padStart(2, '0')}
        </span>
        <span className={cn('eyebrow', sev.tagColor)}>{sev.label}</span>
      </div>

      <h3 className="serif text-[20px] font-medium leading-tight tracking-tight text-ink">
        {callout.headline}
      </h3>

      <p className="text-[12.5px] leading-relaxed text-ink-2">{callout.body}</p>

      <div className="mt-auto flex items-end justify-between gap-3 pt-2">
        <div className="flex items-baseline gap-1.5">
          <span className={cn('num serif text-[28px] font-medium leading-none', sev.metricColor)}>
            {callout.metricValue}
          </span>
          {callout.metricUnit && (
            <span className="text-xs text-ink-3">{callout.metricUnit}</span>
          )}
          {callout.delta && (
            <span className="ml-1">
              <DeltaPill
                value={callout.delta.value}
                format={callout.delta.format}
                invert={callout.category === 'perdidas'}
              />
            </span>
          )}
        </div>
        {callout.action && (
          <Link
            href={callout.action.href}
            className="group/btn inline-flex items-center gap-1 rounded-pill border border-hairline bg-bone/50 px-3 py-1.5 text-[11px] font-medium text-ink-2 transition-colors hover:border-ink hover:bg-ink hover:text-surface"
          >
            {callout.action.label}
            <ArrowUpRight className="h-3 w-3 transition-transform group-hover/btn:translate-x-0.5 group-hover/btn:-translate-y-0.5" strokeWidth={2} />
          </Link>
        )}
      </div>
    </article>
  );
}

function severityStyles(s: BriefSeverity) {
  switch (s) {
    case 'critical':
      return {
        label: 'Crítico',
        tagColor: 'text-damm',
        metricColor: 'text-damm',
        ornamentColor: 'text-damm',
      };
    case 'warning':
      return {
        label: 'Atención',
        tagColor: 'text-gold-700',
        metricColor: 'text-gold-700',
        ornamentColor: 'text-gold',
      };
    case 'positive':
      return {
        label: 'Positivo',
        tagColor: 'text-moss',
        metricColor: 'text-moss',
        ornamentColor: 'text-moss',
      };
    case 'info':
    default:
      return {
        label: 'Estable',
        tagColor: 'text-ink-3',
        metricColor: 'text-ink',
        ornamentColor: 'text-ink-4',
      };
  }
}

function BriefSkeleton() {
  return (
    <section className="overflow-hidden rounded-card border border-hairline bg-surface shadow-card">
      <div className="flex items-center justify-between border-b border-hairline bg-bone/60 px-6 py-3">
        <div className="flex items-center gap-3">
          <Skeleton className="h-7 w-7 rounded-full" />
          <div>
            <Skeleton className="h-3 w-32" />
            <Skeleton className="mt-1.5 h-2.5 w-48" />
          </div>
        </div>
      </div>
      <div className="grid md:grid-cols-3 divide-x divide-hairline">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-3 px-6 py-5">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
            <div className="flex items-center justify-between pt-2">
              <Skeleton className="h-7 w-20" />
              <Skeleton className="h-6 w-24 rounded-pill" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
