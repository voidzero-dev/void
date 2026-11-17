import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('../../src/plugin-cloudflare.ts', () => import('../helpers/cloudflare-vite-plugin.ts'));

const roots: Array<string> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('queue consumer config', () => {
  it.each([undefined, 2])('emits only exported concurrency (maxConcurrency: %s)', async (value) => {
    const root = mkdtempSync(join(tmpdir(), 'void-queue-config-'));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(
      join(root, 'void.json'),
      JSON.stringify({ worker: { compatibility_date: '2026-02-24' } }),
    );
    mkdirSync(join(root, 'queues'));
    writeFileSync(
      join(root, 'queues/jobs.ts'),
      `${value === undefined ? '' : `export const maxConcurrency = ${value};`}
export default async () => {};`,
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const { voidPlugin } = await import('../../src/index.ts');
    const cloudflare = voidPlugin().find((plugin) => plugin.name === 'mock:cloudflare');
    if (!cloudflare) {
      throw new Error('Expected mocked Cloudflare plugin.');
    }
    const { config } = (
      cloudflare.api as {
        pluginConfig: { config: (resolved: Record<string, unknown>) => Record<string, unknown> };
      }
    ).pluginConfig;
    expect(config({}).queues).toEqual({
      producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }],
      consumers: [{ queue: 'jobs', ...(value !== undefined && { max_concurrency: value }) }],
    });
  });
});
