import {
  useActionState,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  VoidActionError,
  cloneFormValue,
  getValidationErrors,
  interpolateRouteParams,
  isAbortError,
  isEqualFormValue,
  parseFormResetArgs,
  submitAction,
  type FormResetOptions,
  type FormState,
} from 'void/pages-client';
import type { ActionUrl, ResolveActionBody, ActionFormOptions } from 'void/routes';
import { RouterContext } from './context.ts';

type SubmitPayload = {
  method: string;
  snapshot: Record<string, unknown>;
  dispatchData: Record<string, unknown>;
};

type SubmissionOutcome =
  | { status: 'idle'; defaults: Record<string, unknown> }
  | { status: 'success'; defaults: Record<string, unknown> }
  | { status: 'validation'; defaults: Record<string, unknown>; errors: Record<string, string> }
  | { status: 'error'; defaults: Record<string, unknown>; error: VoidActionError };

type ErrorEdits = {
  source: SubmissionOutcome;
  errors?: Record<string, string>;
  dismissActionError?: boolean;
};

const EMPTY_ERRORS: Record<string, string> = {};

function resolveOutcomeErrors(
  outcome: SubmissionOutcome,
  edits: ErrorEdits | null,
): Record<string, string> {
  if (edits?.source === outcome && edits.errors !== undefined) {
    return edits.errors;
  }
  return outcome.status === 'validation' ? outcome.errors : EMPTY_ERRORS;
}

// Submit methods are native form actions that take FormData.
type FormReturn<TData> = FormState<TData, 'setters'> &
  Readonly<{
    setData: <K extends keyof TData & string>(field: K, value: TData[K]) => void;
    post(formData: FormData): void;
    put(formData: FormData): void;
    patch(formData: FormData): void;
    delete(formData: FormData): void;
  }>;

type FormOptions = {
  params?: Record<string, string>;
  resetOnSuccess?: boolean;
  preserveScroll?: boolean;
  onSuccess?: () => void | Promise<void>;
  onError?: (error: Record<string, string> | VoidActionError) => void | Promise<void>;
};

// Typed overload — full inference from PageActionMap (requires codegen)
export function useForm<U extends ActionUrl & string>(
  url: U,
  defaults: ResolveActionBody<U>,
  options?: ActionFormOptions<U> & Pick<FormOptions, 'onSuccess' | 'onError' | 'preserveScroll'>,
): FormReturn<ResolveActionBody<U>>;

