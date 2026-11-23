import type { RouteUrl } from 'void/routes';
import type { VoidActionError } from './action-result.ts';
import type { FormResetOptions } from './form-reset.ts';
import { isEqualFormValue, isPlainObject } from './form-value-equality.ts';
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
/**
 * A body field plus the dotted nested paths a validator reports for it, such as `profile.name`
 * or `contacts.0.email`. The recursion is capped so a recursive body type stays cheap to check.
 */
export type FormErrorPath<T, Depth extends ReadonlyArray<unknown> = []> = Depth['length'] extends 6
  ? never
  : T extends ReadonlyArray<infer Item>
    ? `${number}` | `${number}.${FormErrorPath<Item, [unknown, ...Depth]>}`
    : T extends object
      ? {
          [K in keyof T & string]: T[K] extends (...args: Array<never>) => unknown
            ? never
            : K | `${K}.${FormErrorPath<T[K], [unknown, ...Depth]>}`;
        }[keyof T & string]
      : never;
/**
 * A body field or one of its nested paths. `keyof TData & string` keeps top-level names usable in
 * generic callers, where TypeScript cannot resolve the `FormErrorPath` conditional.
 */
type FormFieldPath<TData> = FormErrorPath<TData> | (keyof TData & string);
/** Field-keyed validation messages; a field without an error is absent. */
export type FormErrors<TData> = Partial<Record<FormFieldPath<TData>, string>>;
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
    setError(field: FormFieldPath<TData>, message: string): void;
    clearErrors(...fields: ReadonlyArray<FormFieldPath<TData>>): void;
    clearError(): void;
  }>;
/**
 * The `useIslandForm()` contract every adapter shares. Errors are keyed by whatever names the
 * action returns, not only the default fields. Submit methods take the action URL.
 * That URL is a `RouteUrl`: any string, unless `routing.typedRoutes` is on.
 */
export type IslandFormState<TData, TEditing extends FormEditing> = FormStatus &
  FormFields<TData, Partial<Record<string, string>>, TEditing> &
  Readonly<{
    reset(...fields: ReadonlyArray<keyof TData & string>): void;
    clearErrors(...fields: ReadonlyArray<string>): void;
    clearError(): void;
    post(url: RouteUrl): Promise<void>;
    put(url: RouteUrl): Promise<void>;
    patch(url: RouteUrl): Promise<void>;
    delete(url: RouteUrl): Promise<void>;
  }>;

/** Whether an error key names `field` or a nested field below it, such as `profile.name`. */
export function isFormErrorWithin(key: string, field: string): boolean {
  return key === field || key.startsWith(`${field}.`);
}
/**
 * Dotted paths of the values that differ between two form value snapshots. `prefix` names the field
 * the two values belong to. Only arrays and plain objects are visited, matching `cloneFormValue`
 * and `isEqualFormValue`, so a `File`, `Date` or class instance stays one value.
 */
export function changedFormFields(
  previous: unknown,
  next: unknown,
  prefix = '',
): ReadonlyArray<string> {
  const changed: Array<string> = [];
  collectChangedFormFields(previous, next, prefix, changed);
  return changed;
}
function collectChangedFormFields(
  previous: unknown,
  next: unknown,
  prefix: string,
  changed: Array<string>,
): void {
  if (isEqualFormValue(previous, next)) {
    return;
  }
  if (Array.isArray(previous) && Array.isArray(next)) {
    const length = Math.max(previous.length, next.length);
    for (let index = 0; index < length; index += 1) {
      collectChangedFormFields(
        previous[index],
        next[index],
        joinFormPath(prefix, String(index)),
        changed,
      );
    }
    return;
  }
  if (isPlainObject(previous) && isPlainObject(next)) {
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      collectChangedFormFields(previous[key], next[key], joinFormPath(prefix, key), changed);
    }
    return;
  }
  if (prefix !== '') {
    changed.push(prefix);
  }
}
function joinFormPath(prefix: string, key: string): string {
  return prefix === '' ? key : `${prefix}.${key}`;
}
/**
 * Error keys a change touched: the changed field, the fields below it, and the field that contains
 * it. Editing one contact's email keeps the error of another contact.
 */
export function affectedFormErrorKeys(
  errors: Readonly<Record<string, string>>,
  changedFields: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return Object.keys(errors).filter((key) =>
    changedFields.some((field) => isFormErrorWithin(key, field) || isFormErrorWithin(field, key)),
  );
}
/**
 * Removes the errors of `fields` and of the nested fields below them, keeping unrelated errors.
 * Returns the same object when no error matched, so callers can skip an update.
 */
export function omitFormErrors(
  errors: Record<string, string>,
  fields: ReadonlyArray<string>,
): Record<string, string> {
  const kept = Object.entries(errors).filter(
    ([key]) => !fields.some((field) => isFormErrorWithin(key, field)),
  );
  return kept.length === Object.keys(errors).length ? errors : Object.fromEntries(kept);
}
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
