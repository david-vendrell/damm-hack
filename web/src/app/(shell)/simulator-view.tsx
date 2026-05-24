'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { lookupSku, SKU_FAMILY_LABEL } from '@/lib/sku-catalog';

type LineId = 'L14' | 'L17' | 'L19';
const LINES: LineId[] = ['L14', 'L17', 'L19'];

type BlockCtx = {
  oee: number;
  sku?: string;
  format?: string | null;
  brand?: string;
  brandColor?: string;
  hl?: number;
  turno?: string;
  feasible?: boolean;
  feasReason?: string;
  progress?: number;
  start?: number;
  end?: number;
  startIso?: string;
  endIso?: string;
  changeoverType?: string;
  idle: boolean;
};

type NextBlock = {
  sku: string;
  brand: string;
  brandColor: string;
  format: string | null;
  startIso: string;
  start: number;
};

type TickData = {
  playhead: number;
  tMin: number;
  tMax: number;
  weekStart: string | null;
  weekEnd: string | null;
  playing: boolean;
  speed: number;
  ctx: Record<LineId, BlockCtx>;
  next: Partial<Record<LineId, NextBlock>>;
};

const SCENE_SRC = '/interactive-3d/linewise_tres_lineas_oee_fabrica_3d_sin_paredes.html?embedded=1';

export function SimulatorView() {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [tick, setTick] = useState<TickData | null>(null);
  const [selectedLine, setSelectedLine] = useState<LineId | null>('L14');
  const [ready, setReady] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      const d = ev.data as { type?: string } & Partial<TickData>;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'lw:ready') {
        setReady(true);
        return;
      }
      if (d.type === 'lw:tick') {
        setTick(d as TickData);
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const post = useCallback((action: string, value?: number) => {
    const w = iframeRef.current?.contentWindow;
    if (!w) return;
    w.postMessage({ type: 'lw:cmd', action, value }, '*');
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const el = rootRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await el.requestFullscreen();
      }
    } catch {
      // ignore — browser denied or not supported
    }
  }, []);

  return (
    <div
      ref={rootRef}
      className={cn(
        '-mx-8 -my-8 flex overflow-hidden bg-cream',
        isFullscreen ? 'h-screen' : 'h-[calc(100vh-73px)]',
      )}
    >
      <div className="relative flex-1 overflow-hidden bg-[#05080f]">
        <iframe
          ref={iframeRef}
          src={SCENE_SRC}
          title="LineWise · Simulador de planta"
          allow="autoplay; fullscreen"
          className="absolute inset-0 h-full w-full"
          style={{ border: 0, background: '#05080f' }}
        />

        {/* Line chips overlay (top-left) */}
        <div className="absolute left-4 top-4 z-10 flex items-center gap-1.5 rounded-pill border border-white/10 bg-black/55 p-1 backdrop-blur-md">
          <ChipButton
            label="Resumen"
            active={selectedLine === null}
            onClick={() => setSelectedLine(null)}
          />
          {LINES.map((l) => (
            <ChipButton
              key={l}
              label={l}
              active={selectedLine === l}
              onClick={() => setSelectedLine(l)}
              dotColor={tick?.ctx?.[l]?.brandColor}
            />
          ))}
        </div>

        {/* Fullscreen toggle (top-right) */}
        <button
          type="button"
          onClick={toggleFullscreen}
          className="absolute right-4 top-4 z-10 inline-flex items-center gap-1.5 rounded-pill border border-white/10 bg-black/55 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-white/80 backdrop-blur-md transition-colors hover:bg-black/70 hover:text-white"
          aria-label={isFullscreen ? 'Salir de pantalla completa' : 'Ver en pantalla completa'}
          title={isFullscreen ? 'Salir de pantalla completa (Esc)' : 'Pantalla completa'}
        >
          {isFullscreen ? (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4.5 1.5 V4.5 H1.5" />
              <path d="M7.5 1.5 V4.5 H10.5" />
              <path d="M4.5 10.5 V7.5 H1.5" />
              <path d="M7.5 10.5 V7.5 H10.5" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1.5 4.5 V1.5 H4.5" />
              <path d="M10.5 4.5 V1.5 H7.5" />
              <path d="M1.5 7.5 V10.5 H4.5" />
              <path d="M10.5 7.5 V10.5 H7.5" />
            </svg>
          )}
          {isFullscreen ? 'Salir' : 'Pantalla completa'}
        </button>

        {/* Bottom transport */}
        <Transport
          tick={tick}
          ready={ready}
          onCmd={post}
        />
      </div>

      <aside className="relative h-full w-[400px] shrink-0 overflow-hidden border-l border-hairline bg-surface">
        <SidePanel tick={tick} selectedLine={selectedLine} />
      </aside>
    </div>
  );
}

