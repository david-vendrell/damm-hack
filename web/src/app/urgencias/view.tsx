'use client';

import Link from 'next/link';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Card, CardHeader, KPI, Pill, SectionTitle, Skeleton, VeredictoBadge } from '@/components/ui';
import { cn, hl, pct, pts } from '@/lib/utils';
import type {
  AccionUrgencia,
  AnalisisUrgencia,
  Linea,
  ModoUrgencia,
  PlanResumen,
  TipoUrgencia,
  Urgencia,
  Veredicto,
} from '@/types';

async function jget<T>(url: string): Promise<T | null> {
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('fetch_failed');
  return r.json();
}

async function jpost<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.detail ?? j.error ?? 'request_failed');
  }
  return r.json();
}

export function UrgenciasView() {
  const planQ = useQuery({ queryKey: ['plan-latest'], queryFn: () => jget<PlanResumen>('/api/planes/latest') });
  const tienePlan = !!planQ.data;
  const [modo, setModo] = useState<ModoUrgencia>('plan_activo');

  useEffect(() => {
    if (planQ.data === null) setModo('escenario_libre');
    else if (planQ.data) setModo('plan_activo');
  }, [planQ.data]);

  const [tipo, setTipo] = useState<TipoUrgencia | null>(null);
  const [form, setForm] = useState<Partial<Urgencia>>({});
  const [analisis, setAnalisis] = useState<AnalisisUrgencia | null>(null);

  const submit = useMutation({
    mutationFn: (u: Urgencia) => jpost<AnalisisUrgencia>('/api/urgencias', { urgencia: u, modo }),
    onSuccess: (d) => setAnalisis(d),
  });

  const seleccionarTipo = (t: TipoUrgencia) => {
    setTipo(t);
    setForm({ tipo: t });
    setAnalisis(null);
  };

  const onAnalizar = () => {
    if (!tipo) return;
    submit.mutate({ ...(form as Urgencia), tipo });
  };

  return (
    <div className="space-y-10">
      <header>
        <SectionTitle subtitle="Algo se ha desviado del plan. Decide en caliente qué mover, qué priorizar y cuál es el coste en OEE.">
          Urgencias
        </SectionTitle>
      </header>

      {/* Toggle modo */}
      <section className="flex flex-wrap items-center gap-3">
        <span className="text-xs uppercase tracking-wider text-muted">Modo</span>
        <button
          disabled={!tienePlan}
          onClick={() => setModo('plan_activo')}
          className={cn(
            'rounded-soft border px-4 py-2 text-sm transition-colors',
            modo === 'plan_activo' ? 'border-ink bg-ink text-surface' : 'border-hairline bg-surface text-muted hover:text-ink',
            !tienePlan && 'cursor-not-allowed opacity-40',
          )}
        >
          Plan activo
        </button>
        <button
          onClick={() => setModo('escenario_libre')}
          className={cn(
            'rounded-soft border px-4 py-2 text-sm transition-colors',
            modo === 'escenario_libre' ? 'border-ink bg-ink text-surface' : 'border-hairline bg-surface text-muted hover:text-ink',
          )}
        >
          Escenario libre
        </button>
        {!tienePlan && <span className="text-xs text-muted">No hay plan cargado · <Link href="/validar" className="text-damm underline">subir uno</Link></span>}
      </section>

      {/* Banner plan activo */}
      {modo === 'plan_activo' && planQ.data && <BannerPlanActivo plan={planQ.data} />}

      {/* Step 1: tipo */}
      <section>
        <h3 className="mb-3 text-sm font-medium text-muted">1 · ¿Qué ha ocurrido?</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {TIPOS.map((t) => (
            <TipoCard key={t.id} t={t} active={tipo === t.id} onClick={() => seleccionarTipo(t.id)} />
          ))}
        </div>
      </section>

      {/* Step 2: detalles */}
      {tipo && (
        <section>
          <h3 className="mb-3 text-sm font-medium text-muted">2 · Detalles</h3>
          <Card>
            <div className="grid grid-cols-1 gap-4 px-5 py-5 md:grid-cols-2">
              <Formulario tipo={tipo} form={form} setForm={setForm} modo={modo} dias={planQ.data?.dias ?? []} />
            </div>
            <div className="flex items-center justify-between border-t border-hairline px-5 py-3">
              <span className="text-xs text-muted">
                {modo === 'plan_activo' ? 'Las acciones se ajustarán al plan cargado.' : 'Sin plan: solo ranking por baseline histórico.'}
              </span>
              <button
                onClick={onAnalizar}
                disabled={submit.isPending}
                className="rounded-soft bg-damm px-4 py-2 text-sm font-medium text-surface hover:bg-damm-hover disabled:opacity-50"
              >
                {submit.isPending ? 'Analizando…' : 'Analizar impacto'}
              </button>
            </div>
            {submit.isError && <div className="border-t border-hairline px-5 py-2 text-sm text-damm">Error: {(submit.error as Error).message}</div>}
          </Card>
        </section>
      )}

      {/* Resultados */}
      {analisis && <Resultados a={analisis} />}
    </div>
  );
}

