import { createElement } from 'react';

export function parseUtcDate(iso: string): Date {
  const normalized = iso.replace(' ', 'T');
  return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`);
}

export function formatAbsoluteDate(iso: string): string {
  return parseUtcDate(iso).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(iso: string, tz?: string) {
  const d = parseUtcDate(iso);
  if (isNaN(d.getTime())) {
    return createElement('span', { suppressHydrationWarning: true }, iso);
  }
  const formatted = d.toLocaleString('en-US', {
    timeZone: tz || 'UTC',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  let ago: string;
  if (seconds < 60) {
    ago = `${seconds}s ago`;
  } else if (seconds < 3600) {
    ago = `${Math.floor(seconds / 60)}m ago`;
  } else if (seconds < 86400) {
    ago = `${Math.floor(seconds / 3600)}h ago`;
  } else {
    ago = `${Math.floor(seconds / 86400)}d ago`;
  }
  // The relative age may tick between SSR and hydration. Preserve the server
  // text until the next React render without treating that tick as a mismatch.
  return createElement(
    'span',
    { className: 'void-admin-date-time', suppressHydrationWarning: true },
    `${formatted} (${ago})`,
  );
}

export function formatBytes(n: number): string {
  if (n === 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  const value = n / Math.pow(1024, i);
  return `${value % 1 === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatLimit(value: number, unit?: string): string {
  if (value === 0) {
    return 'Unlimited';
  }
  if (unit === 'bytes') {
    return formatBytes(value);
  }
  return formatNumber(value);
}

export const STATUS_COLORS: Record<string, string> = {
  success: '#16a34a',
  failed: '#dc2626',
  pending: '#d97706',
  skipped: '#6b7280',
};

type AiLoggingStatusDisplay = Readonly<{
  effective: string;
  source: string;
  planId: string;
  planKnown: boolean;
  planMode: string | null;
  defaultPlanId: string;
  published: string | null;
  publishedAt: string | null;
  state: string;
}>;

/** `14:03:20 UTC`, two minutes after the publish time, or null when it is not a time. */
function expectedBy(publishedAt: string | null): string | null {
  const time = publishedAt === null ? Number.NaN : Date.parse(publishedAt);
  return Number.isNaN(time) ? null : `${new Date(time + 120_000).toISOString().slice(11, 19)} UTC`;
}

const aiLoggingStates: Record<string, (status: AiLoggingStatusDisplay) => string> = {
  applied: () => 'applied',
  pending: (status) => {
    const by = expectedBy(status.publishedAt);
    return by ? `pending (expected by ${by})` : 'pending (normally within 2 minutes)';
  },
  pending_plan_publish: () => 'pending (the plan default is still being published)',
  drift: (status) => `drift (published: ${status.published ?? 'unknown value'})`,
  unknown: () => 'state unknown (the published setting could not be read)',
};

/**
 * `metadata (from plan "pro") — applied`. Keep the wording in step with `project show`
 * (`aiLoggingStatusLine` in packages/void/src/cli/operator-ai-logging.ts).
 */
export function formatAiLoggingStatus(status: AiLoggingStatusDisplay | null): string {
  if (!status) {
    return '—';
  }
  const plan = status.planKnown
    ? `plan "${status.planId}"`
    : `plan "${status.planId}" (not in catalog; uses default plan "${status.defaultPlanId}")`;
  const planDefault = `${plan} default: ${status.planMode ?? 'inherit'}`;
  const source =
    status.source === 'project'
      ? `set on project; ${planDefault}`
      : status.source === 'plan'
        ? `from ${plan}`
        : `AI Gateway setting; ${planDefault}`;
  const state = Object.hasOwn(aiLoggingStates, status.state)
    ? aiLoggingStates[status.state]!(status)
    : status.state;
  return `${status.effective} (${source}) — ${state}`;
}
