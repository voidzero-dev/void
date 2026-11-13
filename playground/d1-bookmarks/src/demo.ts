export type Variant = 'without-bookmark' | 'with-bookmark';
export type Experiment = 'redirect' | 'immediate';

export function experimentForQuery(value: string | undefined): Experiment {
  return value === 'immediate' ? 'immediate' : 'redirect';
}

export function experimentLabel(experiment: Experiment): string {
  return experiment === 'immediate' ? 'Immediate server read' : 'Browser redirect (cookie)';
}

export const PRESSURE_OPTIONS = [0.25, 0.5, 1, 2] as const;
export const DEFAULT_PRESSURE_MIB = 0.25;
export const RUN_COUNTS = [20, 50, 100, 200, 500] as const;

export function pressureLabel(size: number): string {
  return size < 1 ? `${size * 1024} KiB` : `${size} MiB`;
}

export function pressureMiBForQuery(value: string | undefined): number {
  const size = Number(value);
  return PRESSURE_OPTIONS.some((option) => option === size) ? size : 0;
}

export type Observation = {
  experiment: Experiment;
  pressureMiB: number;
  variant: Variant;
  expected: string | null;
  observed: string | null;
  savedAt: string | null;
  outcome: 'idle' | 'fresh' | 'stale' | 'errored';
  incomingBookmark: string | null;
  writeBookmark: string | null;
  outgoingBookmark: string | null;
  servedByPrimary: boolean | null;
  servedByRegion: string | null;
  workerColo: string | null;
  metadata?: Record<string, unknown>;
  elapsedMs?: number;
  error?: TrialError;
};

export type TrialError = {
  phase: 'save' | 'read' | 'request' | 'probe';
  status: number | null;
  requestId: string | null;
  causes: Array<{ name: string; message: string; stack: string | null }>;
};

export type RoutingProbe = {
  path: 'void-run';
  workerColo: string | null;
  elapsedMs: number;
  metadata: Record<string, unknown> | null;
  rows: unknown[];
  bookmark: string | null;
  error?: TrialError;
};

export function serializeError(cause: unknown): TrialError['causes'] {
  const errors: TrialError['causes'] = [];
  for (let depth = 0; cause !== undefined && depth < 5; depth++) {
    errors.push(
      cause instanceof Error
        ? { name: cause.name, message: cause.message, stack: cause.stack ?? null }
        : { name: 'Cause', message: String(cause), stack: null },
    );
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return errors;
}

export function errorObservation(
  variant: Variant,
  pressureMiB: number,
  error: TrialError,
  expected: string | null = null,
  experiment: Experiment = 'redirect',
): Observation {
  return {
    experiment,
    variant,
    pressureMiB,
    outcome: 'errored',
    expected,
    observed: null,
    savedAt: null,
    incomingBookmark: null,
    writeBookmark: null,
    outgoingBookmark: null,
    servedByPrimary: null,
    servedByRegion: null,
    workerColo: null,
    error,
  };
}

export const BOOKMARK_COOKIE = 'd1-demo-bookmark';
export const VISITOR_COOKIE = 'd1-demo-visitor';

export function variantForPath(path: string): Variant | null {
  if (path === '/with-bookmark' || path === '/api/with-bookmark') {
    return 'with-bookmark';
  }
  if (path === '/without-bookmark' || path === '/api/without-bookmark') {
    return 'without-bookmark';
  }
  return null;
}
