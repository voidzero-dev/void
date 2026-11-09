import { createSignal, createMemo } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import {
  cloneFormValue,
  isEqualFormValue,
  submitIslandAction,
  type IslandFormState,
  type VoidActionError,
} from 'void/pages-client';
import type { RouteUrl } from 'void/routes';

export type IslandFormReturn<T extends Record<string, unknown>> = IslandFormState<T, 'setters'> &
  Readonly<{ setData: <K extends keyof T & string>(field: K, value: T[K]) => void }>;

/**
 * Form composable for island pages. Uses fetch + page reload instead of the
 * Void Router (which is not available in island mode).
 */
export function useIslandForm<T extends Record<string, unknown>>(defaults: T): IslandFormReturn<T> {
  const [data, setDataStore] = createStore<Record<string, unknown>>({ ...defaults });
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const [error, setError] = createSignal<VoidActionError | null>(null);
  const [pending, setPending] = createSignal(false);
  const [wasSuccessful, setWasSuccessful] = createSignal(false);
  const [recentlySuccessful, setRecentlySuccessful] = createSignal(false);

  let defaults_ = { ...defaults };
  let successTimeout: ReturnType<typeof setTimeout> | null = null;
  let latestRequestId = 0;

  const hasChanges = createMemo(() => {
    return Object.keys(defaults_).some((key) => !isEqualFormValue(data[key], defaults_[key]));
  });

  function setData(field: string, value: unknown) {
    setDataStore(field, value);
  }

  function reset(...fields: ReadonlyArray<string>) {
    if (fields.length === 0) {
      setDataStore(reconcile({ ...defaults_ }));
    } else {
      for (const field of fields) {
        setDataStore(field, defaults_[field]);
      }
    }
  }

  function clearErrors(...fields: ReadonlyArray<string>) {
    if (fields.length === 0) {
      setErrors({});
    } else {
      setErrors((prev) => {
        const next = { ...prev };
        for (const field of fields) {
          delete next[field];
        }
        return next;
      });
    }
  }

  function clearError() {
    setError(null);
  }

  async function submit(url: string, method: string) {
    const requestId = ++latestRequestId;
    // Edits made while this request is in flight stay unsaved.
    const submittedData = cloneFormValue(data);
    setPending(true);
    setWasSuccessful(false);
    setRecentlySuccessful(false);
    if (successTimeout) {
      clearTimeout(successTimeout);
    }
    setErrors({});
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
        setWasSuccessful(true);
        setRecentlySuccessful(true);
        defaults_ = submittedData as typeof defaults_;
        successTimeout = setTimeout(() => setRecentlySuccessful(false), 2000);
        window.location.reload();
      } else if (result.kind === 'validation') {
        setErrors(result.errors);
      } else {
        setError(result.error);
      }
    } finally {
      if (requestId === latestRequestId) {
        setPending(false);
      }
    }
  }

  return {
    get data() {
      return data as T;
    },
    setData: setData as IslandFormReturn<T>['setData'],
    get errors() {
      return errors();
    },
    get error() {
      return error();
    },
    get pending() {
      return pending();
    },
    get hasChanges() {
      return hasChanges();
    },
    get wasSuccessful() {
      return wasSuccessful();
    },
    get recentlySuccessful() {
      return recentlySuccessful();
    },
    reset,
    clearErrors,
    clearError,
    post: (url: RouteUrl) => submit(url, 'POST'),
    put: (url: RouteUrl) => submit(url, 'PUT'),
    patch: (url: RouteUrl) => submit(url, 'PATCH'),
    delete: (url: RouteUrl) => submit(url, 'DELETE'),
  };
}
