import { useEffect, useState } from 'hono/jsx';
import type { Child, JSX, PropsWithChildren } from 'hono/jsx';
import type { JSX as JSXRuntime } from 'hono/jsx/jsx-runtime';
import {
  formErrorMessage,
  formRetryMessage,
  formSubmissionBlocked,
  scheduleFormRetry,
  type FormModel,
  type FormMethod,
  type VoidActionError,
} from 'void/pages-client';

export type FormProps = PropsWithChildren<
  Omit<JSX.IntrinsicElements['form'], 'action' | 'onSubmit' | 'method' | 'onError'> & {
    form: FormModel;
    method?: FormMethod;
    renderError?: (error: VoidActionError) => Child;
  }
>;

export function Form({
  form,
  method = 'post',
  renderError,
  children,
  ...props
}: FormProps): JSXRuntime.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => scheduleFormRetry(form.error, () => setNow(Date.now())), [form.error]);
  const message = formErrorMessage(form);
  const retry = formRetryMessage(form.error);
  return (
    <form
      {...props}
      // Hono JSX omits an attribute whose value is `false`.
      aria-busy={form.pending ? 'true' : 'false'}
      onSubmit={async (event: Event) => {
        event.preventDefault();
        if (!formSubmissionBlocked(form, now)) {
          await form[method]();
        }
      }}
    >
      {message && (
        <div role="alert" data-void-form-error>
          {form.error && renderError ? renderError(form.error) : message}
          {retry && <p>{retry}</p>}
        </div>
      )}
      {children}
    </form>
  );
}
