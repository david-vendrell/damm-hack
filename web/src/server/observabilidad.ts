import { prisma } from './db';
import type {
  ObservabilidadData,
  ObservabilidadDimensiones,
} from '@/types';

export interface ObservabilidadFiltros {
  anio?: number;
  linea?: 14 | 17 | 19;
  marca?: string;
  formato?: string;
  canal?: string;
}

const LINEAS_VALIDAS = new Set([14, 17, 19]);

function weightedMean(rows: { hl: number; v: number | null }[]): number {
  let s = 0;
  let w = 0;
  for (const { hl, v } of rows) {
    if (v === null || !Number.isFinite(v)) continue;
    s += v * hl;
    w += hl;
  }
  return w > 0 ? s / w : 0;
}

function groupWeightedOee<K extends string | number>(
  rows: { hl: number; oee: number; key: K }[],
): { key: K; oee: number }[] {
  const map = new Map<K, { sum: number; w: number }>();
  for (const r of rows) {
    const cur = map.get(r.key) ?? { sum: 0, w: 0 };
    cur.sum += r.oee * r.hl;
    cur.w += r.hl;
    map.set(r.key, cur);
  }
  return [...map.entries()].map(([key, { sum, w }]) => ({
    key,
    oee: w > 0 ? sum / w : 0,
  }));
}

