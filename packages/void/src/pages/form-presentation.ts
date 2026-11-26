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
/** Values a validator reports as one field, so their properties are not error paths. */
type FormErrorLeaf =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | Date
  | Blob
  | ReadonlyMap<unknown, unknown>
  | ReadonlySet<unknown>
  | ((...args: Array<never>) => unknown);
/** Whether `T` is exactly one of `Ancestors`. Assignability would also match a different object whose extra fields are optional. */
type IsFormErrorAncestor<T, Ancestors extends ReadonlyArray<unknown>> = Ancestors extends readonly [
  infer Head,
  ...infer Rest,
]
  ? (<G>() => G extends T ? 1 : 2) extends <G>() => G extends Head ? 1 : 2
    ? true
    : IsFormErrorAncestor<T, Rest>
  : false;
/**
 * A body field plus the dotted nested paths a validator reports for it, such as `profile.name`
 * or `contacts.0.email`. Past six segments, or where a recursive body type repeats, any
 * nested path is accepted. Without that cut, a type with several self references expands to
 * an exponential union.
 */
export type FormErrorPath<
  T,
  Ancestors extends ReadonlyArray<unknown> = [],
> = T extends FormErrorLeaf
  ? never
  : Ancestors['length'] extends 6
    ? string
    : IsFormErrorAncestor<T, Ancestors> extends true
      ? string
      : T extends ReadonlyArray<infer Item>
        ? `${number}` | `${number}.${FormErrorPath<Item, [T, ...Ancestors]>}`
        : T extends object
          ? {
              [K in keyof T & string]: T[K] extends (...args: Array<never>) => unknown
                ? never
                : K | `${K}.${FormErrorPath<T[K], [T, ...Ancestors]>}`;
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

function hasFormField(value: unknown, field: string): value is Record<string, unknown> {
  return (isPlainObject(value) || Array.isArray(value)) && Object.hasOwn(value, field);
}

// A literal key can contain dots. Prefer the longest own key before treating dots as path
// separators. Check both snapshots so deleting a literal key still identifies the same field.
function formValuePath(field: string, previous: unknown, next = previous): Array<string> {
  const path: Array<string> = [];
  for (;;) {
    let key = field;
    while (!hasFormField(previous, key) && !hasFormField(next, key)) {
      const dot = key.lastIndexOf('.');
      if (dot === -1) {
        break;
      }
      key = key.slice(0, dot);
    }
    path.push(key);
    if (key === field) {
      return path;
    }
    previous = hasFormField(previous, key) ? previous[key] : undefined;
    next = hasFormField(next, key) ? next[key] : undefined;
    field = field.slice(key.length + 1);
  }
}

function formValueChanged(previous: unknown, next: unknown, path: ReadonlyArray<string>): boolean {
  for (const key of path) {
    if (Object.is(previous, next)) {
      return false;
    }
    if (!hasFormField(previous, key)) {
      if (hasFormField(next, key)) {
        return true;
      }
      // Replacing a container invalidates descendant errors even when the
      // specific field was missing, for example a required field in an empty object.
      return !(
        (isPlainObject(previous) && isPlainObject(next)) ||
        (Array.isArray(previous) && Array.isArray(next))
      );
    }
    if (!hasFormField(next, key)) {
      return true;
    }
    previous = previous[key];
    next = next[key];
  }
  return !isEqualFormValue(previous, next);
}

/** The exact error keys whose field values changed, including affected parent fields. */
export function changedFormErrorKeys(
  errors: Readonly<Record<string, string>>,
  previous: unknown,
  next: unknown,
): Array<string> {
  return Object.keys(errors).filter((key) =>
    formValueChanged(previous, next, formValuePath(key, previous, next)),
  );
}

/** The error keys on explicitly cleared fields and their descendants. */
export function formErrorKeysWithin(
  errors: Readonly<Record<string, string>>,
  fields: ReadonlyArray<string>,
  data: unknown,
): Array<string> {
  const paths = fields.map((field) => formValuePath(field, data));
  return Object.keys(errors).filter((key) => {
    const path = formValuePath(key, data);
    return paths.some((parent) => parent.every((part, index) => part === path[index]));
  });
}

/** Remove only the selected error keys. */
export function omitFormErrors(
  errors: Record<string, string>,
  keys: ReadonlyArray<string>,
): Record<string, string> {
  if (keys.length === 0) {
    return errors;
  }
  const next = { ...errors };
  for (const key of keys) {
    delete next[key];
  }
  // oxlint-disable-next-line quality/no-known-value-widening -- Error keys come from dynamic form data.
  return next;
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
