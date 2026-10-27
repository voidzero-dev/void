import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { nodeTargetPlugin } from '../../src/plugin-node-target.ts';
import { getHookHandler } from '../helpers/vite-hooks.ts';

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

const tempDirs: Array<string> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function servePlugin(): Plugin {
  const plugin = nodeTargetPlugin('node').find((p) => p.configureServer);
  if (!plugin) {
    throw new Error('Expected the node target serve plugin.');
  }
  return plugin;
}

async function requestThrough(middleware: Middleware, path: string): Promise<Response> {
  const server = createServer((req, res) => {
    middleware(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    await response.text();
    return response;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('nodeTargetPlugin request bridge', () => {
  it('keeps every Set-Cookie header in dev', async () => {
    let middleware: Middleware | undefined;
    const app = {
      fetch: async () => {
        const headers = new Headers({ 'content-type': 'text/plain' });
        headers.append('set-cookie', 'session=abc; Path=/');
        headers.append('set-cookie', 'csrf=xyz; Path=/');
        return new Response('ok', { headers });
      },
    };
    const server = {
      middlewares: { use: (fn: Middleware) => (middleware = fn) },
      ssrLoadModule: async () => ({ default: app }),
    } as unknown as ViteDevServer;
    getHookHandler(servePlugin().configureServer)!.call({} as never, server);

    const response = await requestThrough(middleware!, '/login');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(response.headers.getSetCookie()).toEqual(['session=abc; Path=/', 'csrf=xyz; Path=/']);
  });

  it('keeps every Set-Cookie header in preview', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-node-target-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'dist', 'ssr'), { recursive: true });
    writeFileSync(
      join(root, 'dist', 'ssr', 'app.js'),
      `export default {
  fetch: async () => {
    const headers = new Headers();
    headers.append('set-cookie', 'session=abc; Path=/');
    headers.append('set-cookie', 'csrf=xyz; Path=/');
    return new Response('ok', { headers });
  },
};
`,
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    let middleware: Middleware | undefined;
    const server = {
      middlewares: { use: (fn: Middleware) => (middleware = fn) },
    } as unknown as PreviewServer;
    getHookHandler(servePlugin().configurePreviewServer)!.call({} as never, server);

    const response = await requestThrough(middleware!, '/login');

    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual(['session=abc; Path=/', 'csrf=xyz; Path=/']);
  });
});
