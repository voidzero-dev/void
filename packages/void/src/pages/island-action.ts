import {
  categorizeActionError,
  createActionErrorFromResponse,
  type VoidActionError,
} from './action-result.ts';
import { getValidationErrors } from './adapter-helpers.ts';
import { fetchPages } from './redirect.ts';

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
  const { response, redirectedTo } = await fetchPages(
    url,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    },
    false,
  );

  if (redirectedTo) {
    return { kind: 'redirect', url: redirectedTo };
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
