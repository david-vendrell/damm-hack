'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import {
  Button, Card, CardHeader, KPI, Pill, SectionTitle, SegmentedControl,
  Skeleton, StatBlock, StatStrip, VeredictoBadge,
} from '@/components/ui';
import { AlertTriangle, Sparkles, Upload } from '@/components/icons';
import { cn, hl, pct, pts } from '@/lib/utils';
import type { AnalisisPlan, FilaPlan, Linea, PlanRecomendado, Recomendacion } from '@/types';
import { CalendarGrid } from './calendar-grid';
import { CellDrawer } from './cell-drawer';

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch_failed');
  return r.json();
}

async function postFile<T>(url: string, file: File): Promise<T> {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch(url, { method: 'POST', body: fd });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.detail ?? j.error ?? 'upload_failed');
  }
  return r.json();
}

export function ValidarView() {
  const [analisis, setAnalisis] = useState<AnalisisPlan | null>(null);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [drawerFilas, setDrawerFilas] = useState<FilaPlan[] | null>(null);
  const [vista, setVista] = useState<'calendario' | 'tabla'>('calendario');
  const fileRef = useRef<HTMLInputElement>(null);
  const calRef = useRef<HTMLDivElement>(null);
  const tablaRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);

  const upload = useMutation({
    mutationFn: (file: File) => postFile<AnalisisPlan>('/api/planes', file),
    onSuccess: (data) => {
      setAnalisis(data);
      setApplied(new Set());
      setDrawerFilas(null);
    },
  });

  const recos = useQuery({
    queryKey: ['recos', analisis?.planId],
    enabled: !!analisis?.planId,
    queryFn: () => jget<PlanRecomendado>(`/api/planes/${analisis!.planId}/recomendaciones`),
    staleTime: 60_000,
  });

  const handleFile = (f: File | null) => {
    if (f) upload.mutate(f);
  };

  const cambioVista = (v: 'calendario' | 'tabla') => {
    setVista(v);
    const target = v === 'calendario' ? calRef.current : tablaRef.current;
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="space-y-8">
      <header>
        <SectionTitle
          eyebrow="Validar plan"
          subtitle="Sube el Excel del plan (Diario Hl o Planificado). El modelo LineWise predice OEE por OF y te da una visión de la semana con veredictos: procede, revisar, evitar."
        >
          Validar planificación
        </SectionTitle>
      </header>

      {/* Dropzone — only shown until a plan is loaded */}
      {!analisis && (
        <UploadDropzone
          drag={drag}
          setDrag={setDrag}
          pending={upload.isPending}
          error={upload.isError ? (upload.error as Error).message : null}
          onFile={handleFile}
          inputRef={fileRef}
        />
      )}

      {upload.isPending && <PendingState />}

      {analisis && (
        <>
          <PlanHero
            analisis={analisis}
            recos={recos.data}
            onReset={() => setAnalisis(null)}
          />

          {analisis.meta?.source === 'heuristic_fallback' && (
            <FallbackBadge warning={analisis.meta.warning} />
          )}

          <div className="flex items-center justify-between">
            <SegmentedControl
              value={vista}
              onChange={cambioVista}
              options={[
                { v: 'calendario', l: 'Calendario' },
                { v: 'tabla', l: 'Tabla' },
              ]}
            />
            <div className="text-xs text-ink-3">
              {analisis.filas.length} OFs · {analisis.totalHl ? `${hl(analisis.totalHl)} planificados` : ''}
            </div>
          </div>

          {/* Calendar — answer-first hero */}
          <section ref={calRef} aria-label="Calendario del plan">
            <CalendarGrid
              bloques={analisis.filas}
              bloqueosMant={analisis.bloqueosMant}
              onClickCell={(filas) => setDrawerFilas(filas)}
            />
          </section>

          {/* Recomendaciones */}
          {recos.data && (
            <RecomendacionesPanel
              data={recos.data}
              applied={applied}
              setApplied={setApplied}
              oeeOriginal={analisis.oeePrevistoPlan}
            />
          )}

          {/* Tabla — drill-down */}
          <section ref={tablaRef} aria-label="Detalle por OF">
            <SectionTitle eyebrow="Drill-down" subtitle="Lista completa de OFs ordenada por línea y secuencia.">
              Detalle por OF
            </SectionTitle>
            <TablaOFs analisis={analisis} />
          </section>
        </>
      )}

      <CellDrawer filas={drawerFilas} onClose={() => setDrawerFilas(null)} />
    </div>
  );
}

