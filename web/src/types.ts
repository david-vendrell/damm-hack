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
  volumenHl: number;
  volumenUds: number;
  ofs: number;
  pctCambios: number;
}

export interface ObservabilidadData {
  kpis: ObservabilidadKpis;
  oeePorLinea: { linea: 14 | 17 | 19; oee: number }[];
  oeePorFormato: { formato: string; oee: number }[];
  oeeMensual: { mes: number; oee: number; oeePorLinea: Partial<Record<14 | 17 | 19, number>> }[];
  oeeSemanal: { semana: number; oee: number; oeePorLinea: Partial<Record<14 | 17 | 19, number>> }[];
  topMarcas: { marca: string; ofs: number; oee: number }[];
  perdidasTiempo: { concepto: string; horas: number }[];
  rangoFechas: { desde: string; hasta: string } | null;
}

export interface ObservabilidadDimensiones {
  anios: number[];
  lineas: (14 | 17 | 19)[];
  marcas: string[];
  formatos: string[];
  canales: string[];
}
