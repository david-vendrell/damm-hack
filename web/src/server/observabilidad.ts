import { num, query, str } from './duck';
import type {
  CambioPorLineaItem,
  CambiosImpactoItem,
  LimpiezaPorLineaItem,
  ObservabilidadData,
  ObservabilidadDimensiones,
  OeeDistribucionBucket,
  ParetoPerdidasItem,
  PeorOf,
  PerdidasPorLineaItem,
  PlanVsActualFila,
  SerieMensualLinea,
  UtilizacionLineaItem,
} from '@/types';

export interface ObservabilidadFiltros {
  anio?: number;
  linea?: 14 | 17 | 19;
  marca?: string;
  formato?: string;
  canal?: string;
  turno?: string;
  desde?: string; // YYYY-MM-DD inclusive
  hasta?: string; // YYYY-MM-DD inclusive
}

const LINEAS_VALIDAS = new Set<14 | 17 | 19>([14, 17, 19]);
const LINEAS_ORDEN: (14 | 17 | 19)[] = [14, 17, 19];

interface FactRow {
  of: string;
  linea: number;
  fechaFin: string;
  anio: number;
  mes: number;
  semanaIso: number;
  sku: string;
  marca: string | null;
  familia: string | null;
  tipoEnvase: string | null;
  formato: string | null;
  canal: string | null;
  oee: number;
  disp: number;
  rend: number;
  inef: number | null;
  hl: number;
  uds: number;
  tieneCambio: boolean;
  hTotales: number;
  hMarcha: number;
  hParo: number;
  hPnp: number;
  hLimpieza: number;
  hIdle: number;
  hBajaVelocidad: number;
  hSaturacionSal: number;
  hFaltaProducto: number;
  hCip: number;
  hEsterilizacion: number;
  hCambio: number;
  nLlamadasMant: number;
  hEsperaMant: number;
  hIntervencionMant: number;
  nDimsCambiadas: number;
}

const BASE_SELECT = `
  SELECT
    r.of                                              AS of,
    r.linea                                           AS linea,
    CAST(r.fecha_fin AS VARCHAR)                      AS "fechaFin",
    CAST(r.anyo AS INTEGER)                           AS anio,
    CAST(r.mes AS INTEGER)                            AS mes,
    CAST(r.semana AS INTEGER)                         AS "semanaIso",
    r.sku                                             AS sku,
    r.marca                                           AS marca,
    r.familia                                         AS familia,
    r.tipo_envase                                     AS "tipoEnvase",
    r.estado_volumen                                  AS formato,
    NULLIF(TRIM(REGEXP_REPLACE(o.canal_distribucion, '^Canal\\s*distrib\\.?\\s*', '', 'i')), '') AS canal,
    COALESCE(r.oee, 0)                                AS oee,
    COALESCE(r.disponibilidad, 0)                     AS disp,
    COALESCE(r.rendimiento, 0)                        AS rend,
    r.ineficiencia                                    AS inef,
    COALESCE(r.hl, 0)                                 AS hl,
    CAST(COALESCE(r.uds, 0) AS DOUBLE)                AS uds,
    COALESCE(r.hubo_cambio, FALSE)                    AS "tieneCambio",
    COALESCE(r.horas_totales, 0)                      AS "hTotales",
    COALESCE(r.horas_marcha, 0)                       AS "hMarcha",
    COALESCE(r.horas_paro, 0)                         AS "hParo",
    COALESCE(r.horas_pnp, 0)                          AS "hPnp",
    COALESCE(r.horas_limpieza_dentro_of, 0)           AS "hLimpieza",
    COALESCE(r.horas_idle, 0)                         AS "hIdle",
    COALESCE(r.horas_baja_velocidad, 0)               AS "hBajaVelocidad",
    COALESCE(r.horas_saturacion, 0)                   AS "hSaturacionSal",
    COALESCE(r.horas_falta_producto, 0)               AS "hFaltaProducto",
    COALESCE(r.horas_cip, 0)                          AS "hCip",
    COALESCE(r.horas_esterilizacion, 0)               AS "hEsterilizacion",
    COALESCE(r.horas_cambio, 0)                       AS "hCambio",
    COALESCE(r.n_llamadas_mant, 0)                    AS "nLlamadasMant",
    COALESCE(r.horas_espera_mant, 0)                  AS "hEsperaMant",
    COALESCE(r.horas_intervencion_mant, 0)            AS "hIntervencionMant",
    CAST(COALESCE(r.n_dimensiones_cambiadas, 0) AS INTEGER) AS "nDimsCambiadas"
  FROM fact_runs r
  LEFT JOIN raw_oee o ON o.of = r.of
  WHERE NOT r.outlier
`;

