import { useState } from 'react';

export default function Counter({
  initial = 0,
  createdAt,
}: {
  initial?: number;
  createdAt?: Date;
}) {
  const [count, setCount] = useState(initial);
  return (
    <div>
      <span data-testid="island-date">{createdAt?.toISOString()}</span>
      <span data-testid="count">Count: {count}</span>
      <button onClick={() => setCount((c) => c + 1)}>Increment</button>
    </div>
  );
}
