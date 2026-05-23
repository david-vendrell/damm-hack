'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { Card, CardHeader, KPI, Pill, SectionTitle, Skeleton, VeredictoBadge } from '@/components/ui';
import { cn, hl, pct, pts } from '@/lib/utils';
import type { AnalisisPlan, Linea, PlanRecomendado, Recomendacion } from '@/types';

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
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  const upload = useMutation({
    mutationFn: (file: File) => postFile<AnalisisPlan>('/api/planes', file),
    onSuccess: (data) => { setAnalisis(data); setApplied(new Set()); },
  });

  const recos = useQuery({
    queryKey: ['recos', analisis?.planId],
    enabled: !!analisis?.planId,
    queryFn: () => jget<PlanRecomendado>(`/api/planes/${analisis!.planId}/recomendaciones`),
  });

  const handleFile = (f: File | null) => {
    if (f) upload.mutate(f);
  };

  return (
    <div className="space-y-10">
      <header>
        <SectionTitle subtitle="Sube el Excel del plan (Diario Hl). Te decimos qué procede, qué revisar, qué evitar — y cómo mejorarlo.">
          Validar planificación
        </SectionTitle>
      </header>

      {/* Dropzone */}
      {!analisis && (
        <Card>
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              const f = e.dataTransfer.files?.[0];
              if (f) handleFile(f);
            }}
            className={cn(
              'flex flex-col items-center justify-center gap-3 rounded-soft border-2 border-dashed px-6 py-16 text-center transition-colors',
              drag ? 'border-damm bg-damm-soft/40' : 'border-hairline bg-cream/30',
            )}
          >
            <div className="text-base font-medium">Arrastra aquí el Diario_Hl_Planif.xlsx</div>
            <div className="text-sm text-muted">o</div>
            <button
              onClick={() => fileRef.current?.click()}
              className="rounded-soft bg-damm px-4 py-2 text-sm font-medium text-surface hover:bg-damm-hover"
            >
              Seleccionar archivo
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            />
            <div className="mt-2 text-xs text-muted">Formato esperado: hoja "Diario Hl", bloques de 12 columnas por día.</div>
            {upload.isPending && <div className="text-sm text-muted">Procesando…</div>}
            {upload.isError && <div className="text-sm text-damm">Error: {(upload.error as Error).message}</div>}
          </div>
        </Card>
      )}

      {analisis && <ResumenPlan analisis={analisis} recos={recos.data} onReset={() => setAnalisis(null)} />}
      {analisis && <BannerVeredicto analisis={analisis} />}
      {analisis && recos.data && (
        <RecomendacionesPanel data={recos.data} applied={applied} setApplied={setApplied} oeeOriginal={analisis.oeePrevistoPlan} />
      )}
      {analisis && <TablaOFs analisis={analisis} />}
    </div>
  );
}

function ResumenPlan({ analisis, recos, onReset }: { analisis: AnalisisPlan; recos?: PlanRecomendado; onReset: () => void }) {
  return (
    <section className="grid grid-cols-1 gap-4 md:grid-cols-4">
      <KPI label="OEE previsto del plan" value={pct(analisis.oeePrevistoPlan)} hint={analisis.nombre} accent />
      <KPI label="Pérdida evitable" value={`${analisis.perdidaEvitablePts.toFixed(1)} pts`} hint="vs. correr cada OF en su alcanzable" />
      <KPI label="Banderas" value={`${analisis.banderas.evitar} / ${analisis.banderas.revisar} / ${analisis.banderas.procede}`} hint="evitar · revisar · procede" />
      <div className="rounded-soft border border-hairline bg-surface px-5 py-4">
        <div className="text-xs text-muted">Ganancia potencial</div>
        <div className="mt-1 text-3xl font-semibold tracking-tight text-good num">{recos ? `+${recos.gananciaPts.toFixed(1)} pts` : '…'}</div>
        <button onClick={onReset} className="mt-2 text-xs text-muted hover:text-ink">subir otro plan ↻</button>
      </div>
    </section>
  );
}

