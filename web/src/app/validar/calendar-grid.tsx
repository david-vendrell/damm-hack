'use client';

import { Fragment } from 'react';
import { cn } from '@/lib/utils';
import type { BloqueoMant, FilaPlan, Linea, Turno } from '@/types';

/**
 * Plan calendar / timetable.
 * Grid is 9 rows (3 líneas × 3 turnos) × 7 día columns + 1 sticky label.
 * Each cell renders the OF(s) scheduled at (línea, día, turno) with a
 * Veredicto-tinted background and the model's p50 prediction.
 * Maintenance / outage slots are hatched and labelled.
 */

const LINEAS: Linea[] = [14, 17, 19];
const TURNOS: Turno[] = ['M', 'T', 'N'];
const TURNO_LABEL: Record<Turno, string> = { M: 'Mañana', T: 'Tarde', N: 'Noche' };
const DOW_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']; // dia.getDay() index

interface Props {
  bloques: FilaPlan[];
  bloqueosMant?: BloqueoMant[];
  onClickCell: (filas: FilaPlan[]) => void;
}

export function CalendarGrid({ bloques, bloqueosMant, onClickCell }: Props) {
  const dias = collectDias(bloques);
  if (!dias.length) {
    return (
      <div className="rounded-card border border-hairline bg-surface px-6 py-10 text-center text-sm text-ink-3 shadow-card">
        Sin días planificados en el fichero.
      </div>
    );
  }

  const byCell = indexByCell(bloques);
  const mantByCell = indexBloqueosMant(bloqueosMant);

  return (
    <div className="overflow-x-auto rounded-card border border-hairline bg-surface shadow-card">
      <div
        className="grid min-w-[920px]"
        style={{ gridTemplateColumns: `120px repeat(${dias.length}, minmax(110px, 1fr))` }}
      >
        {/* Header row: empty corner + día labels */}
        <div className="border-b border-hairline bg-cream px-3 py-2.5" />
        {dias.map((d) => {
          const dt = new Date(d + 'T00:00:00');
          return (
            <div
              key={d}
              className="border-b border-l border-hairline bg-cream px-3 py-2.5 text-center"
            >
              <div className="eyebrow text-ink-3">{DOW_ES[dt.getDay()]}</div>
              <div className="num text-xs text-ink-2">{d.slice(5)}</div>
            </div>
          );
        })}

        {/* Body: 9 rows = 3 líneas × 3 turnos */}
        {LINEAS.map((linea, li) =>
          TURNOS.map((turno, ti) => {
            const isLineaStart = ti === 0;
            const isLineaBoundary = isLineaStart && li > 0;
            return (
              <Fragment key={`${linea}-${turno}`}>
                {/* Sticky label column */}
                <div
                  className={cn(
                    'flex items-center gap-2 border-hairline bg-cream/50 px-3 py-3 text-xs',
                    isLineaBoundary && 'border-t-2 border-hairline-strong',
                  )}
                >
                  {isLineaStart ? (
                    <span className="serif text-base font-medium text-ink">{`L${linea}`}</span>
                  ) : (
                    <span className="w-7" />
                  )}
                  <span className="eyebrow text-ink-3">{TURNO_LABEL[turno]}</span>
                </div>

                {/* 7 día cells */}
                {dias.map((dia) => {
                  const key = `${linea}|${dia}|${turno}`;
                  const filasHere = byCell.get(key) ?? [];
                  const mant = mantByCell.get(key);
                  return (
                    <Cell
                      key={key}
                      filas={filasHere}
                      mant={mant}
                      borderLeft
                      borderTop={isLineaBoundary}
                      onClick={() => filasHere.length && onClickCell(filasHere)}
                    />
                  );
                })}
              </Fragment>
            );
          }),
        )}
      </div>

      <Leyenda />
    </div>
  );
}

/* ─────────────────────────── Cell ─────────────────────────── */

