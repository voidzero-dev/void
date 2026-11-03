import { useRouter } from '@void/react';
import { useState } from 'react';

// Rendered only in the browser, so the first render can use the query.
export default function RouterUrlClientPage() {
  const router = useRouter();
  const [firstSearch] = useState(() => router.url.search);
  return <p data-testid="router-first-search">{firstSearch}</p>;
}
