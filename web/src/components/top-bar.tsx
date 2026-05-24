'use client';

import { usePathname } from 'next/navigation';
import { Bell, Moon, Plus, Sun } from './icons';
import { ScopeBar } from './scope-bar';

const TITLES: Record<string, { title: string; subtitle: string }> = {
  '/observabilidad': {
    title: 'Observabilidad',
    subtitle: 'Histórico real · líneas 14 · 17 · 19 — El Prat',
  },
  '/post-mortem': {
    title: 'Post mortem',
    subtitle: 'Dónde se pierde el OEE y por qué',
  },
  '/validar': {
    title: 'Validar plan',
    subtitle: 'Riesgos y advertencias sobre la planificación propuesta',
  },
  '/urgencias': {
    title: 'Urgencias',
    subtitle: 'Impacto y acciones recomendadas para incidencias',
  },
};

export function TopBar() {
  const pathname = usePathname();
  const key = Object.keys(TITLES).find((k) => pathname.startsWith(k));
  const meta = key ? TITLES[key] : { title: 'LineWise', subtitle: 'Damm — operación de líneas' };

  return (
    <header className="sticky top-0 z-30 border-b border-hairline bg-cream/85 backdrop-blur-md">
      <div className="flex items-center justify-between gap-6 px-8 py-4">
        <div className="flex items-baseline gap-4">
          <h1 className="serif text-[28px] font-semibold leading-none tracking-tight text-ink">
            {meta.title}
          </h1>
          <span className="text-xs text-ink-3">{meta.subtitle}</span>
        </div>

        <div className="flex items-center gap-3">
          <ScopeBar />

          <div className="flex items-center gap-1 rounded-pill border border-hairline bg-surface p-0.5">
            <button
              type="button"
              aria-label="Modo claro"
              className="flex h-7 w-7 items-center justify-center rounded-full bg-ink text-surface"
            >
              <Sun className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
            <button
              type="button"
              aria-label="Modo oscuro"
              className="flex h-7 w-7 items-center justify-center rounded-full text-ink-3 hover:text-ink-2"
            >
              <Moon className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          </div>

          <button
            type="button"
            className="relative flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-surface text-ink-2 hover:bg-linen"
            aria-label="Notificaciones"
          >
            <Bell className="h-4 w-4" strokeWidth={1.75} />
            <span className="absolute right-1.5 top-1.5 flex h-2 w-2 items-center justify-center">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-damm opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-damm" />
            </span>
          </button>
        </div>
      </div>

      <WorkspaceTabs />
    </header>
  );
}

function WorkspaceTabs() {
  // Placeholder for the multi-workspace future. Today: single "Default" view.
  return (
    <div className="flex items-end gap-1 border-t border-hairline/60 bg-cream/40 px-8">
      <button
        type="button"
        className="relative -mb-px flex items-center gap-2 border-b-2 border-damm bg-cream px-3.5 py-2 text-xs font-medium text-ink"
      >
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink-3">01</span>
        Vista por defecto
      </button>
      <button
        type="button"
        className="ml-1 flex h-7 w-7 items-center justify-center rounded-full text-ink-3 hover:bg-linen hover:text-ink"
        aria-label="Nueva vista"
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
    </div>
  );
}
