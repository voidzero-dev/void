import type { VoidActionError } from './action-result.ts';
import type { FormResetOptions } from './form-reset.ts';
import type { VisitOptions } from './navigation-engine.ts';

export type FormMethod = 'post' | 'put' | 'patch' | 'delete';
export type FormModel<Args extends Array<unknown> = []> = Pick<FormStatus, 'pending' | 'error'> & {
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
 * How an adapter's apps change `data` and `errors`, following its framework's idiom.
 * `'in-place'`: apps edit them directly (Vue, Svelte).
 * `'setters'`: they are read-only and change through adapter setters such as `setData` (React, Solid).
 */
type FormEditing = 'in-place' | 'setters';
type FormFields<TData, TErrors, TEditing extends FormEditing> = [TEditing] extends ['setters']
  ? { readonly data: Readonly<TData>; readonly errors: Readonly<TErrors> }
  : { readonly data: TData; readonly errors: TErrors };
/**
 * The `useForm()` contract every adapter shares. Field names are typed from the action body.
 * Adapters add their submit methods.
 */
export type FormState<TData, TEditing extends FormEditing> = FormStatus &
  FormFields<TData, FormErrors<TData>, TEditing> &
  Readonly<{
    reset(options: FormResetOptions, ...fields: ReadonlyArray<keyof TData & string>): void;
    reset(...fields: ReadonlyArray<keyof TData & string>): void;
    setError(field: keyof TData & string, message: string): void;
    clearErrors(...fields: ReadonlyArray<keyof TData & string>): void;
    clearError(): void;
  }>;
/**
 * The `useIslandForm()` contract every adapter shares. Errors are keyed by whatever names the
 * action returns, not only the default fields. Submit methods take the action URL.
 */
export type IslandFormState<TData, TEditing extends FormEditing> = FormStatus &
  FormFields<TData, Partial<Record<string, string>>, TEditing> &
  Readonly<{
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