function ChipButton({
  label,
  active,
  onClick,
  dotColor,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  dotColor?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill px-3 py-1 text-[11px] font-medium uppercase tracking-wider transition-colors',
        active
          ? 'bg-white text-ink'
          : 'text-white/70 hover:bg-white/10 hover:text-white',
      )}
    >
      {dotColor && (
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: dotColor, boxShadow: `0 0 8px ${dotColor}` }}
        />
      )}
      {label}
    </button>
  );
}

/* ─────────────────────────── Transport (play / speed / scrubber) ─────────────────────────── */

const SPEEDS = [0.25, 0.5, 1, 2];

function Transport({
  tick,
  ready,
  onCmd,
}: {
  tick: TickData | null;
  ready: boolean;
  onCmd: (action: string, value?: number) => void;
}) {
  const playhead = tick?.playhead ?? 0;
  const tMin = tick?.tMin ?? 0;
  const tMax = tick?.tMax ?? 1;
  const playing = tick?.playing ?? false;
  const speed = tick?.speed ?? 0.25;
  const progress = tMax > tMin ? (playhead - tMin) / (tMax - tMin) : 0;
  const disabled = !ready || !tick || tMax <= tMin;

  return (
    <div className="absolute bottom-5 left-1/2 z-10 flex w-[min(720px,calc(100%-32px))] -translate-x-1/2 items-center gap-3 rounded-2xl border border-white/10 bg-black/60 px-4 py-2.5 text-white shadow-[0_18px_45px_-12px_rgba(0,0,0,0.65)] backdrop-blur-md">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onCmd('toggle')}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-ink transition-transform hover:scale-[1.04] disabled:opacity-40"
        aria-label={playing ? 'Pausar' : 'Reproducir'}
      >
        {playing ? (
          <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor">
            <rect x="1" y="0" width="3" height="11" rx="1" />
            <rect x="7" y="0" width="3" height="11" rx="1" />
          </svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor">
            <path d="M1.5 0.5 L10 5.5 L1.5 10.5 Z" />
          </svg>
        )}
      </button>

      <button
        type="button"
        disabled={disabled}
        onClick={() => onCmd('nudge', -3600 * 1000)}
        className="rounded-full border border-white/15 px-2 text-[11px] text-white/70 hover:text-white disabled:opacity-40"
        aria-label="− 1 h"
      >
        −1h
      </button>

      <div className="flex flex-1 items-center gap-2">
        <input
          type="range"
          disabled={disabled}
          min={tMin}
          max={tMax}
          step={1000 * 60}
          value={playhead}
          onChange={(e) => onCmd('seek', Number(e.target.value))}
          className="lw-range flex-1"
          style={{
            background: `linear-gradient(90deg, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.85) ${progress * 100}%, rgba(255,255,255,0.18) ${progress * 100}%, rgba(255,255,255,0.18) 100%)`,
          }}
        />
      </div>

      <button
        type="button"
        disabled={disabled}
        onClick={() => onCmd('nudge', 3600 * 1000)}
        className="rounded-full border border-white/15 px-2 text-[11px] text-white/70 hover:text-white disabled:opacity-40"
        aria-label="+ 1 h"
      >
        +1h
      </button>

      <div className="flex items-center gap-0.5 rounded-full border border-white/10 bg-black/30 p-0.5">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            disabled={disabled}
            onClick={() => onCmd('speed', s)}
            className={cn(
              'rounded-full px-2.5 py-0.5 text-[10px] font-medium tabular-nums transition-colors',
              speed === s ? 'bg-white text-ink' : 'text-white/60 hover:text-white',
            )}
          >
            {s}×
          </button>
        ))}
      </div>

      <span className="min-w-[110px] text-right font-mono text-[11px] tabular-nums text-white/80">
        {formatTime(playhead)}
      </span>

      <style>{`
        .lw-range { appearance: none; height: 4px; border-radius: 999px; outline: none; }
        .lw-range::-webkit-slider-thumb { appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.4); cursor: pointer; }
        .lw-range::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: #fff; border: 0; box-shadow: 0 1px 4px rgba(0,0,0,0.4); cursor: pointer; }
        .lw-range:disabled { opacity: 0.5; }
      `}</style>
    </div>
  );
}

