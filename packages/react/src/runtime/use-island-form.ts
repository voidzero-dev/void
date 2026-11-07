import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  cloneFormValue,
  isEqualFormValue,
  submitIslandAction,
  type IslandFormState,
  type VoidActionError,
} from 'void/pages-client';
import type { RouteUrl } from 'void/routes';

const EMPTY_ERRORS: Record<string, string> = {};

export type IslandFormReturn<T extends Record<string, unknown>> = IslandFormState<T, 'setters'> &
  Readonly<{ setData: <K extends keyof T & string>(field: K, value: T[K]) => void }>;

type IslandOutcome<T extends Record<string, unknown>> =
  | { status: 'idle'; defaults: T }
  | { status: 'pending'; defaults: T; requestId: number }
  | { status: 'success'; defaults: T }
  | { status: 'validation'; defaults: T; errors: Record<string, string> }
  | { status: 'error'; defaults: T; error: VoidActionError };

/**
 * Form hook for island pages. Uses fetch + page reload instead of the
 * Void Router (which is not available in island mode).
 */
export function useIslandForm<T extends Record<string, unknown>>(defaults: T): IslandFormReturn<T> {
  const [data, setDataState] = useState<T>(() => cloneFormValue(defaults));
  const [outcome, setOutcome] = useState<IslandOutcome<T>>(() => ({
    status: 'idle',
    defaults: cloneFormValue(defaults),
  }));
  const [expiredOutcome, setExpiredOutcome] = useState<IslandOutcome<T> | null>(null);
  const dataRef = useRef<T>(data);
  const latestRequestIdRef = useRef(0);

  const defaultsState = outcome.defaults;
  const pending = outcome.status === 'pending';
  const errors = outcome.status === 'validation' ? outcome.errors : EMPTY_ERRORS;
  const error: VoidActionError | null = outcome.status === 'error' ? outcome.error : null;
  const wasSuccessful = outcome.status === 'success';
  const recentlySuccessful = wasSuccessful && expiredOutcome !== outcome;

  const hasChanges = useMemo(() => {
    return Object.keys(defaultsState).some(
      (key) => !isEqualFormValue(data[key], defaultsState[key as keyof T]),
    );
  }, [data, defaultsState]);

  useEffect(() => {
    if (outcome.status !== 'success') {
      return;
    }
    const timer = setTimeout(() => setExpiredOutcome(outcome), 2000);
    return () => clearTimeout(timer);
  }, [outcome]);

  const setData = useCallback(<K extends keyof T & string>(field: K, value: T[K]) => {
    const previousValue = dataRef.current[field];
    dataRef.current = { ...dataRef.current, [field]: value };
    setDataState(dataRef.current);
    if (isEqualFormValue(previousValue, value)) {
      return;
    }
    setOutcome((prev) => {
      if (prev.status !== 'validation' || !(field in prev.errors)) {
        return prev;
      }
      const next = { ...prev.errors };
      delete next[field];
      return { status: 'validation', defaults: prev.defaults, errors: next };
    });
  }, []);

  const reset = useCallback(
    (...fields: ReadonlyArray<keyof T & string>) => {
      if (fields.length === 0) {
        dataRef.current = cloneFormValue(defaultsState);
      } else {
        const next = { ...dataRef.current };
        for (const field of fields) {
          next[field] = cloneFormValue(defaultsState[field]);
        }
        dataRef.current = next;
      }
      setDataState(dataRef.current);
    },
    [defaultsState],
  );

  const clearErrors = useCallback((...fields: ReadonlyArray<string>) => {
    setOutcome((prev) => {
      if (prev.status !== 'validation') {
        return prev;
      }
      if (fields.length === 0) {
        return { status: 'idle', defaults: prev.defaults };
      }
      const next = { ...prev.errors };
      for (const field of fields) {
        delete next[field];
      }
      return { status: 'validation', defaults: prev.defaults, errors: next };
    });
  }, []);

  const clearError = useCallback(() => {
    setOutcome((prev) =>
      prev.status === 'error' ? { status: 'idle', defaults: prev.defaults } : prev,
    );
  }, []);

  const submit = useCallback(async (url: string, method: string) => {
    const requestId = ++latestRequestIdRef.current;
    const submittedData = cloneFormValue(dataRef.current);
    setOutcome((prev) => ({ status: 'pending', defaults: prev.defaults, requestId }));

    try {
      const result = await submitIslandAction(url, method, submittedData);
      if (requestId !== latestRequestIdRef.current) {
        return;
      }

      if (result.kind === 'redirect') {
        setOutcome((prev) => ({ status: 'idle', defaults: prev.defaults }));
        window.location.href = result.url;
        return;
      }

      if (result.kind === 'success') {
        setOutcome({ status: 'success', defaults: submittedData });
        window.location.reload();
      } else if (result.kind === 'validation') {
        setOutcome((prev) => ({
          status: 'validation',
          defaults: prev.defaults,
          errors: result.errors,
        }));
      } else {
        setOutcome((prev) => ({
          status: 'error',
          defaults: prev.defaults,
          error: result.error,
        }));
      }
    } catch (submitError) {
      if (requestId === latestRequestIdRef.current) {
        setOutcome((prev) =>
          prev.status === 'pending' && prev.requestId === requestId
            ? { status: 'idle', defaults: prev.defaults }
            : prev,
        );
      }
      throw submitError;
    }
  }, []);

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
    post: (url: RouteUrl) => submit(url, 'POST'),
    put: (url: RouteUrl) => submit(url, 'PUT'),
    patch: (url: RouteUrl) => submit(url, 'PATCH'),
    delete: (url: RouteUrl) => submit(url, 'DELETE'),
  };
}
