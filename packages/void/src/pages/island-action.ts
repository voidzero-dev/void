import {
  categorizeActionError,
  createActionErrorFromResponse,
  type VoidActionError,
} from './action-result.ts';
import { getValidationErrors } from './adapter-helpers.ts';

export type IslandActionResult =
  | { kind: 'redirect'; url: string }
  | { kind: 'success' }
  | { kind: 'validation'; errors: Record<string, string> }
  | { kind: 'error'; error: VoidActionError };

export async function submitIslandAction(
  url: string,
  method: string,
  data: Record<string, unknown>,
): Promise<IslandActionResult> {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (response.redirected) {
    return { kind: 'redirect', url: response.url };
  }
  if (response.ok) {
    return { kind: 'success' };
  }

  const error = await createActionErrorFromResponse(response, url);
  const errors = response.status === 422 ? getValidationErrors(error.body) : null;
  if (errors) {
    return { kind: 'validation', errors };
  }
  if (categorizeActionError(response.status) === 'boundary') {
    throw error;
  }
  return { kind: 'error', error };
}
