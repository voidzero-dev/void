import type { ApiEnv } from '../env.ts';
import { GITHUB_API_BASE, GITHUB_API_VERSION, getInstallationToken } from './installation-token.ts';

/**
 * GitHub Check Run helper. Both functions are BEST-EFFORT and NEVER throw: a
 * failed check-run write must not fail (or even perturb) the build it reports
 * on. They catch network errors, retry only transient failures (5xx / network /
 * token-mint), do NOT retry definitive 4xx (sole exception: a complete PATCH
 * 422-rejected over its `output.text` is retried once without the text — see
 * `completeCheckRun`), log every failure via the shared `area:'github'` warn
 * shape, and return `null` (create) / `false` (complete) on permanent failure.
 *
 * Uses the App's existing `Checks: Write` permission — the only GitHub calls are
 * POST/PATCH `/repos/{repoFullName}/check-runs[/{id}]`. The module is
 * executor-agnostic (plain args only) so both build executors can call it.
 */

// GitHub's full terminal set. The container path uses success/failure/cancelled
// and the Actions path maps `workflow_run.conclusion === 'timed_out'` faithfully.
//
// The rest exist so a REFUSED rerun can echo a run's EXISTING conclusion back
// verbatim. That matters for more than tidiness: GitHub treats `neutral` and
// `skipped` as passing for a required status check, so completing a run we did
// not actually run with a passing conclusion would let anyone with rerun rights
// clear branch protection on a commit that never built. A refusal therefore
// re-states what the run already said, and only an authoritatively complete and
// live build is allowed to write `success`.
export type CheckRunConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'timed_out'
  | 'neutral'
  | 'skipped'
  | 'action_required'
  | 'stale';

/**
 * The conclusions an INTEGRATION may write. `stale` is observable on a run but
 * GitHub rejects it on update, so echoing one back would 422 every time and leave
 * the rerequest unresolved. It maps to `cancelled` below: non-passing, writable,
 * and honest about a rerun that did not run.
 */
const WRITABLE_CONCLUSIONS: ReadonlyArray<CheckRunConclusion> = [
  'success',
  'failure',
  'cancelled',
  'timed_out',
  'neutral',
  'skipped',
  'action_required',
];

/**
 * The conclusion a REFUSED rerun should write: whatever the run already had, as
 * long as we are allowed to write it. `cancelled` otherwise — for a run that had
 * no conclusion (it was still running, so it was never passing) and for `stale`
 * (observable, not writable). Never invents a passing conclusion, which would be
 * a branch-protection bypass.
 */
export function preservedCheckRunConclusion(raw: unknown): CheckRunConclusion {
  return typeof raw === 'string' && (WRITABLE_CONCLUSIONS as ReadonlyArray<string>).includes(raw)
    ? (raw as CheckRunConclusion)
    : 'cancelled';
}

/**
 * The single check-run name both executors publish under, and the name the
 * `check_run:rerequested` webhook matches on to recognize its own run.
 *
 * Shared rather than repeated: GitHub identifies a re-run request only by the
 * run's name + repo + head SHA, so a rename in one producer and not the other
 * would silently make the "Re-run" button a no-op for that executor.
 */
export const VOID_BUILD_CHECK_RUN_NAME = 'Void Build';

// Same retry shape as `getBranchHeadComparisonStatus` (compare): up to 2 extra
// attempts with a short fixed delay on transient 5xx/network/token-mint. A 4xx
// is definitive and returns immediately.
const CHECK_RUN_RETRY_ATTEMPTS = 2;
const CHECK_RUN_RETRY_DELAY_MS = 250;

type CheckRunCreateResponse = Readonly<{ id?: number | string }>;

type FailureReason =
  | 'token-mint-failed'
  | 'network-error'
  | 'http-4xx'
  | 'http-5xx'
  | 'text-rejected-retry'
  | 'exhausted';

function errInfo(err: unknown) {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { message: String(err) };
}

