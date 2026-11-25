import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import { extractTar } from '../../../security-scanner/src/runner/extract.ts';
import { getPlatformCapabilities } from '../../src/capabilities.ts';
import { getInstallationToken } from '../../src/github/installation-token.ts';
import {
  deploymentOperations,
  deployments,
  githubConnections,
  githubInstallations,
  securityScans,
} from '../../src/schema.ts';
import {
  prepareSecurityScanInput,
  prepareSecurityScanInputFiles,
} from '../../src/security/input/prepare.ts';
import {
  SECURITY_SOURCE_MAX_BYTES,
  SECURITY_SOURCE_MAX_FILES,
  SECURITY_SOURCE_TARBALL_MAX_BYTES,
  SECURITY_SOURCE_TARBALL_PART_BYTES,
} from '../../src/security/input/t1-github.ts';
import { sha256Hex } from '../../src/security/input/t2.ts';
import { tarChunks } from '../../src/security/input/tar.ts';
import { securityCoverageLabel } from '../../src/security/input/tier.ts';
import { securityRawOutputPrefix } from '../../src/security/maintenance.ts';
import {
  clearTables,
  createTestBuild,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

vi.mock('../../src/github/installation-token.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/github/installation-token.ts')>()),
  getInstallationToken: vi.fn(async () => 'scoped-token'),
}));

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const REPO_NAME = 'acme/mono';
const COMPARE_URL = `https://api.github.com/repos/${REPO_NAME}/compare/${BASE}...${HEAD}?per_page=1&page=1`;
const TARBALL_URL = `https://api.github.com/repos/${REPO_NAME}/tarball/${HEAD}`;
const MAP_URL = `//# sourceMapping${''}URL=`;

let env: TestEnv;
let onEnv: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  onEnv = {
    ...env,
    PLATFORM_CAPABILITIES: JSON.stringify({
      ...getPlatformCapabilities(env),
      managedBuilds: true,
      securityAudits: true,
    }),
    SECURITY_SCAN_SCHEDULER: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    } as unknown as TestEnv['SECURITY_SCAN_SCHEDULER'],
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(getInstallationToken).mockClear();
});

const USERS_V1 = 'export const GET = () => db.users()';
const USERS_V2 = 'export const GET = (req) => db.users(req.query.id)';

/** The monorepo at the head commit: the project is `apps/web`. */
const REPO: Record<string, string> = {
  'package.json': '{"private":true}',
  'apps/web/package.json': '{"name":"web"}',
  'apps/web/.env': 'TOKEN=x',
  'apps/web/src/server.ts': 'export default { fetch }',
  'apps/web/src/routes/users.ts': USERS_V2,
  'apps/web/src/client/app.tsx': 'export function App() {}',
  'apps/admin/src/server.ts': 'export default { admin: true }',
  'packages/shared/src/auth.ts': 'export function auth() {}',
  'packages/other/src/x.ts': 'export const x = 1',
};

const COMPARE_FILES = [
  'apps/web/src/routes/users.ts',
  'apps/web/src/client/app.tsx',
  'apps/admin/src/server.ts',
  'packages/other/src/x.ts',
].map((filename) => ({ filename, status: 'modified', patch: '@@ -1 +1 @@' }));

/** `apps/web`'s Worker bundle, built in `apps/web/dist`. */
function appModules(users: string): Record<string, string> {
  return {
    'index.js': `import"./chunks/users.js";export default{}\n${MAP_URL}index.js.map`,
    'index.js.map': JSON.stringify({
      version: 3,
      sources: ['../src/server.ts', '../../../packages/shared/src/auth.ts'],
      sourcesContent: [REPO['apps/web/src/server.ts'], REPO['packages/shared/src/auth.ts']],
      mappings: '',
    }),
    'chunks/users.js': `export const users = 1;\n${MAP_URL}users.js.map`,
    'chunks/users.js.map': JSON.stringify({
      version: 3,
      sources: ['../../src/routes/users.ts'],
      sourcesContent: [users],
      mappings: '',
    }),
  };
}

