'use client';

import { useEffect, useRef } from 'react';
import { Button, VeredictoBadge, StatStrip, StatBlock, KPI, DeltaPill } from '@/components/ui';
import { X } from '@/components/icons';
import { cn, hl, pct } from '@/lib/utils';
import type { FilaPlan } from '@/types';

/**
 * Per-OF evidence drawer. Opens from the right on a calendar-cell click.
 * Closes on outside-click + Escape (pattern from scope-bar.tsx).
 * Inline progressive disclosure per STYLE.md §5: not a modal.
 *
 * Body shows everything the planner needs to decide whether to trust the
 * verdict: p10/p50/p90, the Damm decomposition, the top SHAP drivers,
 * the infeasibility reason (when applicable), and the theoretical
 * changeover time.
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
        'fixed right-0 top-0 z-50 h-full w-full max-w-[440px] overflow-y-auto border-l border-hairline bg-surface shadow-elevated',
        'animate-fade-in',
      )}
    >
      {filas.map((f, i) => (
        <DrawerSection key={`${f.linea}-${f.dia}-${f.turno ?? ''}-${i}`} fila={f} isLast={i === filas.length - 1} />
      ))}

      <div className="sticky bottom-0 flex justify-end border-t border-hairline bg-surface px-5 py-3">
        <Button variant="ghost" onClick={onClose} leftIcon={<X className="h-3.5 w-3.5" strokeWidth={1.75} />}>
          Cerrar
        </Button>
      </div>
    </div>
  );
}

/* ─────────────────────────── Section per fila ─────────────────────────── */

function DrawerSection({ fila, isLast }: { fila: FilaPlan; isLast: boolean }) {
  return (
    <section className={cn('px-5 py-5', !isLast && 'border-b border-hairline')}>
      {/* Header */}
      <div className="mb-4">
        <div className="eyebrow mb-2 text-ink-3">
          {`L${fila.linea} · ${fila.dia}`}
          {fila.turno && ` · ${TURNO_LARGO[fila.turno]}`}
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h3 className="serif text-xl font-medium text-ink">{fila.nombre}</h3>
            <p className="mt-0.5 font-mono text-xs text-ink-3">{fila.sku}</p>
          </div>
          <VeredictoBadge v={fila.veredicto} />
        </div>
        <div className="mt-2 text-xs text-ink-3">
          {hl(fila.hlPlan)} planificados · OF <span className="num">{fila.of}</span>
        </div>
      </div>

      {/* Predicción OEE: p10 / p50 / p90 */}
      <StatStrip>
        <StatBlock label="p10 pésimo" value={pct(fila.oeeP10 ?? fila.oeePrevisto, 1)} divider />
        <StatBlock label="p50 esperado" value={pct(fila.oeePrevisto, 1)} accent="damm" divider />
        <StatBlock label="p90 techo" value={pct(fila.oeeP90 ?? fila.oeePrevisto, 1)} />
      </StatStrip>

      {/* Descomposición Damm */}
      {fila.disp !== undefined && fila.rend !== undefined && fila.cal !== undefined && (
        <div className="mt-5">
          <div className="eyebrow mb-2 text-ink-3">Descomposición Damm</div>
          <div className="flex items-baseline gap-2 text-sm text-ink-2">
            <span className="num font-medium">{pct(fila.disp, 1)}</span>
            <span className="text-ink-4">Disponibilidad</span>
            <span className="text-ink-4">×</span>
            <span className="num font-medium">{pct(fila.rend, 1)}</span>
            <span className="text-ink-4">Rendimiento</span>
            <span className="text-ink-4">×</span>
            <span className="num font-medium">{pct(fila.cal, 1)}</span>
            <span className="text-ink-4">Calidad</span>
          </div>
          <p className="mt-1.5 text-xs text-ink-3">
            La disponibilidad suele ser el cuello de botella: tiempos de cambio + limpiezas + averías.
          </p>
        </div>
      )}

      {/* Top SHAP drivers */}
      {fila.topDrivers && fila.topDrivers.length > 0 && (
        <div className="mt-5">
          <div className="eyebrow mb-2 text-ink-3">Por qué este OEE</div>
          <ul className="space-y-1.5">
            {fila.topDrivers.slice(0, 5).map((d) => (
              <li key={d.name} className="flex items-center justify-between gap-3">
                <span className="font-mono text-xs text-ink-2">{driverLabel(d.name)}</span>
                <DeltaPill value={d.shap * 100} format="pts" label={`SHAP ${d.shap.toFixed(4)}`} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Veredicto motivo */}
      <div className="mt-5">
        <div className="eyebrow mb-2 text-ink-3">Por qué este veredicto</div>
        <p className="text-sm text-ink-2">{fila.motivo}</p>
        {fila.feasReason && (
          <div className="mt-2 rounded-soft border border-damm/30 bg-damm-soft/40 px-3 py-2 text-xs text-damm-700">
            {fila.feasReason}
          </div>
        )}
      </div>

      {/* Cambio teórico */}
      {fila.skuAnterior && (
        <div className="mt-5">
          <div className="eyebrow mb-2 text-ink-3">Cambio desde el OF anterior</div>
          <div className="flex items-center gap-2 text-xs text-ink-2">
            <span className="font-mono text-ink-3">{fila.skuAnterior}</span>
            <span className="text-ink-4">→</span>
            <span className="font-mono text-ink">{fila.sku}</span>
            <span className="ml-2 rounded-pill border border-hairline bg-cream px-2 py-0.5 text-[11px] text-ink-3">
              {tipoCambioLabel(fila.tipoCambio)}
            </span>
            {fila.cambioTeoricoMin !== undefined && (
              <span className="num ml-1 text-[11px] text-ink-3">
                ~{fila.cambioTeoricoMin} min teóricos
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

const TURNO_LARGO = { M: 'Mañana', T: 'Tarde', N: 'Noche' } as const;

function tipoCambioLabel(t: FilaPlan['tipoCambio']): string {
  return {
    inicio: 'inicio de jornada',
    formato: 'cambio de formato',
    cerveza: 'cambio de cerveza',
    mantenimiento: 'tras mantenimiento',
    otro: 'cambio menor',
  }[t];
}

/** Map model feature names to a human-readable Spanish label. */
function driverLabel(name: string): string {
  return DRIVER_LABELS[name] ?? name;
}

const DRIVER_LABELS: Record<string, string> = {
  prev_oee: 'OEE del OF anterior',
  changeover_variance_min: 'Variabilidad de cambio',
  linea_oee_p50_last_7d: 'OEE reciente de la línea (7d)',
  linea_oee_p50_last_30d: 'OEE reciente de la línea (30d)',
  familia_line_oee_p50: 'OEE histórico familia × línea',
  hours_since_same_sku: 'Horas desde la última vez',
  sku_line_oee_p50_last_30d: 'OEE histórico SKU × línea',
  sku_line_oee_p90_last_30d: 'Techo SKU × línea (p90)',
  week_iso: 'Semana del año',
  n_llamadas_mant: 'Avisos de mantenimiento',
  hours_to_next_scheduled_limpieza: 'Horas a próxima limpieza',
  hours_since_last_limpieza_on_line: 'Horas desde última limpieza',
  teorico_cambio_min: 'Minutos teóricos de cambio',
  c_producto_flag: 'Cambio de producto',
  c_brand_flag: 'Cambio de marca',
  c_volum_flag: 'Cambio de formato',
  c_envase_flag: 'Cambio de envase',
};
