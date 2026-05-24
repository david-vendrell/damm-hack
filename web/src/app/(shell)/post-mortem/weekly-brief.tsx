'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Card, CardHeader, Skeleton, StatBlock, StatStrip } from '@/components/ui';
import { ChevronDown, Sparkles, Zap } from '@/components/icons';
import { cn, hl, pts } from '@/lib/utils';
import type {
  Linea,
  RecomendacionDetalle,
  RecomendacionSemana,
  WeekBrief,
} from '@/types';

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch_failed');
  return r.json();
}

interface Props {
  semana: number;
  anio: number;
  linea: Linea | null;
}

export function WeeklyBrief({ semana, anio, linea }: Props) {
  const q = useQuery({
    queryKey: ['postmortem-brief', semana, anio, linea],
    queryFn: () =>
      jget<WeekBrief>(
        `/api/postmortem/brief?semana=${semana}&anio=${anio}${linea ? `&linea=${linea}` : ''}`,
      ),
    staleTime: 60_000,
  });

  return (
    <section className="animate-fade-in">
      <Card>
        <CardHeader
          eyebrow="Brief de la semana"
          title={q.data?.semanaLabel ?? `Sem ${semana} · ${anio}`}
          subtitle={q.data?.summary}
          action={
            q.data?.meta ? <SourceBadge meta={q.data.meta} loading={q.isFetching} /> : null
          }
        />
        <div className="px-5 py-5">
          {q.isLoading ? (
            <div className="space-y-4">
              <p className="text-xs text-ink-3">
                Consultando al modelo LightGBM, puede tardar entre 5 y 15 segundos.
              </p>
              <Skeleton className="h-20" />
              <Skeleton className="h-32" />
              <Skeleton className="h-32" />
            </div>
          ) : !q.data ? (
            <p className="text-sm text-ink-3">No se ha podido cargar el brief de esta semana.</p>
          ) : (
            <div className="space-y-6">
              {q.data.kpis.length > 0 && (
                <StatStrip>
                  {q.data.kpis.map((k, i) => (
                    <StatBlock
                      key={i}
                      label={k.label}
                      value={k.value}
                      accent={k.accent}
                      divider={i < q.data.kpis.length - 1}
                    />
                  ))}
                </StatStrip>
              )}

              <div>
                <div className="eyebrow mb-3 text-ink-3">Recomendaciones</div>
                {q.data.recomendaciones.length === 0 ? (
                  <p className="text-sm text-ink-3">
                    Sin palancas detectadas para esta semana. El plan ya estaba cerca de su techo.
                  </p>
                ) : (
                  <ul className="space-y-3">
                    {q.data.recomendaciones.map((r, i) => (
                      <RecomendacionRow key={i} reco={r} index={i} />
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
      </Card>
    </section>
  );
}

function RecomendacionRow({ reco, index }: { reco: RecomendacionSemana; index: number }) {
  const [open, setOpen] = useState(false);
  const detailId = `reco-detail-${index}`;
  const hasDetalle = !!reco.detalle;

  return (
    <li className="rounded-card border border-hairline bg-bone px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink">{reco.titulo}</div>
          <p className="mt-1 text-xs text-ink-2">{reco.descripcion}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
          <span className="num text-sm font-semibold text-moss">
            {pts(reco.gananciaPotencialPts)}
          </span>
          <span className="num text-[11px] text-ink-3">{hl(reco.gananciaPotencialHl)}</span>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between border-t border-hairline pt-2 text-[11px] text-ink-3">
        <span>{reco.evidencia}</span>
        {hasDetalle && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={detailId}
            className="inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-ink-2 transition-colors hover:bg-cream hover:text-ink"
          >
            {open ? 'Ocultar' : 'Leer más'}
            <ChevronDown
              className={cn('h-3 w-3 transition-transform', open && 'rotate-180')}
              strokeWidth={2}
              aria-hidden
            />
          </button>
        )}
      </div>
      {hasDetalle && open && (
        <div id={detailId} className="mt-3 animate-fade-in space-y-4 border-t border-hairline pt-3">
          <DetalleBody detalle={reco.detalle!} />
        </div>
      )}
    </li>
  );
}

function DetalleBody({ detalle }: { detalle: RecomendacionDetalle }) {
  return (
    <>
      {detalle.cambios.length > 0 && (
        <div>
          <div className="eyebrow mb-2 text-ink-3">Cambios concretos</div>
          <ul className="space-y-1.5">
            {detalle.cambios.map((c, i) => (
              <li
                key={i}
                className="flex flex-wrap items-baseline gap-2 text-xs text-ink-2"
              >
                <span className="text-ink-3">{c.etiqueta}:</span>
                <span className="num rounded bg-cream px-1.5 py-0.5 font-mono text-[11px]">
                  {c.antes}
                </span>
                <span className="text-ink-3">→</span>
                <span className="num rounded bg-moss-soft px-1.5 py-0.5 font-mono text-[11px] text-moss">
                  {c.despues}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {detalle.metricas.length > 0 && (
        <div>
          <div className="eyebrow mb-2 text-ink-3">Métricas operacionales</div>
          <div className="flex flex-wrap gap-1.5">
            {detalle.metricas.map((m, i) => (
              <span
                key={i}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-[11px]',
                  m.sentido === 'positivo'
                    ? 'border-moss/30 bg-moss-soft text-moss'
                    : m.sentido === 'negativo'
                      ? 'border-damm/30 bg-damm-soft text-damm-700'
                      : 'border-hairline bg-surface text-ink-2',
                )}
              >
                <span className="text-ink-3">{m.label}:</span>
                <span className="num font-medium">{m.value}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {detalle.pasos.length > 0 && (
        <div>
          <div className="eyebrow mb-2 text-ink-3">Pasos sugeridos</div>
          <ol className="space-y-1.5 text-xs text-ink-2">
            {detalle.pasos.map((p, i) => (
              <li key={i} className="flex gap-2">
                <span className="num shrink-0 text-ink-4">{i + 1}.</span>
                <span>{p}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {detalle.riesgos && detalle.riesgos.length > 0 && (
        <div>
          <div className="eyebrow mb-2 text-ink-3">A vigilar</div>
          <ul className="space-y-1 text-xs text-ink-2">
            {detalle.riesgos.map((r, i) => (
              <li key={i} className="flex gap-2">
                <span className="shrink-0 text-damm">·</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function SourceBadge({
  meta,
  loading,
}: {
  meta: NonNullable<WeekBrief['meta']>;
  loading?: boolean;
}) {
  if (meta.source === 'linewise') {
    const seconds = meta.latencyMs ? (meta.latencyMs / 1000).toFixed(1) : '?';
    const via = meta.via === 'local' ? 'modelo local' : 'modelo en HF';
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-pill border border-damm/30 bg-damm-soft px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-damm-700',
          loading && 'opacity-60',
        )}
        title={`Modelo LightGBM ${via} en ${seconds} s`}
      >
        <Zap className="h-2.5 w-2.5" strokeWidth={2.5} aria-hidden />
        {via} · {seconds}s
      </span>
    );
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill border border-hairline bg-cream px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-ink-3',
        loading && 'opacity-60',
      )}
      title="El sidecar del modelo no respondió. Recomendaciones derivadas por reglas locales."
    >
      <Sparkles className="h-2.5 w-2.5" strokeWidth={2.5} aria-hidden />
      heurística local
    </span>
  );
}
