import { NextResponse } from 'next/server';
import { getOpenAI, getModel, MissingEnvError } from '@/server/openai';
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

const refuseTool = {
  type: 'function' as const,
  function: {
    name: 'refuse_off_topic',
    description:
      'Úsala SOLO cuando la pregunta del usuario no tenga relación con la producción cervecera de Damm (OEE, paros, cambios de formato, mantenimiento, volumen, líneas L14/L17/L19, marcas, formatos, canales, plan vs real, limpieza/CIP, etc.). NUNCA la uses para preguntas legítimas sobre estos temas.',
    parameters: {
      type: 'object' as const,
      additionalProperties: false,
      required: ['reason'],
      properties: {
        reason: {
          type: 'string',
          description:
            'Frase corta en español (≤ 25 palabras) explicando que la pregunta queda fuera del alcance de LineWise.',
        },
      },
    },
  },
};

const buildChartTool = {
  type: 'function' as const,
  function: {
    name: 'build_chart',
    description: 'Construye una configuración de gráfico para el constructor de Observabilidad de LineWise.',
    parameters: {
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

  return `Eres el asistente de **LineWise**, la herramienta interna de planificación y observabilidad de la planta Damm. Tu único trabajo es traducir preguntas en español sobre la producción cervecera de Damm (líneas L14, L17, L19) a configuraciones de gráficos (ChartConfig) que el constructor de la app renderizará.

Ámbito de LineWise (lo que SÍ puedes ayudar):
- OEE, disponibilidad, rendimiento, ineficiencia, utilización.
- Volumen (hl / unidades), nº de OFs, % de OFs con cambio, frecuencia de cambio.
- Horas: marcha, paro, PNP, IDLE, baja velocidad, saturación salida, falta producto, limpieza, CIP, esterilización, cambio.
- Mantenimiento: llamadas, horas de intervención, horas de espera.
- Cambios: tipo principal, dimensiones cambiadas, real vs teórico.
- Cortes por: línea (L14/L17/L19), marca, formato, familia, tipo de envase, canal, SKU, turno, causa de paro, día/semana/mes.
- Plan vs Real, comparativas por periodo.

Reglas duras:
- Si la pregunta entra en el ámbito, DEBES llamar exactamente una vez a \`build_chart\`.
- Si la pregunta NO trata sobre la producción cervecera de Damm (saludos sociales, chistes, política, programación, gastronomía, recetas, deportes, etc.), DEBES llamar a \`refuse_off_topic\` y nada más. No inventes un gráfico para temas fuera de alcance.
- Antes de la llamada a \`build_chart\` puedes añadir UNA frase corta (≤ 25 palabras) en español explicando qué vas a construir. Nada más.
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
- Datos disponibles: año 2025 (enero–diciembre). Si el usuario no precisa año, usa \`preset: 'y2025'\`. Los presets móviles ('7d', '30d', '90d', 'ytd') suelen devolver vacío fuera de 2025.

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

interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIMessage {
  content?: string | null;
  tool_calls?: OpenAIToolCall[] | null;
}

interface ToolCall {
  tool: 'build_chart' | 'refuse_off_topic';
  input: unknown;
  explanation: string;
}

function extractToolCall(message: OpenAIMessage | undefined): ToolCall | null {
  if (!message) return null;
  let explanation = typeof message.content === 'string' ? message.content.trim() : '';
  let toolName: ToolCall['tool'] | null = null;
  let input: unknown = null;
  for (const tc of message.tool_calls ?? []) {
    const name = tc.function?.name;
    if (name === 'build_chart' || name === 'refuse_off_topic') {
      toolName = name;
      try {
        input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : null;
      } catch {
        input = null;
      }
      break;
    }
  }
  if (!toolName) return null;
  if (explanation.length > 240) explanation = explanation.slice(0, 237) + '…';
  return { tool: toolName, input, explanation };
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
    client = getOpenAI();
  } catch (err) {
    if (err instanceof MissingEnvError) {
      return NextResponse.json(
        {
          error: 'env_missing',
          missing: err.missing,
          message: 'Configura OPENAI_API_KEY en .env.local.',
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
    response = await client.chat.completions.create({
      model: getModel(),
      max_tokens: 1024,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: userContent },
      ],
      tools: [buildChartTool, refuseTool],
      tool_choice: 'required',
    });
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status;
    if (status === 401 || status === 403) {
      return NextResponse.json(
        {
          error: 'invalid_key',
          message: 'Clave de OpenAI inválida o sin permiso. Revisa OPENAI_API_KEY.',
        },
        { status: 503 },
      );
    }
    if (status === 429) {
      return NextResponse.json(
        {
          error: 'quota_exceeded',
          message: 'Sin cuota en OpenAI para este modelo. Revisa tu plan en platform.openai.com.',
        },
        { status: 503 },
      );
    }
    if (status && status >= 500) {
      return NextResponse.json(
        { error: 'upstream', message: 'OpenAI respondió con un error. Reintenta en unos segundos.' },
        { status: 502 },
      );
    }
    console.error('[ask] openai error', err);
    return NextResponse.json({ error: 'unknown', message: 'Error inesperado.' }, { status: 500 });
  }

  const tool = extractToolCall(response.choices?.[0]?.message as OpenAIMessage | undefined);
  if (!tool) {
    return NextResponse.json(
      { error: 'no_tool_call', message: 'ChatGPT no devolvió una configuración válida. Reformula la pregunta.' },
      { status: 500 },
    );
  }

  if (tool.tool === 'refuse_off_topic') {
    const reasonRaw = (tool.input as { reason?: unknown })?.reason;
    const reason = typeof reasonRaw === 'string' && reasonRaw.trim()
      ? reasonRaw.trim()
      : 'Esa pregunta queda fuera del alcance de LineWise.';
    return NextResponse.json(
      {
        error: 'off_topic',
        message: `${reason} LineWise solo ayuda con la producción cervecera de Damm: OEE, paros, cambios, volumen, mantenimiento, plan vs real, etc.`,
      },
      { status: 422 },
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