function buildFilters(f: ObservabilidadFiltros): { sql: string; params: Record<string, unknown> } {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (f.anio !== undefined) {
    clauses.push(`CAST(r.anyo AS INTEGER) = $anio`);
    params.anio = f.anio;
  }
  if (f.linea !== undefined) {
    clauses.push(`r.linea = $linea`);
    params.linea = f.linea;
  }
  if (f.marca) {
    clauses.push(`r.marca = $marca`);
    params.marca = f.marca;
  }
  if (f.formato) {
    clauses.push(`r.estado_volumen = $formato`);
    params.formato = f.formato;
  }
  if (f.canal) {
    clauses.push(`NULLIF(TRIM(REGEXP_REPLACE(o.canal_distribucion, '^Canal\\s*distrib\\.?\\s*', '', 'i')), '') = $canal`);
    params.canal = f.canal;
  }
  if (f.turno) {
    clauses.push(`r.turno = $turno`);
    params.turno = f.turno;
  }
  if (f.desde) {
    clauses.push(`r.fecha_fin >= CAST($desde AS DATE)`);
    params.desde = f.desde;
  }
  if (f.hasta) {
    clauses.push(`r.fecha_fin <= CAST($hasta AS DATE)`);
    params.hasta = f.hasta;
  }
  return {
    sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '',
    params,
  };
}

/** Resolve a Scope period preset into [desde, hasta] (YYYY-MM-DD inclusive). */
export function resolvePeriodo(
  periodo: string,
  today: Date = new Date(),
): { desde?: string; hasta?: string } {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const start = new Date(today);
  switch (periodo) {
    case 'today':
      return { desde: iso(start), hasta: iso(start) };
    case 'wtd': {
      const day = (start.getUTCDay() + 6) % 7; // monday = 0
      start.setUTCDate(start.getUTCDate() - day);
      return { desde: iso(start), hasta: iso(today) };
    }
    case 'mtd':
      start.setUTCDate(1);
      return { desde: iso(start), hasta: iso(today) };
    case 'ytd':
      return { desde: `${today.getUTCFullYear()}-01-01`, hasta: iso(today) };
    case 'last7':
      start.setUTCDate(start.getUTCDate() - 6);
      return { desde: iso(start), hasta: iso(today) };
    case 'last30':
      start.setUTCDate(start.getUTCDate() - 29);
      return { desde: iso(start), hasta: iso(today) };
    default:
      return {};
  }
}

