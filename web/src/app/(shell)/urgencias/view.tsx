'use client';

import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import {
  Button, Card, CardHeader, KPI, SectionTitle, Select, Skeleton, StatBlock, StatStrip,
} from '@/components/ui';
import { AlertTriangle, Siren, Sparkles, Star, X } from '@/components/icons';
import { cn, hl, pct, pts } from '@/lib/utils';
import { RecoCard } from '@/components/reco-card';
import type { AnalisisPlan, Linea } from '@/types';

/* ─────────────────────────── Local types ─────────────────────────── */

type IncidentKind = 'averia' | 'pedido';

interface OutageInput {
  linea: Linea;
  fecha: string;
  turno: 'M' | 'T' | 'N';
  motivo: string;
}
interface PriorityInput {
  sku: string;
  hl: number;
  deadline: string;
  preferred_linea?: Linea;
  reason: string;
}

/* ─────────────────────────── Main view ─────────────────────────── */

export function UrgenciasView() {
  const [active, setActive] = useState<AnalisisPlan | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [kind, setKind] = useState<IncidentKind | null>(null);
  const [preview, setPreview] = useState<AnalisisPlan | null>(null);
  // Remember the last submitted payload so ImpactView can tell whether the
  // optimizer actually placed a priority OF (vs silently skipping it).
  const [lastPayload, setLastPayload] = useState<{ outage?: OutageInput; priorityOf?: PriorityInput } | null>(null);
  const [applied, setApplied] = useState(false);

  // Load the active plan (same source as /validar's rehydration)
  useEffect(() => {
    let cancelled = false;
    fetch('/api/planes/latest/full')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data && !('error' in data)) setActive(data as AnalisisPlan);
        setHydrated(true);
      })
      .catch(() => { if (!cancelled) setHydrated(true); });
    return () => { cancelled = true; };
  }, []);

  const submit = useMutation({
    mutationFn: async (payload: { outage?: OutageInput; priorityOf?: PriorityInput }) => {
      if (!active?.planId) throw new Error('no_plan');
      const r = await fetch('/api/urgencias', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planId: active.planId,
          ...(payload.outage     ? { outage:     payload.outage }     : {}),
          ...(payload.priorityOf ? { priorityOf: payload.priorityOf } : {}),
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail ?? err.error ?? 'request_failed');
      }
      return (await r.json()) as AnalisisPlan;
    },
    onMutate: (payload) => { setLastPayload(payload); },
    onSuccess: (data) => { setPreview(data); setApplied(false); },
  });

  const apply = useMutation({
    mutationFn: async () => {
      if (!preview?.planId) throw new Error('no_preview');
      const r = await fetch(`/api/planes/${preview.planId}/aplicar-incidencia`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analisis: preview }),
      });
      if (!r.ok) throw new Error('apply_failed');
      return r.json();
    },
    onSuccess: () => { setActive(preview); setApplied(true); },
  });

  const resetIncident = () => {
    setKind(null);
    setPreview(null);
    setLastPayload(null);
    setApplied(false);
    submit.reset();
    apply.reset();
  };

  return (
    <div className="space-y-8">
      <header>
        <SectionTitle
          eyebrow="Urgencias"
          subtitle="Avería de línea o pedido urgente. El modelo LineWise re-optimiza el plan activo y muestra el impacto en OEE antes de aplicarlo."
        >
          Replanificar por incidencia
        </SectionTitle>
      </header>

      {!hydrated && <Skeleton className="h-32 w-full" />}

      {hydrated && !active && <NoActivePlan />}

      {hydrated && active && (
        <>
          <ActivePlanHeader analisis={active} />

          {!preview && !submit.isPending && (
            <IncidentSelector
              kind={kind}
              onPick={setKind}
              onSubmit={(payload) => submit.mutate(payload)}
              onCancel={() => setKind(null)}
            />
          )}

          {submit.isPending && <SubmittingState />}

          {submit.isError && (
            <ErrorBanner message={(submit.error as Error).message} onDismiss={resetIncident} />
          )}

          {preview && (
            <ImpactView
              before={active}
              after={preview}
              submitted={lastPayload}
              onApply={() => apply.mutate()}
              onCancel={resetIncident}
              applying={apply.isPending}
              applied={applied}
              applyError={apply.isError ? (apply.error as Error).message : null}
            />
          )}
        </>
      )}
    </div>
  );
}

