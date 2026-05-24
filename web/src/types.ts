export type Linea = 14 | 17 | 19;
export type Veredicto = 'procede' | 'revisar' | 'evitar';
export type TipoCambio = 'inicio' | 'formato' | 'cerveza' | 'mantenimiento' | 'otro';

export interface PostMortemResumen {
  perdidaEvitablePts: number;
  ofsPorDebajoPct: number;
  hlLatente: number;
  ofsAnalizadas: number;
  porLinea: { linea: Linea; perdidaPts: number; oeeEjecutado: number; oeeAlcanzable: number }[];
}

export interface CambioIneficienteDTO {
  of: string;
  linea: Linea;
  fecha: string;
  skuAnterior: string;
  skuActual: string;
  tipoCambio: 'formato' | 'cerveza' | 'mantenimiento' | 'otro';
  oeeReal: number;
  oeeAlcanzable: number;
  ptsPerdidos: number;
  motivo: string;
}

export interface DistribucionSku {
  sku: string;
  nombre: string;
  linea: Linea;
  valoresOee: number[];
  mediana: number;
  alcanzable: number;
  // Optional enhancements (back-compat): histogram, weekly trend, percentiles
  histograma?: { bucket: string; desde: number; hasta: number; count: number }[];
  tendenciaSemanal?: { semana: number; anio: number; oee: number; n: number }[];
  percentiles?: { p25: number; p50: number; p75: number; p90: number };
}

// ---- Post-mortem weekly explorer (Feature 1) ----

export interface SemanaPostMortem {
  semana: number;            // ISO week 1-52
  anio: number;
  semanaLabel: string;       // 'Sem 21 · 19-25 may 2025'
  desde: string;             // ISO date of first OF in week
  hasta: string;             // ISO date of last OF in week
  oeeActual: number;         // 0-1, HL-weighted
  oeeAlcanzable: number;     // 0-1, HL-weighted from SkuLineaBaseline
  perdidaPts: number;        // (oeeAlcanzable - oeeActual) * 100
  hlTotal: number;
  nOfs: number;
  porLinea: { linea: Linea; oeeActual: number; oeeAlcanzable: number; perdidaPts: number; nOfs: number }[];
}

// ---- Post-mortem brief (Feature 2, deterministic) ----

export interface RecomendacionSemana {
  titulo: string;
  descripcion: string;
  gananciaPotencialPts: number;
  gananciaPotencialHl: number;
  evidencia: string;
}

export interface WeekBriefKpi {
  label: string;
  value: string;
  accent?: 'damm' | 'gold' | 'moss';
}

export interface WeekBrief {
  semana: number;
  anio: number;
  semanaLabel: string;
  summary: string;
  kpis: WeekBriefKpi[];
  recomendaciones: RecomendacionSemana[];
}

export interface FilaPlan {
  of: string;
  linea: Linea;
  secuencia: number;
  dia: string;
  sku: string;
  nombre: string;
  hlPlan: number;
  skuAnterior: string | null;
  tipoCambio: TipoCambio;
  oeePrevisto: number;
  veredicto: Veredicto;
  motivo: string;
}

export interface AnalisisPlan {
  planId: string;
  nombre: string;
  oeePrevistoPlan: number;
  perdidaEvitablePts: number;
  banderas: { evitar: number; revisar: number; procede: number };
  filas: FilaPlan[];
}

export interface Recomendacion {
  id: string;
  tipo: 'reordenar' | 'mover_linea' | 'reprogramar';
  titulo: string;
  descripcion: string;
  skusAfectados: string[];
  gananciaPts: number;
  antes: { linea: Linea; secuencia: string[] };
  despues: { linea: Linea; secuencia: string[] };
}

export interface PlanRecomendado {
  oeePlanOriginal: number;
  oeePlanRecomendado: number;
  gananciaPts: number;
  recomendaciones: Recomendacion[];
}

export interface SkuLineaInfo {
  codigo: string;
  nombre: string;
  marca: string;
  formato: string;
  lineas: { linea: Linea; oeeAlcanzable: number; oeeMediana: number; rateHlH: number }[];
}

// ---- Urgencias ----

export type TipoUrgencia = 'averia' | 'pedido_urgente' | 'incidencia_calidad' | 'falta_material';
export type ModoUrgencia = 'plan_activo' | 'escenario_libre';

export interface Urgencia {
  tipo: TipoUrgencia;
  linea?: Linea;
  dia?: string;
  duracionHoras?: number;
  sku?: string;
  hl?: number;
  deadline?: string;
  formato?: '1/3' | '1/2';
}

