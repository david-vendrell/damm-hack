import { NextResponse } from 'next/server';
import { getAnthropic, getModel, MissingEnvError } from '@/server/anthropic';
import { DIMENSION_LIST, DIMENSIONS, MEASURE_LIST, MEASURES } from '@/server/query';
import type {
  Aggregation,
  ChartConfig,
  DateRange,
  DimensionKey,
  Filter,
  Granularity,
  MeasureKey,
  VizType,
} from '@/types';

const AGG_VALUES: Aggregation[] = ['sum', 'avg', 'median', 'count', 'min', 'max', 'p90'];
const GRAN_VALUES: Granularity[] = ['day', 'week', 'month'];
const VIZ_VALUES: VizType[] = ['auto', 'line', 'bar', 'stackedBar', 'donut', 'bigNumber', 'table'];
const PRESET_VALUES: NonNullable<DateRange['preset']>[] = ['7d', '30d', '90d', 'ytd', 'y2025', 'y2024', 'all'];
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

const MEASURE_KEYS = MEASURE_LIST.map((m) => m.key);
const DIM_KEYS = DIMENSION_LIST.map((d) => d.key);

const buildChartTool = {
  name: 'build_chart',
  description: 'Construye una configuración de gráfico para el constructor de Observabilidad.',
  input_schema: {
    type: 'object' as const,
    additionalProperties: false,
    required: ['measure', 'aggregation', 'filters', 'dateRange', 'granularity', 'viz'],
    properties: {
      measure: { type: 'string', enum: MEASURE_KEYS },
      aggregation: { type: 'string', enum: AGG_VALUES },
      dimension: { type: 'string', enum: DIM_KEYS },
      breakdown: { type: 'string', enum: DIM_KEYS },
      filters: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['dim', 'values'],
          properties: {
            dim: { type: 'string', enum: DIM_KEYS },
            values: { type: 'array', items: { type: 'string' }, minItems: 1 },
          },
        },
      },
      dateRange: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          preset: { type: 'string', enum: PRESET_VALUES },
        },
      },
      granularity: { type: 'string', enum: GRAN_VALUES },
      viz: { type: 'string', enum: VIZ_VALUES },
      topN: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
};

function buildSystemPrompt(): string {
  const measures = MEASURE_LIST.map((m) => {
    const def = MEASURES[m.key];
    return `- ${m.key} — ${m.label} (${m.kind}, aggs: ${def.allowedAggs.join('|')}, default: ${def.defaultAgg})`;
  }).join('\n');
  const dims = DIMENSION_LIST.map(
    (d) => `- ${d.key} — ${d.label} (${d.temporal ? 'temporal' : 'categórica'})`,
  ).join('\n');

  return `Eres un asistente que traduce preguntas en español sobre producción cervecera a configuraciones de gráficos (ChartConfig). El usuario trabaja en la planta Damm (líneas L14, L17, L19) y consulta OEE, paros, cambios de formato, mantenimiento y volumen por línea, marca, formato, canal, etc.

Reglas duras:
- DEBES llamar a la herramienta \`build_chart\` exactamente una vez.
- Antes de la llamada puedes añadir UNA frase corta (≤ 25 palabras) en español explicando qué vas a construir. Nada más.
- Usa únicamente las claves de métrica y dimensión listadas abajo. No inventes claves.
- Evolución temporal → \`dimension\` temporal (típicamente 'mesIso') + \`viz: 'line'\`. Ajusta \`granularity\` a 'day' | 'week' | 'month' según la palabra usada (día/diaria, semana/semanal, mes/mensual).
- Comparación por categoría → \`viz: 'bar'\` (o 'stackedBar' si hay desglose) y \`dimension\` categórica; añade \`topN: 10\` si la pregunta dice "top".
- "X por A y por B" → \`dimension: A\`, \`breakdown: B\`.
- Año específico → \`dateRange.preset\` ('y2025', 'y2024'); rango móvil ("últimos 30 días") → '7d' | '30d' | '90d' | 'ytd' | 'all'.
- Trimestre o rango concreto (Q1 2026, "del 1 de marzo al 15 de abril") → usa \`from\`/\`to\` en ISO (YYYY-MM-DD).
- Métricas porcentuales (oee, disp, rend, inef, pctCambios, utilizacion) → \`aggregation: 'avg'\` por defecto.
- Métricas en horas / hl / unidades / conteos → \`aggregation: 'sum'\` por defecto.
- Si la pregunta es ambigua, elige la interpretación más natural y refleja la decisión en tu frase explicativa.
- Filtra siempre con las claves canónicas: para líneas usa valores '14', '17', '19' (string).

Métricas disponibles:
${measures}

Dimensiones disponibles:
${dims}

Presets de fecha: ${PRESET_VALUES.map((p) => `'${p}'`).join(', ')}.
Granularidades: 'day', 'week', 'month'.
Visualizaciones: 'auto', 'line', 'bar', 'stackedBar', 'donut', 'bigNumber', 'table'.`;
}

