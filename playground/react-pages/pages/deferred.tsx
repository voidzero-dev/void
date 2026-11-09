import { Suspense, use, useId } from 'react';
import type { Props } from './deferred.server.ts';

function Stats({ stats }: Pick<Props, 'stats'>) {
  const resolved = use(stats);

  return (
    <div data-testid="deferred-resolved">
      Count: {resolved.count}
      <span data-testid="deferred-date">{resolved.date.toISOString()}</span>
    </div>
  );
}

export default function DeferredPage({ title, stats, createdAt }: Props) {
  const titleId = useId();

  return (
    <div>
      <h1
        id={titleId}
        data-testid="deferred-title"
        ref={(element) => {
          if (element) {
            element.dataset.clientId = titleId;
          }
        }}
      >
        {title}
      </h1>
      <p data-testid="page-date">{createdAt.toISOString()}</p>
      <Suspense fallback={<div data-testid="deferred-loading">Loading stats...</div>}>
        <Stats stats={stats} />
      </Suspense>
    </div>
  );
}
