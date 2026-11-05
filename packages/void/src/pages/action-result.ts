import { readUsageLimit, type UsageLimitData } from '@void/edge';
import type { PageObject } from './protocol.ts';

export type ActionErrorHandlingScope = 'callSite' | 'boundary';

export type ActionResult<T = PageObject | undefined> =
  | { ok: true; pageData: T }
  | { ok: false; error: VoidActionError };

export class VoidActionError extends Error {
  readonly body: unknown;
  readonly limit: UsageLimitData | null;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;

  constructor({
    body,
    message,
    status,
    statusText,
    url,
  }: {
    body: unknown;
    message?: string;
    status: number;
    statusText: string;
    url: string;
  }) {
    const limit = status === 429 ? readUsageLimit(body) : null;
    super(
      message ??
        limit?.message ??
        (statusText
          ? `Action failed with ${status} ${statusText}`
          : `Action failed with ${status}`),
    );
    this.name = 'VoidActionError';
    this.body = body;
    this.limit = limit;
    this.status = status;
    this.statusText = statusText;
    this.url = url;
  }
}

export function categorizeActionError(status: number): ActionErrorHandlingScope {
  switch (status) {
    case 400:
    case 402:
    case 404:
    case 408:
    case 409:
    case 412:
    case 413:
    case 415:
    case 422:
    case 429:
    case 499:
      return 'callSite';

    case 401:
    case 403:
    case 405:
    case 428:
    case 500:
    case 501:
    case 502:
    case 503:
    case 504:
    default:
      return 'boundary';
  }
}

// Checks the name, not `instanceof`: an app can bundle more than one copy of this class.
export function isVoidActionError(error: unknown): error is VoidActionError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'VoidActionError' &&
    'status' in error &&
    typeof error.status === 'number'
  );
}

export function isCallSiteActionError(error: unknown): error is VoidActionError {
  return isVoidActionError(error) && categorizeActionError(error.status) === 'callSite';
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

async function readActionErrorBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || '';
  try {
    if (contentType.includes('application/json')) {
      return await response.json();
    }
    const text = await response.text();
    return text || null;
  } catch {
    return null;
  }
}

function readActionErrorMessage(response: Response, body: unknown): string | undefined {
  if (response.status < 400 || response.status >= 500) {
    return undefined;
  }
  if (!response.headers.get('content-type')?.includes('text/plain')) {
    return undefined;
  }
  return typeof body === 'string' && body.trim() ? body : undefined;
}

export async function createActionErrorFromResponse(
  response: Response,
  url: string,
): Promise<VoidActionError> {
  const body = await readActionErrorBody(response);
  return new VoidActionError({
    body,
    message: readActionErrorMessage(response, body),
    status: response.status,
    statusText: response.statusText,
    url,
  });
}
