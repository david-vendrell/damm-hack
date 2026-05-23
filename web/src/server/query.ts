import { num, query } from './duck';
import type {
  Aggregation,
  ChartConfig,
  DataQuality,
  DimensionKey,
  DimensionMeta,
  Filter,
  Granularity,
  MeasureKey,
  MeasureKind,
  MeasureMeta,
  QueryResult,
  QueryRow,
} from '@/types';

interface MeasureDef extends MeasureMeta {
  column: string;
}

interface DimensionDef extends DimensionMeta {
  sql: string;
}

const PCT: Aggregation[] = ['avg', 'median'];
const NUMERIC: Aggregation[] = ['sum', 'avg', 'median', 'min', 'max', 'p90'];
const COUNT_ONLY: Aggregation[] = ['count'];

export const MEASURES: Record<MeasureKey, MeasureDef> = {
  oee: { key: 'oee', label: 'OEE', kind: 'pct', column: 'r.oee', defaultAgg: 'avg', allowedAggs: PCT },
  disp: { key: 'disp', label: 'Disponibilidad', kind: 'pct', column: 'r.disponibilidad', defaultAgg: 'avg', allowedAggs: PCT },
  rend: { key: 'rend', label: 'Rendimiento', kind: 'pct', column: 'r.rendimiento', defaultAgg: 'avg', allowedAggs: PCT },
  inef: { key: 'inef', label: 'Ineficiencia', kind: 'pct', column: 'r.ineficiencia', defaultAgg: 'avg', allowedAggs: PCT },
  hl: { key: 'hl', label: 'Volumen (Hl)', kind: 'hl', column: 'r.hl', defaultAgg: 'sum', allowedAggs: NUMERIC },
  uds: { key: 'uds', label: 'Unidades', kind: 'units', column: 'r.uds', defaultAgg: 'sum', allowedAggs: NUMERIC },
  ofs: { key: 'ofs', label: 'Nº OFs', kind: 'count', column: '*', defaultAgg: 'count', allowedAggs: COUNT_ONLY },
  pctCambios: { key: 'pctCambios', label: '% OFs con cambio', kind: 'pct', column: 'CASE WHEN r.hubo_cambio THEN 1.0 ELSE 0.0 END', defaultAgg: 'avg', allowedAggs: PCT },
  utilizacion: { key: 'utilizacion', label: 'Utilización', kind: 'pct', column: 'r.oee', defaultAgg: 'avg', allowedAggs: PCT },
  hTotales: { key: 'hTotales', label: 'Horas totales', kind: 'hours', column: 'r.horas_totales', defaultAgg: 'sum', allowedAggs: NUMERIC },
  hMarcha: { key: 'hMarcha', label: 'Horas marcha', kind: 'hours', column: 'r.horas_marcha', defaultAgg: 'sum', allowedAggs: NUMERIC },
  hParo: { key: 'hParo', label: 'Horas paro', kind: 'hours', column: 'r.horas_paro', defaultAgg: 'sum', allowedAggs: NUMERIC },
  hPnp: { key: 'hPnp', label: 'Horas PNP', kind: 'hours', column: 'r.horas_pnp', defaultAgg: 'sum', allowedAggs: NUMERIC },
  hLimpieza: { key: 'hLimpieza', label: 'Horas limpieza', kind: 'hours', column: 'r.horas_limpieza_dentro_of', defaultAgg: 'sum', allowedAggs: NUMERIC },
  hIdle: { key: 'hIdle', label: 'Horas IDLE', kind: 'hours', column: 'r.horas_idle', defaultAgg: 'sum', allowedAggs: NUMERIC },
  hBajaVelocidad: { key: 'hBajaVelocidad', label: 'Horas baja velocidad', kind: 'hours', column: 'r.horas_baja_velocidad', defaultAgg: 'sum', allowedAggs: NUMERIC },
  hSaturacionSal: { key: 'hSaturacionSal', label: 'Horas saturación salida', kind: 'hours', column: 'r.horas_saturacion', defaultAgg: 'sum', allowedAggs: NUMERIC },
  hFaltaProducto: { key: 'hFaltaProducto', label: 'Horas falta producto', kind: 'hours', column: 'r.horas_falta_producto', defaultAgg: 'sum', allowedAggs: NUMERIC },
  hCip: { key: 'hCip', label: 'Horas CIP', kind: 'hours', column: 'r.horas_cip', defaultAgg: 'sum', allowedAggs: NUMERIC },
  hEsterilizacion: { key: 'hEsterilizacion', label: 'Horas esterilización', kind: 'hours', column: 'r.horas_esterilizacion', defaultAgg: 'sum', allowedAggs: NUMERIC },
  hCambio: { key: 'hCambio', label: 'Horas cambio', kind: 'hours', column: 'r.horas_cambio', defaultAgg: 'sum', allowedAggs: NUMERIC },
  nLlamadasMant: { key: 'nLlamadasMant', label: 'Llamadas mantenimiento', kind: 'count', column: 'r.n_llamadas_mant', defaultAgg: 'sum', allowedAggs: NUMERIC },
  hMantenimiento: { key: 'hMantenimiento', label: 'Horas mantenimiento (intervención)', kind: 'hours', column: 'r.horas_intervencion_mant', defaultAgg: 'sum', allowedAggs: NUMERIC },
  hEsperaMant: { key: 'hEsperaMant', label: 'Horas mantenimiento (espera)', kind: 'hours', column: 'r.horas_espera_mant', defaultAgg: 'sum', allowedAggs: NUMERIC },
  nDimsCambiadas: { key: 'nDimsCambiadas', label: 'Dimensiones cambiadas', kind: 'count', column: 'CAST(r.n_dimensiones_cambiadas AS INTEGER)', defaultAgg: 'sum', allowedAggs: NUMERIC },
  frecCambio: { key: 'frecCambio', label: 'Frecuencia cambio', kind: 'count', column: 'r.frecuencia_cambio', defaultAgg: 'sum', allowedAggs: NUMERIC },
};

