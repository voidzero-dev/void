import { Fragment, useEffect, useState } from 'react';
import {
  DEFAULT_PRESSURE_MIB,
  errorObservation,
  experimentForQuery,
  experimentLabel,
  PRESSURE_OPTIONS,
  pressureLabel,
  RUN_COUNTS,
  type Observation,
  type TrialError,
} from './demo.ts';
import { MetadataDetails } from './metadata.tsx';
import { RoutingProbePanel } from './routing-probe.tsx';
import { SourceLink } from './source-link.tsx';

export default function DemoPage(props: Observation) {
  // Keyed by the variant so client navigation never mixes the two trial histories.
  return <Trials key={props.variant} initial={props} />;
}

function Trials({ initial }: { initial: Observation }) {
  const [results, setResults] = useState<Array<Observation>>([]);
  const [running, setRunning] = useState(false);
  const [trialsRunning, setTrialsRunning] = useState(false);
  const [trialCount, setTrialCount] = useState(20);
  const [runSize, setRunSize] = useState(20);
  const [pressure, setPressure] = useState(true);
  const [pressureMiB, setPressureMiB] = useState(initial.pressureMiB || DEFAULT_PRESSURE_MIB);
  const [experiment, setExperiment] = useState(initial.experiment);
  const [probeCount, setProbeCount] = useState(20);
  const [settingsReady, setSettingsReady] = useState(false);
  useEffect(() => {
    let saved: Record<string, string> = {};
    try {
      saved = JSON.parse(localStorage.getItem('d1-demo-settings-v1') ?? '{}') ?? {};
    } catch {
      // Browser storage may be unavailable. The URL still persists selections.
    }
    const params = new URLSearchParams(location.search);
    const value = (key: string) => params.get(key) ?? saved[key];
    const timing = value('experiment');
    if (timing === 'redirect' || timing === 'immediate') setExperiment(timing);
    const trials = Number(value('trials'));
    if (RUN_COUNTS.some((count) => count === trials)) setTrialCount(trials);
    const probes = Number(value('probes'));
    if (RUN_COUNTS.some((count) => count === probes)) setProbeCount(probes);
    const size = Number(
      params.get('size') ?? params.get('pressure') ?? saved.size ?? saved.pressure,
    );
    if (PRESSURE_OPTIONS.some((option) => option === size)) setPressureMiB(size);
    if (value('pressure') !== undefined) setPressure(Number(value('pressure')) > 0);
    setSettingsReady(true);
  }, []);
  useEffect(() => {
    if (!settingsReady) return;
    const settings = {
      experiment,
      trials: String(trialCount),
      probes: String(probeCount),
      pressure: String(pressure ? pressureMiB : 0),
      size: String(pressureMiB),
    };
    try {
      localStorage.setItem('d1-demo-settings-v1', JSON.stringify(settings));
    } catch {
      /* URL fallback. */
    }
    const url = new URL(location.href);
    url.searchParams.delete('reads');
    url.searchParams.delete('writes');
    for (const [key, value] of Object.entries(settings)) url.searchParams.set(key, value);
    history.replaceState(history.state, '', url);
  }, [settingsReady, experiment, trialCount, probeCount, pressure, pressureMiB]);
  const controlsDisabled = running || !settingsReady;
  const immediate = experiment === 'immediate';
  const fixed = initial.variant === 'with-bookmark';
  const latest = results.at(-1) ?? initial;
  const fresh = results.filter((result) => result.outcome === 'fresh').length;
  const stale = results.filter((result) => result.outcome === 'stale').length;
  const errored = results.filter((result) => result.outcome === 'errored').length;

  async function runTrials(count: number) {
    setRunSize(count);
    setRunning(true);
    setTrialsRunning(true);
    setResults([]);
    try {
      for (let index = 0; index < count; index++) {
        // Redirect mode follows the 303; immediate mode writes and reads in this POST.
        const response = await fetch(
          `/api/${initial.variant}?experiment=${experiment}${pressure ? `&pressure=${pressureMiB}` : ''}`,
          {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
          },
        );
        if (!response.ok) {
          const text = await response.text();
          let failure = errorObservation(
            initial.variant,
            pressure ? pressureMiB : 0,
            {
              phase: immediate ? 'request' : response.redirected ? 'read' : 'save',
              status: response.status,
              requestId: response.headers.get('cf-ray'),
              causes: [{ name: 'HTTP error', message: text || response.statusText, stack: null }],
            },
            null,
            experiment,
          );
          try {
            const body: Observation = JSON.parse(text);
            if (body.outcome === 'errored' && body.error) failure = body;
          } catch {
            // Infrastructure failures can return plain text or HTML instead of app JSON.
          }
          setResults((previous) => [...previous, failure]);
          break;
        }
        const observation: Observation = await response.json();
        setResults((previous) => [...previous, observation]);
      }
    } catch (cause) {
      const failure = errorObservation(
        initial.variant,
        pressure ? pressureMiB : 0,
        {
          phase: 'request',
          status: null,
          requestId: null,
          causes: [
            {
              name: cause instanceof Error ? cause.name : 'Error',
              message: cause instanceof Error ? cause.message : String(cause),
              stack: cause instanceof Error ? (cause.stack ?? null) : null,
            },
          ],
        },
        null,
        experiment,
      );
      setResults((previous) => [...previous, failure]);
    } finally {
      setRunning(false);
      setTrialsRunning(false);
    }
  }

  return (
    <>
      <h1>{fixed ? 'Manual bookmark propagation' : 'Without bookmark propagation'}</h1>
      <p>
        <strong>Selected write/read experiment: {experimentLabel(experiment)}</strong>. Settings are
        shared between variants and saved in this browser and URL. Explicit URL settings take
        precedence.
      </p>
      <RoutingProbePanel
        running={controlsDisabled}
        setRunning={setRunning}
        count={probeCount}
        setCount={setProbeCount}
      />
      <hr />
      <h2>Write/read experiment</h2>
      <p>
        <label>
          Read timing{' '}
          <select
            value={experiment}
            disabled={controlsDisabled}
            onChange={(event) => {
              setExperiment(experimentForQuery(event.target.value));
              setResults([]);
            }}
          >
            <option value="redirect">Browser redirect (cookie)</option>
            <option value="immediate">Immediate server read</option>
          </select>
        </label>
      </p>
      <p>
        {immediate
          ? fixed
            ? 'Each trial writes, then reads once through a new session initialized with that write’s bookmark, passed directly in server code.'
            : 'Each trial writes, then reads once through a new unconstrained session. The write’s bookmark is not passed to the read.'
          : fixed
            ? 'The POST returns its bookmark in a cookie. The redirected GET resumes from that bookmark.'
            : 'The POST and redirected GET have independent, unconstrained sessions. No bookmark is sent back.'}
      </p>
      <pre>
        {immediate
          ? fixed
            ? `// After the write completes on writer:
const bookmark = getBookmark(writer);
if (!bookmark) throw new Error('Missing write bookmark');
const reader = createDb(c.env.DB, { session: bookmark });
// Read once through reader, not writer.`
            : `// After the write completes on writer:
const reader = createDb(c.env.DB, { session: 'first-unconstrained' });
// Read once through reader, not writer.`
          : fixed
            ? `setSession(getCookie(c, 'd1-demo-bookmark') ?? 'first-unconstrained');
await next();
const bookmark = getBookmark();
if (bookmark) setCookie(c, 'd1-demo-bookmark', bookmark, options);`
            : '// No setSession() call; no bookmark cookie is read or written.'}
      </pre>
      {immediate && (
        <p>
          Both variants use the same write and read query with separate sessions. There is no
          browser round trip between them. Each trial finishes before the next starts. D1 still
          chooses each read's destination.
        </p>
      )}
      <p>
        <SourceLink file="middleware/database.ts" /> · <SourceLink file="src/database.ts" />
      </p>
      <hr />
      <p>
        <label>
          <input
            type="checkbox"
            checked={pressure}
            disabled={controlsDisabled}
            onChange={(event) => setPressure(event.target.checked)}
          />{' '}
          Add replication pressure
        </label>{' '}
        <label>
          Pressure per trial{' '}
          <select
            value={pressureMiB}
            disabled={controlsDisabled || !pressure}
            onChange={(event) => setPressureMiB(Number(event.target.value))}
          >
            {PRESSURE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {pressureLabel(size)}
              </option>
            ))}
          </select>
        </label>{' '}
        — {pressure ? pressureMiB * trialCount : 0} MiB per {trialCount} trials. This does not
        guarantee lag. Use a disposable database.
      </p>
      {pressure && (
        <p>
          The revision and unrelated BLOB rows are saved in one transaction, followed by one read.
          No database operations run in parallel.
        </p>
      )}
      <div className="controls">
        <label>
          Trials{' '}
          <select
            value={trialCount}
            disabled={controlsDisabled}
            onChange={(event) => setTrialCount(Number(event.target.value))}
          >
            {RUN_COUNTS.map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={controlsDisabled}
          onClick={() => void runTrials(trialCount)}
        >
          {trialsRunning ? `Running… ${results.length}/${runSize}` : 'Run trials'}
        </button>
      </div>
      <section className={`result ${latest.outcome}`} aria-live="polite">
        <h2>
          {latest.outcome === 'errored'
            ? 'Errored — trial did not complete'
            : latest.outcome === 'idle'
              ? 'Ready to run trials'
              : latest.outcome === 'fresh'
                ? 'Fresh read'
                : 'Stale read — save acknowledged, but not visible'}
        </h2>
        {latest.error && <p role="alert">{failureMessage(latest.error)}</p>}
        <dl>
          <dt>Read timing</dt>
          <dd>{experimentLabel(latest.experiment)}</dd>
          <dt>Expected revision (write receipt)</dt>
          <dd>
            <code>
              {latest.expected ??
                (latest.error ? 'Save not acknowledged' : 'No save in this URL yet')}
            </code>
          </dd>
          <dt>Observed revision (database read)</dt>
          <dd>
            <code>
              {latest.observed ?? (latest.error ? 'Read did not complete' : 'No row visible')}
            </code>
          </dd>
          <dt>Observed saved time</dt>
          <dd>{latest.savedAt ?? '—'}</dd>
          <dt>Replication pressure</dt>
          <dd>{latest.pressureMiB ? `${pressureLabel(latest.pressureMiB)} per trial` : 'Off'}</dd>
          <dt>Read served by</dt>
          <dd>
            {latest.error
              ? 'No completed read'
              : latest.servedByPrimary === null
                ? 'Unknown (local D1 does not report this)'
                : latest.servedByPrimary
                  ? 'Primary'
                  : 'Replica'}{' '}
            · {latest.servedByRegion ?? 'unknown region'}
          </dd>
          <dt>Worker placement / colo</dt>
          <dd>{latest.workerColo ?? 'Unknown / local'}</dd>
          {latest.experiment === 'immediate' && (
            <>
              <dt>Write bookmark</dt>
              <dd>
                <code>{latest.writeBookmark ?? 'None'}</code>
              </dd>
            </>
          )}
          <dt>
            {latest.experiment === 'immediate' ? 'Read session bookmark' : 'Incoming bookmark'}
          </dt>
          <dd>
            <code>{latest.incomingBookmark ?? (fixed ? 'None yet' : 'Not carried (control)')}</code>
          </dd>
          <dt>Outgoing bookmark</dt>
          <dd>
            <code>{latest.outgoingBookmark ?? 'None'}</code>
          </dd>
          {latest.error && (
            <>
              <dt>Error</dt>
              <dd>
                <ErrorDetails error={latest.error} />
              </dd>
            </>
          )}
        </dl>
        <MetadataDetails metadata={latest.metadata} elapsedMs={latest.elapsedMs} />
      </section>
      <hr />
      <h2>Trial history</h2>
      <p>
        {fresh + stale} completed · <span className="fresh-count">{fresh} fresh</span> ·{' '}
        <span className="stale-count">{stale} stale</span> ·{' '}
        <span className="error-count">{errored} errored</span>
      </p>
      <ReadCounts reads={results} />
      <div className="table-scroll">
        <table className="trial-history">
          <thead>
            <tr>
              <th>Trial</th>
              <th>Result</th>
              <th>Read target</th>
              <th>Expected</th>
              <th>Observed</th>
            </tr>
          </thead>
          <tbody>
            {results.map((result, index) => (
              <Fragment key={index}>
                <tr className={`trial-row ${result.outcome}`}>
                  <td>{index + 1}</td>
                  <td>{result.outcome}</td>
                  <td>
                    {result.error
                      ? '—'
                      : result.servedByPrimary === null
                        ? 'unknown'
                        : result.servedByPrimary
                          ? 'primary'
                          : 'replica'}{' '}
                    / {result.servedByRegion ?? 'local'}
                  </td>
                  <td>
                    <code>{result.expected}</code>
                  </td>
                  <td>
                    <code>{result.observed ?? (result.error ? '—' : 'missing')}</code>
                  </td>
                </tr>
                {result.metadata && (
                  <tr>
                    <td colSpan={5}>
                      <MetadataDetails metadata={result.metadata} elapsedMs={result.elapsedMs} />
                    </td>
                  </tr>
                )}
                {result.error && (
                  <tr className="error-details">
                    <td colSpan={5}>
                      <ErrorDetails error={result.error} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="notice">
        Replica lag is not guaranteed. Both variants will usually look fresh locally. Run in one tab
        without concurrent writes; the expected revision is a comparison value, not a bookmark.
        Trials stay in this page’s memory and reset when you leave it.
      </p>
    </>
  );
}

function ReadCounts({ reads }: { reads: Observation[] }) {
  const completed = reads.filter((read) => read.outcome === 'fresh' || read.outcome === 'stale');
  return (
    <p className="read-counts">
      Reads: {completed.filter((read) => read.servedByPrimary === true).length} primary ·{' '}
      {completed.filter((read) => read.servedByPrimary === false).length} replica ·{' '}
      <span className="stale-count">
        {
          completed.filter((read) => read.servedByPrimary === false && read.outcome === 'stale')
            .length
        }{' '}
        stale replica
      </span>{' '}
      · {completed.filter((read) => read.servedByPrimary === null).length} unknown target ·{' '}
      <span className="error-count">
        {reads.filter((read) => read.outcome === 'errored').length} read errors
      </span>
    </p>
  );
}

function failureMessage(error: TrialError): string {
  const status = error.status === null ? 'Request failed' : `HTTP ${error.status}`;
  const outcome =
    error.phase === 'probe'
      ? 'The read-only probe failed; no write was attempted.'
      : error.phase === 'save'
        ? 'Save was not acknowledged; the write may have committed.'
        : error.phase === 'read'
          ? 'Save was acknowledged, but the follow-up read failed.'
          : 'The request did not complete; the write outcome may be unknown.';
  return `${status}. ${outcome}`;
}

function ErrorDetails({ error }: { error: TrialError }) {
  return (
    <details>
      <summary>{error.causes[0]?.message || 'Error details'}</summary>
      <p>{failureMessage(error)}</p>
      <p>
        Phase: {error.phase} · Request ID: <code>{error.requestId ?? 'Unavailable'}</code>
      </p>
      {error.causes.map((cause, index) => (
        <div key={index}>
          <p>
            <strong>
              {index === 0 ? 'Error' : `Cause ${index}`}: {cause.name}
            </strong>
          </p>
          <pre>{cause.message}</pre>
          <pre>{cause.stack ?? 'No stack trace available.'}</pre>
        </div>
      ))}
    </details>
  );
}