function BannerVeredicto({ analisis }: { analisis: AnalisisPlan }) {
  const total = analisis.banderas.evitar + analisis.banderas.revisar + analisis.banderas.procede;
  const pctEvitar = total ? analisis.banderas.evitar / total : 0;
  let tono: 'evitar' | 'revisar' | 'procede' = 'procede';
  if (pctEvitar > 0.2) tono = 'evitar';
  else if (pctEvitar > 0.05 || analisis.banderas.revisar > total * 0.25) tono = 'revisar';
  const map = {
    procede: { txt: 'Plan saludable', cls: 'border-good bg-good-soft text-good' },
    revisar: { txt: 'El plan tiene huecos: revísalos antes de soltarlo', cls: 'border-warn bg-warn-soft text-warn' },
    evitar: { txt: 'El plan deja OEE sobre la mesa: aplica las recomendaciones', cls: 'border-damm bg-damm-soft text-damm' },
  };
  const s = map[tono];
  return (
    <section className={cn('flex items-center justify-between rounded-soft border-2 px-5 py-4', s.cls)}>
      <div className="flex items-center gap-3">
        <VeredictoBadge v={tono} />
        <span className="font-medium">{s.txt}</span>
      </div>
      <div className="text-sm num">
        {analisis.banderas.evitar} evitar · {analisis.banderas.revisar} revisar · {analisis.banderas.procede} procede
      </div>
    </section>
  );
}