interface AskBody {
  prompt?: unknown;
  currentConfig?: unknown;
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

function validateConfig(
  raw: unknown,
  warnings: string[],
): ChartConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const measure = isStr(r.measure) && (MEASURES as Record<string, unknown>)[r.measure]
    ? (r.measure as MeasureKey)
    : null;
  if (!measure) return null;

  const measureDef = MEASURES[measure];
  let aggregation: Aggregation = measureDef.defaultAgg;
  if (isStr(r.aggregation) && (AGG_VALUES as string[]).includes(r.aggregation)) {
    const candidate = r.aggregation as Aggregation;
    if (measureDef.allowedAggs.includes(candidate)) {
      aggregation = candidate;
    } else {
      warnings.push(
        `La agregación "${candidate}" no aplica a ${measureDef.label}; usada "${measureDef.defaultAgg}".`,
      );
    }
  }

  let dimension: DimensionKey | undefined;
  if (isStr(r.dimension) && (DIMENSIONS as Record<string, unknown>)[r.dimension]) {
    dimension = r.dimension as DimensionKey;
  } else if (r.dimension !== undefined && r.dimension !== null && r.dimension !== '') {
    warnings.push(`Dimensión desconocida descartada.`);
  }

  let breakdown: DimensionKey | undefined;
  if (isStr(r.breakdown) && (DIMENSIONS as Record<string, unknown>)[r.breakdown]) {
    breakdown = r.breakdown as DimensionKey;
    if (breakdown === dimension) breakdown = undefined;
  }

  const filters: Filter[] = [];
  if (Array.isArray(r.filters)) {
    for (const f of r.filters) {
      if (!f || typeof f !== 'object') continue;
      const fr = f as Record<string, unknown>;
      if (!isStr(fr.dim) || !(DIMENSIONS as Record<string, unknown>)[fr.dim]) continue;
      if (!Array.isArray(fr.values)) continue;
      const values = fr.values.filter(isStr);
      if (!values.length) continue;
      filters.push({ dim: fr.dim as DimensionKey, values });
    }
  }

  let granularity: Granularity = 'month';
  if (isStr(r.granularity) && (GRAN_VALUES as string[]).includes(r.granularity)) {
    granularity = r.granularity as Granularity;
  }

  let viz: VizType = 'auto';
  if (isStr(r.viz) && (VIZ_VALUES as string[]).includes(r.viz)) {
    viz = r.viz as VizType;
  }

  const dateRange: DateRange = {};
  if (r.dateRange && typeof r.dateRange === 'object') {
    const dr = r.dateRange as Record<string, unknown>;
    if (isStr(dr.preset) && (PRESET_VALUES as string[]).includes(dr.preset)) {
      dateRange.preset = dr.preset as DateRange['preset'];
    }
    if (isStr(dr.from) && ISO_RE.test(dr.from)) dateRange.from = dr.from;
    if (isStr(dr.to) && ISO_RE.test(dr.to)) dateRange.to = dr.to;
  }
  if (!dateRange.preset && !dateRange.from && !dateRange.to) {
    dateRange.preset = 'y2025';
  }

