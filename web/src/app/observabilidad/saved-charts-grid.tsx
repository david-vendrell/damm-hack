'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Card, CardHeader, Skeleton } from '@/components/ui';
import type {
  ChartConfig,
  DimensionKey,
  MeasureMeta,
  QueryResult,
  SavedChartDTO,
} from '@/types';
import { ChartPreview } from './chart-preview';

const TEMPORAL_DIMS: DimensionKey[] = ['dia', 'semana', 'mesIso', 'fechaFin', 'mes', 'semanaIso'];

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch_failed');
  return r.json();
}

async function jpost<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('post_failed');
  return r.json();
}

async function jdel(url: string): Promise<void> {
  await fetch(url, { method: 'DELETE' });
}

function effectiveDim(config: ChartConfig): DimensionKey | undefined {
  if (config.viz === 'bigNumber') return undefined;
  if (!config.dimension) return undefined;
  if (TEMPORAL_DIMS.includes(config.dimension)) {
    return config.granularity === 'day' ? 'dia' : config.granularity === 'week' ? 'semana' : 'mesIso';
  }
  return config.dimension;
}

export function SavedChartsGrid({
  onEdit,
}: {
  onEdit?: (chart: SavedChartDTO) => void;
}) {
  const qc = useQueryClient();
  const metricas = useQuery({
    queryKey: ['obs-metricas'],
    queryFn: () => jget<{ measures: MeasureMeta[] }>('/api/observabilidad/metricas'),
  });
  const list = useQuery({
    queryKey: ['saved-charts'],
    queryFn: () => jget<{ charts: SavedChartDTO[] }>('/api/observabilidad/charts'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => jdel(`/api/observabilidad/charts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-charts'] }),
  });

  if (list.isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-72" />
        ))}
      </div>
    );
  }

  const charts = list.data?.charts ?? [];
  if (charts.length === 0) {
    return (
      <Card>
        <div className="px-6 py-10 text-center text-sm text-muted">
          Todavía no has guardado ningún gráfico. Configúralo arriba y pulsa <b>Guardar</b>.
        </div>
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {charts.map((c) => (
        <SavedCard
          key={c.id}
          chart={c}
          measures={metricas.data?.measures ?? []}
          onEdit={onEdit ? () => onEdit(c) : undefined}
          onDelete={() => {
            if (window.confirm(`¿Eliminar "${c.nombre}"?`)) remove.mutate(c.id);
          }}
        />
      ))}
    </div>
  );
}

function SavedCard({
  chart,
  measures,
  onEdit,
  onDelete,
}: {
  chart: SavedChartDTO;
  measures: MeasureMeta[];
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const config = chart.config;
  const dim = effectiveDim(config);
  const isTemporal = dim ? TEMPORAL_DIMS.includes(dim) : false;

  const queryBody = useMemo(
    () => ({
      measure: config.measure,
      aggregation: config.aggregation,
      dimension: dim,
      breakdown: config.breakdown && config.breakdown !== dim ? config.breakdown : undefined,
      filters: config.filters,
      dateRange: config.dateRange,
      topN: config.topN,
      withPrevious: config.viz === 'bigNumber' || !dim,
    }),
    [config, dim],
  );

  const data = useQuery({
    queryKey: ['saved-chart-data', chart.id, queryBody],
    queryFn: () => jpost<QueryResult>('/api/observabilidad/query', queryBody),
  });

  const measureMeta = measures.find((m) => m.key === config.measure);

  return (
    <Card>
      <CardHeader
        title={chart.nombre}
        subtitle={`${measureMeta?.label ?? config.measure} · ${config.aggregation}`}
        action={
          <div className="relative">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="rounded p-1 text-muted hover:bg-hairline/40 hover:text-ink"
              aria-label="Acciones"
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="absolute right-0 z-10 mt-1 w-32 rounded border border-hairline bg-surface text-xs shadow-lg">
                {onEdit && (
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      onEdit();
                    }}
                    className="block w-full px-3 py-1.5 text-left hover:bg-hairline/30"
                  >
                    Editar
                  </button>
                )}
                {onDelete && (
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      onDelete();
                    }}
                    className="block w-full px-3 py-1.5 text-left text-damm hover:bg-damm-soft/40"
                  >
                    Eliminar
                  </button>
                )}
              </div>
            )}
          </div>
        }
      />
      <div className="h-56 px-2 pb-3">
        {data.isLoading || !data.data ? (
          <Skeleton className="h-full" />
        ) : (
          <ChartPreview
            data={data.data}
            measure={measureMeta}
            viz={config.viz}
            dimTemporal={isTemporal}
            height={220}
            compact
          />
        )}
      </div>
    </Card>
  );
}
