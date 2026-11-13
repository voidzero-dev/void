import { useEffect, useRef, useState } from 'react';
import { fontCounts, type FontMemorySample } from '../src/font-memory.ts';

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const metrics = [
  ['rss', 'Process RSS', '#2563eb'],
  ['external', 'External / Wasm', '#dc2626'],
  ['heapUsed', 'JS heap used', '#059669'],
  ['arrayBuffers', 'Array buffers', '#7c3aed'],
] as const;

async function request(action?: string, count?: number): Promise<FontMemorySample> {
  const response = await fetch(
    '/api/font-memory',
    action
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, count }),
        }
      : { cache: 'no-store' },
  );
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }
  return data;
}

export default function FontMemory() {
  const [count, setCount] = useState(100);
  const [sample, setSample] = useState<FontMemorySample>();
  const [baseline, setBaseline] = useState<FontMemorySample>();
  const [history, setHistory] = useState<Array<FontMemorySample>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(false);

  function record(next: FontMemorySample) {
    if (!alive.current) {
      return;
    }
    setSample(next);
    setHistory((previous) => [
      ...previous.filter((entry) => entry.startedAt === next.startedAt).slice(-239),
      next,
    ]);
    setBaseline((previous) => (previous?.startedAt === next.startedAt ? previous : undefined));
  }

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        record(await request());
      } catch (cause) {
        if (alive.current) {
          setError(String(cause));
        }
      }
      if (alive.current) {
        timer = setTimeout(poll, 500);
      }
    }
    void poll();
    return () => {
      alive.current = false;
      clearTimeout(timer);
    };
  }, []);

  async function act(action: string) {
    setError('');
    if (action !== 'stop') {
      setBusy(true);
    }
    try {
      const next = await request(action, count);
      record(next);
      if (action === 'warmup') {
        setBaseline(next);
        setHistory([next]);
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      if (action !== 'stop') {
        setBusy(false);
      }
    }
  }

  const running = busy || sample?.running;
  const reference = baseline ?? history[0];
  const scale = Math.max(
    16 * 1024 * 1024,
    ...history.flatMap((entry) =>
      metrics.map(([key]) => Math.abs(entry[key] - (reference?.[key] ?? entry[key]))),
    ),
  );
  const start = reference?.sampledAt ?? 0;
  const duration = Math.max(1000, (history.at(-1)?.sampledAt ?? start) - start);

  return (
    <>
      <h1>Font cache memory reproduction</h1>
      <p>
        Render distinct font binaries under the same <code>Font Memory Demo</code> family using{' '}
        <code>ImageResponse</code>. The server reports its own memory every 500 ms.
      </p>
      <p>
        Warm up first, then run several batches of the same size. Before the fix, retained font data
        keeps growing. After the fix, memory should level off across batches. Wasm memory keeps its
        high-water allocation; garbage collection does not shrink it.
      </p>
      <div className="controls">
        <button disabled={Boolean(running) || !sample} onClick={() => void act('warmup')}>
          Warm up &amp; set baseline
        </button>
        <label>
          Fonts per batch
          <select
            value={count}
            disabled={Boolean(running)}
            onChange={(event) => setCount(Number(event.target.value))}
          >
            {fontCounts.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <button disabled={Boolean(running) || !sample?.warmed} onClick={() => void act('run')}>
          Load {count} fonts into one family
        </button>
        <button disabled={!sample?.running} onClick={() => void act('stop')}>
          Stop batch
        </button>
        <button disabled={Boolean(running) || !sample?.gcAvailable} onClick={() => void act('gc')}>
          Collect JS garbage
        </button>
      </div>
      {error && <pre role="alert">{error}</pre>}
      {sample && (
        <>
          <p aria-live="polite">
            PID <strong>{sample.pid}</strong> ·{' '}
            {sample.running ? `Rendering ${sample.completed} / ${sample.requested}` : 'Idle'} ·{' '}
            <strong>{sample.rendered}</strong> distinct fonts rendered · {mib(sample.fontBytes)} per
            font · {mib(sample.fontBytes * sample.rendered)} cumulative input (not retained-memory
            measurement).
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2rem' }}>
            {metrics.map(([key, label, color]) => (
              <section key={key}>
                <h2 style={{ color, fontSize: '1rem' }}>{label}</h2>
                <strong style={{ fontSize: '1.5rem' }}>{mib(sample[key])}</strong>
                <div>Δ {mib(sample[key] - (reference?.[key] ?? sample[key]))}</div>
              </section>
            ))}
          </div>
          <h2>Memory change from baseline</h2>
          <svg
            viewBox="0 0 900 280"
            role="img"
            aria-label="Server memory delta over time"
            style={{
              width: '100%',
              maxWidth: 1100,
              background: 'white',
              border: '1px solid #cbd5e1',
            }}
          >
            <text x="10" y="20" fontSize="12">
              +{mib(scale)}
            </text>
            <text x="10" y="142" fontSize="12">
              0 MiB
            </text>
            <text x="10" y="265" fontSize="12">
              −{mib(scale)}
            </text>
            <line x1="100" y1="140" x2="890" y2="140" stroke="#cbd5e1" />
            {metrics.map(([key, , color]) => (
              <polyline
                key={key}
                fill="none"
                stroke={color}
                strokeWidth="2"
                points={history
                  .map(
                    (entry) =>
                      `${100 + ((entry.sampledAt - start) / duration) * 790},${140 - ((entry[key] - (reference?.[key] ?? entry[key])) / scale) * 120}`,
                  )
                  .join(' ')}
              />
            ))}
          </svg>
          <p>
            Same image SHA-256 throughout:{' '}
            <code>{sample.imageHash?.slice(0, 20) ?? 'warm up to render'}</code>. Only the font
            timestamp and checksums change; glyphs remain identical. The demo retains one source
            font, counters, and this hash—not generated font buffers or images.
          </p>
        </>
      )}
      <h2>Compare before and after</h2>
      <ol>
        <li>
          Warm up, run a few batches, and note external memory and RSS after garbage collection.
        </li>
        <li>
          Stop this server, apply the fix stash, rebuild <code>void</code>, and restart the memory
          demo. A fresh PID is essential; HMR does not reset Wasm memory.
        </li>
        <li>
          Repeat the same batch sizes. RSS includes Vite and JavaScript overhead; external memory
          includes Wasm. Array buffers are a subset of external memory, so do not add these figures
          together.
        </li>
      </ol>
      <pre>vp run --filter ./playground/image-response dev:memory</pre>
    </>
  );
}