function rowsToTyped(raw: Record<string, unknown>[]): FactRow[] {
  return raw.map((r) => ({
    of: String(r.of),
    linea: num(r.linea),
    fechaFin: String(r.fechaFin),
    anio: num(r.anio),
    mes: num(r.mes),
    semanaIso: num(r.semanaIso),
    sku: String(r.sku ?? ''),
    marca: str(r.marca),
    familia: str(r.familia),
    tipoEnvase: str(r.tipoEnvase),
    formato: str(r.formato),
    canal: str(r.canal),
    oee: num(r.oee),
    disp: num(r.disp),
    rend: num(r.rend),
    inef: r.inef === null || r.inef === undefined ? null : num(r.inef),
    hl: num(r.hl),
    uds: num(r.uds),
    tieneCambio: Boolean(r.tieneCambio),
    hTotales: num(r.hTotales),
    hMarcha: num(r.hMarcha),
    hParo: num(r.hParo),
    hPnp: num(r.hPnp),
    hLimpieza: num(r.hLimpieza),
    hIdle: num(r.hIdle),
    hBajaVelocidad: num(r.hBajaVelocidad),
    hSaturacionSal: num(r.hSaturacionSal),
    hFaltaProducto: num(r.hFaltaProducto),
    hCip: num(r.hCip),
    hEsterilizacion: num(r.hEsterilizacion),
    hCambio: num(r.hCambio),
    nLlamadasMant: num(r.nLlamadasMant),
    hEsperaMant: num(r.hEsperaMant),
    hIntervencionMant: num(r.hIntervencionMant),
    nDimsCambiadas: num(r.nDimsCambiadas),
  }));
}

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
): { key: K; oee: number; hl: number }[] {
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
    hl: w,
  }));
}

