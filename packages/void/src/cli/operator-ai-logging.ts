import { AI_LOGGING_SETTLE_MS } from '@void/platform/ai-logging';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import { ensurePlatformAccessToken } from './cf-access.ts';
import { OperatorClientError } from './operator-client.ts';
import { sanitizeTerminalText } from './output.ts';
import { readPlatformDiscoveryResponse } from './platform-discovery.ts';

/** The first platform release with per-project AI logging settings. */
export const AI_LOGGING_PLATFORM_VERSION = '1.8.0';

type Fields = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === 'string' ? sanitizeTerminalText(value) : '';
}

function record(value: unknown): Fields | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : null;
}

/** `14:03:20 UTC`, or null when the value is not a time. */
export function utcTime(value: unknown, offsetMs = 0): string | null {
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(time)) {
    return null;
  }
  return `${new Date(time + offsetMs).toISOString().slice(11, 19)} UTC`;
}

/** `plan "pro"`, naming the default plan an unknown plan ID follows. */
function planLabel(fields: Fields): string {
  const plan = `plan "${text(fields.planId)}"`;
  if (fields.planKnown === false) {
    return `${plan} (not in catalog; uses default plan "${text(fields.defaultPlanId)}")`;
  }
  return plan;
}

/** Where the effective mode comes from, or null for a platform that does not say. */
function sourceText(fields: Fields): string | null {
  if (typeof fields.planId !== 'string') {
    return null;
  }
  const planDefault = `${planLabel(fields)} default: ${text(fields.planMode) || 'inherit'}`;
  switch (fields.source) {
    case 'project':
      return `set on project; ${planDefault}`;
    case 'plan':
      return `from ${planLabel(fields)}`;
    case 'gateway':
      return `AI Gateway setting; ${planDefault}`;
    default:
      return null;
  }
}

function effective(fields: Fields): string {
  return text(fields.effective) || text(fields.mode);
}

function withSource(mode: string, fields: Fields): string {
  const source = sourceText(fields);
  return source ? `${mode} (${source})` : mode;
}

/** The `project ai-logging` result: the setting and when new requests follow it. */
export function aiLoggingChangeLines(projectId: string, result: Fields): Array<string> {
  const lines = [
    `AI logging for ${sanitizeTerminalText(projectId)}: ${withSource(effective(result), result)}`,
  ];
  const expectedBy = utcTime(result.expectedBy);
  if (expectedBy) {
    lines.push(
      `New AI requests are expected to follow it by ${expectedBy} (normally within 2 minutes).`,
    );
  }
  return lines;
}

/** The `project ai-logging --plan` preview: current and new effective modes. */
export function aiLoggingPreviewLines(projectId: string, preview: Fields): Array<string> {
  const previous = text(preview.previous);
  const next = effective(preview);
  const change = previous ? `${previous} → ${next}` : next;
  return [
    `AI logging for ${sanitizeTerminalText(projectId)}: ${withSource(change, preview)}`,
    'No change was made. Run the command again without --plan to apply it.',
  ];
}

const STATES: Record<string, (fields: Fields) => string> = {
  applied: () => 'applied',
  pending: (fields) => {
    const by = utcTime(fields.publishedAt, AI_LOGGING_SETTLE_MS);
    return by ? `pending (expected by ${by})` : 'pending (normally within 2 minutes)';
  },
  pending_plan_publish: () => 'pending (the plan default is still being published)',
  drift: (fields) => `drift (published: ${text(fields.published) || 'unknown value'})`,
  unknown: () => 'state unknown (the published setting could not be read)',
};

/**
 * `project show` line, such as `metadata (from plan "pro") — applied`, or null
 * when the response has no AI logging data.
 */
export function aiLoggingStatusLine(value: unknown): string | null {
  const fields = record(value);
  if (!fields || typeof fields.mode !== 'string') {
    return null;
  }
  const state =
    typeof fields.state === 'string' && Object.hasOwn(STATES, fields.state)
      ? STATES[fields.state]
      : undefined;
  const summary = withSource(effective(fields), fields);
  return `AI Gateway logging: ${state ? `${summary} — ${state(fields)}` : summary}`;
}

type DiscoveryProbe = { kind: 'version'; version: string } | { kind: 'missing' | 'unknown' };

async function probePlatformVersion(origin: string): Promise<DiscoveryProbe> {
  ensurePlatformAccessToken(origin);
  let response: Response;
  try {
    response = await fetch(`${origin}/.well-known/void-platform`, {
      headers: { Accept: 'application/json', ...cfAccessHeaders(process.env, origin) },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { kind: 'unknown' };
  }
  if (response.status === 404) {
    await response.body?.cancel();
    return { kind: 'missing' };
  }
  try {
    return {
      kind: 'version',
      version: (await readPlatformDiscoveryResponse(origin, response)).platformVersion,
    };
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * Refuses `project ai-logging` on a platform before AI logging settings existed.
 * It reads the platform version instead of guessing from a 404, because "Project
 * not found" is also a 404. When the version cannot be read, the request runs and
 * reports its own error.
 */
export async function assertAiLoggingPlatform(origin: string): Promise<void> {
  const probe = await probePlatformVersion(origin);
  if (probe.kind === 'unknown') {
    return;
  }
  if (probe.kind === 'version') {
    const { isOlderPlatformVersion } = await import('./client.ts');
    // "hosted" and development builds are not release versions and pass.
    if (isOlderPlatformVersion(probe.version, AI_LOGGING_PLATFORM_VERSION) !== true) {
      return;
    }
  }
  throw new OperatorClientError(
    'This platform does not support AI logging policies. Run `void platform upgrade`.',
    'unsupported',
  );
}
