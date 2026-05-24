'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { SectionTitle, Skeleton, StatBlock, StatStrip } from '@/components/ui';
import { hl } from '@/lib/utils';
import type { Linea, PostMortemResumen, SkuLineaInfo } from '@/types';
import { SkuExplorer } from './sku-explorer';
import { WeeklyBrief } from './weekly-brief';
import { WeeklyExplorer } from './weekly-explorer';

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch_failed');
  return r.json();
}

export function PostMortemView() {
  const [filtroLinea, setFiltroLinea] = useState<Linea | null>(null);
  const [selected, setSelected] = useState<{ semana: number; anio: number } | null>(null);

  const resumen = useQuery({
    queryKey: ['postmortem-resumen'],
    queryFn: () => jget<PostMortemResumen>('/api/postmortem/resumen'),
    staleTime: 60_000,
  });
  const skus = useQuery({
    queryKey: ['postmortem-skus'],
    queryFn: () => jget<SkuLineaInfo[]>('/api/postmortem/skus'),
    staleTime: 60_000,
  });

  return (
    <div className="space-y-10">
      <header>
        <SectionTitle subtitle="Evidencia del histórico: dónde se está perdiendo OEE y por qué.">
          Análisis post mortem
        </SectionTitle>
      </header>

      {/* KPIs */}
      <section>
        {resumen.isLoading || !resumen.data ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : (
          <StatStrip>
            <StatBlock
              label="Pérdida evitable media"
              value={`${resumen.data.perdidaEvitablePts.toFixed(1)}`}
              unit="pp"
              accent="damm"
              divider
            />
            <StatBlock
              label="OFs por debajo de su alcanzable"
              value={`${resumen.data.ofsPorDebajoPct}%`}
              divider
            />
            <StatBlock label="Hl latentes" value={hl(resumen.data.hlLatente)} accent="gold" divider />
            <StatBlock
              label="OFs analizadas"
              value={resumen.data.ofsAnalizadas.toLocaleString('es-ES')}
            />
          </StatStrip>
        )}
      </section>

      {/* Feature 1: Weekly Explorer (dropdown selectors) */}
      <WeeklyExplorer
        filtroLinea={filtroLinea}
        setFiltroLinea={setFiltroLinea}
        selectedSemana={selected?.semana ?? null}
        selectedAnio={selected?.anio ?? null}
        setSelected={setSelected}
      />

      {/* Feature 2: Weekly Brief (renders the selected week) */}
      {selected && (
        <WeeklyBrief semana={selected.semana} anio={selected.anio} linea={filtroLinea} />
      )}

      {/* Feature 3: SKU + línea historical explorer */}
      <SkuExplorer skus={skus.data ?? []} />
    </div>
  );
}