const CANAL_SQL =
  "NULLIF(TRIM(REGEXP_REPLACE(o.canal_distribucion, '^Canal\\s*distrib\\.?\\s*', '', 'i')), '')";

export const DIMENSIONS: Record<DimensionKey, DimensionDef> = {
  mes: { key: 'mes', label: 'Mes (1-12)', temporal: true, sql: 'CAST(r.mes AS INTEGER)' },
  semanaIso: { key: 'semanaIso', label: 'Semana ISO', temporal: true, sql: 'CAST(r.semana AS INTEGER)' },
  fechaFin: { key: 'fechaFin', label: 'Fecha (fin OF)', temporal: true, sql: "STRFTIME(r.fecha_fin, '%Y-%m-%d')" },
  dia: { key: 'dia', label: 'Día', temporal: true, sql: "STRFTIME(r.fecha_fin, '%Y-%m-%d')" },
  semana: { key: 'semana', label: 'Semana', temporal: true, sql: "STRFTIME(DATE_TRUNC('week', r.fecha_fin), '%Y-%m-%d')" },
  mesIso: { key: 'mesIso', label: 'Mes', temporal: true, sql: "STRFTIME(DATE_TRUNC('month', r.fecha_fin), '%Y-%m')" },
  linea: { key: 'linea', label: 'Línea', temporal: false, sql: 'r.linea' },
  formato: { key: 'formato', label: 'Formato', temporal: false, sql: 'r.estado_volumen' },
  marca: { key: 'marca', label: 'Marca', temporal: false, sql: 'r.marca' },
  familia: { key: 'familia', label: 'Familia', temporal: false, sql: 'r.familia' },
  tipoEnvase: { key: 'tipoEnvase', label: 'Tipo envase', temporal: false, sql: 'r.tipo_envase' },
  canal: { key: 'canal', label: 'Canal', temporal: false, sql: CANAL_SQL },
  sku: { key: 'sku', label: 'SKU', temporal: false, sql: 'r.sku' },
  cambioPrincipal: { key: 'cambioPrincipal', label: 'C. PRINCIPAL', temporal: false, sql: 'r.cambio_tipo_principal' },
  turno: { key: 'turno', label: 'Definición de turno', temporal: false, sql: 'r.turno' },
  causaParo: { key: 'causaParo', label: 'Causa de paro', temporal: false, sql: '__causa_paro__' },
};