async function gzipChunks(chunks: Array<Uint8Array>): Promise<ArrayBuffer> {
  const stream = new Blob(chunks as Array<BlobPart>)
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

async function gzip(files: Record<string, string | Uint8Array>): Promise<ArrayBuffer> {
  return gzipChunks(
    tarChunks(
      Object.entries(files).map(([path, data]) => ({ path: `acme-mono-bbbbbbb/${path}`, data })),
    ),
  );
}

/** A ustar header that claims `size` bytes, so a test can name a huge file cheaply. */
function tarHeader(name: string, size: number): Uint8Array {
  const block = new Uint8Array(512);
  const put = (offset: number, text: string) => block.set(new TextEncoder().encode(text), offset);
  put(0, name);
  put(100, '0000444\0');
  put(108, '0000000\0');
  put(116, '0000000\0');
  put(124, `${size.toString(8).padStart(11, '0')}\0`);
  put(136, '00000000000\0');
  block.fill(0x20, 148, 156);
  put(156, '0');
  put(257, 'ustar\0');
  put(263, '00');
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  put(148, `${sum.toString(8).padStart(6, '0')}\0 `);
  return block;
}

/** `bytes` as a stream of odd-sized chunks, the way a network body arrives. */
function oddChunks(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      const size = 1_000_003 + (at % 7919);
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let at = 0; at < size; at += 65_536) {
    crypto.getRandomValues(bytes.subarray(at, Math.min(size, at + 65_536)));
  }
  return bytes;
}

type GithubCall = { url: string; auth: string | null };

