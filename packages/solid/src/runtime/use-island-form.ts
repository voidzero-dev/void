import { createSignal, createMemo } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { isEqualFormValue, submitIslandAction, type VoidActionError } from 'void/pages-client';

export type IslandFormReturn<T extends Record<string, unknown>> = Readonly<{
  data: T;
  setData: <K extends keyof T & string>(field: K, value: T[K]) => void;
  errors: Record<string, string>;
  error: VoidActionError | null;
  pending: boolean;
  hasChanges: boolean;
  wasSuccessful: boolean;
  recentlySuccessful: boolean;
  reset: (...fields: ReadonlyArray<keyof T & string>) => void;
  clearErrors: (...fields: ReadonlyArray<string>) => void;
  clearError: () => void;
  post: (url: string) => Promise<void>;
  put: (url: string) => Promise<void>;
  patch: (url: string) => Promise<void>;
  delete: (url: string) => Promise<void>;
}>;

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
    setPending(true);
    setWasSuccessful(false);
    setRecentlySuccessful(false);
    if (successTimeout) {
      clearTimeout(successTimeout);
    }
    setErrors({});
    clearError();

    try {
      const result = await submitIslandAction(url, method, data);

      if (result.kind === 'redirect') {
        window.location.href = result.url;
        return;
      }

      if (result.kind === 'success') {
        setWasSuccessful(true);
        setRecentlySuccessful(true);
        defaults_ = { ...data } as typeof defaults_;
        successTimeout = setTimeout(() => setRecentlySuccessful(false), 2000);
        window.location.reload();
      } else if (result.kind === 'validation') {
        setErrors(result.errors);
      } else {
        setError(result.error);
      }
    } finally {
      setPending(false);
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
    post: (url: string) => submit(url, 'POST'),
    put: (url: string) => submit(url, 'PUT'),
    patch: (url: string) => submit(url, 'PATCH'),
    delete: (url: string) => submit(url, 'DELETE'),
  };
}