const TIPOS: { id: TipoUrgencia; label: string; desc: string }[] = [
  { id: 'averia', label: 'Avería', desc: 'Una línea (o parte) cae. ¿Qué se mueve?' },
  { id: 'pedido_urgente', label: 'Pedido urgente', desc: 'Hay que producir X Hl antes del deadline.' },
  { id: 'incidencia_calidad', label: 'Incidencia calidad', desc: 'Lote rechazado: hay que reproducir.' },
  { id: 'falta_material', label: 'Falta material', desc: 'Lata o caja agotada para un formato.' },
];

function TipoCard({ t, active, onClick }: { t: typeof TIPOS[number]; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-soft border bg-surface px-4 py-4 text-left transition-colors',
        active ? 'border-ink shadow-hairline' : 'border-hairline hover:border-ink',
      )}
    >
      <div className={cn('text-sm font-medium', active && 'text-damm')}>{t.label}</div>
      <div className="mt-1 text-xs text-muted">{t.desc}</div>
    </button>
  );
}

function BannerPlanActivo({ plan }: { plan: PlanResumen }) {
  return (
    <section className="flex items-center justify-between rounded-soft border border-hairline bg-surface px-5 py-3">
      <div className="flex items-center gap-4">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted">Plan activo</div>
          <div className="text-sm font-medium">{plan.nombre}</div>
        </div>
        <div className="text-xs text-muted">
          <span className="num">{plan.nOfs}</span> OFs · <span className="num">{plan.dias.length}</span> días · OEE previsto <span className="num font-medium text-ink">{pct(plan.oeePrevisto)}</span>
        </div>
      </div>
      <Link href="/validar" className="text-xs text-muted hover:text-ink">cambiar plan →</Link>
    </section>
  );
}

