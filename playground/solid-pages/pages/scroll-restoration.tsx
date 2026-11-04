import { action, Form, Link, useForm } from '@void/solid';
import { For } from 'solid-js';
import type { Props } from './scroll-restoration.server.ts';

export default function ScrollRestorationPage(props: Props) {
  const form = useForm('/scroll-restoration?touch', {});
  const rows = Array.from({ length: 80 }, (_, index) => index + 1);

  return (
    <div>
      <h1>Scroll restoration</h1>
      <p>Scroll down, follow a link, then use the browser Back button.</p>
      <output data-testid="scroll-request">{props.requestId}</output>
      <For each={rows}>
        {(row) => (
          <section data-testid={`scroll-row-${row}`} style={{ height: '120px' }}>
            <h2 style={{ margin: 0 }}>Row {row}</h2>
            <a href="/users">Go to Users</a>
            <Link href="/users">Visit Users</Link>
            {row === 30 && (
              <div>
                <button onClick={() => void action('/scroll-restoration?touch')}>
                  Update action
                </button>
                <button
                  onClick={() =>
                    void action('/scroll-restoration?touch', { preserveScroll: false })
                  }
                >
                  Reset action scroll
                </button>
                <button onClick={() => void action('/scroll-restoration?redirect')}>
                  Redirect action
                </button>
                <Form form={form}>
                  <button type="submit">Update form</button>
                </Form>
              </div>
            )}
          </section>
        )}
      </For>
    </div>
  );
}