export const MEASURE_LIST: MeasureMeta[] = Object.values(MEASURES).map(
  ({ key, label, kind, defaultAgg, allowedAggs }) => ({ key, label, kind, defaultAgg, allowedAggs }),
);
export const DIMENSION_LIST: DimensionMeta[] = Object.values(DIMENSIONS).map(
  ({ key, label, temporal }) => ({ key, label, temporal }),
);

const MES_LABEL = ['', 'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

const CAUSA_COLUMNS: { label: string; col: string }[] = [
  { label: 'PNP', col: 'r.horas_pnp' },
  { label: 'Saturación salida', col: 'r.horas_saturacion' },
  { label: 'Falta producto', col: 'r.horas_falta_producto' },
  { label: 'Baja velocidad', col: 'r.horas_baja_velocidad' },
  { label: 'Limpieza', col: 'r.horas_limpieza_dentro_of' },
  { label: 'CIP', col: 'r.horas_cip' },
  { label: 'Esterilización', col: 'r.horas_esterilizacion' },
];

function aggExpr(measure: MeasureDef, agg: Aggregation): string {
  const col = measure.column;
  if (measure.kind === 'pct' && agg === 'avg') {
    if (measure.key === 'oee' || measure.key === 'disp' || measure.key === 'rend' || measure.key === 'inef') {
      return `SUM(${col} * r.hl) / NULLIF(SUM(r.hl), 0)`;
    }
    if (measure.key === 'utilizacion') {
      return 'SUM(r.horas_marcha) / NULLIF(SUM(r.horas_totales), 0)';
    }
    if (measure.key === 'pctCambios') {
      return `AVG(${col})`;
    }
    return `AVG(${col})`;
  }
  switch (agg) {
    case 'sum':
      return `SUM(${col})`;
    case 'avg':
      return `AVG(${col})`;
    case 'median':
      return `MEDIAN(${col})`;
    case 'min':
      return `MIN(${col})`;
    case 'max':
      return `MAX(${col})`;
    case 'p90':
      return `QUANTILE_CONT(${col}, 0.9)`;
    case 'count':
      return col === '*' ? 'COUNT(*)' : `COUNT(${col})`;
  }
}

interface RangeBounds {
  from?: string;
  to?: string;
}

function buildWhere(filters: Filter[], range: RangeBounds): { sql: string; params: Record<string, unknown> } {
  const clauses: string[] = ['NOT r.outlier', '(r.oee IS NULL OR r.oee <= 1)'];
  const params: Record<string, unknown> = {};
  if (range.from) {
    clauses.push('r.fecha_fin >= $dateFrom');
    params.dateFrom = range.from;
  }
  if (range.to) {
    clauses.push('r.fecha_fin <= $dateTo');
    params.dateTo = range.to;
  }
  let fi = 0;
  for (const f of filters) {
    const dim = DIMENSIONS[f.dim];
    if (!dim || dim.key === 'causaParo') continue;
    if (!f.values?.length) continue;
    const placeholders: string[] = [];
    for (let j = 0; j < f.values.length; j++) {
      const p = `f${fi}_${j}`;
      placeholders.push(`$${p}`);
      const raw = f.values[j];
      params[p] = dim.key === 'linea' ? Number(raw) : raw;
    }
    clauses.push(`${dim.sql} IN (${placeholders.join(', ')})`);
    fi++;
  }
  return { sql: clauses.join(' AND '), params };
}

function labelFor(dim: DimensionKey, k: unknown): string {
  if (k === null || k === undefined || k === '') return '—';
  if (dim === 'mes') return MES_LABEL[num(k)] ?? String(k);
  if (dim === 'semanaIso') return `S${num(k)}`;
  if (dim === 'linea') return `L${num(k)}`;
  if (dim === 'mesIso') {
    const s = String(k);
    const m = s.match(/^(\d{4})-(\d{2})$/);
    if (m) return `${MES_LABEL[Number(m[2])]} ${m[1].slice(2)}`;
    return s;
  }
  return String(k);
}

interface RunArgs {
  measure: MeasureKey;
  aggregation?: Aggregation;
  dimension?: DimensionKey;
  breakdown?: DimensionKey;
  filters?: Filter[];
  dateFrom?: string;
  dateTo?: string;
  topN?: number;
  breakdownTopN?: number;
  previousRange?: { from?: string; to?: string };
}

export async function runQuery(input: RunArgs): Promise<QueryResult> {
  const measure = MEASURES[input.measure];
  if (!measure) throw new Error('invalid_measure');
  const agg = input.aggregation && measure.allowedAggs.includes(input.aggregation)
    ? input.aggregation
    : measure.defaultAgg;

  const filters = input.filters ?? [];
  const range: RangeBounds = { from: input.dateFrom, to: input.dateTo };
  const useCausa = input.dimension === 'causaParo' || input.breakdown === 'causaParo';

  if (useCausa) {
    return runCausaQuery({
      measure: measure.key,
      dimension: input.dimension,
      breakdown: input.breakdown,
      filters,
      range,
      topN: input.topN,
      breakdownTopN: input.breakdownTopN,
    });
  }

  const dim = input.dimension ? DIMENSIONS[input.dimension] : undefined;
  const bd = input.breakdown ? DIMENSIONS[input.breakdown] : undefined;
  const { sql: whereSql, params } = buildWhere(filters, range);

  const dataQuality = await computeDataQuality(filters, range);

  if (!dim) {
    const total = await scalar(
      `SELECT ${aggExpr(measure, agg)} AS v FROM fact_runs r LEFT JOIN raw_oee o ON o.of = r.of WHERE ${whereSql}`,
      params,
    );
    let previousTotal: number | undefined;
    if (input.previousRange?.from && input.previousRange?.to) {
      const prev = buildWhere(filters, { from: input.previousRange.from, to: input.previousRange.to });
      previousTotal = await scalar(
        `SELECT ${aggExpr(measure, agg)} AS v FROM fact_runs r LEFT JOIN raw_oee o ON o.of = r.of WHERE ${prev.sql}`,
        prev.params,
      );
    }
    return {
      measure: measure.key,
      aggregation: agg,
      rows: [],
      breakdownKeys: [],
      dataQuality,
      total,
      previousTotal,
    };
  }

  const groupCols = bd
    ? `${dim.sql} AS dim_key, ${bd.sql} AS bd_key`
    : `${dim.sql} AS dim_key`;
  const groupBy = bd ? 'GROUP BY dim_key, bd_key' : 'GROUP BY dim_key';

  const sql = `
    SELECT ${groupCols}, ${aggExpr(measure, agg)} AS value
    FROM fact_runs r
    LEFT JOIN raw_oee o ON o.of = r.of
    WHERE ${whereSql}
    ${groupBy}
    ORDER BY dim_key
  `;
  const raw = await query<{ dim_key: unknown; bd_key?: unknown; value: unknown }>(sql, params);

  if (!bd) {
    let rows: QueryRow[] = raw.map((r) => ({
      key: String(r.dim_key ?? '—'),
      label: labelFor(dim.key, r.dim_key),
      value: num(r.value),
    }));
    if (!dim.temporal && input.topN && input.topN > 0) {
      rows = rows.sort((a, b) => b.value - a.value).slice(0, input.topN);
    }
    return {
      measure: measure.key,
      dimension: dim.key,
      aggregation: agg,
      rows,
      breakdownKeys: [],
      dataQuality,
    };
  }

  const byDim = new Map<string, { label: string; breakdown: Record<string, number>; key: unknown }>();
  const bdTotals = new Map<string, number>();
  for (const r of raw) {
    const dimKey = String(r.dim_key ?? '—');
    const bdKey = String(r.bd_key ?? '—');
    if (!byDim.has(dimKey)) {
      byDim.set(dimKey, { label: labelFor(dim.key, r.dim_key), breakdown: {}, key: r.dim_key });
    }
    const v = num(r.value);
    byDim.get(dimKey)!.breakdown[bdKey] = v;
    bdTotals.set(bdKey, (bdTotals.get(bdKey) ?? 0) + v);
  }
  const topN = input.breakdownTopN ?? 12;
  const breakdownKeys = [...bdTotals.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, topN)
    .map(([k]) => k);
  let rows: QueryRow[] = [...byDim.entries()].map(([key, v]) => ({
    key,
    label: v.label,
    value: Object.values(v.breakdown).reduce((a, b) => a + b, 0),
    breakdown: Object.fromEntries(breakdownKeys.map((k) => [k, v.breakdown[k] ?? 0])),
  }));
  if (!dim.temporal && input.topN && input.topN > 0) {
    rows = rows.sort((a, b) => b.value - a.value).slice(0, input.topN);
  }
  return {
    measure: measure.key,
    dimension: dim.key,
    breakdown: bd.key,
    aggregation: agg,
    rows,
    breakdownKeys,
    dataQuality,
  };
}

async function runCausaQuery(args: {
  measure: MeasureKey;
  dimension?: DimensionKey;
  breakdown?: DimensionKey;
  filters: Filter[];
  range: RangeBounds;
  topN?: number;
  breakdownTopN?: number;
}): Promise<QueryResult> {
  const causaIsDim = args.dimension === 'causaParo';
  const otherKey = causaIsDim ? args.breakdown : args.dimension;
  const other = otherKey ? DIMENSIONS[otherKey] : undefined;

  const { sql: whereSql, params } = buildWhere(args.filters, args.range);
  const dataQuality = await computeDataQuality(args.filters, args.range);

  const expandedUnion = CAUSA_COLUMNS.map(
    (c) => `SELECT '${c.label}' AS causa, COALESCE(${c.col}, 0) AS h_causa, r.* FROM base r`,
  ).join(' UNION ALL ');
  const innerSql = `
    WITH base AS (
      SELECT r.*, ${CANAL_SQL} AS canal_clean
      FROM fact_runs r
      LEFT JOIN raw_oee o ON o.of = r.of
      WHERE ${whereSql}
    ),
    expanded AS (${expandedUnion})
  `;

  const dimExpr = (k?: DimensionKey): string => {
    if (!k) return "''";
    if (k === 'causaParo') return 'causa';
    if (k === 'canal') return 'r.canal_clean';
    return DIMENSIONS[k].sql;
  };

  if (!other) {
    const sql = `${innerSql}
      SELECT causa AS dim_key, SUM(h_causa) AS value
      FROM expanded r
      GROUP BY causa
      ORDER BY value DESC`;
    const raw = await query<{ dim_key: unknown; value: unknown }>(sql, params);
    const rows: QueryRow[] = raw.map((r) => ({
      key: String(r.dim_key ?? '—'),
      label: String(r.dim_key ?? '—'),
      value: num(r.value),
    }));
    return {
      measure: 'hParo',
      dimension: 'causaParo',
      aggregation: 'sum',
      rows,
      breakdownKeys: [],
      dataQuality,
    };
  }

  const dimSqlExpr = causaIsDim ? 'causa' : dimExpr(other.key);
  const bdSqlExpr = causaIsDim ? dimExpr(other.key) : 'causa';
  const sql = `${innerSql}
    SELECT ${dimSqlExpr} AS dim_key, ${bdSqlExpr} AS bd_key, SUM(h_causa) AS value
    FROM expanded r
    GROUP BY dim_key, bd_key
    ORDER BY dim_key`;
  const raw = await query<{ dim_key: unknown; bd_key: unknown; value: unknown }>(sql, params);

  const byDim = new Map<string, { label: string; breakdown: Record<string, number> }>();
  const bdTotals = new Map<string, number>();
  for (const r of raw) {
    const dimKey = String(r.dim_key ?? '—');
    const bdKey = String(r.bd_key ?? '—');
    if (!byDim.has(dimKey)) {
      byDim.set(dimKey, { label: causaIsDim ? dimKey : labelFor(other.key, r.dim_key), breakdown: {} });
    }
    const v = num(r.value);
    byDim.get(dimKey)!.breakdown[bdKey] = v;
    bdTotals.set(bdKey, (bdTotals.get(bdKey) ?? 0) + v);
  }
  const breakdownKeys = [...bdTotals.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, args.breakdownTopN ?? 12)
    .map(([k]) => k);
  let rows: QueryRow[] = [...byDim.entries()].map(([key, v]) => ({
    key,
    label: v.label,
    value: Object.values(v.breakdown).reduce((a, b) => a + b, 0),
    breakdown: Object.fromEntries(breakdownKeys.map((k) => [k, v.breakdown[k] ?? 0])),
  }));
  const dimTemporal = causaIsDim ? false : !!other?.temporal;
  if (!dimTemporal && args.topN && args.topN > 0) {
    rows = rows.sort((a, b) => b.value - a.value).slice(0, args.topN);
  }
  return {
    measure: 'hParo',
    dimension: causaIsDim ? 'causaParo' : (other.key as DimensionKey),
    breakdown: causaIsDim ? (other.key as DimensionKey) : 'causaParo',
    aggregation: 'sum',
    rows,
    breakdownKeys,
    dataQuality,
  };
}

async function scalar(sql: string, params: Record<string, unknown>): Promise<number> {
  const r = await query<{ v: unknown }>(sql, params);
  return r.length ? num(r[0]?.v) : 0;
}

async function computeDataQuality(filters: Filter[], range: RangeBounds): Promise<DataQuality> {
  // Re-evaluate filters without the outlier/OEE-cap clauses to count exclusions.
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (range.from) {
    clauses.push('r.fecha_fin >= $dateFrom');
    params.dateFrom = range.from;
  }
  if (range.to) {
    clauses.push('r.fecha_fin <= $dateTo');
    params.dateTo = range.to;
  }
  let fi = 0;
  for (const f of filters) {
    const dim = DIMENSIONS[f.dim];
    if (!dim || dim.key === 'causaParo') continue;
    if (!f.values?.length) continue;
    const placeholders: string[] = [];
    for (let j = 0; j < f.values.length; j++) {
      const p = `q${fi}_${j}`;
      placeholders.push(`$${p}`);
      const raw = f.values[j];
      params[p] = dim.key === 'linea' ? Number(raw) : raw;
    }
    clauses.push(`${dim.sql} IN (${placeholders.join(', ')})`);
    fi++;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql = `
    SELECT
      COUNT(*) AS total,
      COUNT_IF(r.outlier) AS outliers,
      COUNT_IF(r.oee > 1) AS oeeGt1
    FROM fact_runs r
    LEFT JOIN raw_oee o ON o.of = r.of
    ${where}
  `;
  const rows = await query<{ total: unknown; outliers: unknown; oeeGt1: unknown }>(sql, params);
  const r = rows[0] ?? {};
  const total = num(r.total);
  const outliers = num(r.outliers);
  const oeeGt1 = num(r.oeeGt1);
  return {
    rowsConsidered: Math.max(0, total - outliers - oeeGt1),
    excludedOutliers: outliers,
    excludedOeeGt1: oeeGt1,
  };
}

export function granularityToDim(g: Granularity): DimensionKey {
  return g === 'day' ? 'dia' : g === 'week' ? 'semana' : 'mesIso';
}

export function configToRunArgs(c: ChartConfig): RunArgs {
  const { from, to } = resolveRange(c.dateRange);
  let dimension: DimensionKey | undefined = c.dimension;
  // If user picked a "time" pseudo-dim via granularity (no explicit dimension),
  // builder maps granularity → dim before sending; nothing to do here.
  return {
    measure: c.measure,
    aggregation: c.aggregation,
    dimension,
    breakdown: c.breakdown,
    filters: c.filters,
    dateFrom: from,
    dateTo: to,
    topN: c.topN,
  };
}

export function resolveRange(r: { from?: string; to?: string; preset?: string }): { from?: string; to?: string } {
  if (r.preset && r.preset !== 'all') {
    const today = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    if (r.preset === '7d' || r.preset === '30d' || r.preset === '90d') {
      const days = r.preset === '7d' ? 7 : r.preset === '30d' ? 30 : 90;
      const from = new Date(today);
      from.setDate(from.getDate() - days);
      return { from: iso(from), to: iso(today) };
    }
    if (r.preset === 'ytd') return { from: `${today.getFullYear()}-01-01`, to: iso(today) };
    if (r.preset === 'y2025') return { from: '2025-01-01', to: '2025-12-31' };
    if (r.preset === 'y2024') return { from: '2024-01-01', to: '2024-12-31' };
  }
  return { from: r.from || undefined, to: r.to || undefined };
}