function RecomendacionesPanel({
  data,
  applied,
  setApplied,
  oeeOriginal,
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
        <CardHeader title="Mejoras propuestas" subtitle="aplica las que quieras; el comparador se actualiza al vuelo" />
        <div className="grid grid-cols-1 gap-5 px-5 py-5 lg:grid-cols-[1fr_320px]">
          <div className="space-y-3">
            {data.recomendaciones.length === 0 && (
              <div className="rounded-soft border border-hairline px-4 py-6 text-sm text-muted">No hay mejoras obvias. El plan ya es razonable.</div>
            )}
            {data.recomendaciones.map((r) => (
              <RecoCard key={r.id} reco={r} applied={applied.has(r.id)} onToggle={() => toggle(r.id)} />
            ))}
          </div>

          <div className="rounded-soft border border-hairline bg-cream/30 p-5">
            <div className="text-xs uppercase tracking-wider text-muted">Comparador</div>
            <div className="mt-4 space-y-4">
              <div>
                <div className="text-xs text-muted">Plan original</div>
                <div className="text-2xl font-semibold tracking-tight num">{pct(oeeOriginal)}</div>
              </div>
              <div>
                <div className="text-xs text-muted">Con mejoras aplicadas ({applied.size})</div>
                <div className="text-3xl font-semibold tracking-tight text-good num">{pct(oeeActual)}</div>
                <div className="text-xs num text-good">{pts(gananciaAplicada)}</div>
              </div>
              <div className="border-t border-hairline pt-3">
                <div className="text-xs text-muted">Plan recomendado (todas)</div>
                <div className="text-lg font-medium num">{pct(oeeMaximo)} <span className="text-xs text-muted">{pts(data.gananciaPts)}</span></div>
              </div>
              <button
                className="w-full rounded-soft border border-ink bg-ink px-3 py-2 text-sm text-surface hover:bg-damm hover:border-damm"
                onClick={() => setApplied(new Set(data.recomendaciones.map((r) => r.id)))}
              >
                Aplicar todas
              </button>
              {applied.size > 0 && (
                <button
                  className="w-full rounded-soft border border-hairline px-3 py-2 text-sm text-muted hover:text-ink"
                  onClick={() => setApplied(new Set())}
                >
                  Restablecer
                </button>
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
    reordenar: { label: 'Reordenar', cls: 'bg-warn-soft text-warn' },
    mover_linea: { label: 'Mover de línea', cls: 'bg-damm-soft text-damm' },
    reprogramar: { label: 'Reprogramar', cls: 'bg-good-soft text-good' },
  } as const;
  const t = tipoMap[reco.tipo];
  return (
    <div className={cn('rounded-soft border bg-surface p-4 transition-colors', applied ? 'border-good' : 'border-hairline')}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', t.cls)}>{t.label}</span>
            <span className="text-sm font-medium">{reco.titulo}</span>
          </div>
          <p className="mt-1.5 text-sm text-muted">{reco.descripcion}</p>
          {(reco.tipo === 'reordenar' || reco.tipo === 'mover_linea') && (
            <div className="mt-3 space-y-1.5 text-xs">
              <SecuenciaLinea label={`Antes — L${reco.antes.linea}`} skus={reco.antes.secuencia} />
              <SecuenciaLinea label={`Después — L${reco.despues.linea}`} skus={reco.despues.secuencia} highlight />
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="text-right">
            <div className="text-xs text-muted">Ganancia</div>
            <div className="text-lg font-semibold text-good num">{pts(reco.gananciaPts)}</div>
          </div>
          <button
            onClick={onToggle}
            className={cn(
              'rounded-soft px-3 py-1.5 text-xs font-medium transition-colors',
              applied
                ? 'border border-good bg-good-soft text-good'
                : 'border border-ink bg-ink text-surface hover:bg-damm hover:border-damm',
            )}
          >
            {applied ? '✓ Aplicada' : 'Aplicar'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SecuenciaLinea({ label, skus, highlight }: { label: string; skus: string[]; highlight?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-muted">{label}</span>
      <div className="flex flex-wrap gap-1">
        {skus.slice(0, 8).map((s, i) => (
          <span key={i} className={cn('rounded px-1.5 py-0.5 font-mono text-[10px]', highlight ? 'bg-good-soft text-good' : 'bg-cream text-ink')}>
            {s}
          </span>
        ))}
        {skus.length > 8 && <span className="text-[10px] text-muted">+{skus.length - 8}</span>}
      </div>
    </div>
  );
}

function TablaOFs({ analisis }: { analisis: AnalisisPlan }) {
  const [filtroLinea, setFiltroLinea] = useState<Linea | null>(null);
  const filtradas = useMemo(
    () => (filtroLinea ? analisis.filas.filter((f) => f.linea === filtroLinea) : analisis.filas),
    [analisis, filtroLinea],
  );

  return (
    <section>
      <Card>
        <CardHeader
          title="Órdenes de fabricación del plan"
          subtitle={`${analisis.filas.length} OFs · OEE previsto medio ${pct(analisis.oeePrevistoPlan)}`}
          action={
            <div className="flex gap-1.5">
              <Pill active={filtroLinea === null} onClick={() => setFiltroLinea(null)}>Todas</Pill>
              {[14, 17, 19].map((l) => (
                <Pill key={l} active={filtroLinea === l} onClick={() => setFiltroLinea(l as Linea)}>L{l}</Pill>
              ))}
            </div>
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline text-left text-xs uppercase tracking-wider text-muted">
                <th className="px-5 py-3">Veredicto</th>
                <th className="px-5 py-3">Línea</th>
                <th className="px-5 py-3">Día</th>
                <th className="px-5 py-3">SKU</th>
                <th className="px-5 py-3 text-right">Hl</th>
                <th className="px-5 py-3">Cambio</th>
                <th className="px-5 py-3 text-right">OEE previsto</th>
                <th className="px-5 py-3">Motivo</th>
              </tr>
            </thead>
            <tbody>
              {filtradas.map((f, i) => (
                <tr
                  key={i}
                  className={cn('border-b border-hairline last:border-0', f.veredicto === 'evitar' && 'border-l-2 border-l-damm')}
                >
                  <td className="px-5 py-3"><VeredictoBadge v={f.veredicto} /></td>
                  <td className="px-5 py-3 num">L{f.linea}</td>
                  <td className="px-5 py-3 num text-muted">{f.dia}</td>
                  <td className="px-5 py-3">
                    <div className="font-medium">{f.nombre}</div>
                    <div className="font-mono text-xs text-muted">{f.sku}</div>
                  </td>
                  <td className="px-5 py-3 text-right num">{hl(f.hlPlan)}</td>
                  <td className="px-5 py-3 text-xs">
                    {f.tipoCambio === 'inicio' && <span className="text-muted">— inicio —</span>}
                    {f.tipoCambio === 'formato' && <span className="font-medium text-damm">cambio de formato</span>}
                    {f.tipoCambio === 'cerveza' && <span className="text-muted">cambio de cerveza</span>}
                    {f.tipoCambio === 'mantenimiento' && <span className="text-warn">mantenimiento</span>}
                    {f.tipoCambio === 'otro' && <span className="text-muted">—</span>}
                  </td>
                  <td className="px-5 py-3 text-right num font-medium">{pct(f.oeePrevisto)}</td>
                  <td className="px-5 py-3 text-xs text-muted">{f.motivo}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}