// area:'github' distinguishes from the deploy-pipeline logger (area:'deploy').
// `phase` differentiates create vs complete.
function logFailure(
  phase: 'check-run-create' | 'check-run-complete',
  reason: FailureReason,
  fields: Record<string, unknown>,
): void {
  try {
    console.warn(
      JSON.stringify({
        ts: Date.now(),
        lvl: 'warn',
        area: 'github',
        phase,
        reason,
        msg: `${phase} failed: ${reason}`,
        ...fields,
      }),
    );
  } catch {
    console.warn(`${phase} failed: ${reason}`);
  }
}

/**
 * POST `/repos/{repoFullName}/check-runs` to create an `in_progress` check run.
 * Returns the numeric check-run id as a string, or `null` on permanent failure.
 *
 * The build is already past the queue when this is called, so the run starts
 * `in_progress` (never `queued`). `external_id = buildId` is a reference/audit
 * field, NOT a GitHub idempotency key — `POST /check-runs` creates a NEW run on
 * every call. So this create POST is SINGLE-SHOT: it is never retried on a 5xx or
 * network failure (an ambiguous failure where GitHub created the run but the
 * response was lost would otherwise duplicate it and orphan the first
 * `in_progress`). Only the pre-POST token mint is retried. Dedup across requeues /
 * webhook redeliveries is handled by the caller's reuse gate (DO storage /
 * `builds.check_run_id`).
 */
export async function createCheckRun(
  env: ApiEnv['Bindings'],
  installationId: string,
  repoFullName: string,
  opts: {
    name: string;
    headSha: string;
    externalId: string;
    detailsUrl?: string;
    title: string;
    summary: string;
  },
): Promise<string | null> {
  const body = JSON.stringify({
    name: opts.name,
    head_sha: opts.headSha,
    status: 'in_progress',
    external_id: opts.externalId,
    ...(opts.detailsUrl ? { details_url: opts.detailsUrl } : {}),
    output: { title: opts.title, summary: opts.summary },
  });

  for (let attempt = 0; attempt <= CHECK_RUN_RETRY_ATTEMPTS; attempt++) {
    let token: string;
    try {
      token = await getInstallationToken(env, installationId);
    } catch (err) {
      logFailure('check-run-create', 'token-mint-failed', {
        installationId,
        repoFullName,
        headSha: opts.headSha,
        externalId: opts.externalId,
        attempt,
        err: errInfo(err),
      });
      if (attempt < CHECK_RUN_RETRY_ATTEMPTS) {
        await new Promise((r) => {
          setTimeout(r, CHECK_RUN_RETRY_DELAY_MS);
        });
      }
      continue;
    }
    try {
      const res = await fetch(`${GITHUB_API_BASE}/repos/${repoFullName}/check-runs`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'void-api',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
        },
        body,
      });
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as CheckRunCreateResponse;
        if (data.id === undefined || data.id === null) {
          // 2xx without a usable id — definitive (not worth retrying), but the
          // run can't be tracked, so report null.
          logFailure('check-run-create', 'http-4xx', {
            installationId,
            repoFullName,
            externalId: opts.externalId,
            attempt,
            status: res.status,
            body: 'missing id in response',
          });
          return null;
        }
        return String(data.id);
      }
      // Never retry the POST (not idempotent — see the function doc).
      const errBody = (await res.text().catch(() => '<unreadable>')).slice(0, 500);
      logFailure('check-run-create', res.status < 500 ? 'http-4xx' : 'http-5xx', {
        installationId,
        repoFullName,
        externalId: opts.externalId,
        attempt,
        status: res.status,
        statusText: res.statusText,
        body: errBody,
      });
      return null;
    } catch (err) {
      logFailure('check-run-create', 'network-error', {
        installationId,
        repoFullName,
        externalId: opts.externalId,
        attempt,
        err: errInfo(err),
      });
      return null;
    }
  }
  logFailure('check-run-create', 'exhausted', {
    installationId,
    repoFullName,
    externalId: opts.externalId,
    attempts: CHECK_RUN_RETRY_ATTEMPTS + 1,
  });
  return null;
}

