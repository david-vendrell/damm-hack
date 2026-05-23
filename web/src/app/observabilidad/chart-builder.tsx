'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Card, CardHeader, Pill, Skeleton } from '@/components/ui';
import { cn } from '@/lib/utils';
import type {
  Aggregation,
  ChartConfig,
  DateRange,
  DimensionKey,
  DimensionMeta,
  Filter,
  Granularity,
  MeasureKey,
  MeasureMeta,
  QueryResult,
  SavedChartDTO,
  VizType,
} from '@/types';
import { ChartPreview, resolveViz } from './chart-preview';

const TEMPORAL_DIMS: DimensionKey[] = ['dia', 'semana', 'mesIso', 'fechaFin', 'mes', 'semanaIso'];

const VIZ_OPTIONS: { v: VizType; l: string }[] = [
  { v: 'auto', l: 'Auto' },
  { v: 'line', l: 'Línea' },
  { v: 'bar', l: 'Barras' },
  { v: 'stackedBar', l: 'Apiladas' },
  { v: 'donut', l: 'Donut' },
  { v: 'bigNumber', l: 'KPI' },
  { v: 'table', l: 'Tabla' },
];

const GRANULARITY_OPTIONS: { v: Granularity; l: string }[] = [
  { v: 'day', l: 'Día' },
  { v: 'week', l: 'Semana' },
  { v: 'month', l: 'Mes' },
];

const PRESETS: { v: NonNullable<DateRange['preset']>; l: string }[] = [
  { v: '7d', l: '7d' },
  { v: '30d', l: '30d' },
  { v: '90d', l: '90d' },
  { v: 'ytd', l: 'YTD' },
  { v: 'y2025', l: '2025' },
  { v: 'y2024', l: '2024' },
  { v: 'all', l: 'Todo' },
];

const AGG_LABEL: Record<Aggregation, string> = {
  sum: 'Suma',
  avg: 'Media',
  median: 'Mediana',
  count: 'Conteo',
  min: 'Mín',
  max: 'Máx',
  p90: 'P90',
};

const DEFAULT_CONFIG: ChartConfig = {
  measure: 'oee',
  aggregation: 'avg',
  dimension: 'mesIso',
  filters: [],
  dateRange: { preset: 'y2025' },
  granularity: 'month',
  viz: 'auto',
};

function granularityToDim(g: Granularity): DimensionKey {
  return g === 'day' ? 'dia' : g === 'week' ? 'semana' : 'mesIso';
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

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch_failed');
  return r.json();
}

interface ChartBuilderProps {
  initialConfig?: ChartConfig | null;
  editingId?: string | null;
  initialName?: string;
  onSaved?: (chart: SavedChartDTO) => void;
  onCancelEdit?: () => void;
}

