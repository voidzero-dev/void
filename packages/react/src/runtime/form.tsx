import {
  useCallback,
  type FormEvent,
  type FormHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  formErrorMessage,
  formRetryMessage,
  formSubmissionBlocked,
  type FormModel,
  type FormMethod,
  type VoidActionError,
} from 'void/pages-client';

export type FormProps = Omit<
  FormHTMLAttributes<HTMLFormElement>,
  'action' | 'onSubmit' | 'method' | 'onError'
> & {
  form: FormModel<[FormData]>;
  method?: FormMethod;
  renderError?: (error: VoidActionError) => ReactNode;
};

export function Form({
  form,
  method = 'post',
  renderError,
  children,
  ...props
}: FormProps): ReactElement {
  const message = formErrorMessage(form);
  const retry = formRetryMessage(form.error);
  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      if (formSubmissionBlocked(form)) {
        event.preventDefault();
      }
    },
    [form],
  );
  return (
    <form {...props} action={form[method]} aria-busy={form.pending} onSubmit={onSubmit}>
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
