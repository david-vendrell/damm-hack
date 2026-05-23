'use client';

import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
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
import {
  Card,
  CardHeader,
  Pill,
  SegmentedControl,
  Select,
  Skeleton,
  StatBlock,
  StatStrip,
  type KPIDelta,
} from '@/components/ui';
import { BriefHero } from '@/components/brief-card';
import { useScope } from '@/components/scope-provider';
import { hl, pct } from '@/lib/utils';
import type {
  Linea,
  ObservabilidadData,
  ObservabilidadDimensiones,
  SavedChartDTO,
} from '@/types';
import { ChartBuilder } from './chart-builder';
import { SavedChartsGrid } from './saved-charts-grid';

const COLOR_DAMM = '#A4161A';
const COLOR_DAMM_DARK = '#7E1116';
const COLOR_LINE_14 = '#7E1116';
const COLOR_LINE_17 = '#A4161A';
const COLOR_LINE_19 = '#D85D62';
const MES_LABEL = ['', 'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

type Layer = 'resumen' | 'graficos';

const LAYER_OPTIONS: { v: Layer; l: string }[] = [
  { v: 'resumen', l: 'Resumen' },
  { v: 'graficos', l: 'Gráficos' },
];

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
  const searchParams = useSearchParams();
  const dims = useQuery({
    queryKey: ['obs-dimensiones'],
    queryFn: () => jget<ObservabilidadDimensiones>('/api/observabilidad/dimensiones'),
  });

  const { scope } = useScope();
  const [filtros, setFiltros] = useState<Filtros>({});
  const [granularidad, setGranularidad] = useState<'semanal' | 'mensual'>('mensual');
  const [overlay, setOverlay] = useState(false);
  const [editing, setEditing] = useState<SavedChartDTO | null>(null);
  const [layer, setLayer] = useState<Layer>(
    searchParams?.get('view') === 'graficos' ? 'graficos' : 'resumen',
  );

  // Honor ?view=… and ?chartId=… deep-links (e.g. from sidebar Favoritos)
  useEffect(() => {
    const v = searchParams?.get('view');
    if (v === 'graficos' || v === 'resumen') setLayer(v);
  }, [searchParams]);

  const deepLinkChartId = searchParams?.get('chartId') ?? null;
  const savedCharts = useQuery({
    queryKey: ['saved-charts'],
    queryFn: () => jget<{ charts: SavedChartDTO[] }>('/api/observabilidad/charts'),
  });
  useEffect(() => {
    if (!deepLinkChartId || !savedCharts.data) return;
    const hit = savedCharts.data.charts.find((c) => c.id === deepLinkChartId);
    if (hit) setEditing(hit);
  }, [deepLinkChartId, savedCharts.data]);

  // Default año = más reciente. Línea sync con scope global (ScopeBar).
  const defaultAnio = dims.data?.anios[0];
  const efectivos: Filtros = {
    anio: filtros.anio ?? defaultAnio,
    linea: scope.linea ?? filtros.linea,
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
    <div className="space-y-8">
      {/* Brief de turno hero (answers-first) */}
      <BriefHero />

      {/* Layer switcher: Resumen / Gráficos */}
      <div className="flex items-center justify-between gap-4">
        <SegmentedControl<Layer>
          value={layer}
          options={LAYER_OPTIONS}
          onChange={setLayer}
        />
        <span className="text-[11px] text-ink-3">
          {layer === 'resumen'
            ? 'Indicadores y gráficos fijos del periodo.'
            : 'Compón tus propios gráficos a partir de cualquier métrica.'}
        </span>
      </div>

      {layer === 'resumen' && (
        <ResumenLayer
          d={d}
          prev={prev.data}
          dims={dims.data}
          efectivos={efectivos}
          setFiltros={setFiltros}
          cargando={cargando}
          vacio={vacio}
          granularidad={granularidad}
          setGranularidad={setGranularidad}
          overlay={overlay}
          setOverlay={setOverlay}
        />
      )}

      {layer === 'graficos' && (
        <GraficosLayer
          editing={editing}
          onEdit={(c) => setEditing(c)}
          onClearEdit={() => setEditing(null)}
        />
      )}
    </div>
  );
}

