import {
  cloneFormValue,
  isEqualFormValue,
  submitIslandAction,
  type IslandFormState,
  type VoidActionError,
} from 'void/pages-client';
import type { RouteUrl } from 'void/routes';

export type IslandFormReturn<T extends Record<string, unknown>> = IslandFormState<T, 'in-place'> &
  Readonly<{ submit(url: RouteUrl, method: string): Promise<void> }>;

/**
 * Form composable for island pages. Uses fetch + page reload instead of the
 * Void Router (which is not available in island mode).
 */
export function useIslandForm<T extends Record<string, unknown>>(defaults: T): IslandFormReturn<T> {
  let data: T = $state({ ...defaults });
  let errors: Record<string, string> = $state({});
  let error: VoidActionError | null = $state(null);
  let pending = $state(false);
  let wasSuccessful = $state(false);
  let recentlySuccessful = $state(false);

  let defaults_ = { ...defaults };
  let successTimeout: ReturnType<typeof setTimeout> | null = null;
  let latestRequestId = 0;

  const hasChanges = $derived(
    Object.keys(defaults_).some((key) => !isEqualFormValue(data[key], defaults_[key])),
  );

  function reset(...fields: ReadonlyArray<keyof T & string>) {
    if (fields.length === 0) {
      data = { ...defaults_ };
    } else {
      for (const field of fields) {
        data[field] = defaults_[field];
      }
    }
  }

  function clearErrors(...fields: ReadonlyArray<string>) {
    if (fields.length === 0) {
      errors = {};
    } else {
      for (const field of fields) {
        delete errors[field];
      }
    }
  }

  function clearError() {
    error = null;
  }

  async function submit(url: RouteUrl, method: string) {
    const requestId = ++latestRequestId;
    // Edits made while this request is in flight stay unsaved.
    const submittedData = cloneFormValue(data);
    pending = true;
    wasSuccessful = false;
    recentlySuccessful = false;
    if (successTimeout) {
      clearTimeout(successTimeout);
    }
    clearErrors();
    clearError();

    try {
      const result = await submitIslandAction(url, method, submittedData);
      // A newer submit owns the form's state and decides whether the page changes.
      if (requestId !== latestRequestId) {
        return;
      }

      if (result.kind === 'redirect') {
        window.location.href = result.url;
        return;
      }

      if (result.kind === 'success') {
        wasSuccessful = true;
        recentlySuccessful = true;
        defaults_ = submittedData;
        successTimeout = setTimeout(() => {
          recentlySuccessful = false;
        }, 2000);
        window.location.reload();
      } else if (result.kind === 'validation') {
        Object.assign(errors, result.errors);
      } else {
        error = result.error;
      }
    } finally {
      if (requestId === latestRequestId) {
        pending = false;
      }
    }
  }

  return {
    get data() {
      return data;
    },
    get errors() {
      return errors;
    },
    get error() {
      return error;
    },
    get pending() {
      return pending;
    },
    get hasChanges() {
      return hasChanges;
    },
    get wasSuccessful() {
      return wasSuccessful;
    },
    get recentlySuccessful() {
      return recentlySuccessful;
    },
    submit,
    reset,
    clearErrors,
    clearError,
    post: (url: RouteUrl) => submit(url, 'POST'),
    put: (url: RouteUrl) => submit(url, 'PUT'),
    patch: (url: RouteUrl) => submit(url, 'PATCH'),
    delete: (url: RouteUrl) => submit(url, 'DELETE'),
  };
}
