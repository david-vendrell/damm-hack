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
}

export interface ShapDriver {
  name: string;        // feature name (e.g. 'prev_oee', 'changeover_variance_min')
  shap: number;        // signed contribution: positive = pushed OEE up, negative = down
}

export type Turno = 'M' | 'T' | 'N';

export interface FilaPlan {
  of: string;
  linea: Linea;
  secuencia: number;
  dia: string;
  turno?: Turno;            // optional: present when source plan carries shifts
  sku: string;
  nombre: string;
  hlPlan: number;
  skuAnterior: string | null;
  tipoCambio: TipoCambio;
  oeePrevisto: number;
  veredicto: Veredicto;
  motivo: string;
  // ---- LineWise model fields (present when meta.source === 'linewise') ----
  oeeP10?: number;          // pessimistic floor
  oeeP90?: number;          // achievable ceiling
  disp?: number;            // Disponibilidad (Damm formula)
  rend?: number;            // Rendimiento
  cal?: number;             // Calidad
  topDrivers?: ShapDriver[];// top SHAP features for this OF's p50 prediction
  feasReason?: string;      // explicit infeasibility reason from the parser
  cambioTeoricoMin?: number;// theoretical changeover minutes from CF Prat matrix
}

export interface BloqueoMant {
  linea: Linea;
  dia: string;              // ISO yyyy-mm-dd
  turno: Turno;
  event: 'LIMPIEZA' | 'MANTENIMIENTO' | 'OUTAGE';
  reason: string;           // human-readable Spanish for the UI
}

export interface DecomposicionOEE {
  disp: number;
  rend: number;
  cal: number;
}

export interface AnalisisPlan {
  planId: string;
  nombre: string;
  oeePrevistoPlan: number;
  perdidaEvitablePts: number;
  banderas: { evitar: number; revisar: number; procede: number };
  filas: FilaPlan[];
  // ---- LineWise model headline fields (present when meta.source === 'linewise') ----
  oeeP10Plan?: number;
  oeeP90Plan?: number;
  decomposicion?: DecomposicionOEE;
  bloqueosMant?: BloqueoMant[];
  totalHl?: number;
  meta?: {
    source: 'linewise' | 'heuristic_fallback';
    via?: 'local' | 'hf_space';      // which backend served the LineWise call
    spaceLatencyMs?: number;
    warning?: string;       // shown as small amber badge in the UI when fallback fires
  };
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
