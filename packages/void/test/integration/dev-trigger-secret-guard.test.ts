import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { devTriggerSecretGuardPlugin } from '../../src/plugin-dev-config.ts';

const TOKEN = 'dev-trigger-secret-0f3c9a';
const DATABASE_URL = 'postgresql://app:db-secret-7e21b4@db.example.com/app';

// node:http sends the path exactly as written; fetch would normalize dot segments.
function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Array<Buffer> = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('dev server with the dev-trigger secret guard', () => {
  let root: string;
  let server: ViteDevServer;
  let port: number;

  beforeAll(async () => {
    // `.native` expands Windows 8.3 names such as `RUNNER~1` in the CI temp dir;
    // Vite refuses to serve any file under a short-name path.
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'void-dev-secret-')));
    mkdirSync(join(root, '.void'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>app</title>');
    writeFileSync(join(root, '.void', 'dev-trigger-token'), TOKEN);
    writeFileSync(join(root, '.void', 'routes.d.ts'), 'export {};\n');
    // Astro writes its background dev server output, startup hint included, here.
    mkdirSync(join(root, '.astro'), { recursive: true });
    writeFileSync(join(root, '.astro', 'dev.log'), `x-void-dev-trigger: ${TOKEN}\n`);
    // Older CLI versions left the database URL of `void db push` / `db studio` here.
    writeFileSync(
      join(root, '.void', 'drizzle.config.json'),
      JSON.stringify({ dialect: 'postgresql', dbCredentials: { url: DATABASE_URL } }),
    );

    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0 },
      plugins: [devTriggerSecretGuardPlugin()],
    });
    await server.listen();
    port = (server.httpServer!.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await server?.close();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const fsRoot = () => {
    const posix = root.replaceAll('\\', '/');
    return posix.startsWith('/') ? posix : `/${posix}`;
  };

  // One path each for the static, /@fs/ and transform middlewares the guard must precede.
  it.each([
    '/.void/dev-trigger-token',
    '/@fs<root>/.void/dev-trigger-token',
    '/.astro/dev.log?raw',
  ])('does not serve the token at %s', async (path) => {
    const response = await get(port, path.replace('<root>', fsRoot()));
    expect(response.status).toBe(404);
    expect(response.body).not.toContain(TOKEN);
  });

  it('does not serve a database URL left in .void/drizzle.config.json', async () => {
    const response = await get(port, '/.void/drizzle.config.json');
    expect(response.status).toBe(404);
    expect(response.body).not.toContain('db-secret-7e21b4');
  });

  it('still serves other files under .void', async () => {
    const response = await get(port, '/.void/routes.d.ts');
    expect(response.status).toBe(200);
  });
});