export async function getObservabilidad(
  filtros: ObservabilidadFiltros,
): Promise<ObservabilidadData> {
  const { sql, params } = buildFilters(filtros);
  const raw = await query(BASE_SELECT + sql, params);
  const rows = rowsToTyped(raw);

  if (rows.length === 0) return emptyResponse();

  // -------- KPIs (base) --------
  const totalHl = rows.reduce((a, r) => a + r.hl, 0);
  const totalUds = rows.reduce((a, r) => a + r.uds, 0);
  const cambios = rows.filter((r) => r.tieneCambio).length;
  const sumMarchaAll = rows.reduce((a, r) => a + r.hMarcha, 0);
  const sumTotalesAll = rows.reduce((a, r) => a + r.hTotales, 0);
  const sumIntervMant = rows.reduce((a, r) => a + r.hIntervencionMant, 0);
  const sumLlamadas = rows.reduce((a, r) => a + r.nLlamadasMant, 0);
  const sumCip = rows.reduce((a, r) => a + r.hCip, 0);
  const sumCambio = rows.reduce((a, r) => a + r.hCambio, 0);

  // -------- Changeover real vs teorico (fact_changeovers) --------
  const cambiosRealVsTeorico = await query<{
    linea: number;
    real_min: number | string;
    teorico_min: number | string;
    n: number | string;
  }>(
    `SELECT linea,
            SUM(GREATEST(COALESCE(horas_totales,0) - COALESCE(horas_marcha,0), 0) * 60) AS real_min,
            SUM(COALESCE(teorico_cambio_volumen_min, 0)) AS teorico_min,
            COUNT(*) AS n
     FROM fact_changeovers
     WHERE hubo_cambio
       ${filtros.anio !== undefined ? `AND EXTRACT(year FROM fecha_fin) = $anio` : ''}
       ${filtros.linea !== undefined ? `AND linea = $linea` : ''}
       ${filtros.marca ? `AND marca = $marca` : ''}
     GROUP BY linea
     ORDER BY linea`,
    {
      ...(filtros.anio !== undefined ? { anio: filtros.anio } : {}),
      ...(filtros.linea !== undefined ? { linea: filtros.linea } : {}),
      ...(filtros.marca ? { marca: filtros.marca } : {}),
    },
  );

  const cambioPorLinea: CambioPorLineaItem[] = LINEAS_ORDEN.map((linea) => {
    const fc = cambiosRealVsTeorico.find((x) => num(x.linea) === linea);
    const subset = rows.filter((r) => r.linea === linea);
    const subsetConCambio = subset.filter((r) => r.tieneCambio);
    const horasCambio = subset.reduce((a, r) => a + r.hCambio, 0);
    const nCambios = subsetConCambio.length;
    const realMin = fc ? num(fc.real_min) : horasCambio * 60;
    const teoricoMin = fc ? num(fc.teorico_min) : 0;
    return {
      linea,
      horasCambio,
      nCambios,
      horasCambioPorOf: nCambios > 0 ? horasCambio / nCambios : 0,
      realMin,
      teoricoMin,
      deltaMin: realMin - teoricoMin,
    };
  });

  const totalRealMin = cambioPorLinea.reduce((a, x) => a + x.realMin, 0);
  const totalTeoricoMin = cambioPorLinea.reduce((a, x) => a + x.teoricoMin, 0);

  // -------- Plan vs Actual (May 2026) --------
  const planRows = await query<{
    linea: number;
    sku: string;
    denominacion: string | null;
    hl_plan: number | null;
    hl_actual: number | null;
    estado: string;
  }>(
    `SELECT linea, sku, denominacion,
            CAST(COALESCE(cntd_plan, 0) AS DOUBLE) AS hl_plan,
            COALESCE(hl_actual, 0) AS hl_actual,
            estado_join AS estado
     FROM fact_plan_vs_actual_2026
     WHERE 1=1
       ${filtros.linea !== undefined ? `AND linea = $linea` : ''}`,
    filtros.linea !== undefined ? { linea: filtros.linea } : {},
  );

  let planHl = 0;
  let actualHl = 0;
  let nMatched = 0;
  let nOnlyPlan = 0;
  let nOnlyActual = 0;
  const planFilas: PlanVsActualFila[] = [];
  for (const p of planRows) {
    const hlPlan = num(p.hl_plan);
    const hlActual = num(p.hl_actual);
    planHl += hlPlan;
    actualHl += hlActual;
    if (p.estado === 'matched') nMatched += 1;
    else if (p.estado === 'only_plan') nOnlyPlan += 1;
    else if (p.estado === 'only_actual') nOnlyActual += 1;
    const linea = num(p.linea);
    if (LINEAS_VALIDAS.has(linea as 14 | 17 | 19)) {
      planFilas.push({
        linea: linea as 14 | 17 | 19,
        sku: String(p.sku ?? ''),
        denominacion: p.denominacion ?? null,
        hlPlan,
        hlActual,
        gapHl: hlActual - hlPlan,
        estado: p.estado as PlanVsActualFila['estado'],
      });
    }
  }
  const planTopGap = [...planFilas]
    .sort((a, b) => Math.abs(b.gapHl) - Math.abs(a.gapHl))
    .slice(0, 12);

  // -------- Limpieza (fact_limpieza) --------
  const limpRows = await query<{
    linea: number;
    n_wos: number | string;
    horas: number | null;
    horas_intervencion: number | null;
  }>(
    `SELECT linea,
            COUNT(*) AS n_wos,
            SUM(COALESCE(horas_total, 0)) AS horas,
            SUM(COALESCE(horas_intervencion, 0)) AS horas_intervencion
     FROM fact_limpieza
     WHERE 1=1
       ${filtros.anio !== undefined ? `AND EXTRACT(year FROM fecha_fin) = $anio` : ''}
       ${filtros.linea !== undefined ? `AND linea = $linea` : ''}
     GROUP BY linea
     ORDER BY linea`,
    {
      ...(filtros.anio !== undefined ? { anio: filtros.anio } : {}),
      ...(filtros.linea !== undefined ? { linea: filtros.linea } : {}),
    },
  );
  const limpiezaPorLinea: LimpiezaPorLineaItem[] = LINEAS_ORDEN.map((linea) => {
    const r = limpRows.find((x) => num(x.linea) === linea);
    return {
      linea,
      nWos: r ? num(r.n_wos) : 0,
      horas: r ? num(r.horas) : 0,
      horasIntervencion: r ? num(r.horas_intervencion) : 0,
    };
  });
  const totalLimpiezaWos = limpiezaPorLinea.reduce((a, x) => a + x.nWos, 0);
  const totalLimpiezaH = limpiezaPorLinea.reduce((a, x) => a + x.horas, 0);

  const kpis = {
    oee: weightedMean(rows.map((r) => ({ hl: r.hl, v: r.oee }))),
    disponibilidad: weightedMean(rows.map((r) => ({ hl: r.hl, v: r.disp }))),
    rendimiento: weightedMean(rows.map((r) => ({ hl: r.hl, v: r.rend }))),
    ineficiencia: weightedMean(rows.map((r) => ({ hl: r.hl, v: r.inef }))),
    utilizacion: sumTotalesAll > 0 ? sumMarchaAll / sumTotalesAll : 0,
    volumenHl: totalHl,
    volumenUds: totalUds,
    ofs: rows.length,
    pctCambios: rows.length > 0 ? cambios / rows.length : 0,
    horasCambio: sumCambio,
    horasCambioPorOfCambio: cambios > 0 ? sumCambio / cambios : 0,
    deltaTeoricoMin: totalRealMin - totalTeoricoMin,
    nLlamadasMant: sumLlamadas,
    horasMantenimiento: sumIntervMant,
    pctTiempoMant: sumTotalesAll > 0 ? sumIntervMant / sumTotalesAll : 0,
    planHl,
    actualHl,
    fillRate: planHl > 0 ? actualHl / planHl : 0,
    nOnlyPlan,
    nOnlyActual,
    nLimpiezaWos: totalLimpiezaWos,
    horasLimpieza: totalLimpiezaH,
    pctTiempoCip: sumTotalesAll > 0 ? sumCip / sumTotalesAll : 0,
  };

  // -------- OEE por línea --------
  const oeePorLinea = groupWeightedOee(
    rows.map((r) => ({ hl: r.hl, oee: r.oee, key: r.linea })),
  )
    .filter((x) => LINEAS_VALIDAS.has(x.key as 14 | 17 | 19))
    .sort((a, b) => (a.key as number) - (b.key as number))
    .map((x) => ({ linea: x.key as 14 | 17 | 19, oee: x.oee }));

  const oeePorFormato = groupWeightedOee(
    rows
      .filter((r) => r.formato)
      .map((r) => ({ hl: r.hl, oee: r.oee, key: r.formato as string })),
  )
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((x) => ({ formato: x.key, oee: x.oee }));

  const oeePorFamilia = groupWeightedOee(
    rows
      .filter((r) => r.familia)
      .map((r) => ({ hl: r.hl, oee: r.oee, key: r.familia as string })),
  )
    .sort((a, b) => b.hl - a.hl)
    .map((x) => ({ familia: x.key, oee: x.oee, hl: x.hl }));

  const oeePorCanal = groupWeightedOee(
    rows
      .filter((r) => r.canal)
      .map((r) => ({ hl: r.hl, oee: r.oee, key: r.canal as string })),
  )
    .sort((a, b) => b.hl - a.hl)
    .map((x) => ({ canal: x.key, oee: x.oee, hl: x.hl }));

  const oeePorTipoEnvase = groupWeightedOee(
    rows
      .filter((r) => r.tipoEnvase)
      .map((r) => ({ hl: r.hl, oee: r.oee, key: r.tipoEnvase as string })),
  )
    .sort((a, b) => b.hl - a.hl)
    .map((x) => ({ tipoEnvase: x.key, oee: x.oee, hl: x.hl }));

  function temporalWeighted(
    grouper: (r: FactRow) => number,
    field: 'oee' | 'disp' | 'rend',
  ) {
    const map = new Map<
      number,
      { sum: number; w: number; porLinea: Record<number, { sum: number; w: number }> }
    >();
    for (const r of rows) {
      const v = r[field];
      if (v === null || !Number.isFinite(v)) continue;
      const k = grouper(r);
      const cur = map.get(k) ?? { sum: 0, w: 0, porLinea: {} };
      cur.sum += v * r.hl;
      cur.w += r.hl;
      cur.porLinea[r.linea] ??= { sum: 0, w: 0 };
      cur.porLinea[r.linea].sum += v * r.hl;
      cur.porLinea[r.linea].w += r.hl;
      map.set(k, cur);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a - b)
      .map(([k, v]) => ({
        k,
        value: v.w > 0 ? v.sum / v.w : 0,
        porLinea: Object.fromEntries(
          Object.entries(v.porLinea).map(([l, x]) => [l, x.w > 0 ? x.sum / x.w : 0]),
        ) as Partial<Record<14 | 17 | 19, number>>,
      }));
  }

  const oeeMensual = temporalWeighted((r) => r.mes, 'oee').map(({ k, value, porLinea }) => ({
    mes: k,
    oee: value,
    oeePorLinea: porLinea,
  }));
  const oeeSemanal = temporalWeighted((r) => r.semanaIso, 'oee').map(
    ({ k, value, porLinea }) => ({ semana: k, oee: value, oeePorLinea: porLinea }),
  );
  const dispMensual: SerieMensualLinea[] = temporalWeighted((r) => r.mes, 'disp').map(
    ({ k, value, porLinea }) => ({ mes: k, valor: value, porLinea }),
  );
  const rendMensual: SerieMensualLinea[] = temporalWeighted((r) => r.mes, 'rend').map(
    ({ k, value, porLinea }) => ({ mes: k, valor: value, porLinea }),
  );

  const hlMensualMap = new Map<number, { hl: number; porLinea: Record<number, number> }>();
  for (const r of rows) {
    const cur = hlMensualMap.get(r.mes) ?? { hl: 0, porLinea: {} };
    cur.hl += r.hl;
    cur.porLinea[r.linea] = (cur.porLinea[r.linea] ?? 0) + r.hl;
    hlMensualMap.set(r.mes, cur);
  }
  const hlMensual = [...hlMensualMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([mes, v]) => ({
      mes,
      hl: v.hl,
      porLinea: v.porLinea as Partial<Record<14 | 17 | 19, number>>,
    }));

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
    .map(([marca, { ofs, sum, w }]) => ({ marca, ofs, oee: w > 0 ? sum / w : 0 }))
    .sort((a, b) => b.ofs - a.ofs)
    .slice(0, 10);

  // -------- Pérdidas --------
  type TimeKey =
    | 'hPnp'
    | 'hLimpieza'
    | 'hIdle'
    | 'hBajaVelocidad'
    | 'hSaturacionSal'
    | 'hFaltaProducto'
    | 'hCip'
    | 'hEsterilizacion';
  const CATS: { concepto: string; key: TimeKey }[] = [
    { concepto: 'PNP (paradas no planificadas)', key: 'hPnp' },
    { concepto: 'Baja velocidad', key: 'hBajaVelocidad' },
    { concepto: 'Saturación salida', key: 'hSaturacionSal' },
    { concepto: 'Limpieza', key: 'hLimpieza' },
    { concepto: 'IDLE', key: 'hIdle' },
    { concepto: 'Falta producto', key: 'hFaltaProducto' },
    { concepto: 'CIP', key: 'hCip' },
    { concepto: 'Esterilización', key: 'hEsterilizacion' },
  ];

  const sumKey = (k: TimeKey) =>
    rows.reduce((a, r) => a + (r[k] ?? 0), 0);

  const perdidasTiempo = CATS.map((c) => ({
    concepto: c.concepto,
    horas: sumKey(c.key),
  })).sort((a, b) => b.horas - a.horas);

  const perdidasPorLinea: PerdidasPorLineaItem[] = LINEAS_ORDEN.map((linea) => {
    const subset = rows.filter((r) => r.linea === linea);
    return {
      linea,
      conceptos: CATS.map((c) => ({
        concepto: c.concepto,
        horas: subset.reduce((a, r) => a + (r[c.key] ?? 0), 0),
      })),
    };
  });

  const utilizacionPorLinea: UtilizacionLineaItem[] = LINEAS_ORDEN.map((linea) => {
    const subset = rows.filter((r) => r.linea === linea);
    const marcha = subset.reduce((a, r) => a + r.hMarcha, 0);
    const paro = subset.reduce((a, r) => a + r.hParo, 0);
    const totales = subset.reduce((a, r) => a + r.hTotales, 0);
    return { linea, marcha, paro, totales, pct: totales > 0 ? marcha / totales : 0 };
  });

  const BUCKETS = [
    { desde: 0, hasta: 0.4 },
    { desde: 0.4, hasta: 0.5 },
    { desde: 0.5, hasta: 0.6 },
    { desde: 0.6, hasta: 0.7 },
    { desde: 0.7, hasta: 0.8 },
    { desde: 0.8, hasta: 0.9 },
    { desde: 0.9, hasta: 1.01 },
  ];
  const oeeDistribucion: OeeDistribucionBucket[] = BUCKETS.map((b) => {
    const inBucket = rows.filter((r) => r.oee >= b.desde && r.oee < b.hasta);
    const porLinea: Partial<Record<14 | 17 | 19, number>> = {};
    for (const l of LINEAS_ORDEN) {
      porLinea[l] = inBucket.filter((r) => r.linea === l).length;
    }
    const top = Math.min(b.hasta, 1);
    return {
      bucket: `${Math.round(b.desde * 100)}–${Math.round(top * 100)}%`,
      desde: b.desde,
      hasta: top,
      total: inBucket.length,
      porLinea,
    };
  });

  const cambiosImpacto: CambiosImpactoItem[] = LINEAS_ORDEN.map((linea) => {
    const subset = rows.filter((r) => r.linea === linea);
    const con = subset.filter((r) => r.tieneCambio);
    const sin = subset.filter((r) => !r.tieneCambio);
    const oeeConCambio = weightedMean(con.map((r) => ({ hl: r.hl, v: r.oee })));
    const oeeSinCambio = weightedMean(sin.map((r) => ({ hl: r.hl, v: r.oee })));
    return {
      linea,
      oeeConCambio,
      oeeSinCambio,
      deltaPts: (oeeSinCambio - oeeConCambio) * 100,
      nCon: con.length,
      nSin: sin.length,
    };
  });

  const totalHoras = perdidasTiempo.reduce((a, r) => a + r.horas, 0);
  let acumulado = 0;
  const paretoPerdidas: ParetoPerdidasItem[] = perdidasTiempo.map((r) => {
    acumulado += r.horas;
    return {
      concepto: r.concepto,
      horas: r.horas,
      acumuladoPct: totalHoras > 0 ? acumulado / totalHoras : 0,
    };
  });

  const topPeoresOfs: PeorOf[] = rows
    .filter((r) => r.hl > 100 && LINEAS_VALIDAS.has(r.linea as 14 | 17 | 19))
    .sort((a, b) => a.oee - b.oee)
    .slice(0, 20)
    .map((r) => ({
      of: r.of,
      fecha: r.fechaFin.slice(0, 10),
      linea: r.linea as 14 | 17 | 19,
      sku: r.sku,
      marca: r.marca,
      formato: r.formato,
      oee: r.oee,
      hl: r.hl,
    }));

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
    oeePorFamilia,
    oeePorCanal,
    oeePorTipoEnvase,
    oeeMensual,
    oeeSemanal,
    dispMensual,
    rendMensual,
    hlMensual,
    topMarcas,
    perdidasTiempo,
    perdidasPorLinea,
    utilizacionPorLinea,
    oeeDistribucion,
    cambiosImpacto,
    paretoPerdidas,
    topPeoresOfs,
    rangoFechas: { desde: minF.slice(0, 10), hasta: maxF.slice(0, 10) },
    cambioPorLinea,
    planVsActual: {
      totales: { hlPlan: planHl, hlActual: actualHl, nMatched, nOnlyPlan, nOnlyActual },
      topGap: planTopGap,
    },
    limpiezaPorLinea,
  };
}

