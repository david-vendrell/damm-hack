'use client';

import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { hl as fmtHl, pct as fmtPct } from '@/lib/utils';
import type { MeasureKind, MeasureMeta, QueryResult, VizType } from '@/types';

export const PALETTE = [
  '#A4161A',
  '#7E1116',
  '#D85D62',
  '#5C7A8A',
  '#C19A6B',
  '#3F1F1F',
  '#7A5C3B',
  '#6B8E4E',
  '#B6884A',
  '#2E5C7A',
  '#A35A3D',
  '#4C4452',
];
const COLOR_DAMM = '#A4161A';
const COLOR_MUTED = '#6B6B6B';

function formatterFor(kind: MeasureKind | undefined): (v: number) => string {
  if (!kind) return (v) => String(v);
  switch (kind) {
    case 'pct':
      return (v) => fmtPct(v, 1);
    case 'hl':
      return (v) => fmtHl(v);
    case 'hours':
      return (v) => `${Math.round(v).toLocaleString('es-ES')} h`;
    case 'units':
    case 'count':
      return (v) => Math.round(v).toLocaleString('es-ES');
  }
}

function yTickFor(kind: MeasureKind | undefined): (v: number) => string {
  if (!kind) return (v) => String(v);
  if (kind === 'pct') return (v) => `${Math.round(v * 100)}%`;
  return (v) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v));
}

export function resolveViz(viz: VizType, data: QueryResult, dimTemporal: boolean): Exclude<VizType, 'auto'> {
  if (viz !== 'auto') return viz;
  if (!data.dimension) return 'bigNumber';
  if (dimTemporal && data.breakdown) return 'line';
  if (dimTemporal) return 'line';
  if (data.breakdown) return 'stackedBar';
  return 'bar';
}

interface PreviewProps {
  data: QueryResult;
  measure: MeasureMeta | undefined;
  viz: VizType;
  dimTemporal: boolean;
  height?: number;
  compact?: boolean;
}

