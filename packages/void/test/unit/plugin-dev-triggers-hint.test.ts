import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { devTriggersHintPlugin } from '../../src/plugin-dev-triggers-hint.ts';

const tempDirs: Array<string> = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-dev-hint-'));
  tempDirs.push(root);
  return root;
}

function fakeServer() {
  const httpServer = new EventEmitter() as EventEmitter & {
    address: () => { port: number };
  };
  httpServer.address = () => ({ port: 5173 });
  return { httpServer };
}

async function runConfigureServer(plugin: ReturnType<typeof devTriggersHintPlugin>) {
  const server = fakeServer();
  const hook = plugin.configureServer;
  const fn = typeof hook === 'function' ? hook : hook?.handler;
  if (typeof fn !== 'function') {
    throw new Error('configureServer not callable');
  }
  vi.useFakeTimers();
  try {
    await (fn as (fixture: typeof server) => void | Promise<void>)(server);
    server.httpServer.emit('listening');
    // afterServerReady prints 100 ms after 'listening'.
    vi.advanceTimersByTime(100);
  } finally {
    vi.useRealTimers();
  }
  return server;
}

describe('devTriggersHintPlugin', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('prints nothing when there are no crons or queues', async () => {
    const root = createTempRoot();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runConfigureServer(devTriggersHintPlugin(root, 'dev-token-test'));
    expect(log).not.toHaveBeenCalled();
  });

  it('prints a default-mode hint with curl examples when crons exist', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'crons'), { recursive: true });
    writeFileSync(
      join(root, 'crons', 'heartbeat.ts'),
      'export const cron = "0 * * * *";\nexport default async () => {};\n',
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runConfigureServer(devTriggersHintPlugin(root, 'dev-token-test'));

    const output = log.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('Detected 1 cron');
    expect(output).toContain('/__void/scheduled');
    expect(output).toContain('x-void-dev-trigger: dev-token-test');
    expect(output).toContain('"cron":"0 * * * *"');
  });

  it('includes queues in the count and emits a queue curl example', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'crons'), { recursive: true });
    mkdirSync(join(root, 'queues'), { recursive: true });
    writeFileSync(
      join(root, 'crons', 'a.ts'),
      'export const cron = "* * * * *";\nexport default async () => {};\n',
    );
    writeFileSync(
      join(root, 'crons', 'b.ts'),
      'export const cron = "0 0 * * *";\nexport default async () => {};\n',
    );
    writeFileSync(join(root, 'queues', 'emails.ts'), 'export default async () => {};\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runConfigureServer(devTriggersHintPlugin(root, 'dev-token-test'));

    const output = log.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('Detected 2 crons and 1 queue');
    expect(output).toContain('/__void/queue');
    expect(output).toContain('x-void-dev-trigger: dev-token-test');
    expect(output).toContain('"queue":"emails"');
  });
});
