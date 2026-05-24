'use client';

import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui';
import { X } from '@/components/icons';
import { cn, hl } from '@/lib/utils';
import type { FilaPlan } from '@/types';

/**
 * Per-OF drawer. Bare essentials only:
 *   - what's scheduled at this slot
 *   - HL planificados
 *   - cambio desde el OF anterior (the one operationally useful fact)
 *
 * No verdict badges, no OEE numbers, no model decomposition: per-cell those
 * are either misleading (when the model only gave us a heuristic value) or
 * already shown elsewhere on the page.
 *
 * Closes on outside-click + Escape.
 */
interface Props {
  filas: FilaPlan[] | null;
  onClose: () => void;
}

export function CellDrawer({ filas, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!filas) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onMouse = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouse);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onMouse);
    };
  }, [filas, onClose]);

  if (!filas || filas.length === 0) return null;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Detalle del bloque planificado"
      className={cn(
        'fixed right-0 top-0 z-50 h-full w-full max-w-[380px] overflow-y-auto border-l border-hairline bg-surface shadow-elevated',
        'animate-fade-in',
      )}
    >
      <div className="flex items-center justify-between border-b border-hairline px-5 py-3">
        <span className="eyebrow text-ink-3">
          {filas.length === 1 ? 'Detalle del bloque' : `${filas.length} bloques en la celda`}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar"
          className="text-ink-3 transition-colors hover:text-ink"
        >
          <X className="h-4 w-4" strokeWidth={1.75} />
          <span className="sr-only">Cerrar</span>
        </button>
      </div>

      {filas.map((f, i) => (
        <DrawerSection key={`${f.linea}-${f.dia}-${f.turno ?? ''}-${i}`} fila={f} isLast={i === filas.length - 1} />
      ))}
    </div>
  );
}

function DrawerSection({ fila, isLast }: { fila: FilaPlan; isLast: boolean }) {
  const turnoLargo = fila.turno ? { M: 'Mañana', T: 'Tarde', N: 'Noche' }[fila.turno] : null;
  return (
    <section className={cn('px-5 py-4', !isLast && 'border-b border-hairline')}>
      <div className="eyebrow text-ink-3">
        L{fila.linea} · {fila.dia}
        {turnoLargo && ` · ${turnoLargo}`}
      </div>
      <h3 className="serif mt-1 text-lg font-medium text-ink">{fila.nombre || fila.sku}</h3>
      {fila.nombre !== fila.sku && (
        <p className="mt-0.5 font-mono text-xs text-ink-3">{fila.sku}</p>
      )}
      <p className="mt-3 text-xs text-ink-3">
        <span className="num font-medium text-ink-2">{hl(fila.hlPlan)}</span> planificados ·
        OF&nbsp;<span className="num">{fila.of}</span>
      </p>
      {fila.skuAnterior && (
        <div className="mt-3 flex items-center gap-1.5 text-xs text-ink-3">
          <span>Cambio desde:</span>
          <span className="font-mono text-ink-2">{fila.skuAnterior}</span>
          <span className="text-ink-4">→</span>
          <span className="font-mono text-ink">{fila.sku}</span>
        </div>
      )}
      {fila.feasReason && (
        <div className="mt-3 rounded-soft border border-damm/30 bg-damm-soft/40 px-3 py-2 text-xs text-damm-700">
          {fila.feasReason}
        </div>
      )}
    </section>
  );
}
