import { useRef, useState } from 'hono/jsx';
import { isEqualFormValue, submitIslandAction, type IslandFormState } from 'void/pages-client';
import { useSubmissionStatus } from './submission-status.ts';

export type IslandFormReturn<T extends Record<string, unknown>> = IslandFormState<T, 'setters'> &
  Readonly<{ setData: <K extends keyof T & string>(field: K, value: T[K]) => void }>;

/**
 * Form hook for island pages. Uses fetch + page reload instead of the
 * Void Router (which is not available in island mode).
 */
export function useIslandForm<T extends Record<string, unknown>>(defaults: T): IslandFormReturn<T> {
  const [data, setDataState] = useState<T>(() => ({ ...defaults }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const status = useSubmissionStatus();
  // Submit and reset read the latest values, not those of the render that created them.
  const dataRef = useRef(data);
  const defaultsRef = useRef<T>({ ...defaults });

  function replaceData(next: T) {
    dataRef.current = next;
    setDataState(next);
  }

  function setData<K extends keyof T & string>(field: K, value: T[K]) {
    replaceData({ ...dataRef.current, [field]: value });
  }

  function reset(...fields: ReadonlyArray<keyof T & string>) {
    if (fields.length === 0) {
      replaceData({ ...defaultsRef.current });
      return;
    }
    const next = { ...dataRef.current };
    for (const field of fields) {
      next[field] = defaultsRef.current[field];
    }
    replaceData(next);
  }

  function clearErrors(...fields: ReadonlyArray<string>) {
    if (fields.length === 0) {
      setErrors({});
      return;
    }
    setErrors((prev) => {
      const next = { ...prev };
      for (const field of fields) {
        delete next[field];
      }
      return next;
    });
  }

  async function submit(url: string, method: string) {
    status.begin();
    setErrors({});

    try {
      const result = await submitIslandAction(url, method, dataRef.current);

      if (result.kind === 'redirect') {
        window.location.href = result.url;
        return;
      }

      if (result.kind === 'success') {
        defaultsRef.current = { ...dataRef.current };
        status.succeed();
        window.location.reload();
      } else if (result.kind === 'validation') {
        setErrors(result.errors);
      } else {
        status.setError(result.error);
      }
    } finally {
      status.end();
    }
  }

  return {
    data,
    setData,
    errors,
    error: status.error,
    pending: status.pending,
    hasChanges: Object.keys(defaultsRef.current).some(
      (key) => !isEqualFormValue(data[key], defaultsRef.current[key]),
    ),
    wasSuccessful: status.wasSuccessful,
    recentlySuccessful: status.recentlySuccessful,
    reset,
    clearErrors,
    clearError: () => status.setError(null),
    post: (url: string) => submit(url, 'POST'),
    put: (url: string) => submit(url, 'PUT'),
    patch: (url: string) => submit(url, 'PATCH'),
    delete: (url: string) => submit(url, 'DELETE'),
  };
}
