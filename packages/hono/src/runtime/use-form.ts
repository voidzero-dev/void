import { useContext, useMemo, useRef, useState } from 'hono/jsx';
import {
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
} from 'void/pages-client';
import type { ActionUrl, ResolveActionBody, ActionFormOptions } from 'void/routes';
import { ErrorsContext, RouterContext } from './context.ts';
import { useSubmissionStatus } from './submission-status.ts';

type Fields = Record<string, unknown>;
type FieldErrors = Record<string, string>;

type FormReturn<TData> = FormState<TData, 'setters'> &
  Readonly<{
    setData: <K extends keyof TData & string>(field: K, value: TData[K]) => void;
    post(opts?: FormSubmitOptions): Promise<void>;
    put(opts?: FormSubmitOptions): Promise<void>;
    patch(opts?: FormSubmitOptions): Promise<void>;
    delete(opts?: FormSubmitOptions): Promise<void>;
  }>;

// useForm() compares the server errors by identity, so the fallback must be stable.
const NO_ERRORS: FieldErrors = {};

// Typed overload — full inference from PageActionMap (requires codegen)
export function useForm<U extends ActionUrl & string>(
  url: U,
  defaults: ResolveActionBody<U>,
  options?: ActionFormOptions<U>,
): FormReturn<ResolveActionBody<U>>;

export function useForm(
  url: string,
  defaults: Fields,
  options?: { params?: Record<string, string>; resetOnSuccess?: boolean },
): FormReturn<Fields> {
  const router = useContext(RouterContext);
  // Errors the server sent with the page. A new router result replaces earlier
  // edits, including explicit clears.
  const serverErrors = useContext(ErrorsContext) ?? NO_ERRORS;
  const initialRef = useRef<Fields>(cloneFormValue(defaults));
  const [data, setDataState] = useState<Fields>(() => cloneFormValue(defaults));
  const [defaultsState, setDefaultsState] = useState<Fields>(() => cloneFormValue(defaults));
  const [localErrors, setLocalErrors] = useState<{
    source: FieldErrors;
    values: FieldErrors;
  } | null>(null);
  const status = useSubmissionStatus();

  // Submit and reset read the latest values, not those of the render that created them.
  const dataRef = useRef(data);
  const defaultsRef = useRef(defaultsState);
  const errors = localErrors?.source === serverErrors ? localErrors.values : serverErrors;
  const errorsRef = useRef(errors);
  errorsRef.current = errors;

  const hasChanges = useMemo(
    () =>
      Object.keys(defaultsState).some((key) => !isEqualFormValue(data[key], defaultsState[key])),
    [data, defaultsState],
  );

  function replaceData(next: Fields) {
    dataRef.current = next;
    setDataState(next);
  }

  function replaceErrors(values: FieldErrors) {
    errorsRef.current = values;
    setLocalErrors({ source: serverErrors, values });
  }

  function setData(field: string, value: unknown) {
    replaceData({ ...dataRef.current, [field]: value });
    if (field in errorsRef.current) {
      clearErrors(field);
    }
  }

  function reset(...args: ReadonlyArray<string | FormResetOptions>) {
    const { initial, fields } = parseFormResetArgs(args);
    const source = initial ? initialRef.current : defaultsRef.current;
    if (fields.length === 0) {
      replaceData(cloneFormValue(source));
      return;
    }
    const next = { ...dataRef.current };
    for (const field of fields) {
      next[field] = cloneFormValue(source[field]);
    }
    replaceData(next);
  }

  function clearErrors(...fields: ReadonlyArray<string>) {
    if (fields.length === 0) {
      replaceErrors({});
      return;
    }
    const next = { ...errorsRef.current };
    for (const field of fields) {
      delete next[field];
    }
    replaceErrors(next);
  }

  function setFieldError(field: string, message: string) {
    replaceErrors({ ...errorsRef.current, [field]: message });
  }

  async function submit(method: string, opts: FormSubmitOptions = {}) {
    status.begin();
    clearErrors();

    try {
      if (!router) {
        throw new Error('useForm(): requires the Void Router.');
      }

      // Params are filled in on submit, so a param that would change the
      // request path (such as "..") fails this submit, not the page render.
      const result = await submitAction(router, interpolateRouteParams(url, options?.params), {
        method,
        data: { ...dataRef.current },
        ...opts,
      });

      if (!result.ok) {
        const validationErrors = getValidationErrors(result.error.body);
        if (validationErrors) {
          replaceErrors(validationErrors);
        } else {
          status.setError(result.error);
        }
        return;
      }

      if (options?.resetOnSuccess) {
        replaceData(cloneFormValue(initialRef.current));
      }
      defaultsRef.current = cloneFormValue(dataRef.current);
      setDefaultsState(defaultsRef.current);
      status.succeed();
    } catch (submitError) {
      if (isAbortError(submitError)) {
        return;
      }
      throw submitError;
    } finally {
      status.end();
    }
  }

  return {
    data,
    setData,
    errors,
    error: status.error,
    pending: status.pending,
    hasChanges,
    wasSuccessful: status.wasSuccessful,
    recentlySuccessful: status.recentlySuccessful,
    reset,
    setError: setFieldError,
    clearErrors,
    clearError: () => status.setError(null),
    post: (opts?: FormSubmitOptions) => submit('POST', opts),
    put: (opts?: FormSubmitOptions) => submit('PUT', opts),
    patch: (opts?: FormSubmitOptions) => submit('PATCH', opts),
    delete: (opts?: FormSubmitOptions) => submit('DELETE', opts),
  };
}
