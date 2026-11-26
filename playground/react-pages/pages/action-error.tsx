import { action, useForm, useNavigation, useRouter } from '@void/react';
import { Component, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import type { Props } from './action-error.server.ts';

function SubmitButton({
  children,
  pendingText = 'Submitting...',
}: {
  children: ReactNode;
  pendingText?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? pendingText : children}
    </button>
  );
}

class BoundaryErrorBoundary extends Component<{ children: ReactNode }, { error: unknown | null }> {
  readonly state: { error: unknown | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  render() {
    if (this.state.error) {
      const error =
        this.state.error instanceof Error ? this.state.error : new Error(String(this.state.error));

      return (
        <div role="alert" data-testid="boundary-error" style={{ border: '1px solid crimson' }}>
          <h3>Boundary caught the action error</h3>
          <p>{error.message}</p>
          <button type="button" onClick={() => this.setState({ error: null })}>
            Reset boundary
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

function BoundaryErrorForms() {
  const unauthorizedForm = useForm('/action-error?unauthorized', {});
  const forbiddenForm = useForm('/action-error?forbidden', {});
  const serverForm = useForm('/action-error?server', {});

  return (
    <>
      <p>These should leave form state and be caught by the local React error boundary.</p>
      <form action={unauthorizedForm.post}>
        <SubmitButton>Trigger 401 boundary</SubmitButton>
      </form>
      <form action={forbiddenForm.post}>
        <SubmitButton>Trigger 403 boundary</SubmitButton>
      </form>
      <form action={serverForm.post}>
        <SubmitButton>Trigger 500 boundary</SubmitButton>
      </form>
    </>
  );
}

function ErrorMessage({
  error,
  testId,
}: {
  error: { message: string; status: number; body: unknown } | null;
  testId?: string;
}) {
  if (!error) {
    return null;
  }

  return (
    <p data-testid={testId} style={{ color: 'crimson' }}>
      {error.message}
      {' body='}
      {JSON.stringify(error.body)}
    </p>
  );
}

export default function ActionErrorPage({ successfulSubmissions, lastMessage }: Props) {
  const router = useRouter();
  const navigation = useNavigation();
  const successForm = useForm('/action-error?success', { message: '' });
  const validationForm = useForm('/action-error?validation', { name: '', email: '' });
  const conflictForm = useForm('/action-error?default', {});
  const missingForm = useForm('/action-error?missing', {});
  const rateLimitForm = useForm('/action-error?rateLimit', {});
  const slowForm = useForm('/action-error?slow', { message: 'Slow cancellation check' });
  const slowFormRef = useRef<HTMLFormElement>(null);
  const [helperResult, setHelperResult] = useState('Not run yet.');
  const [cancellationResult, setCancellationResult] = useState('Not run yet.');

  return (
    <div>
      <h1>Action Error Lab</h1>
      <p>
        Successful submissions: <strong>{successfulSubmissions}</strong>
      </p>
      <p>
        Last message: <strong>{lastMessage}</strong>
      </p>
      <p>
        Router navigation: <strong>{navigation.state}</strong>
        {navigation.location ? ` ${navigation.method} ${navigation.location.pathname}` : ''}
      </p>

      <h2>Successful Native Action</h2>
      <form action={successForm.post}>
        <label>
          Message:{' '}
          <input
            name="message"
            value={successForm.data.message}
            onChange={(e) => successForm.setData('message', e.target.value)}
          />
        </label>
        {successForm.errors.message && (
          <p style={{ color: 'crimson' }}>{successForm.errors.message}</p>
        )}
        <p>
          Changes: <strong>{String(successForm.hasChanges)}</strong> Pending:{' '}
          <strong>{String(successForm.pending)}</strong> Successful:{' '}
          <strong>{String(successForm.wasSuccessful)}</strong> Recently successful:{' '}
          <strong>{String(successForm.recentlySuccessful)}</strong>
        </p>
        <SubmitButton>Save with form.post</SubmitButton>{' '}
        <button type="button" onClick={() => successForm.reset()}>
          Reset
        </button>
      </form>

      <h2>Validation Errors</h2>
      <form action={validationForm.post}>
        <div>
          <label>
            Name:{' '}
            <input
              name="name"
              value={validationForm.data.name}
              onChange={(e) => validationForm.setData('name', e.target.value)}
            />
          </label>
          {validationForm.errors.name && (
            <p data-testid="validation-name-error" style={{ color: 'crimson' }}>
              {validationForm.errors.name}
            </p>
          )}
        </div>
        <div>
          <label>
            Email:{' '}
            <input
              name="email"
              value={validationForm.data.email}
              onChange={(e) => validationForm.setData('email', e.target.value)}
            />
          </label>
          {validationForm.errors.email && (
            <p data-testid="validation-email-error" style={{ color: 'crimson' }}>
              {validationForm.errors.email}
            </p>
          )}
        </div>
        <SubmitButton>Submit invalid profile</SubmitButton>{' '}
        <button type="button" onClick={() => validationForm.clearErrors()}>
          Clear validation errors
        </button>
      </form>

      <h2>Call-Site Errors</h2>
      <p>These should stay on this page and populate the form error state.</p>
      <form action={conflictForm.post}>
        <ErrorMessage error={conflictForm.error} testId="conflict-error" />
        <SubmitButton>Trigger conflict</SubmitButton>
      </form>
      <form action={missingForm.post}>
        <ErrorMessage error={missingForm.error} testId="missing-error" />
        <SubmitButton>Trigger 404 missing</SubmitButton>
      </form>
      <form action={rateLimitForm.post}>
        <ErrorMessage error={rateLimitForm.error} testId="rate-limit-error" />
        <SubmitButton>Trigger 429 rate limit</SubmitButton>
      </form>

      <h2>action() Helper</h2>
      <p>{helperResult}</p>
      <button
        type="button"
        onClick={async () => {
          setHelperResult('Running action()...');
          const result = await action('/action-error?missing', { method: 'DELETE' });
          setHelperResult(result.ok ? 'action() succeeded.' : result.error.message);
        }}
      >
        Run action() DELETE with 404
      </button>

      <h2>Boundary Errors</h2>
      <BoundaryErrorBoundary>
        <BoundaryErrorForms />
      </BoundaryErrorBoundary>

      <h2>Cancellation</h2>
      <p>{cancellationResult}</p>
      <form ref={slowFormRef} action={slowForm.post}>
        <label>
          Slow message:{' '}
          <input
            name="message"
            value={slowForm.data.message}
            onChange={(e) => slowForm.setData('message', e.target.value)}
          />
        </label>{' '}
        <SubmitButton pendingText="Waiting...">Submit slow action</SubmitButton>
      </form>
      <button
        type="button"
        onClick={() => {
          setCancellationResult('Started slow action, navigating away...');
          slowFormRef.current?.requestSubmit();
          window.setTimeout(() => {
            void router.visit('/users').catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              setCancellationResult(`Navigation rejected: ${message}`);
            });
          }, 50);
        }}
      >
        Start slow action then navigate to Users
      </button>
    </div>
  );
}
