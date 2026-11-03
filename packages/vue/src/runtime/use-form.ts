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
  type VoidRouter,
} from 'void/pages-client';
import type { ActionUrl, ResolveActionBody, ActionFormOptions } from 'void/routes';
import { computed, reactive, ref, shallowRef, inject, watch } from 'vue';

type FormReturn<TData> = FormState<TData, 'in-place'> &
  Readonly<{
    post(opts?: FormSubmitOptions): Promise<void>;
    put(opts?: FormSubmitOptions): Promise<void>;
    patch(opts?: FormSubmitOptions): Promise<void>;
    delete(opts?: FormSubmitOptions): Promise<void>;
  }>;

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
  const initialDefaults = cloneFormValue(defaults);
  const router = inject<VoidRouter | null>('__void_router', null);
  const data = reactive(cloneFormValue(initialDefaults)) as Record<string, unknown>;
  const errors = reactive<Record<string, string>>({});
  const error = ref<VoidActionError | null>(null);
  const pending = ref(false);
  const wasSuccessful = ref(false);
  const recentlySuccessful = ref(false);

  const defaults_ = shallowRef(initialDefaults);
  let successTimeout: ReturnType<typeof setTimeout> | null = null;

  let dataSnapshot = cloneFormValue(initialDefaults);
  watch(
    () => cloneFormValue(data),
    (val) => {
      for (const key of new Set([...Object.keys(dataSnapshot), ...Object.keys(val)])) {
        if (!isEqualFormValue(val[key], dataSnapshot[key])) {
          delete errors[key];
        }
      }
      dataSnapshot = val;
    },
    { flush: 'sync' },
  );

  const hasChanges = computed(() =>
    Object.keys(defaults_.value).some((key) => !isEqualFormValue(data[key], defaults_.value[key])),
  );

  function reset(...args: ReadonlyArray<string | FormResetOptions>) {
    const { initial, fields } = parseFormResetArgs(args);
    const source = initial ? initialDefaults : defaults_.value;
    if (fields.length === 0) {
      Object.assign(data, cloneFormValue(source));
    } else {
      for (const field of fields) {
        data[field] = cloneFormValue(source[field]);
      }
    }
    dataSnapshot = cloneFormValue(data);
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

  function setError(field: string, message: string) {
    errors[field] = message;
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
        Object.assign(data, cloneFormValue(initialDefaults));
        defaults_.value = cloneFormValue(initialDefaults);
      } else {
        defaults_.value = cloneFormValue(data);
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
    setError,
    clearErrors,
    clearError,
    post: (opts?: FormSubmitOptions) => submit('POST', opts),
    put: (opts?: FormSubmitOptions) => submit('PUT', opts),
    patch: (opts?: FormSubmitOptions) => submit('PATCH', opts),
    delete: (opts?: FormSubmitOptions) => submit('DELETE', opts),
  });
}
