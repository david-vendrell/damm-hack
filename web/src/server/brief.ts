import { num, query } from './duck';
import { resolvePeriodo, type ObservabilidadFiltros } from './observabilidad';

export interface BriefScope {
  linea?: 14 | 17 | 19;
  turno?: string;
  periodo: string; // today | wtd | mtd | ytd | last7 | last30 | custom
  desde?: string;
  hasta?: string;
}

export type BriefSeverity = 'critical' | 'warning' | 'positive' | 'info';

export interface BriefCallout {
  id: string;
  severity: BriefSeverity;
  category: 'oee' | 'perdidas' | 'cambios' | 'mantenimiento' | 'volumen';
  headline: string;       // editorial sentence — short
  body: string;           // 1-line supporting detail
  metricValue: string;    // numeric value to display large
  metricUnit?: string;
  delta?: { value: number; format: 'pts' | 'pct' | 'abs' };
  action?: { label: string; href: string };
}

export interface BriefData {
  periodLabel: string;
  asOf: string; // ISO timestamp
  scopeLabel: string;
  callouts: BriefCallout[];
  metaCurrent: { ofs: number; oee: number; hl: number };
  metaPrevious: { ofs: number; oee: number; hl: number };
}

interface PeriodRow {
  ofs: number;
  oee: number;
  hl: number;
  hPnp: number;
  hParo: number;
  hIdle: number;
  hCambio: number;
  hLimpieza: number;
  hMant: number;
}

interface WorstOf {
  of: string;
  linea: number;
  sku: string | null;
  oee: number;
  hParo: number;
  hPnp: number;
}

const PERIODO_LABEL_BRIEF: Record<string, string> = {
  today: 'Hoy',
  wtd: 'Esta semana',
  mtd: 'Este mes',
  ytd: 'Este año',
  last7: 'Últimos 7 días',
  last30: 'Últimos 30 días',
  custom: 'Periodo personalizado',
};

function previousWindow(scope: BriefScope): { desde?: string; hasta?: string } {
  if (scope.desde && scope.hasta) {
    const a = new Date(scope.desde);
    const b = new Date(scope.hasta);
    const days = Math.max(1, Math.round((b.getTime() - a.getTime()) / 86400000) + 1);
    const prevHasta = new Date(a);
    prevHasta.setUTCDate(prevHasta.getUTCDate() - 1);
    const prevDesde = new Date(prevHasta);
    prevDesde.setUTCDate(prevDesde.getUTCDate() - (days - 1));
    return {
      desde: prevDesde.toISOString().slice(0, 10),
      hasta: prevHasta.toISOString().slice(0, 10),
    };
  }
  return {};
}

async function aggregate(filters: ObservabilidadFiltros): Promise<PeriodRow> {
  const clauses: string[] = ['NOT r.outlier'];
  const params: Record<string, unknown> = {};
  if (filters.linea !== undefined) {
    clauses.push('r.linea = $linea');
    params.linea = filters.linea;
  }
  if (filters.turno) {
    clauses.push('r.turno = $turno');
    params.turno = filters.turno;
  }
  if (filters.desde) {
    clauses.push('r.fecha_fin >= CAST($desde AS DATE)');
    params.desde = filters.desde;
  }
  if (filters.hasta) {
    clauses.push('r.fecha_fin <= CAST($hasta AS DATE)');
    params.hasta = filters.hasta;
  }
  const sql = `
    SELECT
      COUNT(*) AS ofs,
      COALESCE(SUM(r.oee * r.hl) / NULLIF(SUM(r.hl), 0), 0) AS oee,
      COALESCE(SUM(r.hl), 0) AS hl,
      COALESCE(SUM(r.horas_pnp), 0) AS "hPnp",
      COALESCE(SUM(r.horas_paro), 0) AS "hParo",
      COALESCE(SUM(r.horas_idle), 0) AS "hIdle",
      COALESCE(SUM(r.horas_cambio), 0) AS "hCambio",
      COALESCE(SUM(r.horas_limpieza_dentro_of), 0) AS "hLimpieza",
      COALESCE(SUM(r.horas_espera_mant + r.horas_intervencion_mant), 0) AS "hMant"
    FROM fact_runs r
    WHERE ${clauses.join(' AND ')}
  `;
  const rows = await query<Record<string, number>>(sql, params);
  const r = rows[0] ?? {};
  return {
    ofs: num(r.ofs ?? 0),
    oee: num(r.oee ?? 0),
    hl: num(r.hl ?? 0),
    hPnp: num(r.hPnp ?? 0),
    hParo: num(r.hParo ?? 0),
    hIdle: num(r.hIdle ?? 0),
    hCambio: num(r.hCambio ?? 0),
    hLimpieza: num(r.hLimpieza ?? 0),
    hMant: num(r.hMant ?? 0),
  };
}

