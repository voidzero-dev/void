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
} from 'void/pages-client';
import type { ActionUrl, ResolveActionBody, ActionFormOptions } from 'void/routes';
import { RouterContext } from './context.ts';

type SubmitPayload = FormData | { method: string };
type UntypedForm = {
  data: Record<string, unknown>;
  setData(field: string, value: unknown): void;
  errors: Record<string, string>;
  error: VoidActionError | null;
  pending: boolean;
  hasChanges: boolean;
  wasSuccessful: boolean;
  recentlySuccessful: boolean;
  post(formData: FormData): void;
  put(formData: FormData): void;
  patch(formData: FormData): void;
  delete(formData: FormData): void;
  reset(options: FormResetOptions, ...fields: ReadonlyArray<string>): void;
  reset(...fields: ReadonlyArray<string>): void;
  setError(field: string, message: string): void;
  clearErrors(...fields: ReadonlyArray<string>): void;
  clearError(): void;
};

type FormOptions = {
  params?: Record<string, string>;
  resetOnSuccess?: boolean;
  onSuccess?: () => void | Promise<void>;
  onError?: (error: Record<string, string> | VoidActionError) => void | Promise<void>;
};

// Typed overload — full inference from PageActionMap (requires codegen)
export function useForm<U extends ActionUrl & string>(
  url: U,
  defaults: ResolveActionBody<U>,
  options?: ActionFormOptions<U> & Pick<FormOptions, 'onSuccess' | 'onError'>,
): {
  data: ResolveActionBody<U>;
  setData: <K extends keyof ResolveActionBody<U> & string>(
    field: K,
    value: ResolveActionBody<U>[K],
  ) => void;
  errors: Partial<Record<keyof ResolveActionBody<U> & string, string>>;
  error: VoidActionError | null;
  pending: boolean;
  hasChanges: boolean;
  wasSuccessful: boolean;
  recentlySuccessful: boolean;
  post(formData: FormData): void;
  put(formData: FormData): void;
  patch(formData: FormData): void;
  delete(formData: FormData): void;
  reset(
    options: FormResetOptions,
    ...fields: ReadonlyArray<keyof ResolveActionBody<U> & string>
  ): void;
  reset(...fields: ReadonlyArray<keyof ResolveActionBody<U> & string>): void;
  setError(field: keyof ResolveActionBody<U> & string, message: string): void;
  clearErrors(...fields: ReadonlyArray<keyof ResolveActionBody<U> & string>): void;
  clearError(): void;
};

export function useForm(
  url: string,
  defaults: Record<string, unknown>,
  options?: FormOptions,
): UntypedForm {
  const router = useContext(RouterContext);
  const [data, setDataState] = useState<Record<string, unknown>>(() => cloneFormValue(defaults));
  const [defaultsState, setDefaultsState] = useState<Record<string, unknown>>(() =>
    cloneFormValue(defaults),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setActionError] = useState<VoidActionError | null>(null);
  const [wasSuccessful, setWasSuccessful] = useState(false);
  const [recentlySuccessful, setRecentlySuccessful] = useState(false);

  const defaultsRef = useRef(defaultsState);
  const initialRef = useRef(defaultsState);
  const dataRef = useRef(data);
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasChanges = useMemo(() => {
    return Object.keys(defaultsState).some(
      (key) => !isEqualFormValue(data[key], defaultsState[key]),
    );
  }, [data, defaultsState]);

  const setData = useCallback((field: string, value: unknown) => {
    dataRef.current = { ...dataRef.current, [field]: value };
    setDataState(dataRef.current);
    setErrors((prev) => {
      if (!(field in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  const reset = useCallback((...args: ReadonlyArray<string | FormResetOptions>) => {
    const { initial, fields } = parseFormResetArgs(args);
    const source = initial ? initialRef.current : defaultsRef.current;
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

  const setError = useCallback((field: string, message: string) => {
    setErrors((prev) => ({ ...prev, [field]: message }));
  }, []);

  const clearError = useCallback(() => {
    setActionError(null);
  }, []);

  const [, dispatchAction, pending] = useActionState(
    async (previousSuccessVersion: number, payload: SubmitPayload) => {
      if (!router) {
        throw new Error('useForm(): requires the Void Router.');
      }

      const method = payload instanceof FormData ? 'POST' : payload.method;

      setWasSuccessful(false);
      setRecentlySuccessful(false);
      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current);
        successTimeoutRef.current = null;
      }
      setErrors({});
      setActionError(null);

      let result;
      try {
        // Params are filled in on submit, so a param that would change the
        // request path (such as "..") fails this submit, not the page render.
        result = await submitAction(router, interpolateRouteParams(url, options?.params), {
          method,
          data: { ...dataRef.current },
          _resolveOnShell: true,
        });
      } catch (submitError) {
        if (isAbortError(submitError)) {
          return previousSuccessVersion;
        }
        throw submitError;
      }

      if (!result.ok) {
        const validationErrors = getValidationErrors(result.error.body);
        if (validationErrors) {
          setErrors(validationErrors);
          await options?.onError?.(validationErrors);
        } else {
          setActionError(result.error);
          await options?.onError?.(result.error);
        }
        return previousSuccessVersion;
      }

      if (options?.resetOnSuccess) {
        dataRef.current = cloneFormValue(initialRef.current);
        setDataState(dataRef.current);
      }
      const nextDefaults = cloneFormValue(dataRef.current);
      defaultsRef.current = nextDefaults;
      setDefaultsState(nextDefaults);
      setWasSuccessful(true);
      setRecentlySuccessful(true);
      successTimeoutRef.current = setTimeout(() => {
        setRecentlySuccessful(false);
        successTimeoutRef.current = null;
      }, 2000);
      await options?.onSuccess?.();
      return previousSuccessVersion + 1;
    },
    0,
  );

  useEffect(() => {
    return () => {
      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current);
        successTimeoutRef.current = null;
      }
    };
  }, []);

  const dispatchMethodAction = useCallback(
    (method: string) => (_formData: FormData) => {
      dispatchAction({ method });
    },
    [dispatchAction],
  );

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
    post: dispatchAction,
    put,
    patch,
    delete: deleteAction,
    reset,
    setError,
    clearErrors,
    clearError,
  };
}
