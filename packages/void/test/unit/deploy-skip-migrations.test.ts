import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import { parseDeployArgs } from '../../src/cli/args.ts';
import type { PlatformClient } from '../../src/cli/client.ts';
import { runFrameworkDeploy } from '../../src/cli/deploy-managed-framework.ts';
import { runFullDeploy } from '../../src/cli/deploy-managed-full.ts';

const { upload } = vi.hoisted(() => ({
  upload: vi.fn(
    async (
      _input: Parameters<
        typeof import('../../src/cli/deploy-managed-events.ts').streamDirectR2Deploy
      >[0],
    ) => ({
      event: 'done' as const,
      deployment: 'dep_test',
      url: 'https://app.test',
      workers: 1,
      assets: 0,
    }),
  ),
}));
vi.mock('../../src/cli/deploy-managed-events.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/deploy-managed-events.ts')>()),
  streamDirectR2Deploy: upload,
}));

describe('explicit deployment migration opt-out', () => {
  it.each(['void', 'cloudflare'])('accepts --skip-migrations on %s', (platform) => {
    expect(parseDeployArgs(['--platform', platform, '--skip-migrations'])).toMatchObject({
      platform,
      skipMigrations: true,
    });
  });

  it('keeps automatic migrations as the default', () => {
    expect(parseDeployArgs([])).not.toMatchObject({ skipMigrations: true });
  });

  it.each(['void', 'framework'] as const)(
    'preserves the bundled migration plan when skipping in a %s app',
    async (kind) => {
      const root = mkdtempSync(join(tmpdir(), 'void-skip-sql-'));
      try {
        for (const [path, content] of Object.entries({
          'package.json': '{"name":"skip-sql"}',
          'routes/index.ts': 'export const GET = () => "ok";',
          'db/migrations/0000_notes.sql': 'CREATE TABLE notes (id INTEGER PRIMARY KEY);',
          'dist/ssr/index.js': 'export default { fetch() { return new Response("ok"); } };',
          'dist/client/index.html': '<h1>Notes</h1>',
        })) {
          const file = join(root, path);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, content);
        }
        const client = {
          preflight: async () => ({ needed: [], skipped: 0 }),
        } as unknown as PlatformClient;
        const project = { projectId: 'proj_test', slug: 'skip-sql' };
        upload.mockClear();
        if (kind === 'void') {
          await runFullDeploy(
            root,
            project,
            client,
            {},
            undefined,
            true,
            undefined,
            undefined,
            undefined,
            true,
          );
        } else {
          await runFrameworkDeploy(
            root,
            project,
            client,
            { name: 'astro', class: 'c' },
            {
              cloudflareArtifact: 'worker-output',
              buildCommand: 'vite build',
              workerDir: 'dist/ssr',
              workerMain: 'index.js',
              assetsDir: 'dist/client',
            },
            {},
            true,
            undefined,
            undefined,
            true,
          );
        }
        expect(upload).toHaveBeenCalledOnce();
        expect(upload.mock.calls[0][0].manifest).toMatchObject({
          migrationMode: 'skip',
          migrations: { pending: 1 },
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