function stubGithub(
  options: {
    compare?: object | null;
    compareStatus?: number;
    repo?: Record<string, string | Uint8Array>;
    /** The tarball response, in place of the gzipped `repo`. */
    tarball?: () => Response | Promise<Response>;
  } = {},
): Array<GithubCall> {
  const calls: Array<GithubCall> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
      if (url === COMPARE_URL) {
        if (options.compareStatus !== undefined) {
          return new Response('not found', { status: options.compareStatus });
        }
        return Response.json(
          options.compare ?? { status: 'ahead', ahead_by: 1, behind_by: 0, files: COMPARE_FILES },
        );
      }
      if (url === TARBALL_URL) {
        return options.tarball ? options.tarball() : new Response(await gzip(options.repo ?? REPO));
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
  return calls;
}

async function setup() {
  const user = await createTestUser(env.db, `owner-${crypto.randomUUID()}`);
  const project = await createTestProject(env.db, user.id);
  await env.db.insert(githubInstallations).values({
    id: `ghi_${crypto.randomUUID()}`,
    installation_id: '1',
    user_id: user.id,
    account_login: 'acme',
    account_id: '42',
    account_type: 'Organization',
    repository_selection: 'selected',
    repositories: [{ id: 9, full_name: REPO_NAME }],
  });
  await env.db.insert(githubConnections).values({
    id: `ghc_${crypto.randomUUID()}`,
    project_id: project.id,
    installation_id: '1',
    repo_full_name: REPO_NAME,
    repository_id: '9',
    authorized_by_user_id: user.id,
  });
  return { user, project };
}

async function deploy(
  projectId: string,
  userId: string,
  modules: Record<string, string>,
  options: { commit: string | null; buildId?: string },
) {
  const deployment = await createTestDeployment(env.db, projectId, 'live', undefined, undefined, {
    commit: options.commit,
  });
  await env.db
    .update(deployments)
    .set({ manifest: JSON.stringify({ type: 'void', workerMain: 'index.js' }) })
    .where(eq(deployments.id, deployment.id));
  const prefix = `deployment-inputs/${projectId}/${deployment.id}/`;
  const payload = { body: {}, modules: [] as Array<Record<string, unknown>> };
  for (const [index, [name, text]] of Object.entries(modules).entries()) {
    const key = `${prefix}${index}`;
    await env.STATIC_ASSETS_R2.put(key, text);
    payload.modules.push({
      name,
      key,
      digest: sha256Hex(text),
      type: name.endsWith('.map') ? 'application/source-map' : 'application/javascript+module',
      size: new TextEncoder().encode(text).length,
    });
  }
  await env.db.insert(deploymentOperations).values({
    id: deployment.id,
    project_id: projectId,
    actor_id: userId,
    build_id: options.buildId ?? null,
    idempotency_key: deployment.id,
    input_digest: 'digest',
    input_prefix: prefix,
    payload: payload as never,
    status: 'terminal',
  });
  return { deployment, prefix };
}

async function runningScan(id: string, projectId: string, deploymentId: string, prefix: string) {
  await env.db.insert(securityScans).values({
    id,
    project_id: projectId,
    deployment_id: deploymentId,
    status: 'running',
    trigger: 'deploy',
    attempt: 1,
    lease_until: new Date(Date.now() + 60 * 60_000).toISOString(),
    model_requested: '@cf/test/model',
    model_used: '@cf/test/model',
    engine: 'void_loop',
    input_prefix: prefix,
    first_queued_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
  });
}

/** A first scan of the base deploy at `BASE`, ended `succeeded`. */
async function baseScan(projectId: string, userId: string) {
  const { deployment, prefix } = await deploy(projectId, userId, appModules(USERS_V1), {
    commit: BASE,
  });
  await runningScan('scan_base', projectId, deployment.id, prefix);
  // A first scan is full: GitHub is not asked.
  const calls = stubGithub();
  expect(await prepareSecurityScanInputFiles(onEnv, env.db, 'scan_base', 1)).not.toBeNull();
  expect(calls).toEqual([]);
  vi.unstubAllGlobals();
  await env.db
    .update(securityScans)
    .set({ status: 'succeeded', finished_at: new Date().toISOString() })
    .where(eq(securityScans.id, 'scan_base'));
  return deployment;
}

async function headScan(
  projectId: string,
  userId: string,
  options: { users?: string; commit?: string | null; buildId?: string } = {},
) {
  const { deployment, prefix } = await deploy(
    projectId,
    userId,
    appModules(options.users ?? USERS_V2),
    {
      commit: options.commit === undefined ? HEAD : options.commit,
      ...(options.buildId ? { buildId: options.buildId } : {}),
    },
  );
  await runningScan('scan_head', projectId, deployment.id, prefix);
  return deployment;
}

async function scanRow() {
  const [row] = await env.db.select().from(securityScans).where(eq(securityScans.id, 'scan_head'));
  return row;
}

function label(row: Awaited<ReturnType<typeof scanRow>>) {
  return securityCoverageLabel({
    tier: row.tier,
    coverage: row.coverage,
    coverageNotes: row.coverage_notes,
    filesScanned: row.files_scanned,
    backlogFiles: row.backlog_files,
  });
}

/** The tarball keys this test uploads to, and each upload's part sizes. */
function trackTarballs(): Array<{ key: string; parts: Array<number> }> {
  const uploads: Array<{ key: string; parts: Array<number> }> = [];
  const r2 = env.STATIC_ASSETS_R2;
  const create = r2.createMultipartUpload.bind(r2);
  vi.spyOn(r2, 'createMultipartUpload').mockImplementation(async (key, options) => {
    const upload = await create(key, options);
    const tracked = { key, parts: [] as Array<number> };
    uploads.push(tracked);
    const uploadPart = upload.uploadPart.bind(upload);
    upload.uploadPart = async (partNumber, value, partOptions) => {
      tracked.parts.push((value as Uint8Array).byteLength);
      return uploadPart(partNumber, value, partOptions);
    };
    return upload;
  });
  return uploads;
}

/** The archive was stored under this scan, and nothing of it is left. */
async function expectTarballsGone(
  projectId: string,
  uploads: ReadonlyArray<{ key: string }>,
  count = 1,
) {
  expect(uploads).toHaveLength(count);
  for (const { key } of uploads) {
    expect(key.startsWith(`${securityRawOutputPrefix(projectId, 'scan_head')}source-`)).toBe(true);
    expect(await env.STATIC_ASSETS_R2.get(key)).toBeNull();
  }
  const kept = await env.STATIC_ASSETS_R2.list({
    prefix: `${securityRawOutputPrefix(projectId, 'scan_head')}source-`,
  });
  expect(kept.objects).toEqual([]);
}

const dirs: Array<string> = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function unpack(stream: ReadableStream<Uint8Array>): Promise<Map<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), 'scan-input-'));
  dirs.push(dir);
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  await extractTar(bytes, { dest: dir, allowedRoots: ['task.json', 'input', 'memory'] });
  const out = new Map<string, string>();
  const walk = async (folder: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else {
        out.set(relative(dir, path), await readFile(path, 'utf8'));
      }
    }
  };
  await walk(dir);
  return out;
}

