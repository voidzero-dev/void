import { Label } from './Label.tsx';
export function Action({ invoke, children }: { invoke: () => void; children: string }) {
  return <button onclick={invoke}>{children}</button>;
}
export function Counter({ initial = 0 }: { initial?: number }) {
  let count = initial;
  let message = 'Try the delayed update';
  return (
    <section class="card">
      <h2>Independent state and callbacks</h2>
      <p class="count">
        <Label>Count: {count}</Label>
      </p>
      <Action
        invoke={() => {
          count++;
        }}
      >
        Increment
      </Action>
      <Action
        invoke={() => {
          count--;
        }}
      >
        Decrement
      </Action>
      <button
        onclick={async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          message = 'Updated after await';
        }}
      >
        Delayed update
      </button>
      <p class="message">{message}</p>
      {count > 2 ? <strong class="milestone">Three or more!</strong> : null}
      <ul>
        {Array.from({ length: Math.max(0, count) }, (_, index) => (
          <li>Item {index + 1}</li>
        ))}
      </ul>
      <style>{`
        .card {
          background: white;
          border: 1px solid #d6dfd1;
          border-radius: 12px;
          padding: 24px;
          margin: 24px 0;
        }
        .milestone { color: #31794b; }
      `}</style>
    </section>
  );
}
