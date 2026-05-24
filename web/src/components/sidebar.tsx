'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import type { SavedChartDTO } from '@/types';
import {
  Activity,
  ChartBar,
  ChevronsUpDown,
  ClipboardCheck,
  Command,
  Factory,
  Search,
  Siren,
  Star,
} from './icons';

const NAV = [
  { href: '/', label: 'Simulador', icon: Factory, hint: 'Plan semanal en vivo' },
  { href: '/observabilidad', label: 'Observabilidad', icon: Activity, hint: 'OEE · líneas · turnos' },
  { href: '/post-mortem', label: 'Post mortem', icon: ChartBar, hint: 'Pérdidas · causas raíz' },
  { href: '/validar', label: 'Validar plan', icon: ClipboardCheck, hint: 'Planificación propuesta' },
  { href: '/urgencias', label: 'Urgencias', icon: Siren, hint: 'Incidencias · acciones' },
];

const MAX_FAVORITES = 5;

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch_failed');
  return r.json();
}

export function Sidebar() {
  const pathname = usePathname();
  const savedCharts = useQuery({
    queryKey: ['saved-charts'],
    queryFn: () => jget<{ charts: SavedChartDTO[] }>('/api/observabilidad/charts'),
  });
  const favorites = (savedCharts.data?.charts ?? []).slice(0, MAX_FAVORITES);
  const showFavorites = favorites.length > 0 || savedCharts.isLoading;

  return (
    <aside className="sticky top-0 flex h-screen w-[252px] shrink-0 flex-col border-r border-hairline bg-linen/70">
      {/* Brand */}
      <div className="px-5 pt-6 pb-5">
        <div className="flex items-center justify-between">
          <Link href="/" className="group flex items-baseline gap-2">
            <DammMark />
            <div className="flex flex-col leading-none">
              <span className="serif text-[20px] font-semibold tracking-tight text-ink">Damm</span>
              <span className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-ink-3">
                Linewise
              </span>
            </div>
          </Link>
          <span className="rounded-full border border-hairline bg-surface px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-ink-3">
            v0.1
          </span>
        </div>
      </div>

      {/* Search */}
      <div className="px-3">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-card border border-hairline bg-surface px-3 py-2 text-left text-xs text-ink-3 transition-colors hover:border-hairline-strong hover:text-ink-2"
        >
          <Search className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span className="flex-1">Buscar OF, SKU, línea…</span>
          <kbd className="flex items-center gap-0.5 rounded border border-hairline bg-cream px-1 py-0.5 font-mono text-[9px] text-ink-3">
            <Command className="h-2.5 w-2.5" strokeWidth={2} /> K
          </kbd>
        </button>
      </div>

      {/* Favoritos — auto-pobladas con los gráficos guardados */}
      {showFavorites && (
        <div className="mt-6 px-3">
          <div className="flex items-center justify-between px-2 pb-1.5">
            <span className="eyebrow flex items-center gap-1.5 text-ink-3">
              <Star className="h-2.5 w-2.5" strokeWidth={2} /> Mis gráficos
            </span>
            <Link
              href="/observabilidad?view=graficos"
              className="text-[10px] text-ink-4 transition-colors hover:text-ink"
            >
              Ver todos
            </Link>
          </div>
          {savedCharts.isLoading ? (
            <ul className="space-y-1 px-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <li
                  key={i}
                  className="h-3 w-full animate-pulse rounded bg-hairline/40"
                />
              ))}
            </ul>
          ) : (
            <ul className="space-y-0.5">
              {favorites.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/observabilidad?view=graficos&chartId=${c.id}`}
                    className="block truncate rounded-soft px-2 py-1.5 text-xs text-ink-2 transition-colors hover:bg-surface hover:text-ink"
                    title={c.nombre}
                  >
                    {c.nombre}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Nav */}
      <nav className="mt-6 flex-1 overflow-y-auto px-3">
        <div className="eyebrow px-2 pb-2 text-ink-3">Operación</div>
        <ul className="space-y-0.5">
          {NAV.map(({ href, label, icon: Icon, hint }) => {
            const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
            return (
              <li key={href}>
                <Link
                  href={href}
                  data-active={active}
                  className={cn(
                    'nav-item group relative flex items-center gap-2.5 rounded-soft pl-3 pr-2 py-2 text-xs transition-colors',
                    active
                      ? 'bg-surface text-ink font-medium shadow-card'
                      : 'text-ink-2 hover:bg-surface/60 hover:text-ink',
                  )}
                >
                  <Icon
                    className={cn(
                      'h-4 w-4 shrink-0 transition-colors',
                      active ? 'text-damm' : 'text-ink-3 group-hover:text-ink-2',
                    )}
                    strokeWidth={1.75}
                  />
                  <div className="flex flex-1 flex-col leading-tight">
                    <span>{label}</span>
                    <span className="mt-0.5 text-[10px] text-ink-3">{hint}</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* User chip */}
      <div className="border-t border-hairline px-3 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-[11px] font-medium text-surface">
            RM
          </div>
          <div className="flex flex-1 flex-col leading-tight">
            <span className="text-xs font-medium text-ink">R. Marchetti</span>
            <span className="text-[10px] text-ink-3">Planificación · L17</span>
          </div>
          <button
            type="button"
            className="rounded-soft p-1 text-ink-3 hover:bg-cream hover:text-ink"
            aria-label="Cuenta"
          >
            <ChevronsUpDown className="h-3 w-3" strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </aside>
  );
}

/**
 * Stylized Damm star mark — geometric four-point star nodding to the
 * Estrella Damm logo without being a literal copy.
 */
function DammMark() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 22 22"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M11 1.5L13.2 8.8L20.5 11L13.2 13.2L11 20.5L8.8 13.2L1.5 11L8.8 8.8L11 1.5Z"
        fill="#A4161A"
      />
      <circle cx="11" cy="11" r="1.6" fill="#FAF7F1" />
    </svg>
  );
}