function Cell({
  filas,
  mant,
  borderLeft,
  borderTop,
  onClick,
}: {
  filas: FilaPlan[];
  mant?: BloqueoMant;
  borderLeft?: boolean;
  borderTop?: boolean;
  onClick: () => void;
}) {
  // Maintenance / outage cell takes priority over content
  if (mant && filas.length === 0) {
    return (
      <div
        className={cn(
          'hatch min-h-[68px] border-hairline px-2 py-2',
          borderLeft && 'border-l',
          borderTop && 'border-t-2 border-hairline-strong',
        )}
        title={mant.reason}
      >
        <div className="eyebrow text-ink-3">🛠 {mant.event === 'LIMPIEZA' ? 'LIMP.' : mant.event === 'MANTENIMIENTO' ? 'MANT.' : 'OUTAGE'}</div>
      </div>
    );
  }

  if (filas.length === 0) {
    return (
      <div
        className={cn(
          'min-h-[60px] border-hairline bg-cream/40',
          borderLeft && 'border-l',
          borderTop && 'border-t-2 border-hairline-strong',
        )}
      />
    );
  }

  const head = filas[0];
  const extra = filas.length - 1;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex min-h-[60px] flex-col justify-center gap-0.5 border-hairline bg-surface px-2 py-1.5 text-left transition-colors hover:bg-linen',
        borderLeft && 'border-l',
        borderTop && 'border-t-2 border-hairline-strong',
      )}
      aria-label={`${head.sku} en L${head.linea} ${head.dia}`}
    >
      <div className="flex items-start justify-between gap-1.5">
        <span className="font-mono text-[11px] font-medium text-ink">{head.sku}</span>
        {extra > 0 && (
          <span className="rounded-full bg-cream px-1.5 py-0.5 text-[10px] font-medium text-ink-3">
            +{extra}
          </span>
        )}
      </div>
    </button>
  );
}

/* ─────────────────────────── Legend ─────────────────────────── */

function Leyenda() {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-hairline bg-cream/40 px-4 py-2 text-[11px] text-ink-3">
      <span className="inline-flex items-center gap-1.5">
        <span className="hatch inline-block h-3 w-4 rounded-sm border border-hairline" />
        Mantenimiento / Limpieza programada
      </span>
    </div>
  );
}

/* ─────────────────────────── Helpers ─────────────────────────── */

function collectDias(filas: FilaPlan[]): string[] {
  const set = new Set<string>();
  for (const f of filas) set.add(f.dia);
  return [...set].sort();
}

/**
 * Index OFs by (línea, día, turno). When the source plan doesn't carry a
 * turno (the Diario Hl parser doesn't infer shifts), we round-robin OFs
 * across the 3 turnos within (línea, día) by their secuencia order — that
 * gives a visually distributed week and matches how the backend's
 * synthetic-shift parser splits HL into thirds.
 */
function indexByCell(filas: FilaPlan[]): Map<string, FilaPlan[]> {
  const out = new Map<string, FilaPlan[]>();
  // First: rows that carry an explicit turno
  const withTurno = filas.filter((f) => f.turno);
  for (const f of withTurno) {
    const k = `${f.linea}|${f.dia}|${f.turno}`;
    const arr = out.get(k) ?? [];
    arr.push(f);
    out.set(k, arr);
  }
  // Then: rows without turno, distribute by secuencia within (línea, día)
  const noTurno = filas.filter((f) => !f.turno);
  const groups = new Map<string, FilaPlan[]>();
  for (const f of noTurno) {
    const k = `${f.linea}|${f.dia}`;
    const arr = groups.get(k) ?? [];
    arr.push(f);
    groups.set(k, arr);
  }
  for (const [k, group] of groups) {
    group.sort((a, b) => a.secuencia - b.secuencia);
    group.forEach((f, i) => {
      const turno = TURNOS[i % 3];
      const cellKey = `${k}|${turno}`;
      const arr = out.get(cellKey) ?? [];
      arr.push(f);
      out.set(cellKey, arr);
    });
  }
  return out;
}

function indexBloqueosMant(bloqueos?: BloqueoMant[]): Map<string, BloqueoMant> {
  const out = new Map<string, BloqueoMant>();
  for (const b of bloqueos ?? []) {
    out.set(`${b.linea}|${b.dia}|${b.turno}`, b);
  }
  return out;
}
