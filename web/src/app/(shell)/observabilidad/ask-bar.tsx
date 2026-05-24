'use client';

import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button, Card, Pill, Skeleton } from '@/components/ui';
import { Sparkles } from '@/components/icons';
import type { ChartConfig } from '@/types';

const EXAMPLES = [
  'OEE mensual por línea en 2025',
  'Top 10 marcas por horas de paro',
  'Horas de cambio por formato Q1 2026',
];

interface AskResponse {
  config: ChartConfig;
  explanation: string;
  warnings: string[];
}

interface AskError {
  error: string;
  message?: string;
}

interface AskBarProps {
  currentConfig?: ChartConfig | null;
  onProposed: (config: ChartConfig, explanation: string) => void;
}

const ERROR_MAP: Record<string, string> = {
  env_missing:
    'Configura GOOGLE_CLOUD_PROJECT y GOOGLE_CLOUD_ACCESS_TOKEN en `.env.local` y reinicia el servidor.',
  token_expired:
    'Token de Vertex caducado. Renuévalo con `gcloud auth print-access-token` y reinicia.',
  quota_exceeded:
    'Sin cuota en Vertex para este modelo. Solicita un aumento en la consola de GCP (Vertex AI → Quotas, publisher: anthropic).',
  no_tool_call: 'Claude no devolvió una configuración válida. Reformula la pregunta.',
  invalid_config: 'La configuración generada no era válida. Reformula la pregunta.',
  upstream: 'Vertex respondió con un error. Reintenta en unos segundos.',
  empty_prompt: 'Escribe una pregunta.',
  too_long: 'La pregunta es demasiado larga (máx. 600 caracteres).',
};

export function AskBar({ currentConfig, onProposed }: AskBarProps) {
  const [prompt, setPrompt] = useState('');
  const [explanation, setExplanation] = useState<string>('');
  const [warnings, setWarnings] = useState<string[]>([]);

  const ask = useMutation<AskResponse, AskError, string>({
    mutationFn: async (text: string) => {
      const res = await fetch('/api/observabilidad/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text, currentConfig: currentConfig ?? undefined }),
      });
      const body = (await res.json().catch(() => ({}))) as AskResponse | AskError;
      if (!res.ok) {
        throw body as AskError;
      }
      return body as AskResponse;
    },
    onSuccess: (data) => {
      setExplanation(data.explanation);
      setWarnings(data.warnings ?? []);
      onProposed(data.config, data.explanation);
    },
  });

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || ask.isPending) return;
    setExplanation('');
    setWarnings([]);
    ask.mutate(trimmed);
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    submit(prompt);
  };

  const errorMsg = ask.isError
    ? ERROR_MAP[ask.error?.error ?? ''] ?? ask.error?.message ?? 'No se pudo generar el gráfico.'
    : null;

  return (
    <Card aria-label="Pregunta a Claude" className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-hairline bg-bone/40 px-5 py-2.5">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-ink-3">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-damm" />
          Pregunta a Claude
        </div>
        <span className="hidden text-[10px] uppercase tracking-wider text-ink-4 md:inline">
          Vertex · {process.env.NEXT_PUBLIC_ANTHROPIC_MODEL ?? 'claude-opus-4-7'}
        </span>
      </div>

      <div className="space-y-3 px-5 py-4">
        <div className="flex items-baseline justify-between gap-2">
          <div className="eyebrow text-ink-3">Describe el gráfico</div>
          <span className="text-[10px] text-ink-4">
            Lenguaje natural · español
          </span>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Sparkles
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-damm"
              aria-hidden
            />
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder='Ej: "OEE mensual por línea en 2025"'
              maxLength={600}
              className="w-full rounded-pill border border-hairline bg-surface py-2 pl-8 pr-3 text-sm text-ink placeholder:text-ink-4 focus:border-damm focus:outline-none focus:ring-1 focus:ring-damm/30"
            />
          </div>
          <Button
            variant="danger"
            size="md"
            type="submit"
            disabled={!prompt.trim() || ask.isPending}
          >
            {ask.isPending ? 'Construyendo…' : 'Generar gráfico'}
          </Button>
        </form>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-ink-4">Ejemplos</span>
          {EXAMPLES.map((ex) => (
            <Pill
              key={ex}
              onClick={() => {
                setPrompt(ex);
                submit(ex);
              }}
            >
              {ex}
            </Pill>
          ))}
        </div>

        {ask.isPending && (
          <div className="space-y-1.5 pt-1">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        )}

        {!ask.isPending && explanation && (
          <p className="border-l-2 border-damm/40 pl-3 text-xs italic text-ink-2">
            {explanation}
          </p>
        )}

        {!ask.isPending && warnings.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-5 text-[11px] text-ink-3">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}

        {errorMsg && (
          <div className="rounded border border-damm/30 bg-damm-soft/30 px-3 py-1.5 text-xs text-damm">
            {errorMsg}
          </div>
        )}
      </div>
    </Card>
  );
}