async function worstOf(filters: ObservabilidadFiltros): Promise<WorstOf | null> {
  const clauses: string[] = ['NOT r.outlier', 'r.hl > 50'];
  const params: Record<string, unknown> = {};
  if (filters.linea !== undefined) {
    clauses.push('r.linea = $linea');
    params.linea = filters.linea;
  }
  if (filters.turno) {
    clauses.push('r.turno = $turno');
    params.turno = filters.turno;
  }
  if (filters.desde) {
    clauses.push('r.fecha_fin >= CAST($desde AS DATE)');
    params.desde = filters.desde;
  }
  if (filters.hasta) {
    clauses.push('r.fecha_fin <= CAST($hasta AS DATE)');
    params.hasta = filters.hasta;
  }
  const sql = `
    SELECT r.of, r.linea, r.sku, r.oee,
           COALESCE(r.horas_paro, 0) AS "hParo",
           COALESCE(r.horas_pnp, 0)  AS "hPnp"
    FROM fact_runs r
    WHERE ${clauses.join(' AND ')}
    ORDER BY r.oee ASC
    LIMIT 1
  `;
  const rows = await query<Record<string, unknown>>(sql, params);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    of: String(r.of ?? ''),
    linea: num(r.linea ?? 0),
    sku: r.sku ? String(r.sku) : null,
    oee: num(r.oee ?? 0),
    hParo: num(r.hParo ?? 0),
    hPnp: num(r.hPnp ?? 0),
  };
}

export async function getBrief(scope: BriefScope): Promise<BriefData> {
  // Resolve current window
  let { desde, hasta } = scope;
  let isFallback = false;
  if ((!desde || !hasta) && scope.periodo !== 'custom') {
    const r = resolvePeriodo(scope.periodo);
    desde = desde ?? r.desde;
    hasta = hasta ?? r.hasta;
  }
  let currentFilters: ObservabilidadFiltros = {
    linea: scope.linea,
    turno: scope.turno,
    desde,
    hasta,
  };

  // Demo data spans a fixed window; if the chosen period falls outside the
  // ingested window, fall back to the latest 30 days of available data so the
  // brief stays meaningful.
  let probe = await aggregate(currentFilters);
  if (probe.ofs === 0) {
    const fallback = await latestDataWindow(scope.linea);
    if (fallback) {
      isFallback = true;
      desde = fallback.desde;
      hasta = fallback.hasta;
      currentFilters = { ...currentFilters, desde, hasta };
      probe = await aggregate(currentFilters);
    }
  }

  const prevWindow = previousWindow({ ...scope, desde, hasta });
  const prevFilters: ObservabilidadFiltros = {
    linea: scope.linea,
    turno: scope.turno,
    desde: prevWindow.desde,
    hasta: prevWindow.hasta,
  };

  const [previous, worst] = await Promise.all([
    aggregate(prevFilters),
    worstOf(currentFilters),
  ]);
  const current = probe;

  const callouts: BriefCallout[] = [];

  // 1) OEE change vs previous comparable window
  if (current.ofs > 0) {
    const deltaPts = (current.oee - previous.oee) * 100;
    const oeeStr = `${(current.oee * 100).toFixed(1)}%`;
    const isCritical = deltaPts <= -3;
    const isPositive = deltaPts >= 3;
    callouts.push({
      id: 'oee',
      severity: isCritical ? 'critical' : isPositive ? 'positive' : 'info',
      category: 'oee',
      headline:
        previous.ofs === 0
          ? `OEE consolidado en ${oeeStr}`
          : isCritical
            ? `OEE cayó ${Math.abs(deltaPts).toFixed(1)} pp respecto al periodo previo`
            : isPositive
              ? `OEE mejoró ${deltaPts.toFixed(1)} pp respecto al periodo previo`
              : `OEE estable en ${oeeStr}`,
      body:
        previous.ofs === 0
          ? `${current.ofs.toLocaleString('es-ES')} OFs procesadas. Sin comparativa previa disponible.`
          : `${current.ofs.toLocaleString('es-ES')} OFs vs ${previous.ofs.toLocaleString('es-ES')} en el periodo anterior · ${formatHl(current.hl)} hl producidos.`,
      metricValue: oeeStr,
      delta: previous.ofs > 0 ? { value: deltaPts, format: 'pts' } : undefined,
      action: { label: 'Explorar post-mortem', href: '/post-mortem' },
    });
  }

  // 2) Top loss-category delta
  if (previous.ofs > 0 && current.ofs > 0) {
    type Cat = { key: string; label: string; curr: number; prev: number };
    const cats: Cat[] = [
      { key: 'pnp',     label: 'Paro no planificado',   curr: current.hPnp,      prev: previous.hPnp },
      { key: 'paro',    label: 'Paro planificado',      curr: current.hParo,     prev: previous.hParo },
      { key: 'idle',    label: 'Inactividad (idle)',    curr: current.hIdle,     prev: previous.hIdle },
      { key: 'cambio',  label: 'Cambios de formato',    curr: current.hCambio,   prev: previous.hCambio },
      { key: 'limp',    label: 'Limpieza',              curr: current.hLimpieza, prev: previous.hLimpieza },
      { key: 'mant',    label: 'Mantenimiento',         curr: current.hMant,     prev: previous.hMant },
    ];
    const ranked = cats
      .map((c) => ({ ...c, delta: c.curr - c.prev }))
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    const top = ranked[0];
    if (top && Math.abs(top.delta) >= 0.5) {
      const sign = top.delta > 0 ? '+' : '';
      callouts.push({
        id: 'losses',
        severity: top.delta > 0 ? 'warning' : 'positive',
        category: 'perdidas',
        headline:
          top.delta > 0
            ? `${top.label} subió ${formatH(top.delta)} respecto al periodo previo`
            : `${top.label} bajó ${formatH(Math.abs(top.delta))} respecto al periodo previo`,
        body: `Acumulado actual: ${formatH(top.curr)} · Periodo previo: ${formatH(top.prev)}. Representa el mayor cambio entre las 6 categorías de pérdida.`,
        metricValue: formatH(top.curr),
        metricUnit: 'h',
        delta: { value: top.delta, format: 'abs' },
        action: { label: 'Ver desglose', href: '/post-mortem' },
      });
    }
  }

  // 3) Worst OF in window
  if (worst && worst.oee < 0.6) {
    callouts.push({
      id: 'worst-of',
      severity: worst.oee < 0.4 ? 'critical' : 'warning',
      category: 'oee',
      headline: `OF ${worst.of} en Línea ${worst.linea} cerró a ${(worst.oee * 100).toFixed(0)}% OEE`,
      body: `${worst.sku ?? 'SKU s/d'} · ${formatH(worst.hParo)} de paro, ${formatH(worst.hPnp)} de PNP no planificado.`,
      metricValue: `${(worst.oee * 100).toFixed(0)}%`,
      action: { label: 'Abrir urgencia', href: '/urgencias' },
    });
  }

  // Fallback positive note when nothing actionable
  if (callouts.length === 0 && current.ofs > 0) {
    callouts.push({
      id: 'steady',
      severity: 'positive',
      category: 'oee',
      headline: 'Operación estable en el periodo seleccionado',
      body: `${current.ofs.toLocaleString('es-ES')} OFs · ${formatHl(current.hl)} hl · OEE ${(current.oee * 100).toFixed(1)}%.`,
      metricValue: `${(current.oee * 100).toFixed(1)}%`,
    });
  }

  return {
    periodLabel: isFallback
      ? `Últimos 30 días disponibles (${desde} → ${hasta})`
      : PERIODO_LABEL_BRIEF[scope.periodo] ?? 'Periodo',
    asOf: new Date().toISOString(),
    scopeLabel: scopeText(scope),
    callouts,
    metaCurrent: { ofs: current.ofs, oee: current.oee, hl: current.hl },
    metaPrevious: { ofs: previous.ofs, oee: previous.oee, hl: previous.hl },
  };
}

