'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { Pill, SectionTitle, Select, Skeleton } from '@/components/ui';
import type { Linea, SemanaPostMortem } from '@/types';

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch_failed');
  return r.json();
}

interface Props {
  filtroLinea: Linea | null;
  setFiltroLinea: (l: Linea | null) => void;
  selectedSemana: number | null;
  selectedAnio: number | null;
  setSelected: (s: { semana: number; anio: number } | null) => void;
}

export function WeeklyExplorer({
  filtroLinea,
  setFiltroLinea,
  selectedSemana,
  selectedAnio,
  setSelected,
}: Props) {
  const q = useQuery({
    queryKey: ['postmortem-weekly', filtroLinea],
    queryFn: () =>
      jget<SemanaPostMortem[]>(
        `/api/postmortem/weekly${filtroLinea ? `?linea=${filtroLinea}` : ''}`,
      ),
    staleTime: 60_000,
  });

  const semanas = useMemo(() => q.data ?? [], [q.data]);

  // Auto-select the most recent week whenever the filtered list refreshes
  // and no compatible selection exists yet.
  useEffect(() => {
    if (semanas.length === 0) {
      if (selectedSemana !== null) setSelected(null);
      return;
    }
    const stillValid = semanas.some(
      (s) => s.semana === selectedSemana && s.anio === selectedAnio,
    );
    if (!stillValid) {
      const head = semanas[0];
      setSelected({ semana: head.semana, anio: head.anio });
    }
  }, [semanas, selectedSemana, selectedAnio, setSelected]);

  const semanaOptions = useMemo(
    () =>
      semanas.map((s) => ({
        v: `${s.anio}-${s.semana}`,
        l: s.semanaLabel,
      })),
    [semanas],
  );

  const currentValue =
    selectedSemana !== null && selectedAnio !== null
      ? `${selectedAnio}-${selectedSemana}`
      : '';

  return (
    <section className="space-y-4">
      <SectionTitle
        eyebrow="Histórico"
        subtitle="Elige una semana y opcionalmente una línea para revisar su brief."
      >
        Explorador semanal
      </SectionTitle>

      <div className="flex flex-wrap items-end gap-4 rounded-card border border-hairline bg-surface px-5 py-4 shadow-card">
        <div className="min-w-[260px] flex-1">
          {q.isLoading ? (
            <Skeleton className="h-10" />
          ) : (
            <Select
              label="Semana"
              value={currentValue}
              options={semanaOptions}
              placeholder={
                semanaOptions.length === 0 ? 'Sin semanas disponibles' : 'Elige una semana'
              }
              onChange={(v) => {
                if (!v) {
                  setSelected(null);
                  return;
                }
                const [anioStr, semanaStr] = v.split('-');
                setSelected({ semana: Number(semanaStr), anio: Number(anioStr) });
              }}
            />
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="eyebrow text-ink-3">Línea</span>
          <div className="flex gap-1.5">
            <Pill active={filtroLinea === null} onClick={() => setFiltroLinea(null)}>
              Todas
            </Pill>
            {[14, 17, 19].map((l) => (
              <Pill
                key={l}
                active={filtroLinea === l}
                onClick={() => setFiltroLinea(l as Linea)}
              >
                L{l}
              </Pill>
            ))}
          </div>
        </div>

        {semanas.length > 0 && (
          <div className="ml-auto text-xs text-ink-3">
            <span className="num font-medium text-ink-2">{semanas.length}</span> semanas con datos
            {filtroLinea !== null && (
              <>
                {' '}en <span className="font-medium">L{filtroLinea}</span>
              </>
            )}
          </div>
        )}
      </div>

      {!q.isLoading && semanas.length === 0 && (
        <div className="rounded-card border border-hairline bg-surface px-6 py-10 text-center text-sm text-ink-3 shadow-card">
          Sin semanas con datos para la combinación elegida. Prueba a quitar el filtro de línea.
        </div>
      )}
    </section>
  );
}
