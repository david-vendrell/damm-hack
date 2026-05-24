import { NextResponse } from 'next/server';
import { getOpenAI, getModel, MissingEnvError } from '@/server/openai';
import { DIMENSIONS, MEASURES } from '@/server/query';
import type { ChartConfig, QueryResult } from '@/types';

interface ExplainBody {
  config?: unknown;
  data?: unknown;
  chartName?: unknown;
}

const AGG_LABEL: Record<string, string> = {
  sum: 'suma',
  avg: 'media',
  median: 'mediana',
  count: 'conteo',
  min: 'mínimo',
  max: 'máximo',
  p90: 'percentil 90',
};

const VIZ_LABEL: Record<string, string> = {
  auto: 'automático',
  line: 'línea temporal',
  bar: 'barras',
  stackedBar: 'barras apiladas',
  donut: 'donut',
  bigNumber: 'KPI único',
  table: 'tabla',
};

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object';
}

function fmt(n: number, kind?: string): string {
  if (!Number.isFinite(n)) return '—';
  if (kind === 'pct') return `${(n * 100).toFixed(1)}%`;
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString('es-ES', { maximumFractionDigits: 0 });
  if (abs >= 10) return n.toLocaleString('es-ES', { maximumFractionDigits: 1 });
  return n.toLocaleString('es-ES', { maximumFractionDigits: 2 });
}

function summarizeData(config: ChartConfig, data: QueryResult): string {
  const measureDef = MEASURES[config.measure];
  const measureLabel = measureDef?.label ?? config.measure;
  const kind = measureDef?.kind;
  const dimLabel = data.dimension
    ? DIMENSIONS[data.dimension]?.label ?? data.dimension
    : null;
  const breakdownLabel = data.breakdown
    ? DIMENSIONS[data.breakdown]?.label ?? data.breakdown
    : null;
  const aggLabel = AGG_LABEL[data.aggregation] ?? data.aggregation;

  const lines: string[] = [];
  lines.push(`Métrica: ${measureLabel} (${aggLabel}).`);
  if (dimLabel) lines.push(`Eje: ${dimLabel}.`);
  if (breakdownLabel) lines.push(`Desglose: ${breakdownLabel}.`);
  lines.push(`Visualización: ${VIZ_LABEL[config.viz] ?? config.viz}.`);

  const range = config.dateRange;
  if (range.preset) lines.push(`Rango: preset ${range.preset}.`);
  else if (range.from || range.to)
    lines.push(`Rango: ${range.from ?? '—'} → ${range.to ?? '—'}.`);

  if (config.filters?.length) {
    const fs = config.filters
      .map((f) => `${DIMENSIONS[f.dim]?.label ?? f.dim}=${f.values.join('|')}`)
      .join('; ');
    lines.push(`Filtros: ${fs}.`);
  }

  if (typeof data.total === 'number') {
    lines.push(`Total agregado: ${fmt(data.total, kind)}.`);
    if (typeof data.previousTotal === 'number') {
      const delta = data.total - data.previousTotal;
      lines.push(
        `Periodo anterior: ${fmt(data.previousTotal, kind)} (Δ ${fmt(delta, kind)}).`,
      );
    }
  }

  const rows = data.rows ?? [];
  if (rows.length) {
    lines.push(`Segmentos: ${rows.length}.`);
    const sorted = [...rows].sort((a, b) => b.value - a.value);
    const top = sorted.slice(0, Math.min(5, sorted.length));
    lines.push(
      `Top valores: ${top.map((r) => `${r.label}=${fmt(r.value, kind)}`).join('; ')}.`,
    );
    if (sorted.length > 1) {
      const bottom = sorted[sorted.length - 1];
      lines.push(`Mínimo: ${bottom.label}=${fmt(bottom.value, kind)}.`);
    }
    const values = rows.map((r) => r.value).filter(Number.isFinite);
    if (values.length) {
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      lines.push(`Media de segmentos: ${fmt(avg, kind)}.`);
    }
  }

  if (data.dataQuality?.rowsConsidered) {
    lines.push(
      `Filas consideradas: ${data.dataQuality.rowsConsidered.toLocaleString('es-ES')}.`,
    );
  }

  return lines.join('\n');
}

function validateConfig(raw: unknown): ChartConfig | null {
  if (!isObj(raw)) return null;
  if (typeof raw.measure !== 'string' || !(MEASURES as Record<string, unknown>)[raw.measure]) {
    return null;
  }
  return raw as unknown as ChartConfig;
}

function validateData(raw: unknown): QueryResult | null {
  if (!isObj(raw)) return null;
  if (!Array.isArray(raw.rows)) return null;
  return raw as unknown as QueryResult;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as ExplainBody;
  const config = validateConfig(body.config);
  const data = validateData(body.data);
  if (!config || !data) {
    return NextResponse.json(
      { error: 'invalid_input', message: 'Falta config o data.' },
      { status: 400 },
    );
  }

  const hasContent =
    (data.rows && data.rows.length > 0) || typeof data.total === 'number';
  if (!hasContent) {
    return NextResponse.json({
      explanation:
        'No hay datos suficientes en este gráfico todavía. Ajusta filtros o rango para que ChatGPT pueda analizarlo.',
    });
  }

  let client;
  try {
    client = getOpenAI();
  } catch (err) {
    if (err instanceof MissingEnvError) {
      return NextResponse.json(
        {
          error: 'env_missing',
          message: 'Configura OPENAI_API_KEY en .env.local.',
        },
        { status: 503 },
      );
    }
    throw err;
  }

  const summary = summarizeData(config, data);
  const chartName =
    typeof body.chartName === 'string' && body.chartName.trim()
      ? body.chartName.trim()
      : null;

  const system = `Eres el analista de **LineWise**, herramienta interna de Damm para observar la producción cervecera (líneas L14/L17/L19).
Te dan un resumen estructurado del gráfico que el usuario está viendo y debes redactar en español, en 2-4 frases (máx. 80 palabras), una explicación que:
1) describa qué muestra el gráfico (métrica, eje, agregación, rango),
2) destaque 1-2 lecturas concretas de los datos (mayor/menor, contraste, tendencia, total) usando los números reales,
3) ayude al planificador a entender qué significan esos datos en planta.
No inventes valores que no estén en el resumen. No uses listas ni markdown: prosa directa, tono operacional. Nada de saludos ni cierres.`;

  const user = `Gráfico${chartName ? ` "${chartName}"` : ''}:\n${summary}`;

  try {
    const response = await client.chat.completions.create({
      model: getModel(),
      max_tokens: 220,
      temperature: 0.3,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    const explanation =
      response.choices?.[0]?.message?.content?.trim() ??
      'Sin explicación disponible.';
    return NextResponse.json({ explanation });
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status;
    if (status === 401 || status === 403) {
      return NextResponse.json(
        { error: 'invalid_key', message: 'Clave de OpenAI inválida.' },
        { status: 503 },
      );
    }
    if (status === 429) {
      return NextResponse.json(
        { error: 'quota_exceeded', message: 'Sin cuota en OpenAI.' },
        { status: 503 },
      );
    }
    console.error('[explain] openai error', err);
    return NextResponse.json(
      { error: 'unknown', message: 'No se pudo generar la explicación.' },
      { status: 500 },
    );
  }
}
