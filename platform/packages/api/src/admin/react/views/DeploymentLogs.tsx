/** @jsxImportSource react */

import { Button } from '@astryxdesign/core/Button';
import { Selector } from '@astryxdesign/core/Selector';
import { isRecord } from '@void/deploy-core';
import { useCallback, useEffect, useState } from 'react';
import { useFateClient, useView, type ViewRef } from 'react-fate';
import {
  DeploymentLogSettingsView,
  DeploymentLogsView,
  deploymentLogsRequest,
} from '../../fate/views.ts';
import { CopyButton } from './CopyButton.tsx';
import { SearchTypeahead } from './SearchTypeahead.tsx';
import { SectionStack } from './SectionStack.tsx';

type LogEntry = {
  timestamp: number;
  outcome: string;
  method?: string;
  url?: string;
  status?: string;
  logs?: ReadonlyArray<unknown>;
  exceptions?: ReadonlyArray<unknown>;
};

const LEVEL_COLORS: Record<string, string> = {
  error: '#dc2626',
  warn: '#d97706',
  info: '#6b7280',
  log: '#6b7280',
  debug: '#9ca3af',
};

function formatMessage(message: unknown): string {
  if (typeof message === 'string') {
    return message.slice(0, 500);
  }
  if (Array.isArray(message)) {
    return message.join(' ').slice(0, 500);
  }
  return JSON.stringify(message ?? null).slice(0, 500);
}

/**
 * Entries in a tail poll that earlier polls did not show. `seen` counts each
 * row shape: with minimal runtime logs two requests in the same millisecond
 * can look the same, and the server still returns one row for each.
 */
export function takeFreshTailEntries<T extends LogEntry>(
  latest: ReadonlyArray<T>,
  seen: Map<string, number>,
): Array<T> {
  const counts = new Map<string, number>();
  const fresh = latest.filter((entry) => {
    const key = JSON.stringify([
      entry.timestamp,
      entry.method,
      entry.url,
      entry.status,
      entry.outcome,
      entry.logs,
      entry.exceptions,
    ]);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count > (seen.get(key) ?? 0);
  });
  for (const [key, count] of counts) {
    seen.set(key, Math.max(seen.get(key) ?? 0, count));
  }
  return fresh;
}

export const MINIMAL_RUNTIME_LOGS_NOTICE =
  'Log messages, exception messages and URLs are not recorded on this platform.';

function logMessages(entry: LogEntry) {
  return [
    ...(entry.logs ?? []).flatMap((log) =>
      isRecord(log)
        ? [
            {
              level: typeof log.level === 'string' ? log.level : 'log',
              text: formatMessage(log.message),
            },
          ]
        : [],
    ),
    ...(entry.exceptions ?? []).flatMap((exception) => {
      if (!isRecord(exception) || typeof exception.name !== 'string') {
        return [];
      }
      return [
        {
          level: 'error',
          text:
            typeof exception.message === 'string' && exception.message
              ? `${exception.name}: ${exception.message}`
              : exception.name,
        },
      ];
    }),
  ];
}

