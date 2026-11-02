import type { VoidActionError } from './action-result.ts';
import type { FormResetOptions } from './form-reset.ts';
import type { VisitOptions } from './navigation-engine.ts';

export type FormMethod = 'post' | 'put' | 'patch' | 'delete';
export type FormModel<Args extends Array<unknown> = []> = {
  readonly pending: boolean;
  readonly error: VoidActionError | null;
  readonly errors: Readonly<Record<string, string | undefined>>;
} & { [K in FormMethod]: (...args: Args) => void | Promise<void> };

/** Router options a `useForm()` submission accepts in adapters whose submit methods take options. */
export type FormSubmitOptions = Omit<VisitOptions, 'method' | 'data'> & {
  data?: Record<string, unknown>;
};
/** Submission state that `useForm()` and `useIslandForm()` report in every adapter. */
export type FormStatus = {
  readonly error: VoidActionError | null;
  readonly pending: boolean;
  readonly hasChanges: boolean;
  readonly wasSuccessful: boolean;
  readonly recentlySuccessful: boolean;
};
/** Field-keyed validation messages; a field without an error is absent. */
export type FormErrors<TData> = Partial<Record<keyof TData & string, string>>;
/**
 * The `useForm()` contract every adapter shares. Field names are typed from the action body.
 * `data` and `errors` default to editable in place, as reactive frameworks expect; adapters
 * whose state changes go through setters pass read-only types. Adapters add submit methods.
 */
export type FormState<TData, TErrors = FormErrors<TData>> = FormStatus & {
  readonly data: TData;
  readonly errors: TErrors;
  reset(options: FormResetOptions, ...fields: ReadonlyArray<keyof TData & string>): void;
  reset(...fields: ReadonlyArray<keyof TData & string>): void;
  setError(field: keyof TData & string, message: string): void;
  clearErrors(...fields: ReadonlyArray<keyof TData & string>): void;
  clearError(): void;
};
/**
 * The `useIslandForm()` contract every adapter shares. Submit methods take the action URL.
 * As with `FormState`, `data` and `errors` default to editable in place.
 */
export type IslandFormState<TData, TErrors = FormErrors<Record<string, unknown>>> = FormStatus &
  Readonly<{
    data: TData;
    errors: TErrors;
    reset(...fields: ReadonlyArray<keyof TData & string>): void;
    clearErrors(...fields: ReadonlyArray<string>): void;
    clearError(): void;
    post(url: string): Promise<void>;
    put(url: string): Promise<void>;
    patch(url: string): Promise<void>;
    delete(url: string): Promise<void>;
  }>;

export function formErrorMessage(form: Pick<FormModel, 'error' | 'errors'>): string | null {
  return form.error?.message ?? (Object.values(form.errors).filter(Boolean).join('. ') || null);
}
export function formRetryMessage(error: VoidActionError | null): string | null {
  return error?.limit?.retryAt
    ? `Try again after ${new Date(error.limit.retryAt).toUTCString()}.`
    : null;
}
export function formSubmissionBlocked(
  form: Pick<FormModel, 'pending' | 'error'>,
  now: number = Date.now(),
): boolean {
  return (
    form.pending ||
    (form.error?.limit?.retryAt ? Date.parse(form.error.limit.retryAt) > now : false)
  );
}
/** One deadline, capped for browser timers; no polling and no automatic submission. */
export function scheduleFormRetry(error: VoidActionError | null, ready: () => void): () => void {
  const retryAt = error?.limit?.retryAt;
  if (!retryAt) {
    return () => {};
  }
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const remaining = Date.parse(retryAt) - Date.now();
    if (remaining <= 0) {
      ready();
      return;
    }
    timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
  };
  schedule();
  return () => clearTimeout(timer);
}
