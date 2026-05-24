import OpenAI from 'openai';

export class MissingEnvError extends Error {
  constructor(public missing: string[]) {
    super(`Missing env vars: ${missing.join(', ')}`);
    this.name = 'MissingEnvError';
  }
}

export function getOpenAI(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new MissingEnvError(['OPENAI_API_KEY']);
  return new OpenAI({ apiKey });
}

export function getModel(): string {
  return process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';
}
