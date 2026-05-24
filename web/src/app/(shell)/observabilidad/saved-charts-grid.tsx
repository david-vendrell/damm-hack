'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Card, CardHeader, Pill, Skeleton } from '@/components/ui';
import type {
  ChartConfig,
  DimensionKey,
  MeasureMeta,
  QueryResult,
  SavedChartDTO,
} from '@/types';
import { ChartPreview } from './chart-preview';

const TEMPORAL_DIMS: DimensionKey[] = ['dia', 'semana', 'mesIso', 'fechaFin', 'mes', 'semanaIso'];

type SortKey = 'recientes' | 'nombre';
const SORT_THRESHOLD = 4;

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

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('recientes');

  if (list.isLoading) {
    return (
      <section className="space-y-4">
        <GridHeader
          count={null}
          query={query}
          onQuery={setQuery}
          sort={sort}
          onSort={setSort}
          showControls={false}
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-72" />
          ))}
        </div>
      </section>
    );
  }

  const charts = list.data?.charts ?? [];
  if (charts.length === 0) {
    return (
      <section className="space-y-4">
        <GridHeader
          count={0}
          query={query}
          onQuery={setQuery}
          sort={sort}
          onSort={setSort}
          showControls={false}
        />
        <Card>
          <div className="px-6 py-10 text-center text-sm text-muted">
            Todavía no has guardado ningún gráfico. Configúralo arriba y pulsa{' '}
            <b>Guardar gráfico</b>.
          </div>
        </Card>
      </section>
    );
  }
  const showControls = charts.length >= SORT_THRESHOLD;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? charts.filter((c) => c.nombre.toLowerCase().includes(q))
    : charts;
  const sorted = [...filtered].sort((a, b) => {
    if (sort === 'nombre') return a.nombre.localeCompare(b.nombre, 'es');
    const at = a.actualEn || a.creadoEn || '';
    const bt = b.actualEn || b.creadoEn || '';
    return bt.localeCompare(at);
  });

  return (
    <section className="space-y-4">
      <GridHeader
        count={charts.length}
        matched={q ? sorted.length : null}
        query={query}
        onQuery={setQuery}
        sort={sort}
        onSort={setSort}
        showControls={showControls}
      />
      {sorted.length === 0 ? (
        <Card>
          <div className="px-6 py-10 text-center text-sm text-muted">
            Ningún gráfico coincide con &quot;{query}&quot;.
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {sorted.map((c) => (
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
      )}
    </section>
  );
}

function GridHeader({
  count,
  matched,
  query,
  onQuery,
  sort,
  onSort,
  showControls,
}: {
  count: number | null;
  matched?: number | null;
  query: string;
  onQuery: (q: string) => void;
  sort: SortKey;
  onSort: (s: SortKey) => void;
  showControls: boolean;
}) {
  const label =
    count === null
      ? '…'
      : matched != null
        ? `${matched} de ${count}`
        : `${count} ${count === 1 ? 'gráfico' : 'gráficos'}`;
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-hairline pb-3">
      <div>
        <div className="eyebrow text-ink-3">Tus gráficos guardados</div>
        <p className="mt-1 text-xs text-ink-3">
          Edita o elimina desde el menú <span className="text-ink">⋯</span> de cada tarjeta.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {showControls && (
          <>
            <input
              type="search"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="Buscar por nombre"
              className="w-44 rounded border border-hairline bg-surface px-2.5 py-1 text-xs text-ink focus:border-ink focus:outline-none"
              aria-label="Buscar gráficos guardados"
            />
            <div className="flex gap-1">
              <Pill active={sort === 'recientes'} onClick={() => onSort('recientes')}>
                Recientes
              </Pill>
              <Pill active={sort === 'nombre'} onClick={() => onSort('nombre')}>
                A→Z
              </Pill>
            </div>
          </>
        )}
        <span className="text-[11px] uppercase tracking-wider text-ink-4 num">{label}</span>
      </div>
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
        {data.isLoading ? (
          <Skeleton className="h-full" />
        ) : data.isError ? (
          <SavedCardMessage
            tone="warn"
            text="No se pudo cargar."
            action={{ label: 'Reintentar', onClick: () => data.refetch() }}
          />
        ) : !data.data ||
          (data.data.rows.length === 0 &&
            data.data.total === undefined &&
            !data.data.dimension) ? (
          <SavedCardMessage text="Sin datos para los filtros guardados." />
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

function SavedCardMessage({
  text,
  tone = 'muted',
  action,
}: {
  text: string;
  tone?: 'muted' | 'warn';
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      <p
        className={
          tone === 'warn' ? 'text-xs text-damm' : 'text-xs text-ink-3'
        }
      >
        {text}
      </p>
      {action && (
        <button
          onClick={action.onClick}
          className="rounded-pill border border-hairline px-2.5 py-0.5 text-[11px] text-ink-2 hover:border-ink hover:text-ink"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
