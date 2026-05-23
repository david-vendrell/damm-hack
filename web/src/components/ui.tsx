'use client';

import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { Veredicto } from '@/types';
import { ChevronDown, Minus, TrendingDown, TrendingUp } from './icons';

/* ─────────────────────────── Card ─────────────────────────── */

export function Card({
  children,
  className,
  elevated,
}: {
  children: ReactNode;
  className?: string;
  elevated?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-card border border-hairline bg-surface',
        elevated ? 'shadow-elevated' : 'shadow-card',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  eyebrow,
  action,
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-hairline px-5 py-4">
      <div>
        {eyebrow && <div className="eyebrow mb-1.5 text-ink-3">{eyebrow}</div>}
        <h3 className="text-sm font-medium text-ink">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs text-ink-3">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

/* ─────────────────────────── KPI ─────────────────────────── */

export interface KPIDelta {
  value: number; // raw delta number, sign indicates direction
  format: 'pts' | 'pct' | 'abs';
  invert?: boolean; // when true, negative = good (e.g. defect rate)
  label?: string; // hover/aria
}

export function KPI({
  label,
  value,
  hint,
  delta,
  unit,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  delta?: KPIDelta;
  unit?: string;
  accent?: 'damm' | 'gold' | 'moss';
}) {
  const accentMap: Record<string, string> = {
    damm: 'text-damm',
    gold: 'text-gold-600',
    moss: 'text-moss',
  };
  return (
    <div className="group relative overflow-hidden">
      <div className="eyebrow text-ink-3">{label}</div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span
          className={cn(
            'num serif text-kpi font-medium text-ink',
            accent && accentMap[accent],
          )}
        >
          {value}
        </span>
        {unit && <span className="text-xs font-medium text-ink-3">{unit}</span>}
        {delta && <DeltaPill {...delta} />}
      </div>
      {hint && <div className="mt-1.5 text-[11px] text-ink-3">{hint}</div>}
    </div>
  );
}

export function DeltaPill({ value, format, invert, label }: KPIDelta) {
  const positive = value > 0;
  const flat = Math.abs(value) < 0.05;
  const good = flat ? null : invert ? !positive : positive;

  const cls = flat ? 'flat' : good ? 'up' : 'down';
  const Icon = flat ? Minus : positive ? TrendingUp : TrendingDown;

  const formatted =
    format === 'pts'
      ? `${positive ? '+' : ''}${value.toFixed(1)} pp`
      : format === 'pct'
        ? `${positive ? '+' : ''}${value.toFixed(1)}%`
        : `${positive ? '+' : ''}${value.toLocaleString('es-ES')}`;

  return (
    <span className={cn('delta-pill', cls)} title={label} aria-label={label}>
      <Icon className="h-2.5 w-2.5" strokeWidth={2.5} />
      {formatted}
    </span>
  );
}

/* ─────────────────────────── Veredicto badge ─────────────────────────── */

export function VeredictoBadge({ v }: { v: Veredicto }) {
  const map = {
    procede: { label: 'Procede', cls: 'bg-moss-soft text-moss-700 border-moss/30' },
    revisar: { label: 'Revisar', cls: 'bg-gold-soft text-gold-700 border-gold/30' },
    evitar: { label: 'Evitar', cls: 'bg-damm-soft text-damm-700 border-damm/30' },
  } as const;
  const s = map[v];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider',
        s.cls,
      )}
    >
      {s.label}
    </span>
  );
}

/* ─────────────────────────── Skeleton ─────────────────────────── */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-soft bg-hairline/50', className)} />;
}

/* ─────────────────────────── Pill ─────────────────────────── */

export function Pill({
  children,
  active,
  onClick,
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-pill border px-3 py-1 text-xs transition-colors',
        active
          ? 'border-ink bg-ink text-surface font-medium'
          : 'border-hairline bg-surface text-ink-3 hover:text-ink hover:border-hairline-strong',
      )}
    >
      {children}
    </button>
  );
}

/* ─────────────────────────── Section title ─────────────────────────── */

export function SectionTitle({
  children,
  subtitle,
  eyebrow,
}: {
  children: ReactNode;
  subtitle?: string;
  eyebrow?: string;
}) {
  return (
    <div className="mb-5">
      {eyebrow && <div className="eyebrow mb-2 text-ink-3">{eyebrow}</div>}
      <h2 className="serif text-2xl font-semibold tracking-tight text-ink">{children}</h2>
      {subtitle && <p className="mt-1 text-sm text-ink-3">{subtitle}</p>}
    </div>
  );
}

