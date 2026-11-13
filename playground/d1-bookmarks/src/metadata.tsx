export function MetadataDetails({
  metadata,
  elapsedMs,
}: {
  metadata?: Record<string, unknown>;
  elapsedMs?: number;
}) {
  if (!metadata) return null;
  return (
    <details>
      <summary>
        D1 metadata · attempts: {String(metadata.total_attempts ?? 'not reported')} ·{' '}
        {elapsedMs?.toFixed(1) ?? '—'} ms wall time
      </summary>
      <pre>{JSON.stringify(metadata, null, 2)}</pre>
    </details>
  );
}