export interface AccionUrgencia {
  id: string;
  tipo: 'mover' | 'reprogramar' | 'priorizar' | 'sustituir';
  prioridad: 1 | 2 | 3;
  titulo: string;
  descripcion: string;
  ofAfectada?: string;
  lineaOrigen?: Linea;
  lineaDestino?: Linea;
  impactoHl?: number;
  impactoOeePts?: number;
}

export interface AnalisisUrgencia {
  modo: ModoUrgencia;
  planId?: string;
  planNombre?: string;
  urgencia: Urgencia;
  resumen: string;
  kpis: {
    hlEnRiesgo: number;
    oeePlanOriginal?: number;
    oeePlanPostIncidencia?: number;
    oeePlanRecomendado: number;
    gananciaPts: number;
  };
  acciones: AccionUrgencia[];
  filasAfectadas: FilaPlan[];
}

export interface PlanResumen {
  id: string;
  nombre: string;
  creadoEn: string;
  nOfs: number;
  dias: string[];
  oeePrevisto: number;
}

// ---- Observabilidad ----

export interface ObservabilidadKpis {
  oee: number;
  disponibilidad: number;
  rendimiento: number;
  ineficiencia: number;
  utilizacion: number;
  volumenHl: number;
  volumenUds: number;
  ofs: number;
  pctCambios: number;
  // Changeover
  horasCambio: number;
  horasCambioPorOfCambio: number;
  deltaTeoricoMin: number;
  // Mantenimiento
  nLlamadasMant: number;
  horasMantenimiento: number;
  pctTiempoMant: number;
  // Plan vs Actual (May 2026)
  planHl: number;
  actualHl: number;
  fillRate: number;
  nOnlyPlan: number;
  nOnlyActual: number;
  // Limpieza / CIP
  nLimpiezaWos: number;
  horasLimpieza: number;
  pctTiempoCip: number;
}

export interface CambioPorLineaItem {
  linea: 14 | 17 | 19;
  horasCambio: number;
  nCambios: number;
  horasCambioPorOf: number;
  realMin: number;
  teoricoMin: number;
  deltaMin: number;
}

export interface PlanVsActualFila {
  linea: 14 | 17 | 19;
  sku: string;
  denominacion: string | null;
  hlPlan: number;
  hlActual: number;
  gapHl: number;
  estado: 'matched' | 'only_plan' | 'only_actual';
}

export interface LimpiezaPorLineaItem {
  linea: 14 | 17 | 19;
  nWos: number;
  horas: number;
  horasIntervencion: number;
}

export interface SerieMensualLinea {
  mes: number;
  valor: number;
  porLinea: Partial<Record<14 | 17 | 19, number>>;
}

export interface PerdidasPorLineaItem {
  linea: 14 | 17 | 19;
  conceptos: { concepto: string; horas: number }[];
}

export interface UtilizacionLineaItem {
  linea: 14 | 17 | 19;
  marcha: number;
  paro: number;
  totales: number;
  pct: number;
}

export interface OeeDistribucionBucket {
  bucket: string;
  desde: number;
  hasta: number;
  total: number;
  porLinea: Partial<Record<14 | 17 | 19, number>>;
}

export interface CambiosImpactoItem {
  linea: 14 | 17 | 19;
  oeeConCambio: number;
  oeeSinCambio: number;
  deltaPts: number;
  nCon: number;
  nSin: number;
}

export interface ParetoPerdidasItem {
  concepto: string;
  horas: number;
  acumuladoPct: number;
}

export interface PeorOf {
  of: string;
  fecha: string;
  linea: 14 | 17 | 19;
  sku: string;
  marca: string | null;
  formato: string | null;
  oee: number;
  hl: number;
}

