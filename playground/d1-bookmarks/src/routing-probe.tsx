import { useState } from 'react';
import { RUN_COUNTS, serializeError, type RoutingProbe } from './demo.ts';
import { MetadataDetails } from './metadata.tsx';
import { SourceLink } from './source-link.tsx';

export function RoutingProbePanel({
  running,
  setRunning,
  count,
  setCount,
}: {
  running: boolean;
  setRunning: (value: boolean) => void;
  count: number;
  setCount: (value: number) => void;
}) {
  const [results, setResults] = useState<RoutingProbe[]>([]);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function run(rounds: number) {
    setRunning(true);
    setResults([]);
    setProgress(0);
    setError(null);
    try {
      for (let round = 0; round < rounds; round++) {
        const response = await fetch('/api/routing', {
          cache: 'no-store',
          credentials: 'same-origin',
        });
        const text = await response.text();
        let body: RoutingProbe;
        try {
          body = JSON.parse(text);
        } catch {
          throw new Error(
            `HTTP ${response.status}; request ID: ${response.headers.get('cf-ray') ?? 'unavailable'}\n${text}`,
          );
        }
        if (body.path !== 'void-run') throw new Error(`HTTP ${response.status}\n${text}`);
        setResults((previous) => [...previous, body]);
        setProgress(round + 1);
        if (!response.ok || body.error) break;
      }
    } catch (cause) {
      setError(JSON.stringify(serializeError(cause), null, 2));
    } finally {
      setRunning(false);
    }
  }

  return (
    <section>
      <h2>Read-only routing baseline</h2>
      <p>
        No saves, no pressure, no bookmark propagation. Each probe issues one SELECT through a fresh{' '}
        <code>first-unconstrained</code> session using <code>void/db .run()</code>. Probes are
        sequential. An empty result still measures routing, not staleness.
      </p>
      <pre>{'SELECT revision, saved_at FROM bookmark_profiles ORDER BY id LIMIT 1'}</pre>
      <p>
        <SourceLink file="routes/api/routing.ts" />
      </p>
      <p>
        <button disabled={running} onClick={() => void run(1)}>
          Probe once
        </button>{' '}
        <label>
          Probes{' '}
          <select
            value={count}
            disabled={running}
            onChange={(event) => setCount(Number(event.target.value))}
          >
            {RUN_COUNTS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>{' '}
        <button disabled={running} onClick={() => void run(count)}>
          Run probes
        </button>{' '}
        {progress} probes completed
      </p>
      {error && (
        <details open>
          <summary>Probe request failed</summary>
          <pre>{error}</pre>
        </details>
      )}
      <p>
        <strong>void-run</strong>:{' '}
        {
          results.filter((result) => !result.error && result.metadata?.served_by_primary === true)
            .length
        }{' '}
        primary ·{' '}
        {
          results.filter((result) => !result.error && result.metadata?.served_by_primary === false)
            .length
        }{' '}
        replica ·{' '}
        {
          results.filter(
            (result) => !result.error && typeof result.metadata?.served_by_primary !== 'boolean',
          ).length
        }{' '}
        unknown · {results.filter((result) => result.error).length} errors
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Probe</th>
              <th>Worker</th>
              <th>D1 target / region / colo</th>
              <th>Attempts</th>
              <th>Rows returned</th>
              <th>Wall time</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {results.map((result, index) => (
              <tr key={index} className={result.error ? 'errored' : undefined}>
                <td>{index + 1}</td>
                <td>{result.workerColo ?? 'unknown'}</td>
                <td>
                  {result.error
                    ? 'failed'
                    : result.metadata?.served_by_primary === true
                      ? 'primary'
                      : result.metadata?.served_by_primary === false
                        ? 'replica'
                        : 'unknown'}{' '}
                  / {String(result.metadata?.served_by_region ?? 'unknown')} /{' '}
                  {String(result.metadata?.served_by_colo ?? 'unknown')}
                </td>
                <td>{String(result.metadata?.total_attempts ?? 'not reported')}</td>
                <td>{result.error ? '—' : result.rows.length}</td>
                <td>{result.elapsedMs.toFixed(1)} ms</td>
                <td>
                  <MetadataDetails
                    metadata={result.metadata ?? undefined}
                    elapsedMs={result.elapsedMs}
                  />
                  <details>
                    <summary>Rows / bookmark / error</summary>
                    <pre>
                      {JSON.stringify(
                        { rows: result.rows, bookmark: result.bookmark, error: result.error },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
