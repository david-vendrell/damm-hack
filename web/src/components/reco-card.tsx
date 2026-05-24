'use client';

import { cn, pts } from '@/lib/utils';
import type { Recomendacion } from '@/types';

/**
 * Single recommendation row. Shared by /validar and /urgencias: in both
 * places we're rendering an item from `PlanRecomendado.recomendaciones`
 * (the optimizer's swap_log mapped onto the Recomendacion shape).
 *
 * `applied` is purely visual (moss-green border) — the parent component
 * owns the apply/revert action.
 */
export function RecoCard({
  reco,
  applied,
}: {
  reco: Recomendacion;
  applied: boolean;
}) {
  const tipoMap = {
    reordenar: { label: 'Reordenar', cls: 'bg-gold-soft text-gold-700' },
    mover_linea: { label: 'Mover de línea', cls: 'bg-damm-soft text-damm-700' },
    reprogramar: { label: 'Reprogramar', cls: 'bg-moss-soft text-moss-700' },
  } as const;
  const catMap = {
    obligatorio: { label: '🔧 Obligatorio', cls: 'bg-damm-soft text-damm-700' },
    opcional:    { label: '💡 Opcional',    cls: 'bg-cream text-ink-3' },
    prioritario: { label: '⭐ Prioritario', cls: 'bg-gold-soft text-gold-700' },
    desplazado:  { label: '⚠️ Desplazado',  cls: 'bg-damm-soft text-damm-700' },
    realojo:     { label: '↪️ Realojo',     cls: 'bg-moss-soft text-moss-700' },
  } as const;
  const t = tipoMap[reco.tipo];
  const cat = reco.categoria ? catMap[reco.categoria] : null;
  return (
    <div className={cn(
      'rounded-card border bg-surface p-4 transition-colors',
      applied ? 'border-moss' : 'border-hairline',
    )}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {cat && (
              <span className={cn('inline-flex rounded-pill px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider', cat.cls)}>
                {cat.label}
              </span>
            )}
            <span className={cn('inline-flex rounded-pill px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider', t.cls)}>
              {t.label}
            </span>
            <span className="text-sm font-medium text-ink">{reco.titulo}</span>
          </div>
          <p className="mt-1.5 text-sm text-ink-3">{reco.descripcion}</p>
          {(reco.deltaCambioMin !== undefined || reco.deltaMantHoras !== undefined || reco.agrupaFormato) && (
            <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-ink-3">
              {reco.deltaCambioMin !== undefined && reco.deltaCambioMin !== 0 && (
                <span className="num">
                  Δ cambio:&nbsp;
                  <strong className={reco.deltaCambioMin < 0 ? 'text-moss-700' : 'text-damm-700'}>
                    {reco.deltaCambioMin > 0 ? '+' : ''}{reco.deltaCambioMin} min
                  </strong>
                </span>
              )}
              {reco.deltaMantHoras !== undefined && reco.deltaMantHoras !== 0 && (
                <span className="num">
                  Δ mant:&nbsp;
                  <strong className={reco.deltaMantHoras > 0 ? 'text-moss-700' : 'text-damm-700'}>
                    {reco.deltaMantHoras > 0 ? '+' : ''}{reco.deltaMantHoras} h
                  </strong>
                </span>
              )}
              {reco.agrupaFormato && <span className="text-moss-700">✓ agrupa formato</span>}
            </div>
          )}
          {(reco.tipo === 'reordenar' || reco.tipo === 'mover_linea') && (
            <div className="mt-3 space-y-1.5 text-xs">
              <SecuenciaLinea label={`Antes — L${reco.antes.linea}`} skus={reco.antes.secuencia} />
              <SecuenciaLinea label={`Después — L${reco.despues.linea}`} skus={reco.despues.secuencia} highlight />
            </div>
          )}
        </div>
        <div className="text-right">
          <div className="eyebrow text-ink-3">Ganancia</div>
          <div className={cn(
            'num text-lg font-semibold',
            reco.gananciaPts >= 0 ? 'text-moss' : 'text-damm',
          )}>
            {pts(reco.gananciaPts)}
          </div>
        </div>
      </div>
    </div>
  );
}

function SecuenciaLinea({
  label,
  skus,
  highlight,
}: {
  label: string;
  skus: string[];
  highlight?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-ink-3">{label}</span>
      <div className="flex flex-wrap gap-1">
        {skus.slice(0, 8).map((s, i) => (
          <span
            key={i}
            className={cn(
              'rounded-soft px-1.5 py-0.5 font-mono text-[10px]',
              highlight ? 'bg-moss-soft text-moss-700' : 'bg-cream text-ink-2',
            )}
          >
            {s}
          </span>
        ))}
        {skus.length > 8 && <span className="text-[10px] text-ink-3">+{skus.length - 8}</span>}
      </div>
    </div>
  );
}
