import { createSignal } from 'solid-js';

export default function Counter(props: { initial?: number; createdAt?: Date }) {
  const [count, setCount] = createSignal(props.initial ?? 0);
  return (
    <div>
      <span data-testid="island-date">{props.createdAt?.toISOString()}</span>
      <span data-testid="count">Count: {count()}</span>
      <button onClick={() => setCount((c) => c + 1)}>Increment</button>
    </div>
  );
}
