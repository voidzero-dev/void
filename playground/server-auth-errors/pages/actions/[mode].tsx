import { Form, useForm } from '@void/react';
import { useState } from 'react';
import type { Props } from './[mode].server.ts';

export default function ActionExample({ mode, email }: Props) {
  const [throwOnError, setThrowOnError] = useState(false);
  const path = `/actions/${mode}`;
  const form = useForm('/actions/[mode]', {}, { params: { mode }, throwOnError });
  return (
    <section>
      <h1>Action: {mode}</h1>
      <p>
        {email ? `Signed in as ${email}.` : 'Anonymous visitor.'} The loader allows everyone; the
        POST action checks auth.
      </p>
      <p>
        Both buttons submit to the same action. Successful auth redirects to the success page with
        303; no data is changed.
      </p>
      {mode === 'require-auth' ? (
        <>
          <p>
            When signed out, a native form displays a plain-text 401. The enhanced form can keep
            that failure inline, or throw it to the error boundary.
          </p>
          <label>
            <input
              type="checkbox"
              checked={throwOnError}
              onChange={(event) => setThrowOnError(event.target.checked)}
            />{' '}
            Throw enhanced-form errors to the boundary (useForm default)
          </label>
        </>
      ) : (
        <p>
          When signed out, both forms redirect to login with 303. Signing in returns to this form;
          it does not replay the rejected action.
        </p>
      )}
      <div className="action-forms">
        <form method="post" action={path}>
          <button>Native form POST</button>
        </form>
        <Form form={form} renderError={(error) => `${error.status}: ${error.message}`}>
          <button disabled={form.pending}>Enhanced form POST</button>
        </Form>
      </div>
    </section>
  );
}