/* ─────────────────────────── Side panel ─────────────────────────── */

function SidePanel({
  tick,
  selectedLine,
}: {
  tick: TickData | null;
  selectedLine: LineId | null;
}) {
  if (!tick) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="serif text-base text-ink-2">Cargando simulación…</div>
        <p className="max-w-[260px] text-xs text-ink-3">
          Conectando con la planta 3D. Cuando esté lista verás aquí el SKU
          activo, su OEE y la línea de tiempo del bloque.
        </p>
      </div>
    );
  }

  if (selectedLine === null) {
    return <OverviewPanel tick={tick} />;
  }

  return <LinePanel tick={tick} line={selectedLine} />;
}

function OverviewPanel({ tick }: { tick: TickData }) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-hairline px-5 py-5">
        <div className="eyebrow text-ink-3">Plan semanal</div>
        <div className="mt-1.5 serif text-[18px] font-semibold leading-tight text-ink">
          {tick.weekStart && tick.weekEnd
            ? `${tick.weekStart} → ${tick.weekEnd}`
            : 'Plan en simulación'}
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-ink-3">
          Las tres líneas de latas en El Prat ejecutándose en paralelo. Elige
          una línea arriba para ver su SKU activo en detalle.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="eyebrow mb-3 text-ink-3">Estado por línea</div>
        <div className="space-y-2.5">
          {LINES.map((l) => {
            const c = tick.ctx?.[l];
            const sku = c?.sku ?? '—';
            const meta = lookupSku(c?.idle ? null : c?.sku);
            const oeePct = c ? Math.round((c.oee ?? 0) * 100) : 0;
            return (
              <div
                key={l}
                className="rounded-card border border-hairline bg-cream/60 px-4 py-3"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ background: c?.brandColor ?? '#94a3b8' }}
                    />
                    <span className="font-mono text-[11px] uppercase tracking-wider text-ink-2">
                      {l}
                    </span>
                  </div>
                  <OeeChip pct={oeePct} />
                </div>
                <div className="mt-2 serif text-[15px] leading-tight text-ink">
                  {c?.idle ? 'Sin bloque activo' : meta.brand}
                </div>
                <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-3">
                  {c?.idle ? '—' : `${sku} · ${c?.format ?? meta.format}`}
                </div>
              </div>
            );
          })}
        </div>

        <DidacticFooter />
      </div>
    </div>
  );
}

