import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  killChild,
  startServer,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';
import { isGeneratedAssetHeaders } from '../../src/asset-worker-bypass.ts';
import { renderVoidConfig } from '../../src/config-write.ts';
import { readConfig } from '../../src/config.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SOURCE_PLAYGROUND = 'playground/spa';
let playground: IsolatedPlayground;
let authMiddleware = '';
let documentRoute = '';
let middlewareDir = '';
let middlewareBackupDir = '';
let publicDir = '';
let protectedAsset = '';
let edgeHeaderAsset = '';
let edgeRedirectAsset = '';
let voidConfig = '';
let dist = '';
const AUTH_HEADER = 'Basic Z3Vlc3Q6d2VkZGluZw==';

const middlewareSource = `import { basicAuth } from 'void';

export default basicAuth({
  username: 'guest',
  password: 'wedding',
  realm: 'Preview',
});
`;

const documentRouteSource = `export const GET = () =>
  new Response('document route response', {
    headers: { 'Content-Type': 'text/plain' },
  });
`;

const staleCloudflareAssets = {
  binding: 'ASSETS',
  not_found_handling: 'none',
  run_worker_first: ['/', '/*.html'],
} as const;

let child: ReturnType<typeof spawn> | undefined;
let previousVoidConfig: string | undefined;
let middlewareBackedUp = false;
let publicDirCreated = false;

function saveVoidConfig(): void {
  previousVoidConfig = readFileSync(voidConfig, 'utf-8');
}

function writeStaleCloudflareConfig(): void {
  const config = readConfig(playground.root);
  writeFileSync(
    voidConfig,
    renderVoidConfig({
      ...config,
      cloudflare: {
        ...config.cloudflare,
        assets: {
          ...staleCloudflareAssets,
          run_worker_first: [...staleCloudflareAssets.run_worker_first],
        },
      },
    }),
  );
}

function restoreVoidConfig(): void {
  if (previousVoidConfig !== undefined) {
    writeFileSync(voidConfig, previousVoidConfig);
    previousVoidConfig = undefined;
  }
}

function disableMiddlewareDir(): void {
  rmSync(middlewareBackupDir, { recursive: true, force: true });
  if (existsSync(middlewareDir)) {
    renameSync(middlewareDir, middlewareBackupDir);
    middlewareBackedUp = true;
  }
}

function restoreMiddlewareDir(): void {
  if (!middlewareBackedUp) {
    return;
  }
  rmSync(middlewareDir, { recursive: true, force: true });
  if (existsSync(middlewareBackupDir)) {
    renameSync(middlewareBackupDir, middlewareDir);
  }
  middlewareBackedUp = false;
}

function writeProtectedAsset(): void {
  if (!existsSync(publicDir)) {
    mkdirSync(publicDir);
    publicDirCreated = true;
  }
  writeFileSync(protectedAsset, 'protected static asset');
}

async function startSpaDevServer(): Promise<string> {
  const server = await startServer((port) => {
    child = spawn('vp', ['dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: playground.root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        VOID_INSPECTOR_PORT: 'false',
      },
    });
    return child;
  }, 30_000);
  return server.base;
}

async function startSpaPreviewServer(): Promise<string> {
  const server = await startServer((port) => {
    child = spawn(
      'vp',
      ['preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      {
        cwd: playground.root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, VOID_INSPECTOR_PORT: 'false' },
      },
    );
    return child;
  }, 30_000);
  return server.base;
}

function readBuiltAssetConfig(): {
  not_found_handling?: string;
  run_worker_first?: boolean | Array<string>;
} {
  const emittedWrangler = JSON.parse(readFileSync(join(dist, 'ssr/wrangler.json'), 'utf-8')) as {
    assets?: {
      not_found_handling?: string;
      run_worker_first?: boolean | Array<string>;
    };
  };
  return emittedWrangler.assets ?? {};
}

/** Apps that keep the Worker in front of their assets get no generated `_headers`. */
function expectNoGeneratedAssetHeaders(): void {
  const headers = join(dist, 'client/_headers');
  if (existsSync(headers)) {
    expect(isGeneratedAssetHeaders(readFileSync(headers, 'utf-8'))).toBe(false);
  }
}

beforeAll(() => {
  playground = createIsolatedPlayground(ROOT, SOURCE_PLAYGROUND);
  authMiddleware = join(playground.root, 'middleware/00.basic-auth-regression.ts');
  documentRoute = join(playground.root, 'routes/dashboard.ts');
  middlewareDir = join(playground.root, 'middleware');
  middlewareBackupDir = join(playground.root, `.middleware.e2e-backup-${process.pid}`);
  publicDir = join(playground.root, 'public');
  protectedAsset = join(publicDir, 'void-basic-auth-regression.txt');
  edgeHeaderAsset = join(publicDir, 'void-native-header-regression.txt');
  edgeRedirectAsset = join(publicDir, 'void-native-redirect-regression.txt');
  voidConfig = join(playground.root, 'void.config.ts');
  dist = join(playground.root, 'dist');
});

