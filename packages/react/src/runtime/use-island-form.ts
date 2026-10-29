import { useState, useRef, useCallback, useMemo } from 'react';
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
 * Form hook for island pages. Uses fetch + page reload instead of the
 * Void Router (which is not available in island mode).
 */
export function useIslandForm<T extends Record<string, unknown>>(defaults: T): IslandFormReturn<T> {
  const [data, setDataState] = useState<T>(() => ({ ...defaults }));
  const [defaultsState, setDefaultsState] = useState<T>(() => ({ ...defaults }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<VoidActionError | null>(null);
  const [pending, setPending] = useState(false);
  const [wasSuccessful, setWasSuccessful] = useState(false);
  const [recentlySuccessful, setRecentlySuccessful] = useState(false);
  const defaultsRef = useRef(defaultsState);
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasChanges = useMemo(() => {
    return Object.keys(defaultsState).some(
      (key) => !isEqualFormValue(data[key], defaultsState[key as keyof T]),
    );
  }, [data, defaultsState]);

  const setData = useCallback(<K extends keyof T & string>(field: K, value: T[K]) => {
    setDataState((prev) => ({ ...prev, [field]: value }));
  }, []);

  const reset = useCallback((...fields: ReadonlyArray<keyof T & string>) => {
    if (fields.length === 0) {
      setDataState({ ...defaultsRef.current } as T);
    } else {
      setDataState((prev) => {
        const next = { ...prev };
        for (const field of fields) {
          next[field] = defaultsRef.current[field] as T[typeof field];
        }
        return next;
      });
    }
  }, []);

  const clearErrors = useCallback((...fields: ReadonlyArray<string>) => {
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
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const submit = useCallback(
    async (url: string, method: string) => {
      setPending(true);
      setWasSuccessful(false);
      setRecentlySuccessful(false);
      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current);
      }
      setErrors({});
      setError(null);

      try {
        const result = await submitIslandAction(url, method, data);

        if (result.kind === 'redirect') {
          window.location.href = result.url;
          return;
        }

        if (result.kind === 'success') {
          setWasSuccessful(true);
          setRecentlySuccessful(true);
          const nextDefaults = { ...data };
          defaultsRef.current = nextDefaults;
          setDefaultsState(nextDefaults);
          successTimeoutRef.current = setTimeout(() => setRecentlySuccessful(false), 2000);
          window.location.reload();
        } else if (result.kind === 'validation') {
          setErrors(result.errors);
        } else {
          setError(result.error);
        }
      } finally {
        setPending(false);
      }
    },
    [data],
  );

  return {
    data,
    setData,
    errors,
    error,
    pending,
    hasChanges,
    wasSuccessful,
    recentlySuccessful,
    reset,
    clearErrors,
    clearError,
    post: (url: string) => submit(url, 'POST'),
    put: (url: string) => submit(url, 'PUT'),
    patch: (url: string) => submit(url, 'PATCH'),
    delete: (url: string) => submit(url, 'DELETE'),
  };
}