describe('T1 source diff with GitHub', () => {
  it('scans the project root and listed shared files from the head tarball (#32)', async () => {
    const { user, project } = await setup();
    await baseScan(project.id, user.id);
    await headScan(project.id, user.id);
    const calls = stubGithub();

    const stream = await prepareSecurityScanInput(onEnv, env.db, 'scan_head', 1);
    const files = await unpack(stream!);
    expect([...files.keys()].sort()).toEqual([
      'input/_deploy/bindings.json',
      'input/package.json',
      'input/packages/shared/src/auth.ts',
      'input/src/client/app.tsx',
      'input/src/routes/users.ts',
      'input/src/server.ts',
      'task.json',
    ]);
    expect(JSON.parse(files.get('task.json')!)).toMatchObject({
      tier: 'source_diff',
      changed_files: ['src/routes/users.ts', 'src/client/app.tsx'],
    });
    expect(files.get('input/src/routes/users.ts')).toBe(USERS_V2);

    const row = await scanRow();
    expect(row).toMatchObject({
      tier: 'source_diff',
      coverage: 'complete',
      base_scan_id: 'scan_base',
      files_scanned: 2,
      dropped_files: 1,
    });
    expect(row.coverage_notes).toEqual(['dropped secret-like file .env']);
    expect(label(row)).toBe('source diff · 2 files');

    // One scoped token, the compare, then the head tarball; the tarball is not kept.
    expect(vi.mocked(getInstallationToken)).toHaveBeenCalledWith(expect.anything(), '1', {
      repositoryIds: ['9'],
      permissions: { contents: 'read' },
    });
    expect(calls).toEqual([
      { url: COMPARE_URL, auth: 'Bearer scoped-token' },
      { url: TARBALL_URL, auth: 'Bearer scoped-token' },
    ]);
    const kept = await env.STATIC_ASSETS_R2.list({
      prefix: securityRawOutputPrefix(project.id, 'scan_head'),
    });
    expect(
      kept.objects
        .map((object) => object.key.split('/').at(-1))
        .sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(['backlog.json', 'scope.json', 'server-leads.json']);
  });

  it('drops registry packages by the repo lockfile read from the same tarball (spec §7.4)', async () => {
    const { user, project } = await setup();
    await baseScan(project.id, user.id);
    const vendor = {
      'chunks/vendor.js': `export const v = 1;\n${MAP_URL}vendor.js.map`,
      'chunks/vendor.js.map': JSON.stringify({
        version: 3,
        sources: [
          '../../../../node_modules/.pnpm/hono@4.0.0/node_modules/hono/dist/index.js',
          '../../../../node_modules/.pnpm/zod@3.0.0/node_modules/zod/index.js',
        ],
        sourcesContent: ['export class Hono {}', 'export const z = 1'],
        mappings: '',
      }),
    };
    const { deployment, prefix } = await deploy(
      project.id,
      user.id,
      { ...appModules(USERS_V2), ...vendor },
      { commit: HEAD },
    );
    await runningScan('scan_head', project.id, deployment.id, prefix);
    // The lockfile sits at the monorepo root, above the project folder.
    stubGithub({
      repo: {
        ...REPO,
        'pnpm-lock.yaml': [
          "lockfileVersion: '9.0'",
          'importers:',
          '  apps/web:',
          '    dependencies:',
          '      hono:',
          '        specifier: ^4.0.0',
          '        version: 4.0.0',
          'packages:',
          '  hono@4.0.0:',
          '    resolution: {integrity: sha512-x}',
        ].join('\n'),
      },
    });
    const files = await unpack((await prepareSecurityScanInput(onEnv, env.db, 'scan_head', 1))!);
    const sent = [...files.keys()];
    expect(sent.some((path) => path.includes('/hono/'))).toBe(false);
    // Not in the lockfile: kept, ranked last.
    expect(sent.some((path) => path.includes('/zod/'))).toBe(true);
    expect(files.has('input/pnpm-lock.yaml')).toBe(false);
    const row = await scanRow();
    expect(row.tier).toBe('source_diff');
    expect(row.coverage_notes).toContain('third-party-unverified 1 files');
  });

  it('falls back to T2 on a truncated compare (#9)', async () => {
    const { user, project } = await setup();
    await baseScan(project.id, user.id);
    await headScan(project.id, user.id);
    const files = Array.from({ length: 300 }, (_, index) => ({
      filename: `apps/web/src/f${index}.ts`,
      status: 'added',
    }));
    const calls = stubGithub({ compare: { status: 'ahead', files } });
    expect(await prepareSecurityScanInputFiles(onEnv, env.db, 'scan_head', 1)).not.toBeNull();
    const row = await scanRow();
    expect(row.tier).toBe('built_diff');
    expect(row.coverage_notes).toEqual(['compare-truncated']);
    expect(calls.map((call) => call.url)).toEqual([COMPARE_URL]);
  });

  it('falls back to T2 after a force push or with the base commit gone (#9)', async () => {
    const { user, project } = await setup();
    await baseScan(project.id, user.id);
    await headScan(project.id, user.id);
    stubGithub({ compare: { status: 'diverged', ahead_by: 1, behind_by: 2, files: [] } });
    expect(await prepareSecurityScanInputFiles(onEnv, env.db, 'scan_head', 1)).not.toBeNull();
    expect((await scanRow()).coverage_notes).toEqual(['base-not-ancestor']);

    await env.db.update(securityScans).set({ attempt: 2 }).where(eq(securityScans.id, 'scan_head'));
    stubGithub({ compareStatus: 404 });
    expect(await prepareSecurityScanInputFiles(onEnv, env.db, 'scan_head', 2)).not.toBeNull();
    const row = await scanRow();
    expect(row.tier).toBe('built_diff');
    expect(row.coverage_notes).toEqual(['source-diff-unavailable']);
  });

  it('scans the built output when the bundle does not match the commit (#38)', async () => {
    const { user, project } = await setup();
    await baseScan(project.id, user.id);
    const shipped = 'export const GET = () => db.raw(`select ${req.id}`)';
    await headScan(project.id, user.id, { users: shipped });
    stubGithub();
    const prepared = await prepareSecurityScanInputFiles(onEnv, env.db, 'scan_head', 1);
    const row = await scanRow();
    expect(row.tier).toBe('built_diff');
    expect(row.coverage_notes).toEqual(['commit-mismatch']);
    // The code that went live is what gets scanned.
    const users = prepared!.built.entries.find(
      (entry) => entry.path === 'input/src/routes/users.ts',
    );
    expect(users?.data).toBe(shipped);
    expect(prepared!.built.focus).toEqual(['src/routes/users.ts']);
  });

  it('refuses a GitHub Actions deploy whose commit is not the OIDC sha claim (#38)', async () => {
    const { user, project } = await setup();
    await baseScan(project.id, user.id);
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      commitSha: 'c'.repeat(40),
      status: 'complete',
    });
    await headScan(project.id, user.id, { buildId: build.id });
    const calls = stubGithub();
    expect(await prepareSecurityScanInputFiles(onEnv, env.db, 'scan_head', 1)).not.toBeNull();
    const row = await scanRow();
    expect(row.tier).toBe('built_diff');
    expect(row.coverage_notes).toEqual(['commit-mismatch']);
    expect(calls).toEqual([]);
  });

  it('takes a managed container build at its commit without the content check', async () => {
    const { user, project } = await setup();
    await baseScan(project.id, user.id);
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      commitSha: HEAD,
      status: 'complete',
    });
    await headScan(project.id, user.id, { buildId: build.id });
    // A managed build ran at the repository root.
    const repo = {
      'package.json': '{"name":"app"}',
      'src/server.ts': REPO['apps/web/src/server.ts'],
      'src/routes/users.ts': USERS_V2,
      'packages/shared/src/auth.ts': REPO['packages/shared/src/auth.ts'],
    };
    stubGithub({
      repo,
      compare: {
        status: 'ahead',
        files: [{ filename: 'src/routes/users.ts', status: 'modified' }],
      },
    });
    const prepared = await prepareSecurityScanInputFiles(onEnv, env.db, 'scan_head', 1);
    expect(prepared!.built.tier).toBe('source_diff');
    expect(prepared!.built.focus).toEqual(['src/routes/users.ts']);
    expect((await scanRow()).coverage_notes).toEqual([]);
  });

  it('never takes T1 on a self-hosted install: GitHub is not asked (exit check)', async () => {
    onEnv = {
      ...onEnv,
      PLATFORM_CAPABILITIES: JSON.stringify({
        ...getPlatformCapabilities(env),
        managedBuilds: false,
        securityAudits: true,
      }),
    };
    const { user, project } = await setup();
    await baseScan(project.id, user.id);
    await headScan(project.id, user.id);
    const calls = stubGithub();
    expect(await prepareSecurityScanInputFiles(onEnv, env.db, 'scan_head', 1)).not.toBeNull();
    const row = await scanRow();
    expect(row.tier).toBe('built_diff');
    expect(row.coverage_notes).toEqual([]);
    expect(label(row)).toBe('built-output diff · 1 file');
    expect(calls).toEqual([]);
    expect(vi.mocked(getInstallationToken)).not.toHaveBeenCalled();
  });
  it('uploads a big archive in equal parts and deletes it after the scan', async () => {
    const { user, project } = await setup();
    await baseScan(project.id, user.id);
    await headScan(project.id, user.id);
    // About 17 MB that does not compress, outside the project root: three parts.
    const archive = new Uint8Array(
      await gzip({ ...REPO, 'packages/other/blob.bin': randomBytes(17 * 1024 * 1024) }),
    );
    expect(archive.length).toBeGreaterThan(2 * SECURITY_SOURCE_TARBALL_PART_BYTES);
    const uploads = trackTarballs();
    stubGithub({ tarball: () => new Response(oddChunks(archive)) });

    const prepared = await prepareSecurityScanInputFiles(onEnv, env.db, 'scan_head', 1);
    expect(prepared!.built.tier).toBe('source_diff');
    expect(uploads[0].parts).toEqual([
      SECURITY_SOURCE_TARBALL_PART_BYTES,
      SECURITY_SOURCE_TARBALL_PART_BYTES,
      archive.length - 2 * SECURITY_SOURCE_TARBALL_PART_BYTES,
    ]);
    await expectTarballsGone(project.id, uploads);
  });

  it('falls back with source-too-large past 100 MB compressed, keeping nothing', async () => {
    const { user, project } = await setup();
    await baseScan(project.id, user.id);
    await headScan(project.id, user.id);
    const uploads = trackTarballs();
    // No length header: the stream is cut while it is stored.
    const chunk = new Uint8Array(4 * 1024 * 1024);
    let sent = 0;
    stubGithub({
      tarball: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent > SECURITY_SOURCE_TARBALL_MAX_BYTES) {
                controller.close();
                return;
              }
              sent += chunk.length;
              controller.enqueue(chunk);
            },
          }),
        ),
    });
    expect(await prepareSecurityScanInputFiles(onEnv, env.db, 'scan_head', 1)).not.toBeNull();
    let row = await scanRow();
    expect(row.tier).toBe('built_diff');
    expect(row.coverage_notes).toEqual(['source-too-large']);
    // The download stopped soon after the limit (a stream may read one chunk ahead).
    expect(sent).toBeLessThanOrEqual(SECURITY_SOURCE_TARBALL_MAX_BYTES + 2 * chunk.length);
    await expectTarballsGone(project.id, uploads);

    // A length header over the limit: nothing is stored at all.
    await env.db.update(securityScans).set({ attempt: 2 }).where(eq(securityScans.id, 'scan_head'));
    stubGithub({
      tarball: () =>
        new Response('x', {
          headers: { 'content-length': String(SECURITY_SOURCE_TARBALL_MAX_BYTES + 1) },
        }),
    });
    expect(await prepareSecurityScanInputFiles(onEnv, env.db, 'scan_head', 2)).not.toBeNull();
    row = await scanRow();
    expect(row.coverage_notes).toEqual(['source-too-large']);
    expect(uploads).toHaveLength(1);
  });

  it('falls back with source-too-large past 512 MB or 100,000 files unpacked', async () => {
    const { user, project } = await setup();
    await baseScan(project.id, user.id);
    await headScan(project.id, user.id);
    const uploads = trackTarballs();
    // One file that claims more than the limit: refused at its header, never unpacked.
    const big = await gzipChunks([
      tarHeader('acme-mono-bbbbbbb/huge.bin', SECURITY_SOURCE_MAX_BYTES + 1),
    ]);
    stubGithub({ tarball: () => new Response(big) });
    expect(await prepareSecurityScanInputFiles(onEnv, env.db, 'scan_head', 1)).not.toBeNull();
    expect((await scanRow()).coverage_notes).toEqual(['source-too-large']);

    // One file too many (empty files under one name: cheap to make).
    await env.db.update(securityScans).set({ attempt: 2 }).where(eq(securityScans.id, 'scan_head'));
    const empty = tarHeader('acme-mono-bbbbbbb/a.ts', 0);
    // One buffer: a Blob of 100,001 parts takes seconds to compress.
    const headers = new Uint8Array(empty.length * (SECURITY_SOURCE_MAX_FILES + 1));
    for (let at = 0; at < headers.length; at += empty.length) {
      headers.set(empty, at);
    }
    const many = await gzipChunks([headers]);
    stubGithub({ tarball: () => new Response(many) });
    expect(await prepareSecurityScanInputFiles(onEnv, env.db, 'scan_head', 2)).not.toBeNull();
    const row = await scanRow();
    expect(row.tier).toBe('built_diff');
    expect(row.coverage_notes).toEqual(['source-too-large']);
    await expectTarballsGone(project.id, uploads, 2);
  });

  it('deletes the archive after a fallback that read it', async () => {
    const { user, project } = await setup();
    await baseScan(project.id, user.id);
    const shipped = 'export const GET = () => db.raw(1)';
    await headScan(project.id, user.id, { users: shipped });
    const uploads = trackTarballs();
    // The bundle does not match the commit: commit-mismatch after pass 1.
    stubGithub();
    expect(await prepareSecurityScanInputFiles(onEnv, env.db, 'scan_head', 1)).not.toBeNull();
    expect((await scanRow()).coverage_notes).toEqual(['commit-mismatch']);

    // A broken archive: source-diff-unavailable.
    await env.db.update(securityScans).set({ attempt: 2 }).where(eq(securityScans.id, 'scan_head'));
    stubGithub({ tarball: () => new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])) });
    expect(await prepareSecurityScanInputFiles(onEnv, env.db, 'scan_head', 2)).not.toBeNull();
    expect((await scanRow()).coverage_notes).toEqual(['source-diff-unavailable']);
    await expectTarballsGone(project.id, uploads, 2);
    // Each call stored its own archive: an older attempt never deletes a newer one's.
    expect(new Set(uploads.map((upload) => upload.key)).size).toBe(2);
  });

  it('falls back with source-diff-unavailable when the token cannot be minted', async () => {
    const { user, project } = await setup();
    await baseScan(project.id, user.id);
    await headScan(project.id, user.id);
    vi.mocked(getInstallationToken).mockRejectedValueOnce(new Error('installation suspended'));
    const calls = stubGithub();
    expect(await prepareSecurityScanInputFiles(onEnv, env.db, 'scan_head', 1)).not.toBeNull();
    const row = await scanRow();
    expect(row.tier).toBe('built_diff');
    expect(row.coverage_notes).toEqual(['source-diff-unavailable']);
    expect(calls).toEqual([]);
  });

  it('asks GitHub nothing once the connection lost its authority', async () => {
    const { user, project } = await setup();
    await baseScan(project.id, user.id);
    await headScan(project.id, user.id);
    const calls = stubGithub();
    // The repository was dropped from the installation's selection.
    await env.db
      .update(githubInstallations)
      .set({ repositories: [] })
      .where(eq(githubInstallations.installation_id, '1'));
    expect(await prepareSecurityScanInputFiles(onEnv, env.db, 'scan_head', 1)).not.toBeNull();
    expect((await scanRow()).coverage_notes).toEqual(['source-diff-unavailable']);

    // The installation is suspended.
    await env.db.update(securityScans).set({ attempt: 2 }).where(eq(securityScans.id, 'scan_head'));
    await env.db
      .update(githubInstallations)
      .set({ repositories: [{ id: 9, full_name: REPO_NAME }], status: 'suspended' })
      .where(eq(githubInstallations.installation_id, '1'));
    expect(await prepareSecurityScanInputFiles(onEnv, env.db, 'scan_head', 2)).not.toBeNull();
    const row = await scanRow();
    expect(row.tier).toBe('built_diff');
    expect(row.coverage_notes).toEqual(['source-diff-unavailable']);
    expect(calls).toEqual([]);
    expect(vi.mocked(getInstallationToken)).not.toHaveBeenCalled();
  });
});
