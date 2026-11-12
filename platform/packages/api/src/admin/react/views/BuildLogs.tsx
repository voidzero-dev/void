/** @jsxImportSource @voidcloud/api/admin-jsx */

import { useEffect, useRef, useState } from 'react';
import { useFateClient } from 'react-fate';
import type { Build } from '../../../types.ts';
import { BuildLogsView, buildLogsRequest } from '../../fate/views.ts';
import { SectionStack } from './SectionStack.tsx';

type LogLine = { seq: number; line: string; stream: string };
export function BuildLogs({ build }: { build: Build }) {
  const fate = useFateClient();
  const [lines, setLines] = useState<Array<LogLine> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pre = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let active = true;
    let cursor = 0;
    let polling = false;
    let terminalSince: number | null = null;
    setLines(null);
    setError(null);

    const pollLogs = async () => {
      if (polling) {
        return;
      }
      polling = true;
      try {
        const { buildLogs: ref } = await fate.request(buildLogsRequest(build.id, cursor), {
          mode: 'network-only',
        });
        if (!ref) {
          return;
        }
        const { data } = await fate.readView(BuildLogsView, ref);
        if (!active) {
          return;
        }
        cursor = Math.max(cursor, data.lastSeq);
        setLines((current) => [...(current ?? []), ...data.lines]);
        return data;
      } catch {
        // A later poll can recover from a transient log request failure.
      } finally {
        polling = false;
      }
    };

    const poll = async () => {
      const page = await pollLogs();
      if (!page) {
        return;
      }
      if (!page.terminal) {
        terminalSince = null;
        return;
      }
      if (page.logsComplete === true) {
        clearInterval(timer);
        return;
      }
      if (page.logsComplete == null) {
        clearInterval(timer);
        setError(
          'Final log completion is unavailable. Upgrade the platform runtime to follow the complete log tail.',
        );
        return;
      }
      terminalSince ??= Date.now();
      if (Date.now() - terminalSince >= 2 * 60_000) {
        clearInterval(timer);
        setError(
          'The build finished, but its final logs have not been confirmed. Reload to recover the final log tail.',
        );
      }
    };

    const timer = setInterval(() => void poll(), 2_000);
    void poll();
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [build.id, build.status, fate]);

  useEffect(() => {
    const element = pre.current;
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 40) {
      element.scrollTop = element.scrollHeight;
    }
  }, [lines]);

  return (
    <SectionStack>
      <h2>Build Logs</h2>
      {error && <p role="alert">{error}</p>}
      <pre
        ref={pre}
        id="build-log"
        style="min-height: 120px; max-height: 480px; overflow-y: auto; font-size: 0.78rem"
      >
        {lines === null
          ? 'Loading logs...'
          : lines.length === 0
            ? 'No logs yet.'
            : lines.map((line, index) => (
                <span
                  key={line.seq}
                  style={{ color: line.stream === 'stderr' ? '#dc2626' : 'inherit' }}
                >
                  {index > 0 && '\n'}
                  {line.line}
                </span>
              ))}
      </pre>
    </SectionStack>
  );
}
