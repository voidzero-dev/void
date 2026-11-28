import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlatformDiscoveryDocument } from '@void/platform';
import { expect, it } from 'vite-plus/test';
import { savePlatformConnection } from '../../src/cli/platform-registry.ts';
import { listen, systemEnv, temporaryDirectory } from '../helpers/cloudflare-operation-process.ts';
import { platformDiscoveryResponse } from '../helpers/platform-discovery.ts';

const sdk = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(sdk, 'dist/cli/cli.mjs');

function project(): string {
  const root = join(temporaryDirectory('void-init-stdin-'), 'app');
  mkdirSync(root);
  return root;
}

async function init(root: string, args: Array<string>, overrides: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [cli, 'init', ...args], {
    cwd: root,
    env: {
      ...systemEnv,
      CI: '1',
      HOME: dirname(root),
      USERPROFILE: dirname(root),
      VOID_PLATFORM_REGISTRY_DIR: join(dirname(root), 'registry'),
      ...overrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
  }
  const [status] = (await once(child, 'close')) as [number | null];
  return { status, output };
}

function existingProject(root: string): void {
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(sdk, join(root, 'node_modules/void'), 'junction');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'init-stdin-test',
      type: 'module',
      devDependencies: { void: '*', vite: '*' },
    }),
  );
}

function savePlatform(apiUrl: string, registry: string) {
  return savePlatformConnection(
    {
      accountId: null,
      apiUrl,
      applicationDomain: 'void.app',
      displayName: new URL(apiUrl).host,
      installationId: null,
      kind: 'connected',
      proxyUrl: apiUrl,
    },
    registry,
  );
}

async function servePlatform(): Promise<string> {
  let discovery = '';
  const origin = await listen(
    createServer((_, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(discovery);
    }),
  );
  const document = await platformDiscoveryResponse(origin).json<PlatformDiscoveryDocument>();
  discovery = JSON.stringify({
    ...document,
    capabilities: { ...document.capabilities, githubActions: true },
  });
  return origin;
}

const starter = ['--toolchain', 'vite', '--framework', 'react', '--starter', 'sqlite'];

it.each([
  ['toolchain', []],
  ['framework', starter.slice(0, 2)],
  ['starter', starter.slice(0, 4)],
  ['deploy', starter],
] as const)('requires --%s before Git init when stdin is closed', async (flag, args) => {
  const root = project();
  const { status, output } = await init(root, ['--git', ...args]);
  expect(output).toContain(`Pass --${flag}`);
  expect(status).toBe(1);
  expect(readdirSync(root)).toEqual([]);
});

it('rejects an ambiguous project folder before writes when stdin is closed', async () => {
  const root = project();
  const notes = join(root, 'notes.txt');
  writeFileSync(notes, 'Keep these notes.\n');
  const { status, output } = await init(root, ['--no-git', '--deploy', 'none']);
  expect(status, output).toBe(1);
  expect(output).toContain('empty directory');
  expect(readdirSync(root)).toEqual(['notes.txt']);
  expect(readFileSync(notes, 'utf8')).toBe('Keep these notes.\n');
});

it('requires a Void platform connection before scaffolding', async () => {
  const root = project();
  const { status, output } = await init(root, ['--no-git', ...starter, '--deploy', 'void']);
  expect(status, output).toBe(1);
  expect(output).toContain('void connect <url> --no-login');
  expect(output).toContain('--deploy none');
  expect(readdirSync(root)).toEqual([]);
});

it('reports an unreadable registry before scaffolding', async () => {
  const root = project();
  const registry = join(dirname(root), 'registry');
  mkdirSync(registry);
  writeFileSync(join(registry, 'registry.json'), '{');
  const result = await init(root, ['--no-git', ...starter, '--deploy', 'void']);
  expect(result.status, result.output).toBe(1);
  expect(result.output).toContain('Could not read');
  expect(result.output).toContain('registry.json');
  expect(result.output).not.toContain('void connect');
  expect(readdirSync(root)).toEqual([]);
});

it.each([
  { workspace: false, message: 'HTTP 503' },
  { workspace: true, message: '--git/--no-git options are not available' },
])('leaves a D1 starter untouched when init reports "$message"', async ({ workspace, message }) => {
  const root = project();
  if (workspace) {
    writeFileSync(join(dirname(root), 'package.json'), JSON.stringify({ workspaces: ['app'] }));
  }
  const paths: Array<string | undefined> = [];
  const apiUrl = await listen(
    createServer((request, response) => {
      paths.push(request.url);
      response
        .writeHead(503, { 'Content-Type': 'application/json' })
        .end('{"error":"Platform disabled"}');
    }),
  );
  const registry = join(dirname(root), 'registry');
  savePlatform(apiUrl, registry);
  savePlatform('https://other.example.test', registry);
  const projectFile = JSON.stringify({ platform: 'void', platformUrl: apiUrl });
  mkdirSync(join(root, '.void'));
  writeFileSync(join(root, '.void/project.json'), projectFile);
  const before = new Set(readdirSync(root, { encoding: 'utf8', recursive: true }));
  const result = await init(root, ['--no-git', ...starter, '--deploy', 'void']);
  expect(result.status, result.output).toBe(1);
  expect(result.output).toContain(message);
  expect(paths).toEqual(workspace ? [] : ['/.well-known/void-platform']);
  expect(new Set(readdirSync(root, { encoding: 'utf8', recursive: true }))).toEqual(before);
  expect(readFileSync(join(root, '.void/project.json'), 'utf8')).toBe(projectFile);
});