export interface ObservabilidadData {
  kpis: ObservabilidadKpis;
  oeePorLinea: { linea: 14 | 17 | 19; oee: number }[];
  oeePorFormato: { formato: string; oee: number }[];
  oeePorFamilia: { familia: string; oee: number; hl: number }[];
  oeePorCanal: { canal: string; oee: number; hl: number }[];
  oeePorTipoEnvase: { tipoEnvase: string; oee: number; hl: number }[];
  oeeMensual: { mes: number; oee: number; oeePorLinea: Partial<Record<14 | 17 | 19, number>> }[];
  oeeSemanal: { semana: number; oee: number; oeePorLinea: Partial<Record<14 | 17 | 19, number>> }[];
  dispMensual: SerieMensualLinea[];
  rendMensual: SerieMensualLinea[];
  hlMensual: { mes: number; hl: number; porLinea: Partial<Record<14 | 17 | 19, number>> }[];
  topMarcas: { marca: string; ofs: number; oee: number }[];
  perdidasTiempo: { concepto: string; horas: number }[];
  perdidasPorLinea: PerdidasPorLineaItem[];
  utilizacionPorLinea: UtilizacionLineaItem[];
  oeeDistribucion: OeeDistribucionBucket[];
  cambiosImpacto: CambiosImpactoItem[];
  paretoPerdidas: ParetoPerdidasItem[];
  topPeoresOfs: PeorOf[];
  rangoFechas: { desde: string; hasta: string } | null;
  cambioPorLinea: CambioPorLineaItem[];
  planVsActual: {
    totales: { hlPlan: number; hlActual: number; nMatched: number; nOnlyPlan: number; nOnlyActual: number };
    topGap: PlanVsActualFila[];
  };
  limpiezaPorLinea: LimpiezaPorLineaItem[];
}

export interface ObservabilidadDimensiones {
  anios: number[];
  lineas: (14 | 17 | 19)[];
  marcas: string[];
  formatos: string[];
  canales: string[];
  turnos?: string[];
}

// ---- Generic Mixpanel-style query ----

export type MeasureKey =
  | 'oee'
  | 'disp'
  | 'rend'
  | 'inef'
  | 'hl'
  | 'uds'
  | 'ofs'
  | 'pctCambios'
  | 'utilizacion'
  | 'hTotales'
  | 'hMarcha'
  | 'hParo'
  | 'hPnp'
  | 'hLimpieza'
  | 'hIdle'
  | 'hBajaVelocidad'
  | 'hSaturacionSal'
  | 'hFaltaProducto'
  | 'hCip'
  | 'hEsterilizacion'
  | 'hCambio'
  | 'nLlamadasMant'
  | 'hMantenimiento'
  | 'hEsperaMant'
  | 'nDimsCambiadas'
  | 'frecCambio';

export type DimensionKey =
  | 'mes'
  | 'semanaIso'
  | 'fechaFin'
  | 'dia'
  | 'semana'
  | 'mesIso'
  | 'linea'
  | 'formato'
  | 'marca'
  | 'familia'
  | 'tipoEnvase'
  | 'canal'
  | 'sku'
  | 'cambioPrincipal'
  | 'turno'
  | 'causaParo';

export type MeasureKind = 'pct' | 'count' | 'hours' | 'hl' | 'units';

export type Aggregation = 'sum' | 'avg' | 'median' | 'count' | 'min' | 'max' | 'p90';

export interface MeasureMeta {
  key: MeasureKey;
  label: string;
  kind: MeasureKind;
  defaultAgg: Aggregation;
  allowedAggs: Aggregation[];
}

export interface DimensionMeta {
  key: DimensionKey;
  label: string;
  temporal: boolean;
}

export interface Filter {
  dim: DimensionKey;
  values: string[];
}

export type Granularity = 'day' | 'week' | 'month';

export interface DateRange {
  from?: string;
  to?: string;
  preset?: '7d' | '30d' | '90d' | 'ytd' | 'y2025' | 'y2024' | 'all';
}

export type VizType = 'auto' | 'line' | 'bar' | 'stackedBar' | 'donut' | 'bigNumber' | 'table';

export interface ChartConfig {
  measure: MeasureKey;
  aggregation: Aggregation;
  dimension?: DimensionKey;
  breakdown?: DimensionKey;
  filters: Filter[];
  dateRange: DateRange;
  granularity: Granularity;
  viz: VizType;
  topN?: number;
}

export interface QueryRow {
  key: string;
  label: string;
  value: number;
  breakdown?: Record<string, number>;
}

export interface DataQuality {
  excludedOutliers: number;
  excludedOeeGt1: number;
  rowsConsidered: number;
}

export interface QueryResult {
  measure: MeasureKey;
  dimension?: DimensionKey;
  breakdown?: DimensionKey;
  aggregation: Aggregation;
  rows: QueryRow[];
  breakdownKeys: string[];
  dataQuality: DataQuality;
  total?: number;
  previousTotal?: number;
}

export interface SavedChartDTO {
  id: string;
  nombre: string;
  config: ChartConfig;
  creadoEn: string;
  actualEn: string;
}
