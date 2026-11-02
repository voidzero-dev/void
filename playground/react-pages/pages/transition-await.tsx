import { action, useForm, useRouter } from '@void/react';
import { use, useActionState, useEffect, useOptimistic, useState, useTransition } from 'react';
import { useFormStatus } from 'react-dom';
import type { Props } from './transition-await.server.ts';

function FormButton({ testId }: { testId: string }) {
  const { pending } = useFormStatus();
  return <button data-testid={testId}>{pending ? 'pending' : 'run'}</button>;
}

export default function TransitionAwaitPage({ revision }: Props) {
  const router = useRouter();
  const [operation, setOperation] = useState('action');
  const [pending, startTransition] = useTransition();
  const [plainPending, setPlainPending] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [optimisticRevision, setOptimisticRevision] = useOptimistic(revision);
  const [dataReady, setDataReady] = useState(false);
  const [holdRender, setHoldRender] = useState(false);
  const [renderGate] = useState(() => {
    let resolve!: () => void;
    const promise = new Promise<void>((finish) => {
      resolve = finish;
    });
    return { promise, resolve };
  });
  useEffect(() => {
    const finishRender = () => renderGate.resolve();
    window.addEventListener('finish-render', finishRender);
    return () => window.removeEventListener('finish-render', finishRender);
  }, [renderGate]);

  if (holdRender && revision === 'updated') {
    use(renderGate.promise);
  }

  async function run() {
    if (operation === 'action') {
      const result = await action('/transition-await?ping');
      if (!result.ok) {
        throw result.error;
      }
    } else {
      // A mutation performed outside Void's action client, like an auth SDK call.
      await fetch('/transition-await?ping', { method: 'POST' });
      if (operation === 'visit') {
        await router.visit('/transition-await?visited=1', {
          preserveState: true,
          resolveOn: 'data',
        });
      } else {
        await router.refresh({ resolveOn: 'data' });
      }
    }
    startTransition(() => setCompleted(true));
  }

  const [, dispatchAction, actionPending] = useActionState(async () => {
    await run();
    return true;
  }, false);
  const form = useForm(
    '/transition-await?ping',
    {},
    {
      onSuccess: () => startTransition(() => setCompleted(true)),
    },
  );

  return (
    <section>
      <h1>Transition Await</h1>
      <select
        data-testid="operation"
        value={operation}
        onChange={(event) => setOperation(event.target.value)}
      >
        <option value="action">Action</option>
        <option value="visit">Visit</option>
        <option value="refresh">Refresh</option>
      </select>
      <output data-testid="revision">{revision}</output>
      <output data-testid="completed">{completed ? 'complete' : 'waiting'}</output>
      <output data-testid="optimistic">{optimisticRevision}</output>
      <output data-testid="data-ready">{dataReady ? 'ready' : 'waiting'}</output>
      <button data-testid="transition" onClick={() => startTransition(async () => run())}>
        {pending ? 'pending' : 'run'}
      </button>
      <form action={async () => run()}>
        <FormButton testId="form-action" />
      </form>
      <form action={dispatchAction}>
        <button data-testid="action-state">{actionPending ? 'pending' : 'run'}</button>
      </form>
      <button
        data-testid="plain"
        onClick={async () => {
          setPlainPending(true);
          try {
            await run();
          } finally {
            setPlainPending(false);
          }
        }}
      >
        {plainPending ? 'pending' : 'run'}
      </button>
      <form action={form.post}>
        <FormButton testId="use-form" />
      </form>
      <button
        data-testid="async-contract"
        onClick={() =>
          startTransition(async () => {
            setOptimisticRevision('saving');
            setHoldRender(true);
            await run();
            await new Promise<void>((resolve) => {
              window.addEventListener('finish-action', () => resolve(), { once: true });
              setDataReady(true);
            });
          })
        }
      >
        {pending ? 'pending' : 'run'}
      </button>
    </section>
  );
}
