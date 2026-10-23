import { getContext } from 'svelte';
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
  type VoidRouter,
} from 'void/pages-client';
import type { ActionUrl, ResolveActionBody, ActionFormOptions } from 'void/routes';

type FormSubmitOptions = Omit<VisitOptions, 'method' | 'data'> & {
  data?: Record<string, unknown>;
};
type UntypedForm = {
  readonly data: Record<string, unknown>;
  readonly errors: Record<string, string>;
  readonly error: VoidActionError | null;
  readonly pending: boolean;
  readonly hasChanges: boolean;
  readonly wasSuccessful: boolean;
  readonly recentlySuccessful: boolean;
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
  readonly data: ResolveActionBody<U>;
  readonly errors: Partial<Record<keyof ResolveActionBody<U> & string, string>>;
  readonly error: VoidActionError | null;
  readonly pending: boolean;
  readonly hasChanges: boolean;
  readonly wasSuccessful: boolean;
  readonly recentlySuccessful: boolean;
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
  const router = getContext<VoidRouter>('__void_router');

  let data = $state({ ...defaults });
  let errors: Record<string, string> = $state({});
  let error: VoidActionError | null = $state(null);
  let pending = $state(false);
  let wasSuccessful = $state(false);
  let recentlySuccessful = $state(false);

  let defaults_ = { ...defaults };
  const initialDefaults = { ...defaults };
  let successTimeout: ReturnType<typeof setTimeout> | null = null;

  const hasChanges = $derived(
    Object.keys(defaults_).some((key) => !isEqualFormValue(data[key], defaults_[key])),
  );

  function reset(...args: ReadonlyArray<string | FormResetOptions>) {
    const { initial, fields } = parseFormResetArgs(args);
    const source = initial ? initialDefaults : defaults_;
    if (fields.length === 0) {
      data = { ...source };
    } else {
      for (const field of fields) {
        data[field] = source[field];
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

  async function submit(method: string, opts: FormSubmitOptions = {}) {
    pending = true;
    wasSuccessful = false;
    recentlySuccessful = false;
    if (successTimeout) {
      clearTimeout(successTimeout);
    }
    clearErrors();
    clearError();

    try {
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
          Object.assign(errors, validationErrors);
        } else {
          error = result.error;
        }
        return;
      }

      wasSuccessful = true;
      recentlySuccessful = true;
      if (options?.resetOnSuccess) {
        data = { ...initialDefaults };
        defaults_ = { ...initialDefaults };
      } else {
        defaults_ = { ...data };
      }
      successTimeout = setTimeout(() => {
        recentlySuccessful = false;
      }, 2000);
    } catch (submitError) {
      if (isAbortError(submitError)) {
        return;
      }
      throw submitError;
    } finally {
      pending = false;
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
    reset,
    clearErrors,
    clearError,
    post: (opts?: FormSubmitOptions) => submit('POST', opts),
    put: (opts?: FormSubmitOptions) => submit('PUT', opts),
    patch: (opts?: FormSubmitOptions) => submit('PATCH', opts),
    delete: (opts?: FormSubmitOptions) => submit('DELETE', opts),
  };
}
