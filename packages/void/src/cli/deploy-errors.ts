import {
  DEPLOY_POST_ATTEMPTS,
  isCliOutdatedError,
  isHeadersTimeoutError,
  parsePlatformErrorBody,
  PlatformApiError,
} from './client.ts';
import { platformErrorMessage } from './platform-errors.ts';

const BODY_SNIPPET_MAX = 200;

function trimSnippet(body: string): string {
  const collapsed = body.replaceAll(/\s+/g, ' ').trim();
  if (collapsed.length <= BODY_SNIPPET_MAX) {
    return collapsed;
  }
  return `${collapsed.slice(0, BODY_SNIPPET_MAX)}...`;
}

function appendDeploymentLine(message: string, deploymentId: string | null): string {
  return deploymentId ? `${message}\nDeployment: ${deploymentId}` : message;
}

function appendLogLine(message: string, logPath: string | null | undefined): string {
  return logPath ? `${message}\nDetailed log: ${logPath}` : message;
}

function appendTrailingLines(
  message: string,
  deploymentId: string | null,
  logPath: string | null | undefined,
): string {
  return appendLogLine(appendDeploymentLine(message, deploymentId), logPath);
}

/**
 * Describe the deepest `cause` of an error in one short line, e.g.
 * `getaddrinfo ENOTFOUND api.example.com` under `fetch failed`.
 */
function describeRootCause(err: Error): string | null {
  let root: unknown = err;
  for (let depth = 0; depth < 6; depth++) {
    const cause = (root as { cause?: unknown }).cause;
    if (cause === null || typeof cause !== 'object') {
      break;
    }
    root = cause;
  }
  if (root === err) {
    return null;
  }
  const { code, message } = root as { code?: unknown; message?: unknown };
  const text = typeof message === 'string' ? message.trim() : '';
  const codeText = typeof code === 'string' ? code : '';
  if (!text) {
    return codeText || null;
  }
  return codeText && !text.includes(codeText) ? `${codeText}: ${text}` : text;
}

/**
 * Format a server-emitted `event: 'error'` payload with an optional deployment id.
 */
export function formatDeployFailureMessage(
  message: string,
  deploymentId: string | null,
  logPath?: string | null,
): string {
  return appendTrailingLines(message, deploymentId, logPath);
}

/**
 * Format the "stream ended cleanly but no terminal event arrived" case.
 *
 * This is the only call site that should emit the bare "Connection lost during
 * deploy" message — the server closed the NDJSON stream without emitting
 * `done` or `error`, so there is no underlying error to carry.
 */
export function formatConnectionLostMessage(
  deploymentId: string | null,
  logPath?: string | null,
): string {
  return appendTrailingLines('deploy: Connection lost during deploy.', deploymentId, logPath);
}

/**
 * Convert an exception thrown during the deploy NDJSON stream into a
 * user-facing `Error` with a readable message.
 *
 * Four cases:
 *   1. `PlatformApiError` with 409 + a JSON body carrying `{error, deployment}`
 *      — surface the server-supplied error and prefer the body's deployment id.
 *   2. Any other `PlatformApiError` — retain the client's actionable message and
 *      structured error fields; opaque provider failures use a trimmed body snippet.
 *   3. A headers timeout on the last deploy POST attempt — the platform sent
 *      no response in time. Explain that the deploy may still finish and how
 *      to check and retry.
 *   4. Anything else — preserve the original message, plus its root cause when
 *      there is one, under a `Connection lost during deploy: <original>`
 *      prefix so the caller can still tell network, parse, and transport
 *      errors apart.
 */
export function formatStreamDeployError(
  err: unknown,
  deploymentId: string | null,
  logPath?: string | null,
): Error {
  if (err instanceof PlatformApiError) {
    const parsed = parsePlatformErrorBody(err.body);
    const parsedError = platformErrorMessage(parsed) ?? parsed?.error ?? null;
    const parsedDeployment = parsed?.deployment ?? null;
    const effectiveDeploymentId = parsedDeployment ?? deploymentId;

    // cli_outdated: surface the platform's upgrade message verbatim with
    // no "Deploy failed (HTTP 426)" wrapper. The message already includes
    // `npm i -g void@latest`, so adding a status prefix would only obscure
    // the actionable line.
    if (isCliOutdatedError(err) && parsed?.message) {
      err.message = appendTrailingLines(err.message, effectiveDeploymentId, logPath);
      return err;
    }

    if (parsedError || err.status === 401 || err.status === 403 || parsed !== null) {
      err.message = appendTrailingLines(`deploy: ${err.message}`, effectiveDeploymentId, logPath);
      return err;
    }

    const detail = trimSnippet(err.body);
    const base = detail
      ? `deploy: Deploy failed (HTTP ${err.status}): ${detail}`
      : `deploy: Deploy failed (HTTP ${err.status}).`;
    err.message = appendTrailingLines(base, effectiveDeploymentId, logPath);
    return err;
  }

  if (isHeadersTimeoutError(err)) {
    const lines = [
      `deploy: The Void platform did not respond while preparing the deploy. Tried ${DEPLOY_POST_ATTEMPTS} times; the last try waited 5 minutes.`,
      'It may still finish. Check `void project status`, then run `void deploy` again to retry.',
    ];
    if (logPath) {
      lines.push('If this keeps happening, share the detailed log below.');
    }
    return new Error(appendTrailingLines(lines.join('\n'), deploymentId, logPath));
  }

  const original = err instanceof Error ? err.message : String(err);
  const rootCause = err instanceof Error ? describeRootCause(err) : null;
  const detail = rootCause && rootCause !== original ? ` (${rootCause})` : '';
  return new Error(
    appendTrailingLines(
      `deploy: Connection lost during deploy: '${original}'${detail}.`,
      deploymentId,
      logPath,
    ),
  );
}
