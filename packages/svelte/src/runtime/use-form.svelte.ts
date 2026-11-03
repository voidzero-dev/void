import { getContext, untrack } from 'svelte';
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

type FormReturn<TData> = FormState<TData, 'in-place'> &
  Readonly<{
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
  const router = getContext<VoidRouter>('__void_router');

  const initialDefaults = cloneFormValue(defaults);
  let data = $state(cloneFormValue(initialDefaults));
  let errors: Record<string, string> = $state({});
  let error: VoidActionError | null = $state(null);
  let pending = $state(false);
  let wasSuccessful = $state(false);
  let recentlySuccessful = $state(false);

  let defaults_ = $state.raw(initialDefaults);
  let successTimeout: ReturnType<typeof setTimeout> | null = null;
  let dataSnapshot = cloneFormValue(initialDefaults);

  $effect(() => {
    // Read nested values even after an earlier edit, without subscribing to errors.
    const current = cloneFormValue(data);
    untrack(() => {
      for (const key of new Set([...Object.keys(dataSnapshot), ...Object.keys(current)])) {
        if (!isEqualFormValue(current[key], dataSnapshot[key])) {
          delete errors[key];
        }
      }
      dataSnapshot = current;
    });
  });

  // An input handler may validate its new value before the change effect runs.
  function snapshotField(field: string) {
    untrack(() => {
      dataSnapshot = { ...dataSnapshot, [field]: cloneFormValue(data[field]) };
    });
  }

  // Handlers may also write `form.errors.field` directly, which needs the same snapshot.
  // The view is derived because setError and clearErrors replace `errors`.
  const errorsView = $derived(
    new Proxy(errors, {
      set(target, field, message) {
        if (typeof field === 'string') {
          snapshotField(field);
        }
        return Reflect.set(target, field, message);
      },
    }),
  );

  const hasChanges = $derived(
    Object.keys(defaults_).some((key) => !isEqualFormValue(data[key], defaults_[key])),
  );

  function reset(...args: ReadonlyArray<string | FormResetOptions>) {
    const { initial, fields } = parseFormResetArgs(args);
    const source = initial ? initialDefaults : defaults_;
    if (fields.length === 0) {
      data = cloneFormValue(source);
    } else {
      for (const field of fields) {
        data[field] = cloneFormValue(source[field]);
      }
    }
    dataSnapshot = cloneFormValue(data);
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

  function setError(field: string, message: string) {
    snapshotField(field);
    errors = { ...errors, [field]: message };
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
          for (const [field, message] of Object.entries(validationErrors)) {
            setError(field, message);
          }
        } else {
          error = result.error;
        }
        return;
      }

      wasSuccessful = true;
      recentlySuccessful = true;
      if (options?.resetOnSuccess) {
        data = cloneFormValue(initialDefaults);
        defaults_ = cloneFormValue(initialDefaults);
      } else {
        defaults_ = cloneFormValue(data);
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
      return errorsView;
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
    setError,
    clearErrors,
    clearError,
    post: (opts?: FormSubmitOptions) => submit('POST', opts),
    put: (opts?: FormSubmitOptions) => submit('PUT', opts),
    patch: (opts?: FormSubmitOptions) => submit('PATCH', opts),
    delete: (opts?: FormSubmitOptions) => submit('DELETE', opts),
  };
}
