'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardHeader, KPI, Pill, SectionTitle, Skeleton, StatBlock, StatStrip } from '@/components/ui';
import { hl, pct, pts } from '@/lib/utils';
import type { CambioIneficienteDTO, DistribucionSku, Linea, PostMortemResumen, SkuLineaInfo } from '@/types';

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch_failed');
  return r.json();
}

export function PostMortemView() {
  const [filtroLinea, setFiltroLinea] = useState<Linea | null>(null);

  const resumen = useQuery({ queryKey: ['postmortem-resumen'], queryFn: () => jget<PostMortemResumen>('/api/postmortem/resumen') });
  const cambios = useQuery({
    queryKey: ['postmortem-cambios', filtroLinea],
    queryFn: () =>
      jget<CambioIneficienteDTO[]>(`/api/postmortem/cambios${filtroLinea ? `?linea=${filtroLinea}` : ''}`),
  });
  const skus = useQuery({ queryKey: ['postmortem-skus'], queryFn: () => jget<SkuLineaInfo[]>('/api/postmortem/skus') });

  return (
    <div className="space-y-10">
      <header>
        <SectionTitle subtitle="Evidencia del histórico: dónde se está perdiendo OEE y por qué.">Análisis post mortem</SectionTitle>
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
            <StatBlock
              label="Hl latentes"
              value={hl(resumen.data.hlLatente)}
              accent="gold"
              divider
            />
            <StatBlock
              label="OFs analizadas"
              value={resumen.data.ofsAnalizadas.toLocaleString('es-ES')}
            />
          </StatStrip>
        )}
      </section>

      {/* Pérdida por línea */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader title="Pérdida evitable por línea" subtitle="puntos de OEE entre lo ejecutado y lo alcanzable" />
          <div className="h-64 px-3 py-4">
            {resumen.isLoading || !resumen.data ? (
              <Skeleton className="h-full" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={resumen.data.porLinea} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                  <CartesianGrid stroke="#E6E0D6" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="linea" tickFormatter={(v) => `L${v}`} stroke="#6B6B6B" tick={{ fontSize: 12 }} />
                  <YAxis stroke="#6B6B6B" tick={{ fontSize: 12 }} unit=" pts" />
                  <Tooltip
                    cursor={{ fill: 'rgba(0,0,0,0.03)' }}
                    contentStyle={{ background: '#fff', border: '1px solid #E6E0D6', borderRadius: 8 }}
                    formatter={(v: number) => `${v.toFixed(1)} pts`}
                    labelFormatter={(l) => `Línea ${l}`}
                  />
                  <Bar dataKey="perdidaPts" radius={[6, 6, 0, 0]}>
                    {resumen.data.porLinea.map((d, i) => (
                      <Cell key={i} fill={d.linea === 14 ? '#7E1116' : '#A4161A'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="OEE ejecutado vs alcanzable" subtitle="por línea, media 2025" />
          <div className="space-y-3 px-5 py-4">
            {resumen.data?.porLinea.map((l) => (
              <div key={l.linea}>
                <div className="mb-1.5 flex items-center justify-between text-sm">
                  <span className="font-medium">Línea {l.linea}</span>
                  <span className="num text-muted">{pct(l.oeeEjecutado)} → {pct(l.oeeAlcanzable)}</span>
                </div>
                <div className="relative h-2 overflow-hidden rounded-full bg-hairline">
                  <div className="absolute inset-y-0 left-0 bg-damm" style={{ width: `${l.oeeEjecutado * 100}%` }} />
                  <div className="absolute inset-y-0 w-px bg-ink" style={{ left: `${l.oeeAlcanzable * 100}%` }} />
                </div>
                <div className="mt-1 text-xs text-muted">brecha {l.perdidaPts.toFixed(1)} pts</div>
              </div>
            ))}
          </div>
        </Card>
      </section>

      {/* Tabla cambios ineficientes */}
      <section>
        <Card>
          <CardHeader
            title="Peores cambios del histórico"
            subtitle="ordenados por puntos de OEE perdidos vs alcanzable"
            action={
              <div className="flex gap-1.5">
                <Pill active={filtroLinea === null} onClick={() => setFiltroLinea(null)}>Todas</Pill>
                {[14, 17, 19].map((l) => (
                  <Pill key={l} active={filtroLinea === l} onClick={() => setFiltroLinea(l as Linea)}>
                    L{l}
                  </Pill>
                ))}
              </div>
            }
          />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-hairline text-left text-xs uppercase tracking-wider text-muted">
                  <th className="px-5 py-3">OF</th>
                  <th className="px-5 py-3">Línea</th>
                  <th className="px-5 py-3">Fecha</th>
                  <th className="px-5 py-3">Cambio</th>
                  <th className="px-5 py-3 text-right">OEE real</th>
                  <th className="px-5 py-3 text-right">Alcanzable</th>
                  <th className="px-5 py-3 text-right">Perdidos</th>
                  <th className="px-5 py-3">Motivo</th>
                </tr>
              </thead>
              <tbody>
                {cambios.isLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <tr key={i}>
                      <td colSpan={8} className="px-5 py-3"><Skeleton className="h-6" /></td>
                    </tr>
                  ))
                ) : (
                  cambios.data?.map((c, i) => (
                    <tr key={i} className="border-b border-hairline last:border-0">
                      <td className="px-5 py-3 font-mono text-xs">{c.of}</td>
                      <td className="px-5 py-3 num">L{c.linea}</td>
                      <td className="px-5 py-3 num">{c.fecha}</td>
                      <td className="px-5 py-3">
                        <span className="inline-flex items-center gap-2">
                          <span className="rounded bg-cream px-1.5 py-0.5 font-mono text-xs">{c.skuAnterior}</span>
                          <span className="text-muted">→</span>
                          <span className="rounded bg-cream px-1.5 py-0.5 font-mono text-xs">{c.skuActual}</span>
                          <span className={c.tipoCambio === 'formato' ? 'text-damm' : 'text-muted'} >({c.tipoCambio})</span>
                        </span>
                      </td>
                      <td className="px-5 py-3 text-right num">{pct(c.oeeReal)}</td>
                      <td className="px-5 py-3 text-right num text-muted">{pct(c.oeeAlcanzable)}</td>
                      <td className="px-5 py-3 text-right num font-semibold text-damm">{pts(-c.ptsPerdidos)}</td>
                      <td className="px-5 py-3 text-xs text-muted">{c.motivo}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </section>

      {/* Explorador SKU+línea */}
      <SkuExplorer skus={skus.data ?? []} />
    </div>
  );
}

function SkuExplorer({ skus }: { skus: SkuLineaInfo[] }) {
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
  });

  const points = useMemo(() => {
    if (!dist.data) return [] as { x: number; y: number }[];
    return dist.data.valoresOee.map((y, i) => ({ x: i + 1, y: y * 100 }));
  }, [dist.data]);

  return (
    <section>
      <Card>
        <CardHeader title="Explorador SKU + línea" subtitle="distribución del OEE histórico para un SKU en una línea concreta" />
        <div className="grid grid-cols-1 gap-6 px-5 py-5 lg:grid-cols-[260px_1fr]">
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs uppercase tracking-wider text-muted">SKU</label>
              <select
                value={sku ?? ''}
                onChange={(e) => { setSku(e.target.value || null); setLinea(null); }}
                className="w-full rounded border border-hairline bg-surface px-3 py-2 text-sm focus:border-ink focus:outline-none"
              >
                <option value="">— elige un SKU —</option>
                {skus.map((s) => (
                  <option key={s.codigo} value={s.codigo}>{s.nombre} ({s.codigo})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs uppercase tracking-wider text-muted">Línea</label>
              <div className="flex gap-1.5">
                {[14, 17, 19].map((l) => (
                  <Pill
                    key={l}
                    active={linea === l}
                    onClick={() => available.includes(l as Linea) && setLinea(l as Linea)}
                  >
                    <span className={available.includes(l as Linea) ? '' : 'opacity-30'}>L{l}</span>
                  </Pill>
                ))}
              </div>
            </div>
            {dist.data && (
              <div className="space-y-2 pt-2 text-sm">
                <div className="flex justify-between"><span className="text-muted">Mediana</span><span className="num font-medium">{pct(dist.data.mediana)}</span></div>
                <div className="flex justify-between"><span className="text-muted">Alcanzable (p80)</span><span className="num font-medium text-good">{pct(dist.data.alcanzable)}</span></div>
                <div className="flex justify-between"><span className="text-muted">Observaciones</span><span className="num">{dist.data.valoresOee.length}</span></div>
              </div>
            )}
          </div>

          <div className="h-72 rounded-soft border border-hairline bg-cream/40 p-3">
            {!sku || !linea ? (
              <div className="flex h-full items-center justify-center text-sm text-muted">Selecciona un SKU y una línea</div>
            ) : dist.isLoading ? (
              <Skeleton className="h-full" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 8, right: 16, bottom: 16, left: 4 }}>
                  <CartesianGrid stroke="#E6E0D6" strokeDasharray="3 3" />
                  <XAxis type="number" dataKey="x" name="OF" stroke="#6B6B6B" tick={{ fontSize: 12 }} domain={[0, 'dataMax']} />
                  <YAxis type="number" dataKey="y" name="OEE" stroke="#6B6B6B" tick={{ fontSize: 12 }} unit="%" domain={[0, 100]} />
                  <Tooltip
                    cursor={{ stroke: '#E6E0D6' }}
                    contentStyle={{ background: '#fff', border: '1px solid #E6E0D6', borderRadius: 8 }}
                    formatter={(v: number, k: string) => k === 'y' ? `${v.toFixed(0)}%` : v}
                  />
                  {dist.data && (
                    <>
                      <ReferenceLine y={dist.data.mediana * 100} stroke="#6B6B6B" strokeDasharray="4 4" label={{ value: 'mediana', fill: '#6B6B6B', fontSize: 11, position: 'right' }} />
                      <ReferenceLine y={dist.data.alcanzable * 100} stroke="#2E7D32" strokeDasharray="4 4" label={{ value: 'alcanzable', fill: '#2E7D32', fontSize: 11, position: 'right' }} />
                    </>
                  )}
                  <Scatter data={points} fill="#A4161A" />
                </ScatterChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </Card>
    </section>
  );
}
