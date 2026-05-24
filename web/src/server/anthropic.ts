import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import type { AuthClient } from 'google-auth-library';

export class MissingEnvError extends Error {
  constructor(public missing: string[]) {
    super(`Missing env vars: ${missing.join(', ')}`);
    this.name = 'MissingEnvError';
  }
}

function staticAuthClient(token: string, projectId: string): AuthClient {
  return {
    projectId,
    async getRequestHeaders() {
      return { Authorization: `Bearer ${token}` };
    },
    async getAccessToken() {
      return { token };
    },
    async request<T>() {
      throw new Error('staticAuthClient does not implement request');
      return undefined as unknown as T;
    },
  } as unknown as AuthClient;
}

export function getAnthropic(): AnthropicVertex {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim();
  const accessToken = process.env.GOOGLE_CLOUD_ACCESS_TOKEN?.trim();
  const region = process.env.ANTHROPIC_REGION?.trim() || 'global';

  const missing: string[] = [];
  if (!projectId) missing.push('GOOGLE_CLOUD_PROJECT');
  if (!accessToken) missing.push('GOOGLE_CLOUD_ACCESS_TOKEN');
  if (missing.length) throw new MissingEnvError(missing);

  const authClient = staticAuthClient(accessToken!, projectId!);
  return new AnthropicVertex({ region, projectId, authClient });
}

export function getModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || 'claude-opus-4-7';
}
