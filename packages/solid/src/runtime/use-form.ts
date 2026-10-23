import { createSignal, createMemo, useContext } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import {
  VoidActionError,
  getValidationErrors,
  interpolateRouteParams,
  isAbortError,
  isEqualFormValue,
  parseFormResetArgs,
  submitAction,
  type FormResetOptions,
  type VisitOptions,
} from 'void/pages-client';
import type { ActionUrl, ResolveActionBody, ActionFormOptions } from 'void/routes';
import { RouterContext, ErrorsContext } from './context.ts';

type FormSubmitOptions = Omit<VisitOptions, 'method' | 'data'> & {
  data?: Record<string, unknown>;
};
type UntypedForm = {
  data: Record<string, unknown>;
  setData(field: string, value: unknown): void;
  errors: Record<string, string>;
  error: VoidActionError | null;
  pending: boolean;
  hasChanges: boolean;
  wasSuccessful: boolean;
  recentlySuccessful: boolean;
  post(opts?: FormSubmitOptions): Promise<void>;
  put(opts?: FormSubmitOptions): Promise<void>;
  patch(opts?: FormSubmitOptions): Promise<void>;
  delete(opts?: FormSubmitOptions): Promise<void>;
  reset(options: FormResetOptions, ...fields: ReadonlyArray<string>): void;
  reset(...fields: ReadonlyArray<string>): void;
  clearErrors(...fields: ReadonlyArray<string>): void;
  clearError(): void;
};

// Typed overload — full inference from PageActionMap (requires codegen)
export function useForm<U extends ActionUrl & string>(
  url: U,
  defaults: ResolveActionBody<U>,
  options?: ActionFormOptions<U>,
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
  post(opts?: FormSubmitOptions): Promise<void>;
  put(opts?: FormSubmitOptions): Promise<void>;
  patch(opts?: FormSubmitOptions): Promise<void>;
  delete(opts?: FormSubmitOptions): Promise<void>;
  reset(
    options: FormResetOptions,
    ...fields: ReadonlyArray<keyof ResolveActionBody<U> & string>
  ): void;
  reset(...fields: ReadonlyArray<keyof ResolveActionBody<U> & string>): void;
  clearErrors(...fields: ReadonlyArray<keyof ResolveActionBody<U> & string>): void;
  clearError(): void;
};

export function useForm(
  url: string,
  defaults: Record<string, unknown>,
  options?: { params?: Record<string, string>; resetOnSuccess?: boolean },
): UntypedForm {
  const router = useContext(RouterContext);
  // ErrorsContext provides the errors signal accessor — a reactive function
  // that returns the current global errors object. This allows useForm to
  // derive errors from the global state, surviving component re-creation
  // during Solid's reactive tree rebuild after router.visit().
  const globalErrors = useContext(ErrorsContext);
  const [data, setDataStore] = createStore<Record<string, unknown>>({ ...defaults });
  const [localErrors, setLocalErrors] = createSignal<Record<string, string>>({});
  const errors = createMemo(() => {
    const local = localErrors();
    if (Object.keys(local).length > 0) {
      return local;
    }
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
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<VoidActionError | null>(null);
  const [wasSuccessful, setWasSuccessful] = createSignal(false);
  const [recentlySuccessful, setRecentlySuccessful] = createSignal(false);

  const [defaults_, setDefaults] = createSignal<Record<string, unknown>>({ ...defaults });
  const initialDefaults = { ...defaults };
  let successTimeout: ReturnType<typeof setTimeout> | null = null;

  const hasChanges = createMemo(() => {
    const current = defaults_();
    return Object.keys(current).some((key) => !isEqualFormValue(data[key], current[key]));
  });

  function setData(field: string, value: unknown) {
    setDataStore(field, value);
  }

  function reset(...args: ReadonlyArray<string | FormResetOptions>) {
    const { initial, fields } = parseFormResetArgs(args);
    const source = initial ? initialDefaults : defaults_();
    if (fields.length === 0) {
      setDataStore(reconcile({ ...source }));
    } else {
      for (const field of fields) {
        setDataStore(field, source[field]);
      }
    }
  }

  function clearErrors(...fields: ReadonlyArray<string>) {
    if (fields.length === 0) {
      setLocalErrors({});
    } else {
      setLocalErrors((prev) => {
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

  async function submit(method: string, opts: FormSubmitOptions = {}) {
    setPending(true);
    setWasSuccessful(false);
    setRecentlySuccessful(false);
    if (successTimeout) {
      clearTimeout(successTimeout);
    }
    setLocalErrors({});
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
          setLocalErrors(validationErrors);
        } else {
          setError(result.error);
        }
        return;
      }

      setWasSuccessful(true);
      setRecentlySuccessful(true);
      if (options?.resetOnSuccess) {
        setDataStore(reconcile({ ...initialDefaults }));
        setDefaults({ ...initialDefaults });
      } else {
        setDefaults({ ...data });
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
    clearErrors,
    clearError,
    post: (opts?: FormSubmitOptions) => submit('POST', opts),
    put: (opts?: FormSubmitOptions) => submit('PUT', opts),
    patch: (opts?: FormSubmitOptions) => submit('PATCH', opts),
    delete: (opts?: FormSubmitOptions) => submit('DELETE', opts),
  };
}
