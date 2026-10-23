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
import { reactive, ref, inject, watch } from 'vue';

type FormSubmitOptions = Omit<VisitOptions, 'method' | 'data'> & {
  data?: Record<string, unknown>;
};
type UntypedForm = {
  data: Record<string, unknown>;
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

export function useForm<U extends ActionUrl & string>(
  url: U,
  defaults: ResolveActionBody<U>,
  options?: ActionFormOptions<U>,
): {
  data: ResolveActionBody<U>;
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
  const formDefaults = defaults;
  const router = inject<VoidRouter | null>('__void_router', null);
  const data = reactive({ ...formDefaults }) as Record<string, unknown>;
  const errors = reactive<Record<string, string>>({});
  const error = ref<VoidActionError | null>(null);
  const pending = ref(false);
  const wasSuccessful = ref(false);
  const recentlySuccessful = ref(false);

  let defaults_ = { ...formDefaults };
  const initialDefaults = { ...formDefaults };
  let successTimeout: ReturnType<typeof setTimeout> | null = null;

  const hasChanges = ref(false);
  watch(
    () => ({ ...data }),
    (val) => {
      hasChanges.value = Object.keys(defaults_).some(
        (key) => !isEqualFormValue(val[key], defaults_[key]),
      );
    },
    { deep: true },
  );

  function reset(...args: ReadonlyArray<string | FormResetOptions>) {
    const { initial, fields } = parseFormResetArgs(args);
    const source = initial ? initialDefaults : defaults_;
    if (fields.length === 0) {
      Object.assign(data, { ...source });
    } else {
      for (const field of fields) {
        data[field] = source[field];
      }
    }
  }

  function clearErrors(...fields: ReadonlyArray<string>) {
    if (fields.length === 0) {
      for (const key of Object.keys(errors)) {
        delete errors[key];
      }
    } else {
      for (const field of fields) {
        delete errors[field];
      }
    }
  }

  function clearError() {
    error.value = null;
  }

  async function submit(method: string, opts: FormSubmitOptions = {}) {
    pending.value = true;
    wasSuccessful.value = false;
    recentlySuccessful.value = false;
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
          Object.assign(errors, validationErrors);
        } else {
          error.value = result.error;
        }
        return;
      }

      wasSuccessful.value = true;
      recentlySuccessful.value = true;
      if (options?.resetOnSuccess) {
        Object.assign(data, { ...initialDefaults });
        defaults_ = { ...initialDefaults };
      } else {
        defaults_ = { ...data };
      }
      successTimeout = setTimeout(() => {
        recentlySuccessful.value = false;
      }, 2000);
    } catch (submitError) {
      if (isAbortError(submitError)) {
        return;
      }
      throw submitError;
    } finally {
      pending.value = false;
    }
  }

  return reactive({
    data,
    errors,
    error,
    pending,
    hasChanges,
    wasSuccessful,
    recentlySuccessful,
    reset,
    clearErrors,
    clearError,
    post: (opts?: FormSubmitOptions) => submit('POST', opts),
    put: (opts?: FormSubmitOptions) => submit('PUT', opts),
    patch: (opts?: FormSubmitOptions) => submit('PATCH', opts),
    delete: (opts?: FormSubmitOptions) => submit('DELETE', opts),
  });
}
