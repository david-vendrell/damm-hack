'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Pill, Skeleton } from '@/components/ui';
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

const VIZ_TEMPORAL: { v: VizType; l: string }[] = [
  { v: 'auto', l: 'Auto' },
  { v: 'line', l: 'Línea' },
];

const VIZ_COMPARACION: { v: VizType; l: string }[] = [
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

const VIZ_LABEL: Record<Exclude<VizType, 'auto'>, string> = {
  line: 'Línea',
  bar: 'Barras',
  stackedBar: 'Barras apiladas',
  donut: 'Donut',
  bigNumber: 'KPI',
  table: 'Tabla',
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

  const isPristine =
    config.measure === DEFAULT_CONFIG.measure &&
    config.dimension === DEFAULT_CONFIG.dimension &&
    config.filters.length === 0 &&
    !config.breakdown;

  return (
    <Card aria-label="Constructor de gráficos">
      {/* Thin toolbar: only what's needed */}
      <div className="flex items-center justify-between border-b border-hairline px-5 py-2.5">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-ink-3">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-damm" />
          {editingId ? 'Editando gráfico' : 'Nuevo gráfico'}
        </div>
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
        </div>
      </div>

      <div className="grid grid-cols-1 gap-0 lg:grid-cols-[320px_1fr]">
        {/* Left panel: controls */}
        <div className="space-y-5 border-b border-hairline p-5 lg:border-b-0 lg:border-r">
          <FieldGroup
            label="1 · Métrica"
            hint="Qué quieres medir y cómo agregarlo"
          >
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

          <FieldGroup
            label="2 · Eje X"
            hint="En qué se reparte la medida"
          >
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
              <option value="">— Sin eje (KPI único) —</option>
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

          <FieldGroup
            label="3 · Desglose"
            hint="Opcional · segunda dimensión que separa series"
          >
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

          <FieldGroup label="4 · Rango de fechas">
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

          <FieldGroup
            label="5 · Filtros"
            hint="AND entre filtros · OR entre valores de un mismo filtro"
          >
            <FiltersEditor
              filters={config.filters}
              dimensions={nonTemporalDims}
              onChange={(filters) => setConfig((c) => ({ ...c, filters }))}
            />
          </FieldGroup>

          {!isTemporalDim && effectiveDimension && (
            <FieldGroup label="6 · Top N">
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
            <div className="space-y-2">
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-4">
                  Series temporales
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {VIZ_TEMPORAL.map((v) => (
                    <Pill
                      key={v.v}
                      active={config.viz === v.v}
                      onClick={() => setConfig((c) => ({ ...c, viz: v.v }))}
                    >
                      {v.l}
                    </Pill>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-4">
                  Comparación / composición
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {VIZ_COMPARACION.map((v) => (
                    <Pill
                      key={v.v}
                      active={config.viz === v.v}
                      onClick={() => setConfig((c) => ({ ...c, viz: v.v }))}
                    >
                      {v.l}
                    </Pill>
                  ))}
                </div>
              </div>
            </div>
          </FieldGroup>
        </div>

        {/* Right panel: live preview */}
        <div className="flex flex-col p-5">
          <PreviewHeader
            data={data.data}
            measure={measureMeta}
            viz={config.viz}
            isTemporal={isTemporalDim}
            filters={config.filters}
            dimensions={nonTemporalDims}
            onRemoveFilter={(dim) =>
              setConfig((c) => ({ ...c, filters: c.filters.filter((f) => f.dim !== dim) }))
            }
          />
          <div className="mt-3 h-[360px] rounded border border-hairline bg-surface">
            {data.isLoading || metricas.isLoading ? (
              <Skeleton className="h-full" />
            ) : data.isError ? (
              <PreviewError onRetry={() => data.refetch()} />
            ) : !data.data ? (
              <Skeleton className="h-full" />
            ) : data.data.rows.length === 0 &&
              data.data.total === undefined &&
              !data.data.dimension ? (
              <PreviewEmpty pristine={isPristine} />
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
        </div>
      </div>

      {/* Sticky footer: name + save spans full width */}
      <div className="sticky bottom-0 z-10 flex items-center gap-3 border-t border-hairline bg-surface/95 px-5 py-3 backdrop-blur">
        <label className="hidden text-[11px] uppercase tracking-wider text-ink-3 md:block">
          Nombre
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={editingId ? 'Renombrar gráfico' : 'p.ej. OEE mensual por línea'}
          className="flex-1 rounded border border-hairline bg-surface px-3 py-1.5 text-sm focus:border-ink focus:outline-none"
        />
        <Button
          variant="primary"
          size="md"
          onClick={() => save.mutate()}
          disabled={save.isPending || !name.trim()}
        >
          {save.isPending
            ? 'Guardando…'
            : editingId
              ? 'Actualizar gráfico'
              : 'Guardar gráfico'}
        </Button>
      </div>
      {save.isError && (
        <div className="border-t border-damm/30 bg-damm-soft/20 px-5 py-1.5 text-xs text-damm">
          No se pudo guardar. Vuelve a intentarlo.
        </div>
      )}
    </Card>
  );
}

function FieldGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <label className="block text-xs uppercase tracking-wider text-muted">{label}</label>
        {hint && <span className="text-[10px] text-ink-4">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function PreviewHeader({
  data,
  measure,
  viz,
  isTemporal,
  filters,
  dimensions,
  onRemoveFilter,
}: {
  data?: QueryResult;
  measure?: MeasureMeta;
  viz: VizType;
  isTemporal: boolean;
  filters: Filter[];
  dimensions: DimensionMeta[];
  onRemoveFilter: (dim: DimensionKey) => void;
}) {
  const resolved = data ? resolveViz(viz, data, isTemporal) : null;
  const isAuto = viz === 'auto';
  const segmentCount = data?.rows.length ?? 0;
  const dimLabel = dimensions.reduce<Record<string, string>>((acc, d) => {
    acc[d.key] = d.label;
    return acc;
  }, {});
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-3">
        {resolved && (
          <span className="inline-flex items-center gap-1.5 rounded-pill border border-hairline bg-cream px-2 py-0.5">
            {isAuto && (
              <span className="text-[10px] uppercase tracking-wider text-ink-4">Auto →</span>
            )}
            <span className="font-medium text-ink-2">{VIZ_LABEL[resolved]}</span>
          </span>
        )}
        {measure && (
          <span className="num">
            {measure.label}
            {data?.dimension ? ` · ${data.dimension}` : ''}
          </span>
        )}
        {data && (
          <span className="num text-ink-4">
            {segmentCount > 0
              ? `${segmentCount} segmento${segmentCount === 1 ? '' : 's'}`
              : data.total !== undefined
                ? 'KPI agregado'
                : ''}
          </span>
        )}
      </div>
      {filters.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {filters.map((f) => (
            <button
              key={f.dim}
              onClick={() => onRemoveFilter(f.dim)}
              title="Quitar filtro"
              className="group inline-flex items-center gap-1.5 rounded-pill border border-hairline bg-surface px-2 py-0.5 text-[11px] text-ink-2 hover:border-damm/40 hover:text-damm"
            >
              <span className="text-ink-3 group-hover:text-damm">
                {dimLabel[f.dim] ?? f.dim}:
              </span>
              <span className="font-medium">
                {f.values.length === 0
                  ? 'sin valor'
                  : f.values.length <= 2
                    ? f.values.join(', ')
                    : `${f.values.slice(0, 2).join(', ')} +${f.values.length - 2}`}
              </span>
              <span aria-hidden className="text-ink-4 group-hover:text-damm">
                ×
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PreviewError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="eyebrow text-damm">Sin previa</div>
      <p className="max-w-sm text-sm text-ink-3">
        No se pudo cargar la consulta. Revisa la conexión o vuelve a intentarlo en unos segundos.
      </p>
      <button
        onClick={onRetry}
        className="rounded-pill border border-hairline px-3 py-1 text-xs text-ink-2 hover:border-ink hover:text-ink"
      >
        Reintentar
      </button>
    </div>
  );
}

function PreviewEmpty({ pristine }: { pristine: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="eyebrow text-ink-4">Previa</div>
      <p className="max-w-sm text-sm text-ink-3">
        {pristine
          ? 'Ajusta la métrica, el eje y el rango en el panel de la izquierda. La previa se actualiza al instante.'
          : 'Sin datos para la combinación elegida. Prueba a ampliar el rango o quitar filtros.'}
      </p>
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
