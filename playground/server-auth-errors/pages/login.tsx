import { useRouter } from '@void/react';
import { useState, type FormEvent } from 'react';
import { auth } from 'void/client/react';
import { demoUser } from '../src/demo-user.ts';
import type { Props } from './login.server.ts';

export default function Login({ next }: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();
  const { refetch } = auth.useSession();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      const response = await fetch('/api/demo-login', { method: 'POST' });
      if (!response.ok) {
        throw new Error('Could not start the demo session.');
      }
      await refetch();
      await router.visit(next);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not sign in.');
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <h1>Sign in</h1>
      <form className="auth-form" onSubmit={submit}>
        <label>
          Email <input type="email" disabled value={demoUser.email} />
        </label>
        <label>
          Password <input type="password" disabled value={demoUser.password} />
        </label>
        <button disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
  );
}