function LinePanel({ tick, line }: { tick: TickData; line: LineId }) {
  const c = tick.ctx?.[line];
  const next = tick.next?.[line];

  if (!c || c.idle) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-hairline px-5 py-5">
          <div className="eyebrow text-ink-3">Línea {line}</div>
          <div className="mt-1.5 serif text-[20px] font-semibold leading-tight text-ink">
            Sin bloque activo
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-3">
            En este momento la línea {line} no tiene producción asignada
            (limpieza, cambio largo o parada planificada).
          </p>
        </div>
        {next && (
          <div className="px-5 py-4">
            <div className="eyebrow mb-2 text-ink-3">Siguiente bloque</div>
            <NextBlockCard next={next} />
          </div>
        )}
      </div>
    );
  }

  const meta = lookupSku(c.sku);
  const oeePct = Math.round((c.oee ?? 0) * 100);
  const progressPct = Math.max(0, Math.min(1, c.progress ?? 0)) * 100;
  const hlDone = (c.hl ?? 0) * (c.progress ?? 0);
  const remainingMs = c.end && c.end > tick.playhead ? c.end - tick.playhead : 0;

  return (
    <div className="flex h-full flex-col">
      <Hero line={line} meta={meta} sku={c.sku ?? '—'} format={c.format ?? meta.format} color={c.brandColor ?? meta.color} />

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="eyebrow mb-3 text-ink-3">Métricas en vivo</div>
        <div className="grid grid-cols-2 gap-3">
          <MetricCard
            label="OEE línea"
            value={`${oeePct}%`}
            hint="Disponibilidad × Rendimiento × Calidad"
            bar={oeePct}
            barTone={oeeTone(c.oee ?? 0)}
          />
          <MetricCard
            label="Avance del bloque"
            value={`${Math.round(progressPct)}%`}
            hint={remainingMs > 0 ? `Quedan ${formatDuration(remainingMs)}` : 'Bloque finalizado'}
            bar={progressPct}
            barTone="ink"
          />
          <MetricCard
            label="Hectolitros"
            value={hlDone.toLocaleString('es-ES', { maximumFractionDigits: 0 })}
            unit={`hl / ${(c.hl ?? 0).toLocaleString('es-ES', { maximumFractionDigits: 0 })}`}
            hint="1 hl = 100 L ≈ 300 latas de 33 cl"
          />
          <MetricCard
            label="Ritmo previsto"
            value={ritmoHlH(c).toLocaleString('es-ES', { maximumFractionDigits: 0 })}
            unit="hl/h"
            hint="Producción media planificada del bloque"
          />
        </div>

        <div className="mt-6">
          <div className="eyebrow mb-2 text-ink-3">Línea de tiempo del bloque</div>
          <Timeline progress={progressPct / 100} playhead={tick.playhead} c={c} />
        </div>

        {next && (
          <div className="mt-5">
            <div className="eyebrow mb-2 text-ink-3">Después de este bloque</div>
            <NextBlockCard next={next} />
          </div>
        )}

        {c.feasReason && (
          <div className="mt-5 rounded-card border border-gold/30 bg-gold-soft px-3.5 py-2.5">
            <div className="eyebrow text-gold-700">Aviso del optimizador</div>
            <p className="mt-1 text-[11px] leading-snug text-ink-2">{c.feasReason}</p>
          </div>
        )}

        <DidacticFooter />
      </div>
    </div>
  );
}