/* ─────────────────────────── Upload dropzone ─────────────────────────── */

function UploadDropzone({
  drag, setDrag, pending, error, onFile, inputRef,
}: {
  drag: boolean;
  setDrag: (b: boolean) => void;
  pending: boolean;
  error: string | null;
  onFile: (f: File | null) => void;
  inputRef: React.RefObject<HTMLInputElement>;
}) {
  return (
    <Card>
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
        className={cn(
          'flex flex-col items-center justify-center gap-3 rounded-soft border-2 border-dashed px-6 py-16 text-center transition-colors',
          drag ? 'border-damm bg-damm-soft/40' : 'border-hairline bg-cream/30',
        )}
      >
        <Upload className="h-6 w-6 text-ink-3" strokeWidth={1.75} />
        <div className="text-sm font-medium text-ink">Arrastra aquí el Diario_Hl_Planif.xlsx</div>
        <div className="text-xs text-ink-3">o</div>
        <Button
          variant="primary"
          onClick={() => inputRef.current?.click()}
          leftIcon={<Upload className="h-3.5 w-3.5" strokeWidth={1.75} />}
        >
          Seleccionar archivo
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx"
          className="hidden"
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        />
        <div className="mt-2 text-[11px] text-ink-4">
          Formato aceptado: Diario Hl Planif o Planificado producciones.
        </div>
        {pending && (
          <div className="mt-3 text-xs text-ink-3">
            Procesando · construyendo lookup prev-aware (puede tardar 30 a 90 s la primera vez)…
          </div>
        )}
        {error && (
          <div className="mt-3 text-xs text-damm-700">Error: {error}</div>
        )}
      </div>
    </Card>
  );
}

/* ─────────────────────────── Pending state ─────────────────────────── */

function PendingState() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-80 w-full" />
    </div>
  );
}

/* ─────────────────────────── Hero ─────────────────────────── */

function PlanHero({
  analisis, recos, onReset,
}: {
  analisis: AnalisisPlan;
  recos?: PlanRecomendado;
  onReset: () => void;
}) {
  const decomp = analisis.decomposicion;
  return (
    <section className="space-y-4">
      <StatStrip>
        <StatBlock
          label="OEE previsto del plan"
          value={pct(analisis.oeePrevistoPlan, 1)}
          accent="damm"
          divider
        />
        <StatBlock
          label="Techo razonable (p90)"
          value={analisis.oeeP90Plan !== undefined ? pct(analisis.oeeP90Plan, 1) : '—'}
          accent="moss"
          divider
        />
        <StatBlock
          label="Banderas"
          value={`${analisis.banderas.evitar} / ${analisis.banderas.revisar} / ${analisis.banderas.procede}`}
          divider
        />
        <StatBlock
          label="Ganancia potencial"
          value={recos ? pts(recos.gananciaPts) : '…'}
          accent="moss"
        />
      </StatStrip>

      {decomp && (
        <div className="flex flex-wrap items-baseline gap-3 px-1 text-xs text-ink-3">
          <span className="eyebrow text-ink-4">Descomposición Damm</span>
          <span><span className="num font-medium text-ink-2">{pct(decomp.disp, 1)}</span> Disponibilidad</span>
          <span className="text-ink-4">×</span>
          <span><span className="num font-medium text-ink-2">{pct(decomp.rend, 1)}</span> Rendimiento</span>
          <span className="text-ink-4">×</span>
          <span><span className="num font-medium text-ink-2">{pct(decomp.cal, 1)}</span> Calidad</span>
          <span className="ml-auto inline-flex items-center gap-1.5 text-ink-4">
            <Sparkles className="h-3 w-3" strokeWidth={2} />
            {analisis.meta?.source === 'linewise'
              ? `Modelo LineWise · ${analisis.meta.via === 'local' ? 'local' : 'HF Space'}`
              : 'Heurística local'}
            {analisis.meta?.spaceLatencyMs !== undefined && (
              <span className="num">· {Math.round(analisis.meta.spaceLatencyMs / 1000)} s</span>
            )}
            <button
              type="button"
              onClick={onReset}
              className="ml-2 text-ink-3 transition-colors hover:text-ink"
            >
              subir otro plan ↻
            </button>
          </span>
        </div>
      )}

      {!decomp && (
        <div className="flex justify-end px-1 text-xs text-ink-3">
          <button
            type="button"
            onClick={onReset}
            className="transition-colors hover:text-ink"
          >
            subir otro plan ↻
          </button>
        </div>
      )}
    </section>
  );
}