function Formulario({
  tipo,
  form,
  setForm,
  modo,
  dias,
}: {
  tipo: TipoUrgencia;
  form: Partial<Urgencia>;
  setForm: (f: Partial<Urgencia>) => void;
  modo: ModoUrgencia;
  dias: string[];
}) {
  const upd = (k: keyof Urgencia, v: unknown) => setForm({ ...form, [k]: v });

  const inputCls = 'w-full rounded border border-hairline bg-surface px-3 py-2 text-sm focus:border-ink focus:outline-none';
  const labelCls = 'mb-1.5 block text-xs uppercase tracking-wider text-muted';

  const Linea = (
    <div>
      <label className={labelCls}>Línea</label>
      <div className="flex gap-1.5">
        {[14, 17, 19].map((l) => (
          <Pill key={l} active={form.linea === l} onClick={() => upd('linea', l)}>L{l}</Pill>
        ))}
      </div>
    </div>
  );

  const Dia = (
    <div>
      <label className={labelCls}>Día</label>
      {modo === 'plan_activo' && dias.length ? (
        <select className={inputCls} value={form.dia ?? ''} onChange={(e) => upd('dia', e.target.value || undefined)}>
          <option value="">— elige día —</option>
          {dias.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      ) : (
        <input type="date" className={inputCls} value={form.dia ?? ''} onChange={(e) => upd('dia', e.target.value || undefined)} />
      )}
    </div>
  );

  const Sku = (
    <div>
      <label className={labelCls}>SKU</label>
      <input className={inputCls} placeholder="ED13LTNN" value={form.sku ?? ''} onChange={(e) => upd('sku', e.target.value.toUpperCase() || undefined)} />
    </div>
  );

  const Hl = (
    <div>
      <label className={labelCls}>Hl</label>
      <input type="number" className={inputCls} placeholder="1000" value={form.hl ?? ''} onChange={(e) => upd('hl', e.target.value ? Number(e.target.value) : undefined)} />
    </div>
  );

  const Deadline = (
    <div>
      <label className={labelCls}>Deadline</label>
      {modo === 'plan_activo' && dias.length ? (
        <select className={inputCls} value={form.deadline ?? ''} onChange={(e) => upd('deadline', e.target.value || undefined)}>
          <option value="">— sin deadline —</option>
          {dias.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      ) : (
        <input type="date" className={inputCls} value={form.deadline ?? ''} onChange={(e) => upd('deadline', e.target.value || undefined)} />
      )}
    </div>
  );

  const Duracion = (
    <div>
      <label className={labelCls}>Duración (h)</label>
      <input type="number" className={inputCls} placeholder="8" value={form.duracionHoras ?? ''} onChange={(e) => upd('duracionHoras', e.target.value ? Number(e.target.value) : undefined)} />
    </div>
  );

  const Formato = (
    <div>
      <label className={labelCls}>Formato afectado</label>
      <div className="flex gap-1.5">
        {(['1/3', '1/2'] as const).map((f) => (
          <Pill key={f} active={form.formato === f} onClick={() => upd('formato', f)}>{f}</Pill>
        ))}
      </div>
    </div>
  );

  if (tipo === 'averia') return <>{Linea}{Dia}{Duracion}</>;
  if (tipo === 'pedido_urgente') return <>{Sku}{Hl}{Deadline}</>;
  if (tipo === 'incidencia_calidad') return <>{Sku}{Linea}{Hl}{Deadline}</>;
  return <>{Formato}{Duracion}{Dia}</>;
}

function Resultados({ a }: { a: AnalisisUrgencia }) {
  const total = a.acciones.length;
  const prio1 = a.acciones.filter((x) => x.prioridad === 1).length;
  let tono: Veredicto = 'procede';
  if (a.kpis.gananciaPts < 2 && a.kpis.hlEnRiesgo > 0) tono = 'evitar';
  else if (prio1 < total / 2) tono = 'revisar';

  return (
    <div className="space-y-6">
      {/* Banner */}
      <section className={cn(
        'flex items-center justify-between rounded-soft border-2 px-5 py-4',
        tono === 'procede' && 'border-good bg-good-soft text-good',
        tono === 'revisar' && 'border-warn bg-warn-soft text-warn',
        tono === 'evitar' && 'border-damm bg-damm-soft text-damm',
      )}>
        <div className="flex items-center gap-3">
          <VeredictoBadge v={tono} />
          <span className="font-medium">{a.resumen}</span>
        </div>
        <div className="text-sm num">
          {a.acciones.length} acciones · {prio1} crítica{prio1 !== 1 ? 's' : ''}
        </div>
      </section>

      {/* KPIs */}
      <section className={cn('grid gap-4', a.modo === 'plan_activo' ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-2')}>
        <KPI label="Hl en riesgo" value={hl(a.kpis.hlEnRiesgo)} accent />
        {a.modo === 'plan_activo' && (
          <>
            <KPI label="OEE plan original" value={pct(a.kpis.oeePlanOriginal ?? 0)} />
            <KPI label="OEE sin actuar" value={pct(a.kpis.oeePlanPostIncidencia ?? 0)} hint="dejando huecos por la incidencia" />
            <KPI label="OEE con acciones" value={pct(a.kpis.oeePlanRecomendado)} hint={pts(a.kpis.gananciaPts)} />
          </>
        )}
        {a.modo === 'escenario_libre' && (
          <KPI label="OEE previsto mejor opción" value={pct(a.kpis.oeePlanRecomendado)} hint={pts(a.kpis.gananciaPts)} />
        )}
      </section>

      {/* Acciones */}
      <section>
        <Card>
          <CardHeader title="Acciones recomendadas" subtitle="ordenadas por prioridad" />
          <div className="space-y-3 px-5 py-5">
            {a.acciones.length === 0 && (
              <div className="rounded-soft border border-hairline px-4 py-6 text-sm text-muted">
                No hay acciones aplicables con los datos actuales. Revisa el formulario o cambia de modo.
              </div>
            )}
            {a.acciones.map((act) => <AccionCard key={act.id} a={act} />)}
          </div>
        </Card>
      </section>

      {/* Tabla OFs afectadas */}
      {a.modo === 'plan_activo' && a.filasAfectadas.length > 0 && (
        <section>
          <Card>
            <CardHeader title="OFs afectadas" subtitle={`${a.filasAfectadas.length} órdenes en la ventana de la incidencia`} />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-hairline text-left text-xs uppercase tracking-wider text-muted">
                    <th className="px-5 py-3">Línea</th>
                    <th className="px-5 py-3">Día</th>
                    <th className="px-5 py-3">SKU</th>
                    <th className="px-5 py-3 text-right">Hl</th>
                    <th className="px-5 py-3 text-right">OEE previsto</th>
                  </tr>
                </thead>
                <tbody>
                  {a.filasAfectadas.map((f, i) => (
                    <tr key={i} className="border-b border-l-2 border-l-damm border-hairline last:border-0">
                      <td className="px-5 py-3 num">L{f.linea}</td>
                      <td className="px-5 py-3 num text-muted">{f.dia}</td>
                      <td className="px-5 py-3">
                        <div className="font-medium">{f.nombre}</div>
                        <div className="font-mono text-xs text-muted">{f.sku}</div>
                      </td>
                      <td className="px-5 py-3 text-right num">{hl(f.hlPlan)}</td>
                      <td className="px-5 py-3 text-right num">{pct(f.oeePrevisto)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </section>
      )}
    </div>
  );
}

function AccionCard({ a }: { a: AccionUrgencia }) {
  const tipoMap = {
    mover: { label: 'Mover', cls: 'bg-damm-soft text-damm' },
    reprogramar: { label: 'Reprogramar', cls: 'bg-warn-soft text-warn' },
    priorizar: { label: 'Priorizar', cls: 'bg-good-soft text-good' },
    sustituir: { label: 'Sustituir', cls: 'bg-cream text-ink' },
  } as const;
  const t = tipoMap[a.tipo];
  const prioBorder = a.prioridad === 1 ? 'border-l-damm' : a.prioridad === 2 ? 'border-l-warn' : 'border-l-good';
  const prioLabel = a.prioridad === 1 ? 'Crítica' : a.prioridad === 2 ? 'Importante' : 'Sugerida';

  return (
    <div className={cn('rounded-soft border border-hairline border-l-4 bg-surface p-4', prioBorder)}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', t.cls)}>{t.label}</span>
            <span className="text-xs uppercase tracking-wider text-muted">{prioLabel}</span>
            <span className="text-sm font-medium">{a.titulo}</span>
          </div>
          <p className="mt-1.5 text-sm text-muted">{a.descripcion}</p>
          {(a.lineaOrigen || a.lineaDestino || a.ofAfectada) && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              {a.ofAfectada && <span className="rounded bg-cream px-1.5 py-0.5 font-mono text-[10px]">{a.ofAfectada}</span>}
              {a.lineaOrigen && a.lineaDestino && (
                <span className="text-muted num">L{a.lineaOrigen} → L{a.lineaDestino}</span>
              )}
              {!a.lineaOrigen && a.lineaDestino && (
                <span className="text-muted num">→ L{a.lineaDestino}</span>
              )}
            </div>
          )}
        </div>
        <div className="text-right">
          {a.impactoHl != null && (
            <div>
              <div className="text-xs text-muted">Volumen</div>
              <div className="text-sm font-medium num">{hl(a.impactoHl)}</div>
            </div>
          )}
          {a.impactoOeePts != null && (
            <div className="mt-1">
              <div className="text-xs text-muted">OEE</div>
              <div className="text-sm font-semibold text-good num">{a.impactoOeePts}%</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