function Hero({
  line,
  meta,
  sku,
  format,
  color,
}: {
  line: LineId;
  meta: ReturnType<typeof lookupSku>;
  sku: string;
  format: string | null | undefined;
  color: string;
}) {
  return (
    <div
      key={sku}
      className="relative overflow-hidden border-b border-hairline px-5 py-5 lw-hero-fade"
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: `linear-gradient(135deg, ${hexAlpha(color, 0.12)} 0%, transparent 65%)`,
        }}
      />
      <div className="relative">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: color, boxShadow: `0 0 10px ${color}` }}
          />
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">
            {line} · {SKU_FAMILY_LABEL[meta.family]}
          </span>
        </div>
        <h2 className="mt-2 serif text-[24px] font-semibold leading-tight tracking-tight text-ink">
          {meta.brand}
          {meta.variant && (
            <span className="ml-2 text-[14px] font-normal text-ink-3">
              · {meta.variant}
            </span>
          )}
        </h2>
        <div className="mt-1 flex items-center gap-2">
          <span className="font-mono text-[11px] uppercase tracking-wider text-ink-2">
            {sku}
          </span>
          <span className="rounded-pill border border-hairline bg-cream px-2 py-0.5 text-[10px] text-ink-3">
            {format ?? meta.format}
          </span>
        </div>
        <p className="mt-3 text-[12.5px] leading-relaxed text-ink-2">
          {meta.description}
        </p>
      </div>
      <style>{`
        .lw-hero-fade { animation: lwHeroIn 0.45s ease-out both; }
        @keyframes lwHeroIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

function MetricCard({
  label,
  value,
  unit,
  hint,
  bar,
  barTone,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  bar?: number;
  barTone?: 'green' | 'amber' | 'red' | 'ink';
}) {
  const toneCls =
    barTone === 'green'
      ? 'bg-moss'
      : barTone === 'amber'
        ? 'bg-gold'
        : barTone === 'red'
          ? 'bg-damm'
          : 'bg-ink';
  return (
    <div className="rounded-card border border-hairline bg-cream/40 px-3.5 py-3">
      <div className="eyebrow text-ink-3">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className="serif text-[22px] font-semibold leading-none text-ink tabular-nums">
          {value}
        </span>
        {unit && <span className="text-[10px] text-ink-3">{unit}</span>}
      </div>
      {typeof bar === 'number' && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-hairline/60">
          <div
            className={cn('h-full rounded-full transition-all duration-500', toneCls)}
            style={{ width: `${Math.max(0, Math.min(100, bar))}%` }}
          />
        </div>
      )}
      {hint && <div className="mt-2 text-[10px] leading-snug text-ink-3">{hint}</div>}
    </div>
  );
}

function OeeChip({ pct }: { pct: number }) {
  const tone =
    pct >= 70
      ? 'bg-moss-soft text-moss-700 border-moss/30'
      : pct >= 55
        ? 'bg-gold-soft text-gold-700 border-gold/30'
        : 'bg-damm-soft text-damm-700 border-damm/30';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium tabular-nums',
        tone,
      )}
    >
      OEE {pct}%
    </span>
  );
}

function Timeline({
  progress,
  playhead,
  c,
}: {
  progress: number;
  playhead: number;
  c: BlockCtx;
}) {
  const startMs = c.start ?? playhead - blockDuration(c) * progress;
  const endMs = c.end ?? startMs + blockDuration(c);
  return (
    <div>
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-hairline/60">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-ink transition-all duration-500"
          style={{ width: `${Math.max(0, Math.min(100, progress * 100))}%` }}
        />
        <div
          className="absolute -top-1 h-3.5 w-0.5 rounded-full bg-ink"
          style={{ left: `${Math.max(0, Math.min(100, progress * 100))}%` }}
        />
      </div>
      <div className="mt-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-ink-3">
        <span>{formatTime(startMs)}</span>
        <span className="text-ink-2">{formatTime(playhead)}</span>
        <span>{formatTime(endMs)}</span>
      </div>
    </div>
  );
}

function NextBlockCard({ next }: { next: NextBlock }) {
  const meta = lookupSku(next.sku);
  return (
    <div className="rounded-card border border-hairline bg-cream/40 px-3.5 py-3">
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: next.brandColor }}
        />
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-3">
          {next.sku}
        </span>
      </div>
      <div className="mt-1 serif text-[14px] leading-tight text-ink">
        {meta.brand}
        {meta.variant && <span className="text-ink-3"> · {meta.variant}</span>}
      </div>
      <div className="mt-1 text-[11px] text-ink-3">
        Empieza {formatTime(next.start)}
        {next.format && <span> · {next.format}</span>}
      </div>
    </div>
  );
}

function DidacticFooter() {
  return (
    <div className="mt-6 rounded-card border border-hairline bg-linen/50 px-4 py-3">
      <div className="eyebrow mb-1.5 text-ink-3">¿Qué estoy viendo?</div>
      <ul className="space-y-1.5 text-[11px] leading-snug text-ink-2">
        <li>
          <b className="text-ink">Bloque</b> — periodo continuo en el que la línea
          fabrica un SKU concreto antes de un cambio.
        </li>
        <li>
          <b className="text-ink">Changeover</b> — transición entre dos bloques
          (limpieza, ajuste de formato o cambio de marca). El anillo ámbar marca
          cuellos de botella, el rojo cambios costosos.
        </li>
        <li>
          <b className="text-ink">OEE</b> — Disponibilidad × Rendimiento × Calidad.
          Un 70% se considera bueno; por debajo de 55% hay pérdida material.
        </li>
      </ul>
    </div>
  );
}

/* ─────────────────────────── helpers ─────────────────────────── */

function oeeTone(oee: number): 'green' | 'amber' | 'red' {
  if (oee >= 0.7) return 'green';
  if (oee >= 0.55) return 'amber';
  return 'red';
}

function blockDuration(c: BlockCtx): number {
  if (c.start && c.end && c.end > c.start) return c.end - c.start;
  return 4 * 3600 * 1000;
}

function ritmoHlH(c: BlockCtx): number {
  const dur = blockDuration(c) / 3600 / 1000;
  if (dur <= 0) return 0;
  return (c.hl ?? 0) / dur;
}

function formatTime(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, '0');
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const mon = months[d.getMonth()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${dd} ${mon} ${hh}:${mm}`;
}

function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

function hexAlpha(hex: string, alpha: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return `rgba(148,163,184,${alpha})`;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