function emptyResponse(): ObservabilidadData {
  return {
    kpis: {
      oee: 0,
      disponibilidad: 0,
      rendimiento: 0,
      ineficiencia: 0,
      utilizacion: 0,
      volumenHl: 0,
      volumenUds: 0,
      ofs: 0,
      pctCambios: 0,
      horasCambio: 0,
      horasCambioPorOfCambio: 0,
      deltaTeoricoMin: 0,
      nLlamadasMant: 0,
      horasMantenimiento: 0,
      pctTiempoMant: 0,
      planHl: 0,
      actualHl: 0,
      fillRate: 0,
      nOnlyPlan: 0,
      nOnlyActual: 0,
      nLimpiezaWos: 0,
      horasLimpieza: 0,
      pctTiempoCip: 0,
    },
    oeePorLinea: [],
    oeePorFormato: [],
    oeePorFamilia: [],
    oeePorCanal: [],
    oeePorTipoEnvase: [],
    oeeMensual: [],
    oeeSemanal: [],
    dispMensual: [],
    rendMensual: [],
    hlMensual: [],
    topMarcas: [],
    perdidasTiempo: [],
    perdidasPorLinea: [],
    utilizacionPorLinea: [],
    oeeDistribucion: [],
    cambiosImpacto: [],
    paretoPerdidas: [],
    topPeoresOfs: [],
    rangoFechas: null,
    cambioPorLinea: [],
    planVsActual: { totales: { hlPlan: 0, hlActual: 0, nMatched: 0, nOnlyPlan: 0, nOnlyActual: 0 }, topGap: [] },
    limpiezaPorLinea: [],
  };
}