export function useForm(
  url: string,
  defaults: Record<string, unknown>,
  options?: FormOptions,
): FormReturn<Record<string, unknown>> {
  const router = useContext(RouterContext);
  const [data, setDataState] = useState<Record<string, unknown>>(() => cloneFormValue(defaults));
  const [initialDefaults] = useState<Record<string, unknown>>(() => cloneFormValue(defaults));
  const [errorEdits, setErrorEdits] = useState<ErrorEdits | null>(null);
  const [expiredOutcome, setExpiredOutcome] = useState<SubmissionOutcome | null>(null);

  const dataRef = useRef(data);
  const callbackOutcomeRef = useRef<SubmissionOutcome | null>(null);

  const runErrorCallback = async (
    nextOutcome: SubmissionOutcome,
    errorArg: Record<string, string> | VoidActionError,
  ): Promise<SubmissionOutcome> => {
    callbackOutcomeRef.current = nextOutcome;
    try {
      await options?.onError?.(errorArg);
    } finally {
      if (callbackOutcomeRef.current === nextOutcome) {
        callbackOutcomeRef.current = null;
      }
    }
    return nextOutcome;
  };

  const [outcome, dispatchAction, pending] = useActionState<SubmissionOutcome, SubmitPayload>(
    async (previousOutcome, payload) => {
      if (!router) {
        throw new Error('useForm(): requires the Void Router.');
      }

      let result;
      try {
        // Params are filled in on submit, so a param that would change the
        // request path (such as "..") fails this submit, not the page render.
        result = await submitAction(router, interpolateRouteParams(url, options?.params), {
          method: payload.method,
          data: payload.snapshot,
          preserveScroll: options?.preserveScroll,
          _resolveOnShell: true,
        });
      } catch (submitError) {
        if (isAbortError(submitError)) {
          return { status: 'idle', defaults: previousOutcome.defaults };
        }
        throw submitError;
      }

      if (!result.ok) {
        const validationErrors = getValidationErrors(result.error.body);
        if (validationErrors) {
          return runErrorCallback(
            {
              status: 'validation',
              defaults: previousOutcome.defaults,
              errors: validationErrors,
            },
            validationErrors,
          );
        }
        return runErrorCallback(
          {
            status: 'error',
            defaults: previousOutcome.defaults,
            error: result.error,
          },
          result.error,
        );
      }

      const nextDefaults = options?.resetOnSuccess
        ? cloneFormValue(initialDefaults)
        : cloneFormValue(payload.snapshot);
      const nextOutcome: SubmissionOutcome = { status: 'success', defaults: nextDefaults };
      // Helpers called after an await still belong to this successful submission.
      callbackOutcomeRef.current = nextOutcome;
      try {
        await options?.onSuccess?.();
      } finally {
        if (callbackOutcomeRef.current === nextOutcome) {
          callbackOutcomeRef.current = null;
        }
      }
      if (options?.resetOnSuccess && dataRef.current === payload.dispatchData) {
        dataRef.current = cloneFormValue(initialDefaults);
        setDataState(dataRef.current);
      }
      return nextOutcome;
    },
    { status: 'idle', defaults: initialDefaults },
  );

  const defaultsState = outcome.defaults;
  const hasChanges = useMemo(() => {
    return Object.keys(defaultsState).some(
      (key) => !isEqualFormValue(data[key], defaultsState[key]),
    );
  }, [data, defaultsState]);

  const setData = useCallback(
    (field: string, value: unknown) => {
      const previousValue = dataRef.current[field];
      dataRef.current = { ...dataRef.current, [field]: value };
      setDataState(dataRef.current);
      if (isEqualFormValue(previousValue, value)) {
        return;
      }
      const target = callbackOutcomeRef.current ?? outcome;
      setErrorEdits((prev) => {
        const current = resolveOutcomeErrors(target, prev);
        if (!(field in current)) {
          return prev;
        }
        const next = { ...current };
        delete next[field];
        return {
          ...(prev?.source === target ? prev : { source: target }),
          errors: next,
        };
      });
    },
    [outcome],
  );

  const reset = useCallback(
    (...args: ReadonlyArray<string | FormResetOptions>) => {
      const { initial, fields } = parseFormResetArgs(args);
      const target = callbackOutcomeRef.current ?? outcome;
      const source = initial ? initialDefaults : target.defaults;
      if (fields.length === 0) {
        dataRef.current = cloneFormValue(source);
      } else {
        const next = { ...dataRef.current };
        for (const field of fields) {
          next[field] = cloneFormValue(source[field]);
        }
        dataRef.current = next;
      }
      setDataState(dataRef.current);
    },
    [initialDefaults, outcome],
  );

  const clearErrors = useCallback(
    (...fields: ReadonlyArray<string>) => {
      const target = callbackOutcomeRef.current ?? outcome;
      setErrorEdits((prev) => {
        const base = prev?.source === target ? prev : { source: target };
        if (fields.length === 0) {
          return { ...base, errors: EMPTY_ERRORS };
        }
        const next = { ...resolveOutcomeErrors(target, prev) };
        for (const field of fields) {
          delete next[field];
        }
        return { ...base, errors: next };
      });
    },
    [outcome],
  );

  const setError = useCallback(
    (field: string, message: string) => {
      const target = callbackOutcomeRef.current ?? outcome;
      setErrorEdits((prev) => ({
        ...(prev?.source === target ? prev : { source: target }),
        errors: { ...resolveOutcomeErrors(target, prev), [field]: message },
      }));
    },
    [outcome],
  );

  const clearError = useCallback(() => {
    const target = callbackOutcomeRef.current ?? outcome;
    setErrorEdits((prev) => ({
      ...(prev?.source === target ? prev : { source: target }),
      dismissActionError: true,
    }));
  }, [outcome]);

  const errors = pending ? EMPTY_ERRORS : resolveOutcomeErrors(outcome, errorEdits);
  const error: VoidActionError | null =
    pending ||
    outcome.status !== 'error' ||
    (errorEdits?.source === outcome && errorEdits.dismissActionError)
      ? null
      : outcome.error;
  const wasSuccessful = !pending && outcome.status === 'success';
  const recentlySuccessful = wasSuccessful && expiredOutcome !== outcome;

  useEffect(() => {
    if (outcome.status !== 'success') {
      return;
    }
    const timer = setTimeout(() => {
      setExpiredOutcome(outcome);
    }, 2000);
    return () => clearTimeout(timer);
  }, [outcome]);

  const dispatchMethodAction = useCallback(
    (method: string) => (_formData: FormData) => {
      dispatchAction({
        method,
        snapshot: cloneFormValue(dataRef.current),
        dispatchData: dataRef.current,
      });
    },
    [dispatchAction],
  );

  const post = useMemo(() => dispatchMethodAction('POST'), [dispatchMethodAction]);
  const put = useMemo(() => dispatchMethodAction('PUT'), [dispatchMethodAction]);
  const patch = useMemo(() => dispatchMethodAction('PATCH'), [dispatchMethodAction]);
  const deleteAction = useMemo(() => dispatchMethodAction('DELETE'), [dispatchMethodAction]);

  return {
    data,
    setData,
    errors,
    error,
    pending,
    hasChanges,
    wasSuccessful,
    recentlySuccessful,
    post,
    put,
    patch,
    delete: deleteAction,
    reset,
    setError,
    clearErrors,
    clearError,
  };
}