/* ─────────────────────────── Fallback badge ─────────────────────────── */

function FallbackBadge({ warning }: { warning?: string }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-soft border border-gold/30 bg-gold-soft px-3 py-2 text-xs text-gold-700">
      <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2} />
      <span>{warning ?? 'Predicciones por heurística local (modelo LineWise no disponible).'}</span>
    </div>
  );
}

/* ─────────────────────────── Recomendaciones ─────────────────────────── */

function RecomendacionesPanel({
  data, applied, setApplied, oeeOriginal,
}: {
  data: PlanRecomendado;
  applied: Set<string>;
  setApplied: (s: Set<string>) => void;
  oeeOriginal: number;
}) {
  const gananciaAplicada = useMemo(() => {
    let sum = 0;
    for (const r of data.recomendaciones) if (applied.has(r.id)) sum += r.gananciaPts;
    return Math.min(15, sum * 0.55);
  }, [applied, data]);

  const oeeActual = Math.min(0.95, oeeOriginal + gananciaAplicada / 100);
  const oeeMaximo = data.oeePlanRecomendado;

  const toggle = (id: string) => {
    const next = new Set(applied);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setApplied(next);
  };

  return (
    <section>
      <Card>
        <CardHeader
          eyebrow="Recomendaciones"
          title="Mejoras propuestas"
          subtitle="aplica las que quieras; el comparador se actualiza al vuelo"
        />
        <div className="grid grid-cols-1 gap-5 px-5 py-5 lg:grid-cols-[1fr_320px]">
          <div className="space-y-3">
            {data.recomendaciones.length === 0 && (
              <div className="rounded-soft border border-hairline px-4 py-6 text-sm text-ink-3">
                No hay mejoras obvias. El plan ya es razonable.
              </div>
            )}
            {data.recomendaciones.map((r) => (
              <RecoCard key={r.id} reco={r} applied={applied.has(r.id)} onToggle={() => toggle(r.id)} />
            ))}
          </div>

          <div className="rounded-soft border border-hairline bg-cream/40 p-5">
            <div className="eyebrow text-ink-3">Comparador</div>
            <div className="mt-4 space-y-4">
              <KPI label="Plan original" value={pct(oeeOriginal, 1)} />
              <KPI
                label={`Con mejoras aplicadas (${applied.size})`}
                value={pct(oeeActual, 1)}
                accent="moss"
                delta={{ value: gananciaAplicada, format: 'pts' }}
              />
              <div className="border-t border-hairline pt-3">
                <KPI
                  label="Plan recomendado (todas)"
                  value={pct(oeeMaximo, 1)}
                  delta={{ value: data.gananciaPts, format: 'pts' }}
                />
              </div>
              <Button
                variant="primary"
                className="w-full"
                onClick={() => setApplied(new Set(data.recomendaciones.map((r) => r.id)))}
              >
                Aplicar todas
              </Button>
              {applied.size > 0 && (
                <Button variant="ghost" className="w-full" onClick={() => setApplied(new Set())}>
                  Restablecer
                </Button>
              )}
            </div>
          </div>
        </div>
      </Card>
    </section>
  );
}

