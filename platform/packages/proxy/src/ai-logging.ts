import {
  AI_LOGGING_CACHE_TTL_SECONDS,
  aiLoggingKey,
  parsePublishedAiLogging,
  type AiLoggingMode,
} from '@void/platform/ai-logging';
import type { Context } from 'hono';
import type { ProxyEnv } from './types.ts';

export type AiLoggingRead =
  | Readonly<{ ok: true; mode: AiLoggingMode }>
  | Readonly<{ ok: false; response: Response }>;

/**
 * Reads the project's published AI logging mode from ROUTING KV. A missing key
 * inherits the gateway setting. A failed read or an unknown value refuses the AI
 * call, so an operator's choice is never silently replaced by the gateway default.
 */
export async function readAiLoggingMode(context: Context<ProxyEnv>): Promise<AiLoggingRead> {
  const projectId = context.get('projectId');
  let value: string | null;
  try {
    value = await context.env.ROUTING.get(aiLoggingKey(projectId), {
      cacheTtl: AI_LOGGING_CACHE_TTL_SECONDS,
    });
  } catch (error) {
    console.error('[ai] logging setting unavailable', {
      projectId,
      reason: 'kv_error',
      error: error instanceof Error ? error.name : typeof error,
    });
    return {
      ok: false,
      response: context.json(
        {
          error: 'ai_logging_policy_unavailable',
          message:
            'AI is temporarily unavailable because its logging setting could not be read. Try again shortly.',
        },
        503,
        { 'Retry-After': '5' },
      ),
    };
  }
  const mode = parsePublishedAiLogging(value);
  if (mode === undefined) {
    // Log the length only: the value is operator data and never echoed.
    console.error('[ai] logging setting unavailable', {
      projectId,
      reason: 'invalid_value',
      valueLength: value?.length ?? 0,
    });
    return {
      ok: false,
      response: context.json(
        {
          error: 'ai_logging_policy_invalid',
          message:
            'AI is unavailable because the AI logging setting for this project is not valid. Ask a platform administrator to set the AI logging setting again.',
        },
        503,
      ),
    };
  }
  return { ok: true, mode };
}

type LoggingControls = Readonly<{ collectLog: boolean; payload: boolean }>;

/**
 * The one place that maps a mode to AI Gateway logging controls. `null` sends
 * nothing, so the gateway's own setting applies.
 *
 * Binding calls (`run`, `toMarkdown`) send `gateway.collectLog` plus the
 * `cf-aig-collect-log-payload` extra header. Cloudflare documents only
 * `collectLog` for the binding; if the payload header turns out to be ignored
 * there, change `metadata` here to `{ collectLog: false, payload: false }`.
 */
const BINDING_LOGGING: Readonly<Record<AiLoggingMode, LoggingControls | null>> = {
  inherit: null,
  off: { collectLog: false, payload: false },
  metadata: { collectLog: true, payload: false },
  full: { collectLog: true, payload: true },
};

/** Provider-native calls send `cf-aig-collect-log` and `cf-aig-collect-log-payload`. */
const PROVIDER_LOGGING: Readonly<Record<AiLoggingMode, LoggingControls | null>> = {
  inherit: null,
  off: { collectLog: false, payload: false },
  metadata: { collectLog: true, payload: false },
  full: { collectLog: true, payload: true },
};

export function bindingAiLogging(mode: AiLoggingMode): LoggingControls | null {
  return BINDING_LOGGING[mode];
}

export function applyAiLoggingHeaders(headers: Headers, mode: AiLoggingMode): void {
  const controls = PROVIDER_LOGGING[mode];
  if (controls) {
    headers.set('cf-aig-collect-log', String(controls.collectLog));
    headers.set('cf-aig-collect-log-payload', String(controls.payload));
  }
}