it.each(['home', 'project'] as const)(
  'keeps the %s platform registry unchanged when local validation fails',
  async (location) => {
    const root = project();
    const registry = join(location === 'home' ? dirname(root) : root, '.void', 'platforms');
    const registryFile = join(registry, 'registry.json');
    const apiUrl = await servePlatform();
    savePlatform(apiUrl, registry);
    savePlatform('https://other.example.test', registry);
    const before = readFileSync(registryFile);
    mkdirSync(join(root, '.void'), { recursive: true });
    writeFileSync(
      join(root, '.void/project.json'),
      JSON.stringify({ platform: 'void', platformUrl: apiUrl }),
    );
    writeFileSync(join(root, 'package.json'), '{"name":"toml-app"}');
    writeFileSync(join(root, 'wrangler.toml'), 'name = "toml-app"\n');

    const result = await init(root, ['--no-git', '--deploy', 'void'], {
      VOID_PLATFORM_REGISTRY_DIR: location === 'project' ? registry : undefined,
    });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('Cloudflare tooling TOML is not supported');
    expect(readFileSync(registryFile)).toEqual(before);
  },
);

it('keeps the selected Void platform in the headless workflow follow-up', async () => {
  const root = project();
  existingProject(root);
  const alpha = await servePlatform();
  const beta = await servePlatform();
  const registry = join(dirname(root), 'registry');
  const selected = savePlatform(alpha, registry);
  savePlatform(beta, registry);
  mkdirSync(join(root, '.void'));
  const projectFile = join(root, '.void/project.json');
  writeFileSync(projectFile, JSON.stringify({ platform: 'void', platformUrl: beta }));

  const result = await init(root, ['--no-git', '--deploy', 'void'], { VOID_API_URL: alpha + '/' });
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain(`VOID_API_URL=${alpha} void init --github`);
  expect(result.output).toContain('void account login');
  expect(result.output).toContain('void project link <slug>');
  expect(readFileSync(projectFile, 'utf8')).toContain(`"platformUrl": "${beta}"`);
  const workflow = join(root, '.github/workflows/void-deploy.yml');
  expect(existsSync(workflow)).toBe(false);
  expect(readFileSync(join(registry, 'registry.json'), 'utf8')).toContain(
    `"activeConnectionId": "${selected.id}"`,
  );

  const followUp = await init(root, ['--github'], { VOID_API_URL: alpha });
  expect(followUp.status, followUp.output).toBe(0);
  expect(readFileSync(workflow, 'utf8')).toContain(alpha);
});

it.each([false, true])(
  'continues with multiple Cloudflare accounts, workflow present: %s',
  async (hasWorkflow) => {
    const root = project();
    existingProject(root);
    const workflow = join(root, '.github/workflows/void-deploy.yml');
    const workflowText = 'name: Existing deployment\n';
    if (hasWorkflow) {
      mkdirSync(dirname(workflow), { recursive: true });
      writeFileSync(workflow, workflowText);
    }
    const id = '1'.repeat(32);
    const responses: Record<string, unknown> = {
      '/client/v4/accounts': [
        { id, name: 'First' },
        { id: '2'.repeat(32), name: 'Second' },
      ],
      '/client/v4/user/tokens/verify': { id, status: 'active' },
      '/client/v4/user': { id, email: 'mock@example.test' },
    };
    const url = await listen(
      createServer((request, response) => {
        const result = responses[request.url?.split('?')[0] ?? ''];
        if (!result) {
          response
            .writeHead(404, { 'Content-Type': 'application/json' })
            .end(
              '{"success":false,"errors":[{"code":10000,"message":"Unexpected path in probe"}]}',
            );
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            success: true,
            result,
            result_info: {
              page: 1,
              per_page: 50,
              total_pages: 1,
              count: Array.isArray(result) ? result.length : 1,
              total_count: Array.isArray(result) ? result.length : 1,
            },
          }),
        );
      }),
    );
    const result = await init(root, ['--no-git', '--deploy', 'cloudflare'], {
      CLOUDFLARE_API_BASE_URL: url + '/client/v4',
      CLOUDFLARE_API_TOKEN: 'synthetic-token',
    });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('Multiple Cloudflare accounts are available');
    expect(result.output).toContain('CLOUDFLARE_ACCOUNT_ID');
    expect(result.output.includes('void init --github')).toBe(!hasWorkflow);
    if (hasWorkflow) {
      expect(readFileSync(workflow, 'utf8')).toBe(workflowText);
    }
  },
);

it.each([
  ['the saved target', 'none', []],
  ['an explicit target', 'void', ['--deploy', 'none']],
] as const)(
  'keeps authored SQLite configuration with %s and closed stdin',
  async (_, saved, args) => {
    const root = project();
    existingProject(root);
    const configPath = join(root, 'void.config.ts');
    const config =
      'export default { database: { dialect: "sqlite", casing: "camelCase" }, compatibilityDate: "2026-01-01" };\n';
    writeFileSync(configPath, config);
    mkdirSync(join(root, '.void'));
    writeFileSync(join(root, '.void/project.json'), JSON.stringify({ platform: saved }));
    const { status, output } = await init(root, ['--toolchain', 'vite', '--no-git', ...args]);
    expect(status, output).toBe(0);
    expect(readFileSync(configPath, 'utf8')).toBe(config);
    expect(readdirSync(root)).not.toContain('db');
    expect(output).toContain('in a terminal to scaffold demo code');
    expect(JSON.parse(readFileSync(join(root, '.void/project.json'), 'utf8'))).toEqual({
      platform: 'none',
    });
  },
);
