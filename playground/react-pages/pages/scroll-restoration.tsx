import { action, Form, Link, useForm } from '@void/react';
import { startTransition } from 'react';
import type { Props } from './scroll-restoration.server.ts';

export default function ScrollRestorationPage({ requestId, page }: Props) {
  const form = useForm('/scroll-restoration?touch', {});
  return (
    <div>
      <h1>Scroll restoration</h1>
      <p>Scroll down, follow a link, then use the browser Back button.</p>
      <output data-testid="scroll-request">{requestId}</output>
      <output data-testid="scroll-page">{page}</output>
      {Array.from({ length: 80 }, (_, index) => {
        const row = index + 1;
        return (
          <section key={row} data-testid={`scroll-row-${row}`} style={{ height: '120px' }}>
            <h2 style={{ margin: 0 }}>Row {row}</h2>
            <a href="/users">Go to Users</a>
            <Link href="/users">Visit Users</Link>
            {row === 30 && (
              <div>
                <button
                  onClick={() =>
                    startTransition(async () => {
                      await action('/scroll-restoration?touch');
                    })
                  }
                >
                  Update action
                </button>
                <button
                  onClick={() =>
                    startTransition(async () => {
                      await action('/scroll-restoration?touch', { preserveScroll: false });
                    })
                  }
                >
                  Reset action scroll
                </button>
                <button
                  onClick={() =>
                    startTransition(async () => {
                      await action('/scroll-restoration?redirect');
                    })
                  }
                >
                  Redirect action
                </button>
                <Form form={form}>
                  <button type="submit">Update form</button>
                </Form>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