function RecoCard({ reco, applied, onToggle }: { reco: Recomendacion; applied: boolean; onToggle: () => void }) {
  const tipoMap = {
    reordenar: { label: 'Reordenar', cls: 'bg-gold-soft text-gold-700' },
    mover_linea: { label: 'Mover de línea', cls: 'bg-damm-soft text-damm-700' },
    reprogramar: { label: 'Reprogramar', cls: 'bg-moss-soft text-moss-700' },
  } as const;
  const t = tipoMap[reco.tipo];
  return (
    <div className={cn('rounded-card border bg-surface p-4 transition-colors', applied ? 'border-moss' : 'border-hairline')}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className={cn('inline-flex rounded-pill px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider', t.cls)}>
              {t.label}
            </span>
            <span className="text-sm font-medium text-ink">{reco.titulo}</span>
          </div>
          <p className="mt-1.5 text-sm text-ink-3">{reco.descripcion}</p>
          {(reco.tipo === 'reordenar' || reco.tipo === 'mover_linea') && (
            <div className="mt-3 space-y-1.5 text-xs">
              <SecuenciaLinea label={`Antes — L${reco.antes.linea}`} skus={reco.antes.secuencia} />
              <SecuenciaLinea label={`Después — L${reco.despues.linea}`} skus={reco.despues.secuencia} highlight />
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="text-right">
            <div className="eyebrow text-ink-3">Ganancia</div>
            <div className="num text-lg font-semibold text-moss">{pts(reco.gananciaPts)}</div>
          </div>
          <Button
            variant={applied ? 'secondary' : 'primary'}
            size="sm"
            onClick={onToggle}
          >
            {applied ? '✓ Aplicada' : 'Aplicar'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SecuenciaLinea({ label, skus, highlight }: { label: string; skus: string[]; highlight?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-ink-3">{label}</span>
      <div className="flex flex-wrap gap-1">
        {skus.slice(0, 8).map((s, i) => (
          <span
            key={i}
            className={cn('rounded-soft px-1.5 py-0.5 font-mono text-[10px]', highlight ? 'bg-moss-soft text-moss-700' : 'bg-cream text-ink-2')}
          >
            {s}
          </span>
        ))}
        {skus.length > 8 && <span className="text-[10px] text-ink-3">+{skus.length - 8}</span>}
      </div>
    </div>
  );
}

/* ─────────────────────────── Tabla detalle ─────────────────────────── */

function TablaOFs({ analisis }: { analisis: AnalisisPlan }) {
  const [filtroLinea, setFiltroLinea] = useState<Linea | null>(null);
  const filtradas = useMemo(
    () => (filtroLinea ? analisis.filas.filter((f) => f.linea === filtroLinea) : analisis.filas),
    [analisis, filtroLinea],
  );

  return (
    <Card>
      <CardHeader
        title="Órdenes de fabricación del plan"
        subtitle={`${analisis.filas.length} OFs · OEE previsto medio ${pct(analisis.oeePrevistoPlan, 1)}`}
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
            <tr className="border-b border-hairline text-left">
              <th className="eyebrow px-5 py-3 text-ink-3">Veredicto</th>
              <th className="eyebrow px-5 py-3 text-ink-3">Línea</th>
              <th className="eyebrow px-5 py-3 text-ink-3">Día</th>
              <th className="eyebrow px-5 py-3 text-ink-3">SKU</th>
              <th className="eyebrow px-5 py-3 text-right text-ink-3">Hl</th>
              <th className="eyebrow px-5 py-3 text-ink-3">Cambio</th>
              <th className="eyebrow px-5 py-3 text-right text-ink-3">OEE p50</th>
              <th className="eyebrow px-5 py-3 text-right text-ink-3">p90</th>
              <th className="eyebrow px-5 py-3 text-ink-3">Motivo</th>
            </tr>
          </thead>
          <tbody>
            {filtradas.map((f, i) => (
              <tr key={i} className="border-b border-hairline last:border-0 transition-colors hover:bg-cream/40">
                <td className="px-5 py-3"><VeredictoBadge v={f.veredicto} /></td>
                <td className="num px-5 py-3 text-ink-2">L{f.linea}</td>
                <td className="num px-5 py-3 text-xs text-ink-3">{f.dia}</td>
                <td className="px-5 py-3">
                  <div className="text-sm font-medium text-ink">{f.nombre}</div>
                  <div className="font-mono text-xs text-ink-3">{f.sku}</div>
                </td>
                <td className="num px-5 py-3 text-right text-ink-2">{hl(f.hlPlan)}</td>
                <td className="px-5 py-3 text-xs">
                  {f.tipoCambio === 'inicio' && <span className="text-ink-4">— inicio —</span>}
                  {f.tipoCambio === 'formato' && <span className="font-medium text-damm-700">cambio de formato</span>}
                  {f.tipoCambio === 'cerveza' && <span className="text-ink-3">cambio de cerveza</span>}
                  {f.tipoCambio === 'mantenimiento' && <span className="text-gold-700">mantenimiento</span>}
                  {f.tipoCambio === 'otro' && <span className="text-ink-4">—</span>}
                </td>
                <td className="num px-5 py-3 text-right font-medium text-ink">{pct(f.oeePrevisto, 1)}</td>
                <td className="num px-5 py-3 text-right text-ink-3">
                  {f.oeeP90 !== undefined ? pct(f.oeeP90, 1) : '—'}
                </td>
                <td className="px-5 py-3 text-xs text-ink-3">{f.motivo}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