afterAll(() => {
  playground?.cleanup();
});

afterEach(async () => {
  if (child) {
    await killChild(child);
    child = undefined;
  }
  rmSync(documentRoute, { force: true });
  restoreMiddlewareDir();
  rmSync(authMiddleware, { force: true });
  rmSync(protectedAsset, { force: true });
  rmSync(edgeHeaderAsset, { force: true });
  rmSync(edgeRedirectAsset, { force: true });
  if (publicDirCreated) {
    rmSync(publicDir, { recursive: true, force: true });
    publicDirCreated = false;
  }
  restoreVoidConfig();
});

describe('SPA asset routing policy', () => {
  it('keeps API-only projects on static SPA fallback while routing API requests to the worker', () => {
    saveVoidConfig();
    disableMiddlewareDir();
    writeStaleCloudflareConfig();
    rmSync(dist, { recursive: true, force: true });

    execSync('vp build', { cwd: playground.root, stdio: 'pipe' });

    const assetConfig = readBuiltAssetConfig();
    expect(assetConfig.not_found_handling).toBe('single-page-application');
    expect(assetConfig.run_worker_first).toEqual(['/api', '/api/*', '/__void', '/__void/*']);
    expectNoGeneratedAssetHeaders();
  });

  it('applies native production routing rules before existing static assets', async () => {
    saveVoidConfig();
    disableMiddlewareDir();
    writeStaleCloudflareConfig();
    mkdirSync(publicDir, { recursive: true });
    writeFileSync(edgeHeaderAsset, 'header asset');
    writeFileSync(edgeRedirectAsset, 'redirect asset must not win');
    const config = readConfig(playground.root);
    const routing = {
      headers: {
        '/void-native-header-regression.txt': ['X-Void-Native-Rule: applied'],
      },
      redirects: {
        '/void-native-redirect-regression.txt': { to: '/redirect-target', status: 302 as const },
      },
    };
    writeFileSync(voidConfig, renderVoidConfig({ ...config, routing }));
    rmSync(dist, { recursive: true, force: true });
    const buildEnv = { ...process.env };
    delete buildEnv.VOID_DEPLOY_PROJECT_ID;
    delete buildEnv.VOID_DEPLOY_BUILD;
    execSync('vp build', {
      cwd: playground.root,
      stdio: 'pipe',
      env: buildEnv,
    });

    expect(readBuiltAssetConfig().run_worker_first).toEqual(['/**']);
    expectNoGeneratedAssetHeaders();
    const base = await startSpaPreviewServer();
    const headerResponse = await fetch(`${base}/void-native-header-regression.txt`);
    expect(headerResponse.status).toBe(200);
    expect(await headerResponse.text()).toBe('header asset');
    expect(headerResponse.headers.get('x-void-native-rule')).toBe('applied');

    const redirectResponse = await fetch(`${base}/void-native-redirect-regression.txt`, {
      redirect: 'manual',
    });
    expect(redirectResponse.status).toBe(302);
    expect(redirectResponse.headers.get('location')).toContain('/redirect-target');
    expect(await redirectResponse.text()).not.toContain('redirect asset must not win');
  });

  it('routes document routes through the worker before SPA fallback HTML', async () => {
    saveVoidConfig();
    disableMiddlewareDir();
    writeStaleCloudflareConfig();
    writeFileSync(documentRoute, documentRouteSource);

    const base = await startSpaDevServer();
    const response = await fetch(`${base}/dashboard`, {
      headers: { Accept: 'text/html' },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('document route response');
  });

  it('runs middleware before serving SPA fallback HTML on nested navigations', async () => {
    saveVoidConfig();
    writeFileSync(authMiddleware, middlewareSource);
    writeStaleCloudflareConfig();
    writeProtectedAsset();

    const base = await startSpaDevServer();
    const unauthenticatedAsset = await fetch(`${base}/void-basic-auth-regression.txt`);
    expect(unauthenticatedAsset.status).toBe(401);
    expect(await unauthenticatedAsset.text()).toBe('Authentication required');

    const authenticatedAsset = await fetch(`${base}/void-basic-auth-regression.txt`, {
      headers: { Authorization: AUTH_HEADER },
    });
    expect(authenticatedAsset.status).toBe(200);
    expect(await authenticatedAsset.text()).toBe('protected static asset');

    const unauthenticated = await fetch(`${base}/nested/spa/path`, {
      headers: { Accept: 'text/html' },
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toBe(
      'Basic realm="Preview", charset="UTF-8"',
    );
    expect(await unauthenticated.text()).toBe('Authentication required');

    const authenticated = await fetch(`${base}/nested/spa/path`, {
      headers: {
        Accept: 'text/html',
        Authorization: AUTH_HEADER,
      },
    });
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers.get('content-type')).toContain('text/html');
    expect(await authenticated.text()).toContain('<title>Vite Cloud Playground</title>');
  });
});