/* ─────────────────────────── Sub-components ─────────────────────────── */

function NoActivePlan() {
  return (
    <Card>
      <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
        <AlertTriangle className="h-6 w-6 text-ink-3" strokeWidth={1.75} />
        <div>
          <div className="text-sm font-medium text-ink">No hay plan activo</div>
          <p className="mt-1 text-xs text-ink-3">
            Para gestionar averías o pedidos urgentes, primero sube un plan en Validar planificación.
          </p>
        </div>
        <Link href="/validar">
          <Button variant="primary">Ir a Validar planificación</Button>
        </Link>
      </div>
    </Card>
  );
}

function ActivePlanHeader({ analisis }: { analisis: AnalisisPlan }) {
  return (
    <StatStrip>
      <StatBlock label="Plan activo" value={analisis.nombre} divider />
      <StatBlock label="OFs" value={String(analisis.filas.length)} divider />
      <StatBlock label="OEE previsto" value={pct(analisis.oeePrevistoPlan, 1)} accent="damm" divider />
      <StatBlock
        label="HL totales"
        value={analisis.totalHl ? hl(analisis.totalHl) : '—'}
      />
    </StatStrip>
  );
}

function IncidentSelector({
  kind, onPick, onSubmit, onCancel,
}: {
  kind: IncidentKind | null;
  onPick: (k: IncidentKind) => void;
  onSubmit: (payload: { outage?: OutageInput; priorityOf?: PriorityInput }) => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <IncidentButton
          icon={<Siren className="h-4 w-4" strokeWidth={1.75} />}
          title="Declarar avería"
          subtitle="Una línea queda fuera de servicio en un turno concreto."
          active={kind === 'averia'}
          onClick={() => onPick('averia')}
        />
        <IncidentButton
          icon={<Star className="h-4 w-4" strokeWidth={1.75} />}
          title="Inyectar pedido urgente"
          subtitle="Un pedido extra entra fuera del plan, con plazo cerrado."
          active={kind === 'pedido'}
          onClick={() => onPick('pedido')}
        />
      </div>

      {kind === 'averia' && <OutageForm onSubmit={(o) => onSubmit({ outage: o })} onCancel={onCancel} />}
      {kind === 'pedido' && <PriorityForm onSubmit={(p) => onSubmit({ priorityOf: p })} onCancel={onCancel} />}
    </div>
  );
}

function IncidentButton({
  icon, title, subtitle, active, onClick,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-card border bg-surface px-5 py-4 text-left transition-colors',
        active ? 'border-damm bg-damm-soft/30' : 'border-hairline hover:border-hairline-strong',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={active ? 'text-damm' : 'text-ink-3'}>{icon}</span>
        <span className="text-sm font-medium text-ink">{title}</span>
      </div>
      <p className="mt-1 text-xs text-ink-3">{subtitle}</p>
    </button>
  );
}

/* ─────────────────────────── Forms ─────────────────────────── */

