import { useState } from 'react';

export function useResettableState<Value>(initialValue: Value) {
  const [source, setSource] = useState(() => initialValue);
  const [value, setValue] = useState(() => initialValue);
  if (!Object.is(source, initialValue)) {
    setSource(() => initialValue);
    setValue(() => initialValue);
  }
  return [value, setValue] as const;
}