  let topN: number | undefined;
  if (typeof r.topN === 'number' && Number.isFinite(r.topN)) {
    topN = Math.max(1, Math.min(50, Math.floor(r.topN)));
  }

  return {
    measure,
    aggregation,
    dimension,
    breakdown,
    filters,
    dateRange,
    granularity,
    viz,
    topN,
  };
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

function extractToolCall(blocks: ContentBlock[]): { input: unknown; explanation: string } | null {
  let explanation = '';
  let input: unknown = null;
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string' && !explanation) {
      explanation = b.text.trim();
    }
    if (b.type === 'tool_use' && b.name === 'build_chart') {
      input = b.input;
    }
  }
  if (!input) return null;
  if (explanation.length > 240) explanation = explanation.slice(0, 237) + '…';
  return { input, explanation };
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as AskBody;
  const prompt = isStr(body.prompt) ? body.prompt.trim() : '';
  if (!prompt) {
    return NextResponse.json(
      { error: 'empty_prompt', message: 'Escribe una pregunta.' },
      { status: 400 },
    );
  }
  if (prompt.length > 600) {
    return NextResponse.json(
      { error: 'too_long', message: 'La pregunta es demasiado larga (máx. 600 caracteres).' },
      { status: 400 },
    );
  }

  let client;
  try {
    client = getAnthropic();
  } catch (err) {
    if (err instanceof MissingEnvError) {
      return NextResponse.json(
        {
          error: 'env_missing',
          missing: err.missing,
          message:
            'Faltan credenciales de Vertex. Configura GOOGLE_CLOUD_PROJECT y GOOGLE_CLOUD_ACCESS_TOKEN en .env.local.',
        },
        { status: 503 },
      );
    }
    throw err;
  }

  const userContent =
    body.currentConfig && typeof body.currentConfig === 'object'
      ? `${prompt}\n\nConfiguración actual (refínala si tiene sentido):\n${JSON.stringify(body.currentConfig)}`
      : prompt;

  let response;
  try {
    response = await client.messages.create({
      model: getModel(),
      max_tokens: 1024,
      system: buildSystemPrompt(),
      tools: [buildChartTool],
      tool_choice: { type: 'tool', name: 'build_chart' },
      messages: [{ role: 'user', content: userContent }],
    });
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status;
    if (status === 401 || status === 403) {
      return NextResponse.json(
        {
          error: 'token_expired',
          message:
            'Token de Vertex caducado o sin permiso. Renuévalo con `gcloud auth print-access-token`.',
        },
        { status: 503 },
      );
    }
    if (status === 429) {
      return NextResponse.json(
        {
          error: 'quota_exceeded',
          message:
            'Sin cuota en Vertex para este modelo. Solicita un aumento en la consola de GCP.',
        },
        { status: 503 },
      );
    }
    if (status && status >= 500) {
      return NextResponse.json(
        { error: 'upstream', message: 'Vertex respondió con un error. Reintenta en unos segundos.' },
        { status: 502 },
      );
    }
    console.error('[ask] vertex error', err);
    return NextResponse.json({ error: 'unknown', message: 'Error inesperado.' }, { status: 500 });
  }

  const tool = extractToolCall((response.content ?? []) as ContentBlock[]);
  if (!tool) {
    return NextResponse.json(
      { error: 'no_tool_call', message: 'Claude no devolvió una configuración válida. Reformula la pregunta.' },
      { status: 500 },
    );
  }

  const warnings: string[] = [];
  const config = validateConfig(tool.input, warnings);
  if (!config) {
    return NextResponse.json(
      { error: 'invalid_config', message: 'La configuración generada no era válida. Reformula la pregunta.' },
      { status: 500 },
    );
  }

  return NextResponse.json({ config, explanation: tool.explanation, warnings });
}