/**
 * PATCH `/repos/{repoFullName}/check-runs/{checkRunId}` to mark a check run
 * `completed` with a terminal `conclusion`. An optional markdown `text` is
 * sent as `output.text` when provided (GitHub validates it at 65535 UTF-8
 * BYTES; callers are responsible for staying under that). Returns `true` on
 * `res.ok`, or `false` on permanent failure. Best-effort — never throws.
 *
 * One exception to "4xx is definitive": a 422 on a body that included
 * `output.text` is retried ONCE with the identical body minus the text.
 * GitHub validates `text` server-side (bytesize, plus content checks beyond
 * size that raw build logs can trip), and the complete PATCH is idempotent
 * (unlike the single-shot create POST) — the tail is best-effort and must
 * never cost the completion itself. The fallback attempt then follows the
 * normal non-ok handling if it also fails.
 */
export async function completeCheckRun(
  env: ApiEnv['Bindings'],
  installationId: string,
  repoFullName: string,
  checkRunId: string,
  opts: {
    conclusion: CheckRunConclusion;
    detailsUrl?: string;
    title: string;
    summary: string;
    text?: string;
  },
): Promise<boolean> {
  // Cleared by the one-shot 422 fallback below, which rebuilds `body` without
  // `output.text`.
  let includeText = Boolean(opts.text);
  const makeBody = (): string =>
    JSON.stringify({
      status: 'completed',
      conclusion: opts.conclusion,
      ...(opts.detailsUrl ? { details_url: opts.detailsUrl } : {}),
      output: {
        title: opts.title,
        summary: opts.summary,
        ...(includeText ? { text: opts.text } : {}),
      },
    });
  let body = makeBody();

  for (let attempt = 0; attempt <= CHECK_RUN_RETRY_ATTEMPTS; attempt++) {
    let token: string;
    try {
      token = await getInstallationToken(env, installationId);
    } catch (err) {
      logFailure('check-run-complete', 'token-mint-failed', {
        installationId,
        repoFullName,
        checkRunId,
        conclusion: opts.conclusion,
        attempt,
        err: errInfo(err),
      });
      if (attempt < CHECK_RUN_RETRY_ATTEMPTS) {
        await new Promise((r) => {
          setTimeout(r, CHECK_RUN_RETRY_DELAY_MS);
        });
      }
      continue;
    }
    try {
      const res = await fetch(
        `${GITHUB_API_BASE}/repos/${repoFullName}/check-runs/${encodeURIComponent(checkRunId)}`,
        {
          method: 'PATCH',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'void-api',
            'X-GitHub-Api-Version': GITHUB_API_VERSION,
          },
          body,
        },
      );
      if (res.ok) {
        return true;
      }
      const errBody = (await res.text().catch(() => '<unreadable>')).slice(0, 500);
      if (res.status < 500) {
        if (res.status === 422 && includeText) {
          // `includeText` gates this to a single fire, and `attempt` is rewound
          // so the fallback body gets a full attempt even when the 422 landed
          // on the last one.
          logFailure('check-run-complete', 'text-rejected-retry', {
            installationId,
            repoFullName,
            checkRunId,
            conclusion: opts.conclusion,
            attempt,
            status: res.status,
            statusText: res.statusText,
            body: errBody,
          });
          includeText = false;
          body = makeBody();
          attempt -= 1;
          continue;
        }
        logFailure('check-run-complete', 'http-4xx', {
          installationId,
          repoFullName,
          checkRunId,
          conclusion: opts.conclusion,
          attempt,
          status: res.status,
          statusText: res.statusText,
          body: errBody,
        });
        return false;
      }
      logFailure('check-run-complete', 'http-5xx', {
        installationId,
        repoFullName,
        checkRunId,
        conclusion: opts.conclusion,
        attempt,
        status: res.status,
        body: errBody,
      });
    } catch (err) {
      logFailure('check-run-complete', 'network-error', {
        installationId,
        repoFullName,
        checkRunId,
        conclusion: opts.conclusion,
        attempt,
        err: errInfo(err),
      });
    }
    if (attempt < CHECK_RUN_RETRY_ATTEMPTS) {
      await new Promise((r) => {
        setTimeout(r, CHECK_RUN_RETRY_DELAY_MS);
      });
    }
  }
  logFailure('check-run-complete', 'exhausted', {
    installationId,
    repoFullName,
    checkRunId,
    conclusion: opts.conclusion,
    attempts: CHECK_RUN_RETRY_ATTEMPTS + 1,
  });
  return false;
}