/* ─────────────────────────── Button ─────────────────────────── */

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  leftIcon,
  rightIcon,
  className,
  children,
  ...rest
}: ButtonProps) {
  const variantCls = {
    primary: 'bg-ink text-surface hover:bg-ink-2',
    secondary: 'bg-surface border border-hairline text-ink-2 hover:text-ink hover:border-hairline-strong',
    ghost: 'text-ink-3 hover:text-ink hover:bg-linen',
    danger: 'bg-damm text-surface hover:bg-damm-700',
  };
  const sizeCls = {
    sm: 'px-2.5 py-1 text-[11px] gap-1',
    md: 'px-3.5 py-1.5 text-xs gap-1.5',
  };
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-pill font-medium transition-colors disabled:opacity-50',
        variantCls[variant],
        sizeCls[size],
        className,
      )}
      {...rest}
    >
      {leftIcon}
      {children}
      {rightIcon}
    </button>
  );
}

/* ─────────────────────────── Select ─────────────────────────── */

export function Select({
  label,
  value,
  options,
  onChange,
  placeholder,
  size = 'md',
}: {
  label?: string;
  value: string;
  options: { v: string; l: string }[];
  onChange: (v: string) => void;
  placeholder?: string;
  size?: 'sm' | 'md';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const current = options.find((o) => o.v === value);

  return (
    <div className="flex flex-col gap-1.5" ref={ref}>
      {label && <label className="eyebrow text-ink-3">{label}</label>}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            'flex w-full items-center justify-between gap-2 rounded-soft border border-hairline bg-surface text-left text-ink-2 transition-colors hover:border-hairline-strong',
            size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-sm',
          )}
        >
          <span className={cn(current ? 'text-ink' : 'text-ink-4')}>
            {current ? current.l : placeholder ?? 'Selecciona…'}
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-ink-3" strokeWidth={1.75} />
        </button>
        {open && (
          <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-40 max-h-72 overflow-y-auto rounded-card border border-hairline bg-surface shadow-elevated animate-fade-in">
            {placeholder && (
              <button
                type="button"
                onClick={() => {
                  onChange('');
                  setOpen(false);
                }}
                className={cn(
                  'block w-full px-3 py-1.5 text-left text-xs transition-colors',
                  value === '' ? 'bg-linen text-ink font-medium' : 'text-ink-3 hover:bg-cream',
                )}
              >
                {placeholder}
              </button>
            )}
            {options.map((o) => (
              <button
                key={o.v}
                type="button"
                onClick={() => {
                  onChange(o.v);
                  setOpen(false);
                }}
                className={cn(
                  'block w-full px-3 py-1.5 text-left text-xs transition-colors',
                  o.v === value ? 'bg-linen text-ink font-medium' : 'text-ink-2 hover:bg-cream',
                )}
              >
                {o.l}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── Segmented control ─────────────────────────── */

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { v: T; l: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-pill border border-hairline bg-cream p-0.5">
      {options.map((o) => {
        const active = o.v === value;
        return (
          <button
            key={o.v}
            type="button"
            onClick={() => onChange(o.v)}
            className={cn(
              'rounded-pill px-3 py-1 text-[11px] font-medium uppercase tracking-wider transition-colors',
              active ? 'bg-ink text-surface' : 'text-ink-3 hover:text-ink',
            )}
          >
            {o.l}
          </button>
        );
      })}
    </div>
  );
}

/* ─────────────────────────── Stat block (sparse Dribbble pattern) ─────────────────────────── */

export function StatBlock({
  label,
  value,
  unit,
  delta,
  accent,
  divider,
}: {
  label: string;
  value: string;
  unit?: string;
  delta?: KPIDelta;
  accent?: 'damm' | 'gold' | 'moss';
  divider?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex-1 px-6 py-5',
        divider && 'border-r border-hairline',
      )}
    >
      <KPI label={label} value={value} unit={unit} delta={delta} accent={accent} />
    </div>
  );
}

export function StatStrip({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-stretch overflow-hidden rounded-card border border-hairline bg-surface shadow-card">
      {children}
    </div>
  );
}
