'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader, Skeleton, StatBlock, StatStrip } from '@/components/ui';
import { Sparkles } from '@/components/icons';
import { hl, pts } from '@/lib/utils';
import type { Linea, RecomendacionSemana, WeekBrief } from '@/types';

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
          action={<Sparkles className="h-4 w-4 text-damm" strokeWidth={1.75} aria-hidden />}
        />
        <div className="px-5 py-5">
          {q.isLoading ? (
            <div className="space-y-4">
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
                      <RecomendacionRow key={i} reco={r} />
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

function RecomendacionRow({ reco }: { reco: RecomendacionSemana }) {
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
      <div className="mt-2 border-t border-hairline pt-2 text-[11px] text-ink-3">
        {reco.evidencia}
      </div>
    </li>
  );
}