function OutageForm({
  onSubmit, onCancel,
}: {
  onSubmit: (o: OutageInput) => void;
  onCancel: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [linea, setLinea] = useState<Linea>(17);
  const [fecha, setFecha] = useState(today);
  const [turno, setTurno] = useState<'M' | 'T' | 'N'>('T');
  const [motivo, setMotivo] = useState('');

  return (
    <Card>
      <CardHeader
        eyebrow="Avería"
        title="Línea fuera de servicio"
        subtitle="El optimizador re-planifica los OFs afectados a slots libres."
      />
      <div className="grid grid-cols-1 gap-4 px-5 py-5 md:grid-cols-4">
        <Select
          label="Línea"
          value={String(linea)}
          options={[
            { v: '14', l: 'L14' }, { v: '17', l: 'L17' }, { v: '19', l: 'L19' },
          ]}
          onChange={(v) => setLinea(Number(v) as Linea)}
        />
        <div className="flex flex-col gap-1.5">
          <label className="eyebrow text-ink-3">Fecha</label>
          <input
            type="date"
            value={fecha}
            onChange={(e) => setFecha(e.target.value)}
            className="rounded-soft border border-hairline bg-surface px-3 py-2 text-sm text-ink"
          />
        </div>
        <Select
          label="Turno"
          value={turno}
          options={[
            { v: 'M', l: 'Mañana' }, { v: 'T', l: 'Tarde' }, { v: 'N', l: 'Noche' },
          ]}
          onChange={(v) => setTurno(v as 'M' | 'T' | 'N')}
        />
        <div className="flex flex-col gap-1.5">
          <label className="eyebrow text-ink-3">Motivo (opcional)</label>
          <input
            type="text"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Avería rodillo, mantenimiento correctivo…"
            className="rounded-soft border border-hairline bg-surface px-3 py-2 text-sm text-ink"
          />
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-hairline px-5 py-3">
        <Button variant="ghost" onClick={onCancel}>Cancelar</Button>
        <Button variant="primary" onClick={() => onSubmit({ linea, fecha, turno, motivo })}>
          Calcular impacto
        </Button>
      </div>
    </Card>
  );
}

function PriorityForm({
  onSubmit, onCancel,
}: {
  onSubmit: (p: PriorityInput) => void;
  onCancel: () => void;
}) {
  const inAWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const [sku, setSku] = useState('');
  const [hlVal, setHlVal] = useState(250);
  const [deadline, setDeadline] = useState(inAWeek);
  const [preferred, setPreferred] = useState<string>('');
  const [reason, setReason] = useState('');

  const valid = sku.trim().length >= 3 && Number.isFinite(hlVal) && hlVal > 0 && !!deadline;
  // Typical Damm shift ≈ 1k-10k HL. Anything above ~50k is almost certainly
  // a typo or a misunderstanding of units (HL vs CAJ). Warn but don't block.
  const hlWarning = Number.isFinite(hlVal) && (hlVal > 50_000 || hlVal < 50);

  const handleSubmit = () => {
    if (!valid) return;
    onSubmit({
      sku: sku.trim(),
      hl: hlVal,
      deadline,
      preferred_linea: preferred ? (Number(preferred) as Linea) : undefined,
      reason,
    });
  };

  return (
    <Card>
      <CardHeader
        eyebrow="Pedido urgente"
        title="Inyectar un OF prioritario"
        subtitle="El optimizador lo coloca en el mejor slot factible antes del plazo, desplazando si hace falta."
      />
      <div className="grid grid-cols-1 gap-4 px-5 py-5 md:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <label className="eyebrow text-ink-3">SKU</label>
          <input
            type="text"
            value={sku}
            onChange={(e) => setSku(e.target.value.toUpperCase())}
            placeholder="ED13LTW"
            className="rounded-soft border border-hairline bg-surface px-3 py-2 font-mono text-sm text-ink"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="eyebrow text-ink-3">HL a producir</label>
          <input
            type="number"
            value={hlVal}
            min={1}
            onChange={(e) => setHlVal(Number(e.target.value))}
            className="num rounded-soft border border-hairline bg-surface px-3 py-2 text-sm text-ink"
          />
          {hlWarning && (
            <span className="text-[11px] text-damm">
              Valor inusual. Un turno típico produce entre 1.000 y 10.000 HL.
            </span>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="eyebrow text-ink-3">Plazo (deadline)</label>
          <input
            type="date"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            className="rounded-soft border border-hairline bg-surface px-3 py-2 text-sm text-ink"
          />
        </div>
        <Select
          label="Línea preferida (opcional)"
          value={preferred}
          options={[
            { v: '14', l: 'L14' }, { v: '17', l: 'L17' }, { v: '19', l: 'L19' },
          ]}
          onChange={setPreferred}
          placeholder="Sin preferencia"
        />
        <div className="flex flex-col gap-1.5 md:col-span-2">
          <label className="eyebrow text-ink-3">Razón (opcional)</label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Pedido urgente cliente X, retake calidad…"
            className="rounded-soft border border-hairline bg-surface px-3 py-2 text-sm text-ink"
          />
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-hairline px-5 py-3">
        <Button variant="ghost" onClick={onCancel}>Cancelar</Button>
        <Button variant="primary" onClick={handleSubmit} disabled={!valid}>
          Calcular impacto
        </Button>
      </div>
    </Card>
  );
}

/* ─────────────────────────── Loading + error ─────────────────────────── */

function SubmittingState() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 px-1 text-xs text-ink-3">
        <Sparkles className="h-3.5 w-3.5 animate-pulse text-damm" strokeWidth={2} />
        <span>Re-optimizando con LineWise · 5-15 s</span>
      </div>
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-80 w-full" />
    </div>
  );
}

function WarningBanner({
  title, message, tone = 'warn',
}: {
  title: string;
  message: string;
  tone?: 'warn' | 'info';
}) {
  const cls = tone === 'warn'
    ? 'border-damm/30 bg-damm-soft/40 text-damm-700'
    : 'border-gold/30 bg-gold-soft text-gold-700';
  return (
    <div className={cn('flex items-start gap-3 rounded-soft border px-4 py-3 text-xs', cls)}>
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
      <div className="flex-1">
        <div className="font-medium">{title}</div>
        <p className="mt-1 opacity-80">{message}</p>
      </div>
    </div>
  );
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-soft border border-damm/30 bg-damm-soft/40 px-4 py-3 text-xs text-damm-700">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
      <div className="flex-1">
        <div className="font-medium">No se pudo calcular el impacto</div>
        <p className="mt-0.5 text-damm-700/80">{message}</p>
      </div>
      <button type="button" onClick={onDismiss} className="text-damm-700/80 hover:text-damm-700" aria-label="Cerrar">
        <X className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}

/* ─────────────────────────── Impact view ─────────────────────────── */

function ImpactView({
  before, after, submitted, onApply, onCancel, applying, applied, applyError,
}: {
  before: AnalisisPlan;
  after:  AnalisisPlan;
  submitted: { outage?: OutageInput; priorityOf?: PriorityInput } | null;
  onApply: () => void;
  onCancel: () => void;
  applying: boolean;
  applied: boolean;
  applyError: string | null;
}) {
  // "Plan con incidencia" = what the plan will achieve AFTER the optimizer's
  // recommended moves are applied. `oeePrevistoPlan` is the raw baseline
  // (current state, no optimizer); `planRecomendado.oeePlanRecomendado` is
  // the projected outcome with every recommendation applied — that's what
  // the user gets when they click Apply, so it's what we should compare.
  const oeeBefore = before.oeePrevistoPlan;
  const oeeAfter  = after.planRecomendado?.oeePlanRecomendado ?? after.oeePrevistoPlan;
  const deltaPts  = (oeeAfter - oeeBefore) * 100;
  const arrow = deltaPts < -0.05 ? '▼' : deltaPts > 0.05 ? '▲' : '=';
  const tone  = deltaPts < -0.05 ? 'text-damm' : deltaPts > 0.05 ? 'text-moss' : 'text-ink-3';
  const recos = after.planRecomendado?.recomendaciones ?? [];
  // Detect: planner submitted a priority OF, but the optimizer's recos don't
  // include a 'prioritario' entry → the OF was silently dropped (typically
  // because the HL is unfittable, the deadline is too tight, the SKU has no
  // feasible línea, or the value submitted was invalid).
  const priorityNotPlaced =
    !!submitted?.priorityOf &&
    !recos.some((r) => r.categoria === 'prioritario');
  // Detect: planner submitted an outage, but the optimizer applied zero
  // moves → either the outage hits an empty slot (no impact) or the model
  // didn't recognize it. Either way the planner needs to know.
  const outageNoEffect = !!submitted?.outage && recos.length === 0;

  return (
    <div className="space-y-5">
      {priorityNotPlaced && (
        <WarningBanner
          title="El pedido urgente no se ha podido colocar"
          message={
            `El modelo no encontró un slot factible para ${submitted.priorityOf!.hl.toLocaleString('es-ES')} HL ` +
            `de ${submitted.priorityOf!.sku} antes del ${submitted.priorityOf!.deadline}. ` +
            'Causas habituales: cantidad demasiado grande, plazo demasiado ajustado, ' +
            'o SKU sin línea compatible. Prueba con menos HL o un plazo más tardío.'
          }
        />
      )}
      {outageNoEffect && (
        <WarningBanner
          title="La avería no impacta la producción"
          message={
            `No hay OFs planificados en L${submitted.outage!.linea} el ${submitted.outage!.fecha} turno ${submitted.outage!.turno}. ` +
            'El slot ya estaba vacío, por lo que no hay nada que reasignar.'
          }
          tone="info"
        />
      )}
      <Card>
        <CardHeader
          eyebrow="Impacto en OEE"
          title={applied ? 'Cambios aplicados ✓' : 'Previsualización del impacto'}
          subtitle={
            applied
              ? 'El plan activo ya refleja la incidencia. Revisa el resultado en Validar planificación.'
              : 'Si aceptas, el plan activo se sobrescribe y Validar planificación mostrará este nuevo estado.'
          }
        />
        <div className="grid grid-cols-1 gap-4 px-5 py-5 md:grid-cols-3">
          <KPI label="Plan original" value={pct(oeeBefore, 1)} />
          <KPI
            label="Plan con incidencia"
            value={pct(oeeAfter, 1)}
            accent={deltaPts < -0.05 ? 'damm' : 'moss'}
          />
          <div className="flex flex-col items-start gap-1">
            <div className="eyebrow text-ink-3">Diferencia</div>
            <div className={cn('num serif text-kpi font-medium', tone)}>
              {arrow} {pts(deltaPts)}
            </div>
            <div className="text-xs text-ink-3">
              {recos.length} reasignación(es)
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-hairline px-5 py-3">
          <Button variant="ghost" onClick={onCancel} disabled={applying || applied}>
            {applied ? 'Cerrar' : '↻ Cancelar y empezar otra'}
          </Button>
          {!applied && (
            <Button variant="primary" onClick={onApply} disabled={applying}>
              {applying ? 'Aplicando…' : '✓ Aplicar al plan activo'}
            </Button>
          )}
          {applied && (
            <Link href="/validar">
              <Button variant="primary">Ver en Validar planificación</Button>
            </Link>
          )}
        </div>
      </Card>

      {applyError && (
        <div className="rounded-soft border border-damm/30 bg-damm-soft/40 px-4 py-3 text-xs text-damm-700">
          No se pudo guardar: {applyError}
        </div>
      )}

      {recos.length > 0 && (
        <section className="space-y-3">
          <SectionTitle eyebrow="Detalle" subtitle="Cada fila es un movimiento que el modelo aplica al plan.">
            Reasignaciones propuestas
          </SectionTitle>
          {recos.map((r) => (
            <RecoCard key={r.id} reco={r} applied={applied} />
          ))}
        </section>
      )}
    </div>
  );
}
