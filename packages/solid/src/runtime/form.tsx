import { createEffect, createSignal, onCleanup, splitProps } from 'solid-js';
import type { JSX } from 'solid-js';
import {
  formErrorMessage,
  formRetryMessage,
  formSubmissionBlocked,
  scheduleFormRetry,
} from 'void/pages-client';
import type { FormModel, FormMethod, VoidActionError } from 'void/pages-client';

export type FormProps = Omit<
  JSX.FormHTMLAttributes<HTMLFormElement>,
  'action' | 'onSubmit' | 'method' | 'onError'
> & {
  form: FormModel;
  method?: FormMethod;
  renderError?: (error: VoidActionError) => JSX.Element;
};
export function Form(props: FormProps): JSX.Element {
  const [local, rest] = splitProps(props, ['form', 'method', 'renderError', 'children']);
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    const cancel = scheduleFormRetry(local.form.error, () => setNow(Date.now()));
    onCleanup(cancel);
  });
  return (
    <form
      {...rest}
      aria-busy={local.form.pending}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!formSubmissionBlocked(local.form, now())) {
          await local.form[local.method ?? 'post']();
        }
      }}
    >
      {formErrorMessage(local.form) && (
        <div role="alert" data-void-form-error>
          {local.form.error && local.renderError
            ? local.renderError(local.form.error)
            : formErrorMessage(local.form)}
          {formRetryMessage(local.form.error) && <p>{formRetryMessage(local.form.error)}</p>}
        </div>
      )}
      {local.children}
    </form>
  );
}
