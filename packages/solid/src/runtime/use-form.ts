import { createSignal, createMemo, useContext } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
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
  type FormSubmitOptions,
} from 'void/pages-client';
import type { ActionUrl, ResolveActionBody, ActionFormOptions } from 'void/routes';
import { RouterContext, ErrorsContext } from './context.ts';

type FormReturn<TData> = FormState<TData, 'setters'> &
  Readonly<{
    setData: <K extends keyof TData & string>(field: K, value: TData[K]) => void;
    post(opts?: FormSubmitOptions): Promise<void>;
    put(opts?: FormSubmitOptions): Promise<void>;
    patch(opts?: FormSubmitOptions): Promise<void>;
    delete(opts?: FormSubmitOptions): Promise<void>;
  }>;

// Typed overload — full inference from PageActionMap (requires codegen)
export function useForm<U extends ActionUrl & string>(
  url: U,
  defaults: ResolveActionBody<U>,
  options?: ActionFormOptions<U>,
): FormReturn<ResolveActionBody<U>>;

export function useForm(
  url: string,
  defaults: Record<string, unknown>,
  options?: { params?: Record<string, string>; resetOnSuccess?: boolean },
): FormReturn<Record<string, unknown>> {
  const router = useContext(RouterContext);
  // ErrorsContext provides the errors signal accessor — a reactive function
  // that returns the current global errors object. This allows useForm to
  // derive errors from the global state, surviving component re-creation
  // during Solid's reactive tree rebuild after router.visit().
  const globalErrors = useContext(ErrorsContext);
  const initialDefaults = cloneFormValue(defaults);
  const [data, setDataStore] = createStore<Record<string, unknown>>(
    cloneFormValue(initialDefaults),
  );
  const serverErrors = createMemo(() => {
    // globalErrors is a signal accessor (function) on the client, or a plain
    // object on the server. Handle both cases.
    if (!globalErrors) {
      return {};
    }
    if (typeof globalErrors === 'function') {
      return globalErrors();
    }
    return globalErrors;
  });
  const [localErrors, setLocalErrors] = createSignal<{
    source: Record<string, string>;
    values: Record<string, string>;
  } | null>(null);
  const errors = createMemo(() => {
    const server = serverErrors();
    const local = localErrors();
    // A new router result replaces earlier edits, including explicit clears.
    return local?.source === server ? local.values : server;
  });

  function replaceErrors(values: Record<string, string>) {
    setLocalErrors({ source: serverErrors(), values });
  }
  const [pending, setPending] = createSignal(false);
  const [error, setActionError] = createSignal<VoidActionError | null>(null);
  const [wasSuccessful, setWasSuccessful] = createSignal(false);
  const [recentlySuccessful, setRecentlySuccessful] = createSignal(false);

  const [defaults_, setDefaults] = createSignal<Record<string, unknown>>(initialDefaults);
  let successTimeout: ReturnType<typeof setTimeout> | null = null;

  const hasChanges = createMemo(() => {
    const current = defaults_();
    return Object.keys(current).some((key) => !isEqualFormValue(data[key], current[key]));
  });

  function setData(field: string, value: unknown) {
    setDataStore(field, value);
    clearErrors(field);
  }

  function reset(...args: ReadonlyArray<string | FormResetOptions>) {
    const { initial, fields } = parseFormResetArgs(args);
    const source = initial ? initialDefaults : defaults_();
    if (fields.length === 0) {
      setDataStore(reconcile(cloneFormValue(source)));
    } else {
      for (const field of fields) {
        setDataStore(field, cloneFormValue(source[field]));
      }
    }
  }

  function clearErrors(...fields: ReadonlyArray<string>) {
    if (fields.length === 0) {
      replaceErrors({});
    } else {
      const next = { ...errors() };
      for (const field of fields) {
        delete next[field];
      }
      replaceErrors(next);
    }
  }

  function setFieldError(field: string, message: string) {
    replaceErrors({ ...errors(), [field]: message });
  }

  function clearError() {
    setActionError(null);
  }

  async function submit(method: string, opts: FormSubmitOptions = {}) {
    setPending(true);
    setWasSuccessful(false);
    setRecentlySuccessful(false);
    if (successTimeout) {
      clearTimeout(successTimeout);
    }
    clearErrors();
    clearError();

    try {
      if (!router) {
        throw new Error('useForm(): requires the Void Router.');
      }

      // Params are filled in on submit, so a param that would change the
      // request path (such as "..") fails this submit, not the page render.
      const result = await submitAction(router, interpolateRouteParams(url, options?.params), {
        method,
        data: { ...data },
        ...opts,
      });

      if (!result.ok) {
        const validationErrors = getValidationErrors(result.error.body);
        if (validationErrors) {
          replaceErrors(validationErrors);
        } else {
          setActionError(result.error);
        }
        return;
      }

      setWasSuccessful(true);
      setRecentlySuccessful(true);
      if (options?.resetOnSuccess) {
        setDataStore(reconcile(cloneFormValue(initialDefaults)));
        setDefaults(cloneFormValue(initialDefaults));
      } else {
        setDefaults(cloneFormValue(data));
      }
      successTimeout = setTimeout(() => {
        setRecentlySuccessful(false);
      }, 2000);
    } catch (submitError) {
      if (isAbortError(submitError)) {
        return;
      }
      throw submitError;
    } finally {
      setPending(false);
    }
  }

  return {
    get data() {
      return data;
    },
    setData,
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
    setError: setFieldError,
    clearErrors,
    clearError,
    post: (opts?: FormSubmitOptions) => submit('POST', opts),
    put: (opts?: FormSubmitOptions) => submit('PUT', opts),
    patch: (opts?: FormSubmitOptions) => submit('PATCH', opts),
    delete: (opts?: FormSubmitOptions) => submit('DELETE', opts),
  };
}