interface ResumenLayerProps {
  d: ObservabilidadData | undefined;
  prev: ObservabilidadData | undefined;
  dims: ObservabilidadDimensiones | undefined;
  efectivos: Filtros;
  setFiltros: (fn: (f: Filtros) => Filtros) => void;
  cargando: boolean;
  vacio: boolean;
  granularidad: 'semanal' | 'mensual';
  setGranularidad: (g: 'semanal' | 'mensual') => void;
  overlay: boolean;
  setOverlay: (fn: (o: boolean) => boolean) => void;
}

function ResumenLayer({
  d,
  prev,
  dims,
  efectivos,
  setFiltros,
  cargando,
  vacio,
  granularidad,
  setGranularidad,
  overlay,
  setOverlay,
}: ResumenLayerProps) {
  return (
    <>
      {/* Editorial divider + secondary filters */}
      <div className="flex items-end justify-between gap-6 border-b border-hairline pb-4">
        <div>
          <div className="eyebrow text-ink-3">Refinar</div>
          <p className="mt-1 text-xs text-ink-3">
            Filtros adicionales al alcance del periodo en el ScopeBar
            {d?.rangoFechas && (
              <span className="ml-2 num">
                · {d.rangoFechas.desde} → {d.rangoFechas.hasta}
              </span>
            )}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:w-[640px]">
          <Select
            label="Año"
            value={efectivos.anio ? String(efectivos.anio) : ''}
            options={(dims?.anios ?? []).map((a) => ({ v: String(a), l: String(a) }))}
            onChange={(v) => setFiltros((f) => ({ ...f, anio: v ? Number(v) : undefined }))}
            placeholder="Todos"
            size="sm"
          />
          <Select
            label="Marca"
            value={efectivos.marca ?? ''}
            options={(dims?.marcas ?? []).map((m) => ({ v: m, l: m }))}
            onChange={(v) => setFiltros((f) => ({ ...f, marca: v || undefined }))}
            placeholder="Todas"
            size="sm"
          />
          <Select
            label="Formato"
            value={efectivos.formato ?? ''}
            options={(dims?.formatos ?? []).map((f) => ({ v: f, l: f }))}
            onChange={(v) => setFiltros((f) => ({ ...f, formato: v || undefined }))}
            placeholder="Todos"
            size="sm"
          />
          <Select
            label="Canal"
            value={efectivos.canal ?? ''}
            options={(dims?.canales ?? []).map((c) => ({ v: c, l: c }))}
            onChange={(v) => setFiltros((f) => ({ ...f, canal: v || undefined }))}
            placeholder="Todos"
            size="sm"
          />
        </div>
      </div>

      {/* KPI strip — sparse Dribbble-style with dark delta pills */}
      <section aria-label="Indicadores principales">
        {cargando || !d ? (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : (
          <StatStrip>
            <StatBlock
              label="OEE"
              value={pct(d.kpis.oee, 1)}
              accent="damm"
              delta={ptsDelta(d.kpis.oee, prev?.kpis.oee, 'vs año anterior')}
              divider
            />
            <StatBlock
              label="Disponibilidad"
              value={pct(d.kpis.disponibilidad, 1)}
              delta={ptsDelta(d.kpis.disponibilidad, prev?.kpis.disponibilidad, 'vs año anterior')}
              divider
            />
            <StatBlock
              label="Rendimiento"
              value={pct(d.kpis.rendimiento, 1)}
              delta={ptsDelta(d.kpis.rendimiento, prev?.kpis.rendimiento, 'vs año anterior')}
              divider
            />
            <StatBlock
              label="Volumen"
              value={hl(d.kpis.volumenHl)}
              accent="gold"
              delta={pctDelta(d.kpis.volumenHl, prev?.kpis.volumenHl, 'vs año anterior')}
              divider
            />
            <StatBlock
              label="OFs con cambio"
              value={pct(d.kpis.pctCambios, 0)}
              delta={ptsDelta(d.kpis.pctCambios, prev?.kpis.pctCambios, 'vs año anterior')}
            />
          </StatStrip>
        )}
      </section>

      {!cargando && d && (
        <section aria-label="Indicadores secundarios">
          <StatStrip>
            <StatBlock
              label="Horas cambio"
              value={Math.round(d.kpis.horasCambio).toLocaleString('es-ES')}
              unit="h"
              divider
            />
            <StatBlock
              label="Mantenimiento"
              value={Math.round(d.kpis.horasMantenimiento).toLocaleString('es-ES')}
              unit="h"
              divider
            />
            <StatBlock
              label="Plan vs Real · May'26"
              value={d.kpis.planHl > 0 ? pct(d.kpis.fillRate, 0) : '—'}
              accent={d.kpis.planHl > 0 ? 'moss' : undefined}
              divider
            />
            <StatBlock
              label="Limpieza / CIP"
              value={Math.round(d.kpis.horasLimpieza).toLocaleString('es-ES')}
              unit="h"
            />
          </StatStrip>
          <div className="mt-2 grid grid-cols-2 gap-3 text-[11px] text-ink-3 md:grid-cols-4 px-6">
            <span>
              {d.kpis.horasCambioPorOfCambio > 0
                ? `${d.kpis.horasCambioPorOfCambio.toFixed(2)} h / OF con cambio`
                : '—'}
            </span>
            <span>
              {Math.round(d.kpis.nLlamadasMant).toLocaleString('es-ES')} llamadas · {pct(d.kpis.pctTiempoMant, 1)} t.
            </span>
            <span>
              {d.kpis.planHl > 0
                ? `${hl(d.kpis.actualHl)} / ${hl(d.kpis.planHl)}`
                : 'Sin datos de plan'}
            </span>
            <span>
              {d.kpis.nLimpiezaWos} WOs · CIP {pct(d.kpis.pctTiempoCip, 1)} t.
            </span>
          </div>
        </section>
      )}

      {vacio && (
        <Card>
          <div className="px-6 py-10 text-center text-sm text-muted">
            No hay OFs con los filtros seleccionados.
          </div>
        </Card>
      )}

      {!vacio && d && (
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
                subtitle="horas totales por componente de pérdida (sin doble conteo del paro)"
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
                        tick={{ fontSize: 11 }}
                        width={180}
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

          {/* Changeover real vs teórico + Limpieza */}
          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card aria-label="Cambio real vs teórico">
              <CardHeader
                title="Cambio real vs teórico por línea"
                subtitle="minutos totales (fact_changeovers · matriz CF Prat)"
              />
              <div className="h-64 px-3 py-4">
                {cargando ? (
                  <Skeleton className="h-full" />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={d.cambioPorLinea}
                      margin={{ top: 8, right: 16, left: 0, bottom: 8 }}
                    >
                      <CartesianGrid stroke="#E6E0D6" strokeDasharray="3 3" vertical={false} />
                      <XAxis
                        dataKey="linea"
                        tickFormatter={(v) => `L${v}`}
                        stroke="#6B6B6B"
                        tick={{ fontSize: 12 }}
                      />
                      <YAxis
                        stroke="#6B6B6B"
                        tick={{ fontSize: 12 }}
                        tickFormatter={(v) =>
                          v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)
                        }
                      />
                      <Tooltip
                        cursor={{ fill: 'rgba(0,0,0,0.03)' }}
                        contentStyle={{
                          background: '#fff',
                          border: '1px solid #E6E0D6',
                          borderRadius: 8,
                        }}
                        formatter={(v: number) =>
                          `${Math.round(v).toLocaleString('es-ES')} min`
                        }
                        labelFormatter={(l) => `Línea ${l}`}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="teoricoMin" name="Teórico" fill={COLOR_LINE_19} radius={[6, 6, 0, 0]} />
                      <Bar dataKey="realMin" name="Real" fill={COLOR_DAMM} radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </Card>

            <Card aria-label="Limpieza por línea">
              <CardHeader
                title="Limpieza por línea"
                subtitle="WOs LIMPIEZA · horas totales"
              />
              <div className="h-64 px-3 py-4">
                {cargando ? (
                  <Skeleton className="h-full" />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={d.limpiezaPorLinea}
                      margin={{ top: 8, right: 16, left: 0, bottom: 8 }}
                    >
                      <CartesianGrid stroke="#E6E0D6" strokeDasharray="3 3" vertical={false} />
                      <XAxis
                        dataKey="linea"
                        tickFormatter={(v) => `L${v}`}
                        stroke="#6B6B6B"
                        tick={{ fontSize: 12 }}
                      />
                      <YAxis
                        stroke="#6B6B6B"
                        tick={{ fontSize: 12 }}
                        tickFormatter={(v) =>
                          v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)
                        }
                      />
                      <Tooltip
                        cursor={{ fill: 'rgba(0,0,0,0.03)' }}
                        contentStyle={{
                          background: '#fff',
                          border: '1px solid #E6E0D6',
                          borderRadius: 8,
                        }}
                        formatter={(v: number, name) =>
                          name === 'nWos'
                            ? [`${Math.round(v)} WOs`, 'WOs']
                            : [`${Math.round(v)} h`, name === 'horas' ? 'Total' : 'Intervención']
                        }
                        labelFormatter={(l) => `Línea ${l}`}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="horas" name="Total" fill={COLOR_DAMM} radius={[6, 6, 0, 0]} />
                      <Bar
                        dataKey="horasIntervencion"
                        name="Intervención"
                        fill={COLOR_LINE_14}
                        radius={[6, 6, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </Card>
          </section>

          {/* Plan vs Actual May 2026 */}
          {(d.planVsActual.totales.hlPlan > 0 || d.planVsActual.totales.hlActual > 0) ? (
            <Card aria-label="Plan vs Real Mayo 2026">
              <CardHeader
                title="Plan vs Real (May'26)"
                subtitle={`${d.planVsActual.totales.nMatched} matched · ${d.planVsActual.totales.nOnlyPlan} solo plan · ${d.planVsActual.totales.nOnlyActual} solo real`}
              />
              <div className="h-72 px-3 py-4">
                {cargando ? (
                  <Skeleton className="h-full" />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={d.planVsActual.topGap}
                      margin={{ top: 8, right: 16, left: 0, bottom: 8 }}
                    >
                      <CartesianGrid stroke="#E6E0D6" strokeDasharray="3 3" vertical={false} />
                      <XAxis
                        dataKey="sku"
                        stroke="#6B6B6B"
                        tick={{ fontSize: 11 }}
                        interval={0}
                        angle={-30}
                        textAnchor="end"
                        height={70}
                      />
                      <YAxis
                        stroke="#6B6B6B"
                        tick={{ fontSize: 12 }}
                        tickFormatter={(v) =>
                          v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)
                        }
                      />
                      <Tooltip
                        cursor={{ fill: 'rgba(0,0,0,0.03)' }}
                        contentStyle={{
                          background: '#fff',
                          border: '1px solid #E6E0D6',
                          borderRadius: 8,
                        }}
                        formatter={(v: number) => hl(v)}
                        labelFormatter={(l, p) => {
                          const pl = (p as { payload?: { linea: number; denominacion: string | null } }[])?.[0]?.payload;
                          return `${pl?.denominacion ?? l} · L${pl?.linea ?? ''}`;
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="hlPlan" name="Plan" fill={COLOR_LINE_19} radius={[6, 6, 0, 0]} />
                      <Bar
                        dataKey="hlActual"
                        name="Real"
                        fill={COLOR_DAMM}
                        radius={[6, 6, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </Card>
          ) : null}
        </>
      )}
    </>
  );
}

interface GraficosLayerProps {
  editing: SavedChartDTO | null;
  onEdit: (chart: SavedChartDTO) => void;
  onClearEdit: () => void;
}

function GraficosLayer({ editing, onEdit, onClearEdit }: GraficosLayerProps) {
  return (
    <div className="space-y-6">
      {/* Editorial header for the layer */}
      <div className="flex items-end justify-between gap-6 border-b border-hairline pb-4">
        <div>
          <div className="eyebrow text-ink-3">Componer</div>
          <h2 className="serif mt-1 text-2xl font-semibold tracking-tight text-ink">
            {editing ? `Editando · ${editing.nombre}` : 'Constructor de gráficos'}
          </h2>
          <p className="mt-1 text-xs text-ink-3">
            Define una métrica, segmenta, filtra y guárdala en tu panel. La previa se actualiza al instante.
          </p>
        </div>
        {editing && (
          <button
            onClick={onClearEdit}
            className="text-xs text-muted underline-offset-4 hover:text-ink hover:underline"
          >
            Cancelar edición
          </button>
        )}
      </div>

      <ChartBuilder
        initialConfig={editing?.config ?? null}
        editingId={editing?.id ?? null}
        initialName={editing?.nombre ?? ''}
        onSaved={() => onClearEdit()}
        onCancelEdit={() => onClearEdit()}
      />

      <SavedChartsGrid onEdit={onEdit} />
    </div>
  );
}

function ptsDelta(curr: number, prev: number | undefined, label?: string): KPIDelta | undefined {
  if (prev === undefined) return undefined;
  return { value: (curr - prev) * 100, format: 'pts', label };
}

function pctDelta(curr: number, prev: number | undefined, label?: string): KPIDelta | undefined {
  if (prev === undefined || prev === 0) return undefined;
  return { value: ((curr - prev) / prev) * 100, format: 'pct', label };
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
