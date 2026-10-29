import { isEqualFormValue, submitIslandAction, type VoidActionError } from 'void/pages-client';

type UntypedIslandForm = {
  readonly data: Record<string, unknown>;
  readonly errors: Record<string, string>;
  readonly error: VoidActionError | null;
  readonly pending: boolean;
  readonly hasChanges: boolean;
  readonly wasSuccessful: boolean;
  readonly recentlySuccessful: boolean;
  submit(url: string, method: string): Promise<void>;
  post(url: string): Promise<void>;
  put(url: string): Promise<void>;
  patch(url: string): Promise<void>;
  delete(url: string): Promise<void>;
  reset(...fields: ReadonlyArray<string>): void;
  clearErrors(...fields: ReadonlyArray<string>): void;
  clearError(): void;
};

/**
 * Form composable for island pages. Uses fetch + page reload instead of the
 * Void Router (which is not available in island mode).
 */
export function useIslandForm(defaults: Record<string, unknown>): UntypedIslandForm {
  let data: Record<string, unknown> = $state({ ...defaults });
  let errors: Record<string, string> = $state({});
  let error: VoidActionError | null = $state(null);
  let pending = $state(false);
  let wasSuccessful = $state(false);
  let recentlySuccessful = $state(false);

  let defaults_ = { ...defaults };
  let successTimeout: ReturnType<typeof setTimeout> | null = null;

  const hasChanges = $derived(
    Object.keys(defaults_).some((key) => !isEqualFormValue(data[key], defaults_[key])),
  );

  function reset(...fields: ReadonlyArray<string>) {
    if (fields.length === 0) {
      data = { ...defaults_ };
    } else {
      for (const field of fields) {
        data[field] = defaults_[field];
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

  async function submit(url: string, method: string) {
    pending = true;
    wasSuccessful = false;
    recentlySuccessful = false;
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
        wasSuccessful = true;
        recentlySuccessful = true;
        defaults_ = { ...data };
        successTimeout = setTimeout(() => {
          recentlySuccessful = false;
        }, 2000);
        window.location.reload();
      } else if (result.kind === 'validation') {
        Object.assign(errors, result.errors);
      } else {
        error = result.error;
      }
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
    submit,
    reset,
    clearErrors,
    clearError,
    post: (url: string) => submit(url, 'POST'),
    put: (url: string) => submit(url, 'PUT'),
    patch: (url: string) => submit(url, 'PATCH'),
    delete: (url: string) => submit(url, 'DELETE'),
  };
}
