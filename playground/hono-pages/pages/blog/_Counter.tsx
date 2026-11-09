import { useState } from 'hono/jsx';

export default function Counter(props: { initial?: number }) {
  const [count, setCount] = useState(props.initial ?? 0);
  return (
    <div>
      <span data-testid="count">Count: {count}</span>
      <button onClick={() => setCount((c) => c + 1)}>Increment</button>
    </div>
  );
}