export async function getObservabilidad(
  filtros: ObservabilidadFiltros,
): Promise<ObservabilidadData> {
  const where = {
    ...(filtros.anio ? { anio: filtros.anio } : {}),
    ...(filtros.linea ? { linea: filtros.linea } : {}),
    ...(filtros.marca ? { marca: filtros.marca } : {}),
    ...(filtros.formato ? { formato: filtros.formato } : {}),
    ...(filtros.canal ? { canal: filtros.canal } : {}),
  };

  const rows = await prisma.ofHecho.findMany({ where });

  if (rows.length === 0) {
    return {
      kpis: {
        oee: 0,
        disponibilidad: 0,
        rendimiento: 0,
        volumenHl: 0,
        volumenUds: 0,
        ofs: 0,
        pctCambios: 0,
      },
      oeePorLinea: [],
      oeePorFormato: [],
      oeeMensual: [],
      oeeSemanal: [],
      topMarcas: [],
      perdidasTiempo: [],
      rangoFechas: null,
    };
  }

  // KPIs
  const totalHl = rows.reduce((a, r) => a + r.hl, 0);
  const totalUds = rows.reduce((a, r) => a + r.uds, 0);
  const cambios = rows.filter((r) => r.tieneCambio).length;

  const kpis = {
    oee: weightedMean(rows.map((r) => ({ hl: r.hl, v: r.oee }))),
    disponibilidad: weightedMean(rows.map((r) => ({ hl: r.hl, v: r.disp }))),
    rendimiento: weightedMean(rows.map((r) => ({ hl: r.hl, v: r.rend }))),
    volumenHl: totalHl,
    volumenUds: totalUds,
    ofs: rows.length,
    pctCambios: rows.length > 0 ? cambios / rows.length : 0,
  };

  // OEE por línea
  const oeePorLinea = groupWeightedOee(
    rows.map((r) => ({ hl: r.hl, oee: r.oee, key: r.linea })),
  )
    .filter((x) => LINEAS_VALIDAS.has(x.key))
    .sort((a, b) => a.key - b.key)
    .map((x) => ({ linea: x.key as 14 | 17 | 19, oee: x.oee }));

  // OEE por formato
  const oeePorFormato = groupWeightedOee(
    rows
      .filter((r) => r.formato)
      .map((r) => ({ hl: r.hl, oee: r.oee, key: r.formato as string })),
  )
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((x) => ({ formato: x.key, oee: x.oee }));

  // Mensual & semanal, con desglose por línea
  function temporal(grouper: (r: (typeof rows)[number]) => number) {
    const map = new Map<
      number,
      { sum: number; w: number; porLinea: Record<number, { sum: number; w: number }> }
    >();
    for (const r of rows) {
      const k = grouper(r);
      const cur = map.get(k) ?? { sum: 0, w: 0, porLinea: {} };
      cur.sum += r.oee * r.hl;
      cur.w += r.hl;
      cur.porLinea[r.linea] ??= { sum: 0, w: 0 };
      cur.porLinea[r.linea].sum += r.oee * r.hl;
      cur.porLinea[r.linea].w += r.hl;
      map.set(k, cur);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a - b)
      .map(([k, v]) => ({
        k,
        oee: v.w > 0 ? v.sum / v.w : 0,
        oeePorLinea: Object.fromEntries(
          Object.entries(v.porLinea).map(([l, x]) => [
            l,
            x.w > 0 ? x.sum / x.w : 0,
          ]),
        ) as Partial<Record<14 | 17 | 19, number>>,
      }));
  }

  const oeeMensual = temporal((r) => r.mes).map(({ k, oee, oeePorLinea }) => ({
    mes: k,
    oee,
    oeePorLinea,
  }));

  const oeeSemanal = temporal((r) => r.semanaIso).map(
    ({ k, oee, oeePorLinea }) => ({ semana: k, oee, oeePorLinea }),
  );

  // Top marcas: por nº OFs, top 10
  const marcaMap = new Map<string, { ofs: number; sum: number; w: number }>();
  for (const r of rows) {
    if (!r.marca) continue;
    const cur = marcaMap.get(r.marca) ?? { ofs: 0, sum: 0, w: 0 };
    cur.ofs += 1;
    cur.sum += r.oee * r.hl;
    cur.w += r.hl;
    marcaMap.set(r.marca, cur);
  }
  const topMarcas = [...marcaMap.entries()]
    .map(([marca, { ofs, sum, w }]) => ({
      marca,
      ofs,
      oee: w > 0 ? sum / w : 0,
    }))
    .sort((a, b) => b.ofs - a.ofs)
    .slice(0, 10);

  // Pérdidas de tiempo
  const sumKey = (k: keyof (typeof rows)[number]) =>
    rows.reduce((a, r) => a + ((r[k] as number | null) ?? 0), 0);

  const perdidasTiempo = [
    { concepto: 'Paro máquina', horas: sumKey('hParo') },
    { concepto: 'Baja velocidad', horas: sumKey('hBajaVelocidad') },
    { concepto: 'Saturación salida', horas: sumKey('hSaturacionSal') },
    { concepto: 'Falta producto', horas: sumKey('hFaltaProducto') },
    { concepto: 'CIP', horas: sumKey('hCip') },
    { concepto: 'Esterilización', horas: sumKey('hEsterilizacion') },
  ].sort((a, b) => b.horas - a.horas);

  // Rango fechas
  let minF = rows[0].fechaFin;
  let maxF = rows[0].fechaFin;
  for (const r of rows) {
    if (r.fechaFin < minF) minF = r.fechaFin;
    if (r.fechaFin > maxF) maxF = r.fechaFin;
  }

  return {
    kpis,
    oeePorLinea,
    oeePorFormato,
    oeeMensual,
    oeeSemanal,
    topMarcas,
    perdidasTiempo,
    rangoFechas: {
      desde: minF.toISOString().slice(0, 10),
      hasta: maxF.toISOString().slice(0, 10),
    },
  };
}

export async function getDimensiones(): Promise<ObservabilidadDimensiones> {
  const rows = await prisma.ofHecho.findMany({
    select: { anio: true, linea: true, marca: true, formato: true, canal: true },
  });
  const uniq = <T>(arr: Array<T | null | undefined>): T[] => [
    ...new Set(arr.filter((x): x is T => x !== null && x !== undefined)),
  ];
  return {
    anios: uniq(rows.map((r) => r.anio)).sort((a, b) => b - a),
    lineas: uniq(rows.map((r) => r.linea))
      .filter((l): l is 14 | 17 | 19 => LINEAS_VALIDAS.has(l))
      .sort((a, b) => a - b),
    marcas: uniq(rows.map((r) => r.marca)).sort(),
    formatos: uniq(rows.map((r) => r.formato)).sort(),
    canales: uniq(rows.map((r) => r.canal)).sort(),
  };
}
