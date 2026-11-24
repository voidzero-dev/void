import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toSlash } from 'pathslash';
import { expect, it } from 'vite-plus/test';
import { encodeCloudflareOperation } from '../../src/cli/cloudflare-process.ts';
import { Buffer } from '../../src/cli/node-buffer.ts';
import { withConditionalPlatformWorkerCreate } from '../../src/cli/platform-installer-process.ts';
import { resolveCloudflareOperationArgv } from '../../src/cli/preset.ts';

function unsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`;
}

it.each(['none', 'batch', 'single-file'] as const)(
  'keeps the create-only precondition on the bundled uploader query (assets: %s)',
  async (assets) => {
    const directory = mkdtempSync(join(tmpdir(), 'void-worker-upload-contract-'));
    const sessionJwt = unsignedJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...(assets === 'single-file' ? { wrangler_single_asset_uploads: true } : {}),
    });
    const completionJwt = unsignedJwt({ exp: Math.floor(Date.now() / 1000) + 3600, done: true });
    const requests: Array<{
      authorization: string | undefined;
      body: string;
      precondition: string | undefined;
      request: string;
    }> = [];
    // A local fake API with a synthetic credential; nothing can reach a real account.
    const server = createServer((request, response) => {
      const url = request.url ?? '';
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        requests.push({
          authorization: request.headers.authorization,
          body,
          precondition: request.headers['if-none-match'],
          request: `${request.method} ${url}`,
        });
        response.setHeader('Content-Type', 'application/json');
        const path = new URL(url, 'http://127.0.0.1').pathname;
        if (request.method === 'POST' && path.endsWith('/assets-upload-session')) {
          const { manifest } = JSON.parse(body) as {
            manifest: Record<string, { hash: string }>;
          };
          response.end(
            JSON.stringify({
              success: true,
              result: {
                jwt: sessionJwt,
                buckets: [Object.values(manifest).map((entry) => entry.hash)],
              },
            }),
          );
        } else if (request.method === 'POST' && path.includes('/workers/assets/upload')) {
          response.writeHead(201);
          response.end(JSON.stringify({ success: true, result: { jwt: completionJwt } }));
        } else if (request.method === 'PUT') {
          response.writeHead(412);
          response.end(
            JSON.stringify({
              success: false,
              errors: [{ code: 1000, message: 'Simulated concurrent creation.' }],
            }),
          );
        } else if (path.endsWith('/workers/subdomain')) {
          response.end(JSON.stringify({ success: true, result: { subdomain: 'test' } }));
        } else {
          response.writeHead(404);
          response.end(
            JSON.stringify({
              success: false,
              errors: [{ code: 10_007, message: 'Worker not found.' }],
            }),
          );
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`;
    try {
      writeFileSync(
        join(directory, 'worker.mjs'),
        'export default { fetch() { return new Response("local test"); } };',
      );
      if (assets !== 'none') {
        mkdirSync(join(directory, 'public'));
        writeFileSync(join(directory, 'public', 'client.js'), 'console.log("admin");');
      }
      const config = join(directory, 'wrangler.json');
      writeFileSync(
        config,
        JSON.stringify({
          name: 'void-contract',
          account_id: 'account',
          main: 'worker.mjs',
          compatibility_date: '2026-02-24',
          workers_dev: false,
          preview_urls: false,
          no_bundle: true,
          ...(assets === 'none'
            ? {}
            : { assets: { directory: toSlash(join(directory, 'public')) } }),
        }),
      );
      const [command, ...prefix] = resolveCloudflareOperationArgv();
      let output = '';
      const failure = await withConditionalPlatformWorkerCreate(
        'account',
        'void-contract',
        async (apiBase) => {
          await new Promise<void>((resolve) => {
            const child = execFile(
              command!,
              [
                ...prefix,
                ...encodeCloudflareOperation({ type: 'worker.deploy', configPath: config }),
              ],
              {
                cwd: directory,
                encoding: 'utf8',
                timeout: 20_000,
                maxBuffer: 1024 * 1024,
                env: {
                  PATH: process.env.PATH,
                  SYSTEMROOT: process.env.SYSTEMROOT,
                  WINDIR: process.env.WINDIR,
                  TMP: process.env.TMP,
                  TEMP: process.env.TEMP,
                  CI: 'true',
                  CLOUDFLARE_API_TOKEN: 'synthetic-token',
                  CLOUDFLARE_API_BASE_URL: apiBase,
                  WRANGLER_SEND_METRICS: 'false',
                  WRANGLER_LOG_PATH: join(directory, 'logs'),
                },
              },
              (_error, stdout, stderr) => {
                output = stdout + stderr;
                resolve();
              },
            );
            child.stdin?.end();
          });
        },
        origin,
      ).catch((error: unknown) => error);
      const trace = output + '\n' + requests.map((entry) => entry.request).join('\n');
      expect(String(failure), trace).toContain('created concurrently (HTTP 412)');
      const create = {
        request:
          'PUT /client/v4/accounts/account/workers/scripts/void-contract?excludeScript=true&bindings_inherit=strict',
        authorization: 'Bearer synthetic-token',
        precondition: '*',
      };
      expect(
        requests.filter((entry) => !entry.request.startsWith('GET ')),
        trace,
      ).toMatchObject(
        assets === 'none'
          ? [create]
          : [
              {
                request:
                  'POST /client/v4/accounts/account/workers/scripts/void-contract/assets-upload-session',
                authorization: 'Bearer synthetic-token',
                precondition: undefined,
              },
              {
                request:
                  assets === 'batch'
                    ? 'POST /client/v4/accounts/account/workers/assets/upload?base64=true'
                    : expect.stringMatching(
                        /^POST \/client\/v4\/accounts\/account\/workers\/assets\/upload\/[0-9a-f]{32}$/,
                      ),
                authorization: `Bearer ${sessionJwt}`,
                precondition: undefined,
              },
              { ...create, body: expect.stringContaining(completionJwt) },
            ],
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