export function LogRow({ entry }: { entry: LogEntry }) {
  const messages = logMessages(entry);
  const statusCode = Number.parseInt(entry.status ?? '', 10);
  const statusColor = statusCode >= 500 ? '#dc2626' : statusCode >= 400 ? '#d97706' : '#16a34a';
  return (
    <div style={{ padding: '4px 0', borderBottom: '1px solid #eee', fontSize: '0.8rem' }}>
      <span style={{ color: '#999', marginRight: '8px' }}>
        {new Date(entry.timestamp).toLocaleTimeString()}
      </span>
      {entry.method && (
        <span style={{ marginRight: '8px', fontWeight: '600' }}>{entry.method}</span>
      )}
      {entry.method && entry.url && <span style={{ marginRight: '8px' }}>{entry.url}</span>}
      {entry.status && (
        <span style={{ color: statusColor, fontWeight: 600, marginRight: 8 }}>{entry.status}</span>
      )}
      <span style={{ color: entry.outcome === 'ok' ? '#16a34a' : '#dc2626' }}>{entry.outcome}</span>
      {messages.length > 0 && (
        <div style={{ position: 'relative', marginTop: '4px', marginLeft: '24px' }}>
          <div style={{ position: 'absolute', top: '4px', right: '4px' }}>
            <CopyButton
              text={messages.map((message) => message.text || message.level).join('\n')}
            />
          </div>
          <pre
            style={{
              margin: '0',
              padding: '8px',
              background: '#f9fafb',
              border: '1px solid #e5e7eb',
              borderRadius: 'var(--radius-inner)',
              fontSize: '0.78rem',
              overflowX: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {messages.map((message, index) => (
              <div key={index}>
                <span
                  style={{
                    color: LEVEL_COLORS[message.level] ?? '#6b7280',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    width: 50,
                    display: 'inline-block',
                  }}
                >
                  {message.level}
                </span>
                <span>{message.text}</span>
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}

export function DeploymentLogs({
  deploymentId,
  deploymentRef,
}: {
  deploymentId: string;
  deploymentRef: ViewRef<'AdminDeploymentDetail'>;
}) {
  const fate = useFateClient();
  const settings = useView(DeploymentLogSettingsView, deploymentRef);
  const { logRange: since, logLimit: count, logFilter: filter } = settings;
  const configure = (
    patch: Partial<Pick<typeof settings, 'logRange' | 'logLimit' | 'logFilter'>>,
  ) => fate.mutations.deploymentLogs.configure({ input: { id: String(settings.id), ...patch } });
  const [entries, setEntries] = useState<Array<LogEntry> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tailing, setTailing] = useState(false);
  const [minimal, setMinimal] = useState(false);

  const fetchEntries = useCallback(
    async (range: string, limit: number): Promise<Array<LogEntry> | null> => {
      const { deploymentLogs: ref } = await fate.request(
        deploymentLogsRequest(deploymentId, range, limit),
        { mode: 'network-only' },
      );
      if (!ref) {
        return null;
      }
      const { data } = await fate.readView(DeploymentLogsView, ref);
      setMinimal(data.runtimeLogs === 'minimal');
      return data.data;
    },
    [deploymentId, fate],
  );

  const loadLogs = useCallback(async () => {
    setEntries(null);
    setError(null);
    try {
      const loaded = await fetchEntries(since, count);
      if (!loaded) {
        throw new Error('Deployment logs are unavailable.');
      }
      setEntries(loaded);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [fetchEntries, since, count]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  useEffect(() => {
    if (!tailing) {
      return;
    }
    let active = true;
    const seen = new Map<string, number>();
    const poll = async () => {
      try {
        const latest = await fetchEntries('1m', 50);
        if (!latest || !active) {
          return;
        }
        const fresh = takeFreshTailEntries(latest, seen);
        if (fresh.length > 0) {
          setEntries((current) => [...fresh, ...(current ?? [])]);
        }
      } catch {
        // The next tail poll can recover.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [fetchEntries, tailing]);

  const query = filter.toLowerCase().trim();
  const visible = (entries ?? []).filter(
    (entry) =>
      !query ||
      [
        entry.outcome,
        entry.method,
        entry.url,
        entry.status,
        ...logMessages(entry).map((message) => message.text),
      ]
        .join(' ')
        .toLowerCase()
        .includes(query),
  );

  return (
    <SectionStack>
      <h2>Runtime Logs</h2>
      <div className="void-admin-inline-form">
        <Selector
          id="log-since"
          label="Time"
          value={since}
          onChange={(value: string) => {
            void configure({ logRange: value });
          }}
          options={['1h', '6h', '24h', '7d']}
          width={100}
        />
        <Button type="button" id="load-logs-btn" label="Load" onClick={() => void loadLogs()} />
        <Selector
          id="log-count"
          label="Count"
          value={String(count)}
          onChange={(value: string) => {
            void configure({ logLimit: Number(value) });
          }}
          options={[100, 200, 300, 400, 500].map(String)}
          width={110}
        />
        <SearchTypeahead
          label="Filter logs"
          onChange={(value: string) => {
            void configure({ logFilter: value });
          }}
          initialValue={filter}
          suggestions={(entries ?? []).flatMap((entry) => [
            entry.outcome,
            entry.method,
            entry.url,
            entry.status,
          ])}
          width={240}
        />
        <Button
          type="button"
          id="live-tail-btn"
          style={{ marginLeft: 'auto' }}
          label={tailing ? 'Stop Tail' : 'Live Tail'}
          variant={tailing ? 'destructive' : 'secondary'}
          onClick={() => {
            if (!tailing) {
              setEntries([]);
            }
            setTailing(!tailing);
          }}
        />
      </div>
      {minimal && (
        <p id="runtime-logs-notice" style={{ color: '#6b7280', fontSize: '0.8rem' }}>
          {MINIMAL_RUNTIME_LOGS_NOTICE}
        </p>
      )}
      <div id="log-entries">
        {error ? (
          <p style={{ color: 'red', fontSize: '0.8rem' }}>Failed to load logs: {error}</p>
        ) : tailing && visible.length === 0 ? (
          <p style={{ color: '#999', fontSize: '0.8rem' }}>
            Polling for new events... New logs may take up to 2 minutes to appear.
          </p>
        ) : entries === null ? (
          <p style={{ color: '#999', fontSize: '0.8rem' }}>Loading logs...</p>
        ) : visible.length === 0 ? (
          <p style={{ color: '#999', fontSize: '0.8rem' }}>
            No logs found{query ? ' matching filter' : ' for this time range'}. New logs may take up
            to 2 minutes to appear.
          </p>
        ) : (
          visible.map((entry, index) => (
            <LogRow
              key={`${entry.timestamp}:${entry.url}:${entry.status}:${index}`}
              entry={entry}
            />
          ))
        )}
      </div>
    </SectionStack>
  );
}
