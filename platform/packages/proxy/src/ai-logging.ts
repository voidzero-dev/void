import { isAiLoggingMode, type AiLoggingMode } from '@voidcloud/api/ai-logging-policy';
import { deriveProxyInternalAuth, PROXY_INTERNAL_AUTH_HEADER } from '@voidcloud/api/proxy-token';
import type { Env } from './types.ts';

/** Never cache a privacy policy or fall back to gateway defaults on a failed read. */
export async function readAiLoggingMode(
  env: Env,
  projectId: string,
  signal?: AbortSignal,
): Promise<AiLoggingMode> {
  const response = await env.API.fetch(`https://api/internal/ai-logging/${projectId}`, {
    signal,
    headers: {
      [PROXY_INTERNAL_AUTH_HEADER]: await deriveProxyInternalAuth(
        env.JWT_SECRET,
        'ai-logging',
        projectId,
      ),
    },
  });
  if (!response.ok) {
    throw new Error('AI logging policy unavailable.');
  }
  const policy = await response.json<{ mode?: unknown }>();
  if (!policy || !isAiLoggingMode(policy.mode)) {
    throw new Error('Invalid AI logging policy.');
  }
  return policy.mode;
}

export function applyAiLoggingHeaders(headers: Headers, mode: AiLoggingMode): void {
  if (mode !== 'inherit') {
    headers.set('cf-aig-collect-log', String(mode !== 'off'));
    headers.set('cf-aig-collect-log-payload', String(mode === 'full'));
  }
}