export function ChartBuilder({
  initialConfig,
  editingId,
  initialName,
  onSaved,
  onCancelEdit,
}: ChartBuilderProps) {
  const qc = useQueryClient();
  const metricas = useQuery({
    queryKey: ['obs-metricas'],
    queryFn: () =>
      jget<{ measures: MeasureMeta[]; dimensions: DimensionMeta[] }>(
        '/api/observabilidad/metricas',
      ),
  });

  const [config, setConfig] = useState<ChartConfig>(initialConfig ?? DEFAULT_CONFIG);
  const [name, setName] = useState<string>(initialName ?? '');

  useEffect(() => {
    if (initialConfig) setConfig(initialConfig);
    if (typeof initialName === 'string') setName(initialName);
  }, [initialConfig, initialName, editingId]);

  const measureMeta = metricas.data?.measures.find((m) => m.key === config.measure);
  const dimMeta = config.dimension
    ? metricas.data?.dimensions.find((d) => d.key === config.dimension)
    : undefined;

  // Constrain aggregation to allowed list when measure changes.
  useEffect(() => {
    if (!measureMeta) return;
    if (!measureMeta.allowedAggs.includes(config.aggregation)) {
      setConfig((c) => ({ ...c, aggregation: measureMeta.defaultAgg }));
    }
  }, [measureMeta, config.aggregation]);

  const dimensions = metricas.data?.dimensions ?? [];
  const nonTemporalDims = dimensions.filter((d) => !d.temporal);

  // The "effective" dimension for the query: if user picked a non-temporal dim,
  // use it. If user picked time/none → derive from granularity.
  const effectiveDimension: DimensionKey | undefined = useMemo(() => {
    if (config.viz === 'bigNumber') return undefined;
    if (!config.dimension) return undefined;
    if (TEMPORAL_DIMS.includes(config.dimension)) return granularityToDim(config.granularity);
    return config.dimension;
  }, [config.dimension, config.granularity, config.viz]);

  const isTemporalDim = effectiveDimension ? TEMPORAL_DIMS.includes(effectiveDimension) : false;

  const queryBody = useMemo(
    () => ({
      measure: config.measure,
      aggregation: config.aggregation,
      dimension: effectiveDimension,
      breakdown: config.breakdown && config.breakdown !== effectiveDimension ? config.breakdown : undefined,
      filters: config.filters,
      dateRange: config.dateRange,
      topN: config.topN,
      withPrevious: config.viz === 'bigNumber' || !effectiveDimension,
    }),
    [config, effectiveDimension],
  );

  const data = useQuery({
    queryKey: ['obs-builder-query', queryBody],
    enabled: metricas.isSuccess,
    queryFn: () => jpost<QueryResult>('/api/observabilidad/query', queryBody),
  });

  const save = useMutation({
    mutationFn: async () => {
      const payload = { nombre: name.trim() || 'Sin título', config };
      if (editingId) {
        await jpost(`/api/observabilidad/charts/${editingId}`, payload);
        return { id: editingId, nombre: payload.nombre, config, creadoEn: '', actualEn: '' } as SavedChartDTO;
      }
      return jpost<SavedChartDTO>('/api/observabilidad/charts', payload);
    },
    onSuccess: (chart) => {
      qc.invalidateQueries({ queryKey: ['saved-charts'] });
      onSaved?.(chart);
      if (!editingId) setName('');
    },
  });

  const setRange = (patch: Partial<DateRange>) =>
    setConfig((c) => ({ ...c, dateRange: { ...c.dateRange, ...patch } }));

  return (
    <Card aria-label="Constructor de gráficos">
      <CardHeader
        title={editingId ? 'Editando gráfico' : 'Constructor de gráficos'}
        subtitle="Métrica, agregación, segmentos, filtros y rango — la previa se actualiza al instante."
        action={
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                setConfig(DEFAULT_CONFIG);
                setName('');
                onCancelEdit?.();
              }}
              className="text-xs text-muted underline-offset-4 hover:text-ink hover:underline"
            >
              Limpiar
            </button>
            {editingId && (
              <>
                <span className="h-3 w-px bg-hairline" />
                <button
                  onClick={() => onCancelEdit?.()}
                  className="text-xs text-muted underline-offset-4 hover:text-ink hover:underline"
                >
                  Cancelar edición
                </button>
              </>
            )}
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-0 lg:grid-cols-[320px_1fr]">
        {/* Left panel */}
        <div className="space-y-4 border-b border-hairline p-5 lg:border-b-0 lg:border-r">
          <FieldGroup label="Métrica">
            <select
              value={config.measure}
              onChange={(e) => setConfig((c) => ({ ...c, measure: e.target.value as MeasureKey }))}
              className="w-full rounded border border-hairline bg-surface px-2.5 py-1.5 text-sm focus:border-ink focus:outline-none"
            >
              {(metricas.data?.measures ?? []).map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
            {measureMeta && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {measureMeta.allowedAggs.map((a) => (
                  <Pill
                    key={a}
                    active={config.aggregation === a}
                    onClick={() => setConfig((c) => ({ ...c, aggregation: a }))}
                  >
                    {AGG_LABEL[a]}
                  </Pill>
                ))}
              </div>
            )}
          </FieldGroup>

          <FieldGroup label="Dimensión (eje X)">
            <select
              value={config.dimension ?? ''}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  dimension: (e.target.value || undefined) as DimensionKey | undefined,
                }))
              }
              className="w-full rounded border border-hairline bg-surface px-2.5 py-1.5 text-sm focus:border-ink focus:outline-none"
            >
              <option value="">— Tiempo (auto) —</option>
              <optgroup label="Tiempo">
                <option value="dia">Día</option>
                <option value="semana">Semana</option>
                <option value="mesIso">Mes</option>
              </optgroup>
              <optgroup label="Categórica">
                {nonTemporalDims.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </optgroup>
            </select>
            {isTemporalDim && (
              <div className="mt-2 flex gap-1.5">
                {GRANULARITY_OPTIONS.map((g) => (
                  <Pill
                    key={g.v}
                    active={config.granularity === g.v}
                    onClick={() => setConfig((c) => ({ ...c, granularity: g.v }))}
                  >
                    {g.l}
                  </Pill>
                ))}
              </div>
            )}
          </FieldGroup>

          <FieldGroup label="Desglose (opcional)">
            <select
              value={config.breakdown ?? ''}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  breakdown: (e.target.value || undefined) as DimensionKey | undefined,
                }))
              }
              className="w-full rounded border border-hairline bg-surface px-2.5 py-1.5 text-sm focus:border-ink focus:outline-none"
            >
              <option value="">— sin desglose —</option>
              {dimensions
                .filter((d) => d.key !== effectiveDimension)
                .map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
            </select>
          </FieldGroup>

          <FieldGroup label="Rango de fechas">
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <Pill
                  key={p.v}
                  active={config.dateRange.preset === p.v}
                  onClick={() => setRange({ preset: p.v, from: undefined, to: undefined })}
                >
                  {p.l}
                </Pill>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="date"
                value={config.dateRange.from ?? ''}
                onChange={(e) => setRange({ from: e.target.value || undefined, preset: undefined })}
                className="w-full rounded border border-hairline bg-surface px-2 py-1 text-xs focus:border-ink focus:outline-none"
              />
              <span className="text-xs text-muted">→</span>
              <input
                type="date"
                value={config.dateRange.to ?? ''}
                onChange={(e) => setRange({ to: e.target.value || undefined, preset: undefined })}
                className="w-full rounded border border-hairline bg-surface px-2 py-1 text-xs focus:border-ink focus:outline-none"
              />
            </div>
          </FieldGroup>

          <FieldGroup label="Filtros">
            <FiltersEditor
              filters={config.filters}
              dimensions={nonTemporalDims}
              onChange={(filters) => setConfig((c) => ({ ...c, filters }))}
            />
          </FieldGroup>

          {!isTemporalDim && effectiveDimension && (
            <FieldGroup label="Top N">
              <div className="flex gap-1.5">
                {[5, 10, 20, 50].map((n) => (
                  <Pill
                    key={n}
                    active={config.topN === n}
                    onClick={() => setConfig((c) => ({ ...c, topN: c.topN === n ? undefined : n }))}
                  >
                    {n}
                  </Pill>
                ))}
              </div>
            </FieldGroup>
          )}

          <FieldGroup label="Visualización">
            <div className="flex flex-wrap gap-1.5">
              {VIZ_OPTIONS.map((v) => (
                <Pill
                  key={v.v}
                  active={config.viz === v.v}
                  onClick={() => setConfig((c) => ({ ...c, viz: v.v }))}
                >
                  {v.l}
                </Pill>
              ))}
            </div>
          </FieldGroup>

          <div className="pt-3">
            <label className="mb-1.5 block text-xs uppercase tracking-wider text-muted">
              Nombre del gráfico
            </label>
            <div className="flex gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="p.ej. OEE mensual por línea"
                className="flex-1 rounded border border-hairline bg-surface px-2.5 py-1.5 text-sm focus:border-ink focus:outline-none"
              />
              <button
                onClick={() => save.mutate()}
                disabled={save.isPending || !name.trim()}
                className={cn(
                  'rounded border px-3 py-1.5 text-sm font-medium transition-colors',
                  save.isPending || !name.trim()
                    ? 'border-hairline bg-surface text-muted'
                    : 'border-ink bg-ink text-surface hover:bg-damm hover:border-damm',
                )}
              >
                {editingId ? 'Actualizar' : 'Guardar'}
              </button>
            </div>
            {save.isError && (
              <div className="mt-1 text-xs text-damm">No se pudo guardar.</div>
            )}
          </div>
        </div>

        {/* Right panel */}
        <div className="p-5">
          <div className="h-[360px] rounded border border-hairline bg-surface">
            {data.isLoading || metricas.isLoading || !data.data ? (
              <Skeleton className="h-full" />
            ) : data.data.rows.length === 0 && data.data.total === undefined && !data.data.dimension ? (
              <div className="flex h-full items-center justify-center text-sm text-muted">
                Sin datos para la combinación elegida.
              </div>
            ) : (
              <ChartPreview
                data={data.data}
                measure={measureMeta}
                viz={config.viz}
                dimTemporal={isTemporalDim}
                height={360}
              />
            )}
          </div>
          <DataQualityNote data={data.data} loading={data.isLoading} />
          {data.data && (
            <div className="mt-2 text-xs text-muted">
              {data.data.rows.length > 0
                ? `${data.data.rows.length} segmento${data.data.rows.length === 1 ? '' : 's'}`
                : data.data.total !== undefined
                  ? 'KPI agregado'
                  : ''}{' '}
              · viz <span className="text-ink">{resolveViz(config.viz, data.data, isTemporalDim)}</span>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs uppercase tracking-wider text-muted">{label}</label>
      {children}
    </div>
  );
}

function DataQualityNote({ data, loading }: { data?: QueryResult; loading: boolean }) {
  if (loading || !data) return null;
  const { excludedOutliers, excludedOeeGt1, rowsConsidered } = data.dataQuality;
  const excluded = excludedOutliers + excludedOeeGt1;
  if (excluded === 0 && rowsConsidered === 0) return null;
  if (excluded === 0) {
    return (
      <div className="mt-2 text-xs text-muted">
        {rowsConsidered.toLocaleString('es-ES')} filas consideradas.
      </div>
    );
  }
  const parts: string[] = [];
  if (excludedOeeGt1) parts.push(`${excludedOeeGt1} con OEE > 1`);
  if (excludedOutliers) parts.push(`${excludedOutliers} outliers de H. Tot.`);
  return (
    <div className="mt-2 rounded border border-warn/40 bg-warn-soft/40 px-3 py-1.5 text-xs text-warn">
      Calidad de datos: {excluded.toLocaleString('es-ES')} filas excluidas ({parts.join(', ')}).
      LIMPIEZA ya está fuera del agregado.
    </div>
  );
}

function FiltersEditor({
  filters,
  dimensions,
  onChange,
}: {
  filters: Filter[];
  dimensions: DimensionMeta[];
  onChange: (f: Filter[]) => void;
}) {
  const usedDims = new Set(filters.map((f) => f.dim));
  const available = dimensions.filter((d) => !usedDims.has(d.key));

  return (
    <div className="space-y-2">
      {filters.map((f, i) => (
        <FilterRow
          key={f.dim}
          filter={f}
          dimensions={dimensions}
          onChange={(next) => {
            const copy = [...filters];
            copy[i] = next;
            onChange(copy);
          }}
          onRemove={() => onChange(filters.filter((_, j) => j !== i))}
        />
      ))}
      {available.length > 0 && (
        <select
          value=""
          onChange={(e) => {
            if (!e.target.value) return;
            onChange([...filters, { dim: e.target.value as DimensionKey, values: [] }]);
          }}
          className="w-full rounded border border-dashed border-hairline bg-surface px-2.5 py-1.5 text-xs text-muted focus:border-ink focus:text-ink focus:outline-none"
        >
          <option value="">+ Añadir filtro…</option>
          {available.map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function FilterRow({
  filter,
  dimensions,
  onChange,
  onRemove,
}: {
  filter: Filter;
  dimensions: DimensionMeta[];
  onChange: (f: Filter) => void;
  onRemove: () => void;
}) {
  const meta = dimensions.find((d) => d.key === filter.dim);
  const values = useQuery({
    queryKey: ['dim-values', filter.dim],
    queryFn: () =>
      jget<{ values: string[] }>(`/api/observabilidad/dimension-values?key=${filter.dim}`),
  });
  return (
    <div className="rounded border border-hairline bg-surface p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-ink">{meta?.label ?? filter.dim}</span>
        <button onClick={onRemove} className="text-xs text-muted hover:text-damm">
          ×
        </button>
      </div>
      <div className="flex flex-wrap gap-1">
        {(values.data?.values ?? []).map((v) => {
          const active = filter.values.includes(v);
          return (
            <button
              key={v}
              onClick={() =>
                onChange({
                  ...filter,
                  values: active ? filter.values.filter((x) => x !== v) : [...filter.values, v],
                })
              }
              className={cn(
                'rounded border px-2 py-0.5 text-xs transition-colors',
                active
                  ? 'border-ink bg-ink text-surface'
                  : 'border-hairline bg-surface text-muted hover:text-ink',
              )}
            >
              {v}
            </button>
          );
        })}
        {values.isLoading && <span className="text-xs text-muted">Cargando…</span>}
        {values.data?.values.length === 0 && (
          <span className="text-xs text-muted">Sin valores.</span>
        )}
      </div>
    </div>
  );
}