export function ChartPreview({ data, measure, viz, dimTemporal, height = 320, compact }: PreviewProps) {
  const formatter = useMemo(() => formatterFor(measure?.kind), [measure]);
  const yTick = useMemo(() => yTickFor(measure?.kind), [measure]);
  const resolved = resolveViz(viz, data, dimTemporal);

  const chartData = useMemo(() => {
    if (data.breakdownKeys.length) {
      return data.rows.map((r) => ({ label: r.label, ...(r.breakdown ?? {}) }));
    }
    return data.rows.map((r) => ({ label: r.label, value: r.value }));
  }, [data]);

  if (resolved === 'bigNumber') {
    const v = data.total ?? data.rows.reduce((a, r) => a + r.value, 0);
    const prev = data.previousTotal;
    const delta = typeof prev === 'number' && prev !== 0 ? (v - prev) / Math.abs(prev) : undefined;
    const deltaAbs = typeof prev === 'number' ? v - prev : undefined;
    return (
      <div className="flex h-full flex-col justify-center px-6 py-8">
        <div className="text-xs uppercase tracking-wider text-muted">
          {measure?.label ?? '—'}
        </div>
        <div className="num mt-2 text-5xl font-semibold tracking-tight text-ink">
          {formatter(v)}
        </div>
        {typeof deltaAbs === 'number' && (
          <div
            className={`mt-2 text-sm num ${
              deltaAbs > 0 ? 'text-good' : deltaAbs < 0 ? 'text-damm' : 'text-muted'
            }`}
          >
            {deltaAbs > 0 ? '▲' : deltaAbs < 0 ? '▼' : '·'} {formatter(Math.abs(deltaAbs))}
            {typeof delta === 'number' && (
              <span className="ml-2 text-muted">
                ({delta > 0 ? '+' : ''}
                {(delta * 100).toFixed(1)}% vs período previo)
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  if (resolved === 'table') {
    const cols = data.breakdownKeys.length ? data.breakdownKeys : ['value'];
    return (
      <div className="h-full overflow-auto px-3 py-2">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 bg-surface">
            <tr className="border-b border-hairline text-left text-xs uppercase tracking-wider text-muted">
              <th className="px-3 py-2 font-medium">Dimensión</th>
              {cols.map((c) => (
                <th key={c} className="px-3 py-2 text-right font-medium num">
                  {c === 'value' ? measure?.label ?? 'Valor' : c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.key} className="border-b border-hairline/60">
                <td className="px-3 py-1.5">{r.label}</td>
                {cols.map((c) => (
                  <td key={c} className="px-3 py-1.5 text-right num">
                    {formatter(c === 'value' ? r.value : r.breakdown?.[c] ?? 0)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (resolved === 'donut') {
    const slices = data.breakdownKeys.length
      ? data.breakdownKeys.map((k, i) => ({
          name: k,
          value: data.rows.reduce((a, r) => a + (r.breakdown?.[k] ?? 0), 0),
          fill: PALETTE[i % PALETTE.length],
        }))
      : data.rows.map((r, i) => ({
          name: r.label,
          value: r.value,
          fill: PALETTE[i % PALETTE.length],
        }));
    return (
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Tooltip
            formatter={(v: number) => formatter(v)}
            contentStyle={{ background: '#fff', border: '1px solid #E6E0D6', borderRadius: 8 }}
          />
          {!compact && <Legend wrapperStyle={{ fontSize: 12 }} />}
          <Pie
            data={slices}
            dataKey="value"
            nameKey="name"
            innerRadius={compact ? '45%' : '55%'}
            outerRadius={compact ? '80%' : '85%'}
            strokeWidth={1}
          >
            {slices.map((s, i) => (
              <Cell key={i} fill={s.fill} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (resolved === 'line') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
          <CartesianGrid stroke="#E6E0D6" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" stroke={COLOR_MUTED} tick={{ fontSize: 12 }} interval="preserveStartEnd" />
          <YAxis
            stroke={COLOR_MUTED}
            tick={{ fontSize: 12 }}
            tickFormatter={yTick}
            domain={measure?.kind === 'pct' ? [0, 1] : undefined}
          />
          <Tooltip
            cursor={{ stroke: '#E6E0D6' }}
            contentStyle={{ background: '#fff', border: '1px solid #E6E0D6', borderRadius: 8 }}
            formatter={(v: number) => formatter(v)}
          />
          {data.breakdownKeys.length ? (
            <>
              {!compact && <Legend wrapperStyle={{ fontSize: 12 }} />}
              {data.breakdownKeys.map((k, i) => (
                <Line
                  key={k}
                  type="monotone"
                  dataKey={k}
                  stroke={PALETTE[i % PALETTE.length]}
                  dot={false}
                  strokeWidth={2}
                />
              ))}
            </>
          ) : (
            <Line
              type="monotone"
              dataKey="value"
              stroke={COLOR_DAMM}
              dot={false}
              strokeWidth={2.5}
              name={measure?.label ?? 'Valor'}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  const stackId = resolved === 'stackedBar' ? 'st' : undefined;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
        <CartesianGrid stroke="#E6E0D6" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" stroke={COLOR_MUTED} tick={{ fontSize: 12 }} interval={0} angle={chartData.length > 8 ? -20 : 0} textAnchor={chartData.length > 8 ? 'end' : 'middle'} height={chartData.length > 8 ? 50 : 30} />
        <YAxis
          stroke={COLOR_MUTED}
          tick={{ fontSize: 12 }}
          tickFormatter={yTick}
          domain={measure?.kind === 'pct' ? [0, 1] : undefined}
        />
        <Tooltip
          cursor={{ fill: 'rgba(0,0,0,0.03)' }}
          contentStyle={{ background: '#fff', border: '1px solid #E6E0D6', borderRadius: 8 }}
          formatter={(v: number) => formatter(v)}
        />
        {data.breakdownKeys.length ? (
          <>
            {!compact && <Legend wrapperStyle={{ fontSize: 12 }} />}
            {data.breakdownKeys.map((k, i) => (
              <Bar
                key={k}
                dataKey={k}
                stackId={stackId}
                fill={PALETTE[i % PALETTE.length]}
                radius={i === data.breakdownKeys.length - 1 && stackId ? [4, 4, 0, 0] : 0}
              />
            ))}
          </>
        ) : (
          <Bar dataKey="value" radius={[6, 6, 0, 0]} name={measure?.label ?? 'Valor'}>
            {chartData.map((_, i) => (
              <Cell key={i} fill={COLOR_DAMM} />
            ))}
          </Bar>
        )}
      </BarChart>
    </ResponsiveContainer>
  );
}