export async function getDimensiones(): Promise<ObservabilidadDimensiones> {
  const rows = await query<{
    anio: number;
    linea: number;
    marca: string | null;
    formato: string | null;
    canal: string | null;
  }>(
    `SELECT DISTINCT
        CAST(r.anyo AS INTEGER) AS anio,
        r.linea AS linea,
        r.marca AS marca,
        r.estado_volumen AS formato,
        NULLIF(TRIM(REGEXP_REPLACE(o.canal_distribucion, '^Canal\\s*distrib\\.?\\s*', '', 'i')), '') AS canal
     FROM fact_runs r
     LEFT JOIN raw_oee o ON o.of = r.of
     WHERE NOT r.outlier`,
  );

  const uniq = <T>(arr: Array<T | null | undefined>): T[] => [
    ...new Set(arr.filter((x): x is T => x !== null && x !== undefined)),
  ];

  // turno column is added by the latest derived-tables script but may not be
  // present in databases ingested before that change — query it best-effort.
  let turnos: string[] = [];
  try {
    const trows = await query<{ turno: string | null }>(
      `SELECT DISTINCT r.turno AS turno FROM fact_runs r WHERE r.turno IS NOT NULL`,
    );
    turnos = uniq(trows.map((r) => r.turno)).sort();
  } catch {
    turnos = [];
  }

  return {
    anios: uniq(rows.map((r) => num(r.anio))).sort((a, b) => b - a),
    lineas: uniq(rows.map((r) => num(r.linea)))
      .filter((l): l is 14 | 17 | 19 => LINEAS_VALIDAS.has(l as 14 | 17 | 19))
      .sort((a, b) => a - b),
    marcas: uniq(rows.map((r) => r.marca)).sort(),
    formatos: uniq(rows.map((r) => r.formato)).sort(),
    canales: uniq(rows.map((r) => r.canal)).sort(),
    turnos,
  };
}
