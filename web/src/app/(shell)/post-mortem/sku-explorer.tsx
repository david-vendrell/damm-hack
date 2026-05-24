'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardHeader, Pill, Skeleton } from '@/components/ui';
import { pct } from '@/lib/utils';
import type { DistribucionSku, Linea, SkuLineaInfo } from '@/types';

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch_failed');
  return r.json();
}

const LINEA_COLOR: Record<Linea, string> = {
  14: '#7E1116',
  17: '#A4161A',
  19: '#D85D62',
};

export function SkuExplorer({ skus }: { skus: SkuLineaInfo[] }) {
  const [sku, setSku] = useState<string | null>(null);
  const [linea, setLinea] = useState<Linea | null>(null);

  const available = useMemo(() => {
    if (!sku) return [] as Linea[];
    const s = skus.find((s) => s.codigo === sku);
    return s?.lineas.map((l) => l.linea) ?? [];
  }, [sku, skus]);

  const dist = useQuery({
    queryKey: ['dist', sku, linea],
    enabled: !!sku && !!linea,
    queryFn: () => jget<DistribucionSku>(`/api/postmortem/distribucion?sku=${sku}&linea=${linea}`),
    staleTime: 60_000,
  });

  const scatterPoints = useMemo(() => {
    if (!dist.data) return [] as { x: number; y: number }[];
    return dist.data.valoresOee.map((y, i) => ({ x: i + 1, y: y * 100 }));
  }, [dist.data]);

  const histogramData = useMemo(() => {
    if (!dist.data?.histograma) return [] as { bucket: string; count: number }[];
    return dist.data.histograma.map((b) => ({ bucket: b.bucket, count: b.count }));
  }, [dist.data]);

  const lineColor = linea ? LINEA_COLOR[linea] : '#A4161A';
  const percentiles = dist.data?.percentiles;

  return (
    <section>
      <Card>
        <CardHeader
          title="Explorador SKU + línea"
          subtitle="distribución, tendencia semanal y percentiles del OEE histórico"
        />
        <div className="grid grid-cols-1 gap-6 px-5 py-5 lg:grid-cols-[260px_1fr]">
          {/* Left rail: pickers + stats */}
          <div className="space-y-4">
            <div>
              <label
                htmlFor="sku-select"
                className="mb-1.5 block text-xs uppercase tracking-wider text-ink-3"
              >
                SKU
              </label>
              <select
                id="sku-select"
                value={sku ?? ''}
                onChange={(e) => {
                  setSku(e.target.value || null);
                  setLinea(null);
                }}
                className="w-full rounded-soft border border-hairline bg-surface px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
              >
                <option value="">Elige un SKU</option>
                {skus.map((s) => (
                  <option key={s.codigo} value={s.codigo}>
                    {s.nombre} ({s.codigo})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <span className="mb-1.5 block text-xs uppercase tracking-wider text-ink-3">Línea</span>
              <div className="flex gap-1.5">
                {[14, 17, 19].map((l) => {
                  const enabled = available.includes(l as Linea);
                  return (
                    <Pill
                      key={l}
                      active={linea === l}
                      onClick={() => enabled && setLinea(l as Linea)}
                    >
                      <span className={enabled ? '' : 'opacity-30'}>L{l}</span>
                    </Pill>
                  );
                })}
              </div>
            </div>

            {dist.data && (
              <div className="space-y-2 pt-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-ink-3">Mediana</span>
                  <span className="num font-medium">{pct(dist.data.mediana)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-3">Alcanzable (p80)</span>
                  <span className="num font-medium text-moss">{pct(dist.data.alcanzable)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-3">Observaciones</span>
                  <span className="num">{dist.data.valoresOee.length}</span>
                </div>
                {percentiles && (
                  <div className="mt-3 space-y-1 border-t border-hairline pt-3">
                    <div className="eyebrow mb-1 text-ink-4">Percentiles</div>
                    <div className="flex justify-between text-xs">
                      <span className="text-ink-3">p25</span>
                      <span className="num">{pct(percentiles.p25)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-ink-3">p50</span>
                      <span className="num">{pct(percentiles.p50)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-ink-3">p75</span>
                      <span className="num">{pct(percentiles.p75)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-ink-3">p90</span>
                      <span className="num">{pct(percentiles.p90)}</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right: three stacked charts */}
          <div className="space-y-6">
            {/* Scatter (existing + percentile reference lines) */}
            <div className="h-64 rounded-soft border border-hairline bg-cream/40 p-3">
              <div className="eyebrow mb-1.5 px-1 text-ink-3">Cada OF (orden cronológico)</div>
              {!sku || !linea ? (
                <div className="flex h-full items-center justify-center text-sm text-ink-3">
                  Selecciona un SKU y una línea
                </div>
              ) : dist.isLoading ? (
                <Skeleton className="h-full" />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ScatterChart margin={{ top: 8, right: 16, bottom: 16, left: 4 }}>
                    <CartesianGrid stroke="#E6E0D6" strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      type="number"
                      dataKey="x"
                      name="OF"
                      stroke="#6B6B6B"
                      tick={{ fontSize: 12 }}
                      domain={[0, 'dataMax']}
                    />
                    <YAxis
                      type="number"
                      dataKey="y"
                      name="OEE"
                      stroke="#6B6B6B"
                      tick={{ fontSize: 12 }}
                      unit="%"
                      domain={[0, 100]}
                    />
                    <Tooltip
                      cursor={{ stroke: '#E6E0D6' }}
                      contentStyle={{ background: '#FFFFFF', border: '1px solid #E8E1D3', borderRadius: 8 }}
                      formatter={(v: number, k: string) => (k === 'y' ? `${v.toFixed(0)}%` : v)}
                    />
                    {percentiles && (
                      <>
                        <ReferenceLine
                          y={percentiles.p25 * 100}
                          stroke="#A39B8C"
                          strokeDasharray="2 4"
                          label={{ value: 'p25', fill: '#A39B8C', fontSize: 10, position: 'left' }}
                        />
                        <ReferenceLine
                          y={percentiles.p50 * 100}
                          stroke="#6E665B"
                          strokeDasharray="4 4"
                          label={{ value: 'p50', fill: '#6E665B', fontSize: 11, position: 'right' }}
                        />
                        <ReferenceLine
                          y={percentiles.p75 * 100}
                          stroke="#6E665B"
                          strokeDasharray="2 4"
                          label={{ value: 'p75', fill: '#6E665B', fontSize: 10, position: 'left' }}
                        />
                        <ReferenceLine
                          y={percentiles.p90 * 100}
                          stroke="#3F7A52"
                          strokeDasharray="4 4"
                          label={{ value: 'p90', fill: '#3F7A52', fontSize: 11, position: 'right' }}
                        />
                      </>
                    )}
                    <Scatter data={scatterPoints} fill={lineColor} />
                  </ScatterChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Histogram */}
            <div className="h-56 rounded-soft border border-hairline bg-cream/40 p-3">
              <div className="eyebrow mb-1.5 px-1 text-ink-3">Distribución (10 buckets)</div>
              {!sku || !linea ? (
                <div className="flex h-full items-center justify-center text-sm text-ink-3">
                  Selecciona un SKU y una línea
                </div>
              ) : dist.isLoading ? (
                <Skeleton className="h-full" />
              ) : histogramData.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-ink-3">
                  Sin observaciones suficientes para el histograma.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={histogramData} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
                    <CartesianGrid stroke="#E6E0D6" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="bucket" stroke="#6B6B6B" tick={{ fontSize: 11 }} />
                    <YAxis stroke="#6B6B6B" tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip
                      cursor={{ fill: 'rgba(0,0,0,0.03)' }}
                      contentStyle={{ background: '#FFFFFF', border: '1px solid #E8E1D3', borderRadius: 8 }}
                      formatter={(v: number) => [`${v} OFs`, 'Recuento']}
                    />
                    <Bar dataKey="count" fill={lineColor} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>
      </Card>
    </section>
  );
}
