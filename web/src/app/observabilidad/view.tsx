'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardHeader, KPI, Pill, SectionTitle, Skeleton } from '@/components/ui';
import { hl, pct } from '@/lib/utils';
import type { Linea, ObservabilidadData, ObservabilidadDimensiones } from '@/types';

const LINEAS: Linea[] = [14, 17, 19];
const COLOR_DAMM = '#A4161A';
const COLOR_DAMM_DARK = '#7E1116';
const COLOR_LINE_14 = '#7E1116';
const COLOR_LINE_17 = '#A4161A';
const COLOR_LINE_19 = '#D85D62';
const MES_LABEL = ['', 'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch_failed');
  return r.json();
}

interface Filtros {
  anio?: number;
  linea?: Linea;
  marca?: string;
  formato?: string;
  canal?: string;
}

function qs(f: Filtros): string {
  const sp = new URLSearchParams();
  if (f.anio) sp.set('anio', String(f.anio));
  if (f.linea) sp.set('linea', String(f.linea));
  if (f.marca) sp.set('marca', f.marca);
  if (f.formato) sp.set('formato', f.formato);
  if (f.canal) sp.set('canal', f.canal);
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export function ObservabilidadView() {
  const dims = useQuery({
    queryKey: ['obs-dimensiones'],
    queryFn: () => jget<ObservabilidadDimensiones>('/api/observabilidad/dimensiones'),
  });

  const [filtros, setFiltros] = useState<Filtros>({});
  const [granularidad, setGranularidad] = useState<'semanal' | 'mensual'>('mensual');
  const [overlay, setOverlay] = useState(false);

  // Default año = más reciente
  const defaultAnio = dims.data?.anios[0];
  const efectivos: Filtros = {
    anio: filtros.anio ?? defaultAnio,
    linea: filtros.linea,
    marca: filtros.marca,
    formato: filtros.formato,
    canal: filtros.canal,
  };

  const data = useQuery({
    queryKey: ['obs', efectivos],
    enabled: !!efectivos.anio || dims.data !== undefined,
    queryFn: () => jget<ObservabilidadData>(`/api/observabilidad${qs(efectivos)}`),
  });

  // Comparativa año anterior (KPIs)
  const prevAnio = efectivos.anio ? efectivos.anio - 1 : undefined;
  const prev = useQuery({
    queryKey: ['obs-prev', { ...efectivos, anio: prevAnio }],
    enabled: !!prevAnio && (dims.data?.anios ?? []).includes(prevAnio),
    queryFn: () =>
      jget<ObservabilidadData>(
        `/api/observabilidad${qs({ ...efectivos, anio: prevAnio })}`,
      ),
  });

  const d = data.data;
  const cargando = data.isLoading || !d;
  const vacio = !cargando && d.kpis.ofs === 0;

  return (
    <div className="space-y-10">
      <header className="flex items-end justify-between gap-6">
        <SectionTitle subtitle="Histórico real de líneas 14 · 17 · 19 — El Prat.">
          Observabilidad
        </SectionTitle>
        {d?.rangoFechas && (
          <div className="pb-1 text-xs text-muted num">
            {d.rangoFechas.desde} → {d.rangoFechas.hasta}
          </div>
        )}
      </header>

      {/* Filtros */}
      <Card>
        <div className="grid grid-cols-2 gap-4 px-5 py-4 md:grid-cols-5">
          <Select
            label="Año"
            value={efectivos.anio ? String(efectivos.anio) : ''}
            options={(dims.data?.anios ?? []).map((a) => ({ v: String(a), l: String(a) }))}
            onChange={(v) => setFiltros((f) => ({ ...f, anio: v ? Number(v) : undefined }))}
            placeholder="Todos"
          />
          <Select
            label="Línea"
            value={efectivos.linea ? String(efectivos.linea) : ''}
            options={(dims.data?.lineas ?? []).map((l) => ({ v: String(l), l: `Línea ${l}` }))}
            onChange={(v) =>
              setFiltros((f) => ({ ...f, linea: v ? (Number(v) as Linea) : undefined }))
            }
            placeholder="Todas"
          />
          <Select
            label="Marca"
            value={efectivos.marca ?? ''}
            options={(dims.data?.marcas ?? []).map((m) => ({ v: m, l: m }))}
            onChange={(v) => setFiltros((f) => ({ ...f, marca: v || undefined }))}
            placeholder="Todas"
          />
          <Select
            label="Formato"
            value={efectivos.formato ?? ''}
            options={(dims.data?.formatos ?? []).map((f) => ({ v: f, l: f }))}
            onChange={(v) => setFiltros((f) => ({ ...f, formato: v || undefined }))}
            placeholder="Todos"
          />
          <Select
            label="Canal"
            value={efectivos.canal ?? ''}
            options={(dims.data?.canales ?? []).map((c) => ({ v: c, l: c }))}
            onChange={(v) => setFiltros((f) => ({ ...f, canal: v || undefined }))}
            placeholder="Todos"
          />
        </div>
      </Card>

      {/* KPIs */}
      <section
        aria-label="Indicadores principales"
        className="grid grid-cols-2 gap-4 md:grid-cols-5"
      >
        {cargando ? (
          Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24" />)
        ) : (
          <>
            <Kpi
              label="OEE"
              value={pct(d.kpis.oee, 1)}
              delta={deltaPts(d.kpis.oee, prev.data?.kpis.oee)}
              accent
            />
            <Kpi
              label="Disponibilidad"
              value={pct(d.kpis.disponibilidad, 1)}
              delta={deltaPts(d.kpis.disponibilidad, prev.data?.kpis.disponibilidad)}
            />
            <Kpi
              label="Rendimiento"
              value={pct(d.kpis.rendimiento, 1)}
              delta={deltaPts(d.kpis.rendimiento, prev.data?.kpis.rendimiento)}
            />
            <Kpi
              label="Volumen"
              value={hl(d.kpis.volumenHl)}
              delta={deltaPct(d.kpis.volumenHl, prev.data?.kpis.volumenHl)}
            />
            <Kpi
              label="OFs con cambio"
              value={pct(d.kpis.pctCambios, 0)}
              hint={`${d.kpis.ofs.toLocaleString('es-ES')} OFs`}
              delta={deltaPts(d.kpis.pctCambios, prev.data?.kpis.pctCambios)}
            />
          </>
        )}
      </section>

      {vacio && (
        <Card>
          <div className="px-6 py-10 text-center text-sm text-muted">
            No hay OFs con los filtros seleccionados.
          </div>
        </Card>
      )}

      {!vacio && (
        <>
          {/* OEE temporal */}
          <section aria-label="OEE en el tiempo">
            <Card>
              <CardHeader
                title="OEE en el tiempo"
                subtitle="ponderado por hectolitros producidos"
                action={
                  <div className="flex items-center gap-2">
                    <div className="flex gap-1.5">
                      <Pill
                        active={granularidad === 'semanal'}
                        onClick={() => setGranularidad('semanal')}
                      >
                        Semanal
                      </Pill>
                      <Pill
                        active={granularidad === 'mensual'}
                        onClick={() => setGranularidad('mensual')}
                      >
                        Mensual
                      </Pill>
                    </div>
                    <span className="ml-3 h-4 w-px bg-hairline" />
                    <Pill active={overlay} onClick={() => setOverlay((o) => !o)}>
                      Comparar líneas
                    </Pill>
                  </div>
                }
              />
              <div className="h-72 px-3 py-4">
                {cargando ? (
                  <Skeleton className="h-full" />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={serieTemporal(d, granularidad)}
                      margin={{ top: 8, right: 16, left: 0, bottom: 8 }}
                    >
                      <CartesianGrid stroke="#E6E0D6" strokeDasharray="3 3" vertical={false} />
                      <XAxis
                        dataKey="label"
                        stroke="#6B6B6B"
                        tick={{ fontSize: 12 }}
                      />
                      <YAxis
                        stroke="#6B6B6B"
                        tick={{ fontSize: 12 }}
                        domain={[0, 1]}
                        tickFormatter={(v) => `${Math.round(v * 100)}%`}
                      />
                      <Tooltip
                        cursor={{ stroke: '#E6E0D6' }}
                        contentStyle={{
                          background: '#fff',
                          border: '1px solid #E6E0D6',
                          borderRadius: 8,
                        }}
                        formatter={(v: number, name: string) => [
                          `${(v * 100).toFixed(1)}%`,
                          name,
                        ]}
                      />
                      {overlay && <Legend wrapperStyle={{ fontSize: 12 }} />}
                      {overlay ? (
                        <>
                          <Line
                            type="monotone"
                            dataKey="L14"
                            stroke={COLOR_LINE_14}
                            dot={false}
                            strokeWidth={2}
                          />
                          <Line
                            type="monotone"
                            dataKey="L17"
                            stroke={COLOR_LINE_17}
                            dot={false}
                            strokeWidth={2}
                          />
                          <Line
                            type="monotone"
                            dataKey="L19"
                            stroke={COLOR_LINE_19}
                            dot={false}
                            strokeWidth={2}
                          />
                        </>
                      ) : (
                        <Line
                          type="monotone"
                          dataKey="OEE"
                          stroke={COLOR_DAMM}
                          dot={false}
                          strokeWidth={2.5}
                        />
                      )}
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </Card>
          </section>

          {/* OEE por línea + Pérdidas */}
          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card aria-label="OEE por línea">
              <CardHeader title="OEE por línea" subtitle="media 2025 ponderada por hl" />
              <div className="h-64 px-3 py-4">
                {cargando ? (
                  <Skeleton className="h-full" />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={d.oeePorLinea}
                      margin={{ top: 8, right: 16, left: 0, bottom: 8 }}
                    >
                      <CartesianGrid
                        stroke="#E6E0D6"
                        strokeDasharray="3 3"
                        vertical={false}
                      />
                      <XAxis
                        dataKey="linea"
                        tickFormatter={(v) => `L${v}`}
                        stroke="#6B6B6B"
                        tick={{ fontSize: 12 }}
                      />
                      <YAxis
                        stroke="#6B6B6B"
                        tick={{ fontSize: 12 }}
                        domain={[0, 1]}
                        tickFormatter={(v) => `${Math.round(v * 100)}%`}
                      />
                      <Tooltip
                        cursor={{ fill: 'rgba(0,0,0,0.03)' }}
                        contentStyle={{
                          background: '#fff',
                          border: '1px solid #E6E0D6',
                          borderRadius: 8,
                        }}
                        formatter={(v: number) => pct(v, 1)}
                        labelFormatter={(l) => `Línea ${l}`}
                      />
                      <Bar dataKey="oee" radius={[6, 6, 0, 0]}>
                        {d.oeePorLinea.map((row) => (
                          <Cell
                            key={row.linea}
                            fill={row.linea === 14 ? COLOR_DAMM_DARK : COLOR_DAMM}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </Card>

            <Card aria-label="Pérdidas de tiempo">
              <CardHeader
                title="¿Dónde se va el tiempo?"
                subtitle="horas totales por concepto de pérdida"
              />
              <div className="h-64 px-3 py-4">
                {cargando ? (
                  <Skeleton className="h-full" />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={d.perdidasTiempo}
                      layout="vertical"
                      margin={{ top: 4, right: 24, left: 8, bottom: 4 }}
                    >
                      <CartesianGrid
                        stroke="#E6E0D6"
                        strokeDasharray="3 3"
                        horizontal={false}
                      />
                      <XAxis
                        type="number"
                        stroke="#6B6B6B"
                        tick={{ fontSize: 12 }}
                        tickFormatter={(v) =>
                          v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)
                        }
                      />
                      <YAxis
                        type="category"
                        dataKey="concepto"
                        stroke="#6B6B6B"
                        tick={{ fontSize: 12 }}
                        width={130}
                      />
                      <Tooltip
                        cursor={{ fill: 'rgba(0,0,0,0.03)' }}
                        contentStyle={{
                          background: '#fff',
                          border: '1px solid #E6E0D6',
                          borderRadius: 8,
                        }}
                        formatter={(v: number) =>
                          `${Math.round(v).toLocaleString('es-ES')} h`
                        }
                      />
                      <Bar dataKey="horas" fill={COLOR_DAMM} radius={[0, 6, 6, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </Card>
          </section>

          {/* OEE formato + Top marcas */}
          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card aria-label="OEE por formato">
              <CardHeader title="OEE por formato" />
              <div className="h-64 px-3 py-4">
                {cargando ? (
                  <Skeleton className="h-full" />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={d.oeePorFormato}
                      margin={{ top: 8, right: 16, left: 0, bottom: 8 }}
                    >
                      <CartesianGrid
                        stroke="#E6E0D6"
                        strokeDasharray="3 3"
                        vertical={false}
                      />
                      <XAxis
                        dataKey="formato"
                        stroke="#6B6B6B"
                        tick={{ fontSize: 12 }}
                      />
                      <YAxis
                        stroke="#6B6B6B"
                        tick={{ fontSize: 12 }}
                        domain={[0, 1]}
                        tickFormatter={(v) => `${Math.round(v * 100)}%`}
                      />
                      <Tooltip
                        cursor={{ fill: 'rgba(0,0,0,0.03)' }}
                        contentStyle={{
                          background: '#fff',
                          border: '1px solid #E6E0D6',
                          borderRadius: 8,
                        }}
                        formatter={(v: number) => pct(v, 1)}
                      />
                      <Bar dataKey="oee" fill={COLOR_DAMM} radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </Card>

            <Card aria-label="Top marcas">
              <CardHeader
                title="Top marcas por nº de OFs"
                subtitle="OEE medio en el tooltip"
              />
              <div className="h-64 px-3 py-4">
                {cargando ? (
                  <Skeleton className="h-full" />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={d.topMarcas}
                      layout="vertical"
                      margin={{ top: 4, right: 24, left: 8, bottom: 4 }}
                    >
                      <CartesianGrid
                        stroke="#E6E0D6"
                        strokeDasharray="3 3"
                        horizontal={false}
                      />
                      <XAxis type="number" stroke="#6B6B6B" tick={{ fontSize: 12 }} />
                      <YAxis
                        type="category"
                        dataKey="marca"
                        stroke="#6B6B6B"
                        tick={{ fontSize: 11 }}
                        width={150}
                      />
                      <Tooltip
                        cursor={{ fill: 'rgba(0,0,0,0.03)' }}
                        contentStyle={{
                          background: '#fff',
                          border: '1px solid #E6E0D6',
                          borderRadius: 8,
                        }}
                        formatter={(_v, _name, p) => {
                          const pl = (p as { payload?: { ofs: number; oee: number } }).payload;
                          if (!pl) return ['', 'Marca'];
                          return [
                            `${pl.ofs} OFs · OEE ${pct(pl.oee, 1)}`,
                            'Marca',
                          ];
                        }}
                      />
                      <Bar dataKey="ofs" fill={COLOR_DAMM} radius={[0, 6, 6, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </Card>
          </section>
        </>
      )}

      <p className="text-center text-xs text-muted">
        Histórico disponible solo de {efectivos.anio ?? '—'}. Las comparativas vs año
        anterior se activarán al ingerir más años.
      </p>
    </div>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  options: { v: string; l: string }[];
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-xs uppercase tracking-wider text-muted">
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-hairline bg-surface px-3 py-2 text-sm focus:border-ink focus:outline-none"
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.l}
          </option>
        ))}
      </select>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  delta,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  delta?: string;
  accent?: boolean;
}) {
  return <KPI label={label} value={value} hint={delta ?? hint} accent={accent} />;
}

function deltaPts(curr: number, prev?: number): string | undefined {
  if (prev === undefined) return undefined;
  const d = (curr - prev) * 100;
  const sign = d >= 0 ? '+' : '';
  return `${sign}${d.toFixed(1)} pts vs año anterior`;
}

function deltaPct(curr: number, prev?: number): string | undefined {
  if (prev === undefined || prev === 0) return undefined;
  const d = ((curr - prev) / prev) * 100;
  const sign = d >= 0 ? '+' : '';
  return `${sign}${d.toFixed(1)}% vs año anterior`;
}

interface SeriePunto {
  label: string;
  OEE: number;
  L14?: number;
  L17?: number;
  L19?: number;
}

function serieTemporal(
  d: ObservabilidadData,
  g: 'semanal' | 'mensual',
): SeriePunto[] {
  if (g === 'mensual') {
    return d.oeeMensual.map((m) => ({
      label: MES_LABEL[m.mes] ?? String(m.mes),
      OEE: m.oee,
      L14: m.oeePorLinea[14],
      L17: m.oeePorLinea[17],
      L19: m.oeePorLinea[19],
    }));
  }
  return d.oeeSemanal.map((s) => ({
    label: `S${s.semana}`,
    OEE: s.oee,
    L14: s.oeePorLinea[14],
    L17: s.oeePorLinea[17],
    L19: s.oeePorLinea[19],
  }));
}
