import {
  isEqualFormValue,
  submitIslandAction,
  type IslandFormState,
  type VoidActionError,
} from 'void/pages-client';
import { reactive, ref, watch } from 'vue';

export type IslandFormReturn<T extends Record<string, unknown>> = IslandFormState<T, 'in-place'> &
  Readonly<{ submit(url: string, method: string): Promise<void> }>;

/**
 * Form composable for island pages. Uses fetch + page reload instead of the
 * Void Router (which is not available in island mode).
 */
export function useIslandForm<T extends Record<string, unknown>>(defaults: T): IslandFormReturn<T>;

// Untyped implementation, so the returned object is checked against the island contract.
export function useIslandForm(
  defaults: Record<string, unknown>,
): IslandFormReturn<Record<string, unknown>> {
  const data = reactive({ ...defaults }) as Record<string, unknown>;
  const errors = reactive<Record<string, string>>({});
  const error = ref<VoidActionError | null>(null);
  const pending = ref(false);
  const wasSuccessful = ref(false);
  const recentlySuccessful = ref(false);

  let defaults_ = { ...defaults };
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

  function reset(...fields: ReadonlyArray<string>) {
    if (fields.length === 0) {
      Object.assign(data, { ...defaults_ });
    } else {
      for (const field of fields) {
        data[field] = defaults_[field];
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

  async function submit(url: string, method: string) {
    pending.value = true;
    wasSuccessful.value = false;
    recentlySuccessful.value = false;
    if (successTimeout) {
      clearTimeout(successTimeout);
    }
    clearErrors();
    clearError();

    try {
      const result = await submitIslandAction(url, method, data);

      if (result.kind === 'redirect') {
        window.location.href = result.url;
        return;
      }

      if (result.kind === 'success') {
        wasSuccessful.value = true;
        recentlySuccessful.value = true;
        defaults_ = { ...data };
        successTimeout = setTimeout(() => {
          recentlySuccessful.value = false;
        }, 2000);
        window.location.reload();
      } else if (result.kind === 'validation') {
        Object.assign(errors, result.errors);
      } else {
        error.value = result.error;
      }
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
    submit,
    reset,
    clearErrors,
    clearError,
    post: (url: string) => submit(url, 'POST'),
    put: (url: string) => submit(url, 'PUT'),
    patch: (url: string) => submit(url, 'PATCH'),
    delete: (url: string) => submit(url, 'DELETE'),
  });
}