async function latestDataWindow(linea?: 14 | 17 | 19): Promise<{ desde: string; hasta: string } | null> {
  const clauses = ['NOT r.outlier'];
  const params: Record<string, unknown> = {};
  if (linea !== undefined) {
    clauses.push('r.linea = $linea');
    params.linea = linea;
  }
  const rows = await query<{ maxd: string | null }>(
    `SELECT CAST(MAX(r.fecha_fin) AS VARCHAR) AS maxd FROM fact_runs r WHERE ${clauses.join(' AND ')}`,
    params,
  );
  const maxd = rows[0]?.maxd;
  if (!maxd) return null;
  const hasta = String(maxd).slice(0, 10);
  const end = new Date(hasta);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 29);
  return { desde: start.toISOString().slice(0, 10), hasta };
}

function scopeText(s: BriefScope): string {
  const parts: string[] = [];
  parts.push(s.linea ? `Línea ${s.linea}` : 'Todas las líneas');
  if (s.turno) parts.push(`Turno ${s.turno}`);
  return parts.join(' · ');
}

function formatH(h: number): string {
  if (h >= 100) return `${h.toFixed(0)} h`;
  if (h >= 10) return `${h.toFixed(1)} h`;
  return `${h.toFixed(2)} h`;
}

function formatHl(hl: number): string {
  if (hl >= 100_000) return `${(hl / 1000).toFixed(0)}k hl`;
  if (hl >= 1000) return `${(hl / 1000).toFixed(1)}k hl`;
  return `${hl.toLocaleString('es-ES')} hl`;
}
