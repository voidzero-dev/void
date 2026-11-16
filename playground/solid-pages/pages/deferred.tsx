import type { Props } from './deferred.server.ts';

export default function DeferredPage(props: Props) {
  return (
    <div>
      <h1>{props.title}</h1>
      <p data-testid="page-date">{props.createdAt.toISOString()}</p>
      {props.stats.loading ? (
        <div data-testid="deferred-loading">Loading stats...</div>
      ) : props.stats.error ? (
        <div data-testid="deferred-error">Error: {props.stats.error.message}</div>
      ) : (
        <div data-testid="deferred-resolved">
          Count: {props.stats.value.count}
          <span data-testid="deferred-date">{props.stats.value.date.toISOString()}</span>
        </div>
      )}
    </div>
  );
}
