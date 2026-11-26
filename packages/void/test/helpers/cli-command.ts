import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished, vi } from 'vite-plus/test';
import { Buffer } from '../../src/cli/node-buffer.ts';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';

/** Collects stdout writes and `console.log` lines until `restore()` is called; `clear()` starts over. */
export function captureOutput(): { output: () => string; clear: () => void; restore: () => void } {
  const chunks: Array<string> = [];
  const writeMock = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((...args: Array<unknown>) => {
      const chunk = args[0];
      if (typeof chunk === 'string') {
        chunks.push(chunk);
      } else if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk.toString());
      }
      return true;
    });
  const logMock = vi.spyOn(console, 'log').mockImplementation((...args: Array<unknown>) => {
    chunks.push(args.map(String).join(' ') + '\n');
  });
  return {
    output: () => chunks.join(''),
    clear: () => {
      chunks.length = 0;
    },
    restore: () => {
      writeMock.mockRestore();
      logMock.mockRestore();
    },
  };
}

/**
 * Points HOME and the platform registry at a new temp directory that holds one
 * connected platform. Returns the directory so the caller can remove it.
 */
export function setIsolatedHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'void-home-'));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.VOID_PLATFORM_REGISTRY_DIR = join(dir, 'registry');
  saveTestConnection();
  return dir;
}

function saveTestConnection(): void {
  savePlatformConnection({
    accountId: null,
    apiUrl: 'https://api.example.test',
    applicationDomain: 'apps.example.test',
    displayName: 'Test platform',
    installationId: null,
    kind: 'connected',
    proxyUrl: 'https://proxy.example.test',
  });
}

/**
 * A temp project folder linked to `project_1` on the test platform, with a
 * token in the env. The registry lives inside it; both go when the test ends.
 */
export function linkedProject({ slug }: { slug: string }): string {
  const root = mkdtempSync(join(tmpdir(), 'void-linked-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  vi.stubEnv('VOID_PLATFORM_REGISTRY_DIR', join(root, '.registry'));
  vi.stubEnv('VOID_TOKEN', 'test-token');
  vi.stubEnv('VOID_API_URL', 'https://api.example.test');
  saveTestConnection();
  mkdirSync(join(root, '.void'));
  writeFileSync(
    join(root, '.void', 'project.json'),
    JSON.stringify({
      platform: 'void',
      platformUrl: 'https://api.example.test',
      projectId: 'project_1',
      slug,
    }),
  );
  return root;
}
