/**
 * Shared set-up of the scan input suites: staged deploy modules, the tar a scan
 * receives, and the coverage label of a scan row.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { onTestFinished } from 'vite-plus/test';
import { extractTar } from '../../../security-scanner/src/runner/extract.ts';
import { deploymentOperations } from '../../src/schema.ts';
import type { securityScans } from '../../src/schema.ts';
import { sha256Hex } from '../../src/security/input/t2.ts';
import { securityCoverageLabel } from '../../src/security/input/tier.ts';
import { createTestUser } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

/** Split so this file is not read as having a source map itself. */
export const MAP_URL = `//# sourceMapping${''}URL=`;

/** A source map whose sources are the given paths, with their text inlined. */
export function sourceMapJson(sources: Record<string, string>): string {
  return JSON.stringify({
    version: 3,
    sources: Object.keys(sources),
    sourcesContent: Object.values(sources),
    mappings: '',
  });
}

/**
 * A small Void app's Worker bundle: entry → route chunk, each with its map. The entry's
 * map lists `serverSources`; the route chunk's map the route and `routeSources`.
 */
export function appModules(
  routeSource: string,
  options: { routeSources?: Record<string, string>; serverSources?: Record<string, string> } = {},
): Record<string, string> {
  return {
    'index.js': `import"./chunks/users.js";export default{}\n${MAP_URL}index.js.map`,
    'index.js.map': sourceMapJson(
      options.serverSources ?? { '../src/server.ts': 'export default { fetch }' },
    ),
    'chunks/users.js': `export const users = 1;\n${MAP_URL}users.js.map`,
    'chunks/users.js.map': sourceMapJson({
      '../../src/routes/users.ts': routeSource,
      ...options.routeSources,
    }),
  };
}

/**
 * Stages the modules the way a CLI upload does and records the terminal deployment
 * operation. Returns the staged input prefix.
 */
export async function stageDeploymentInput(
  env: TestEnv,
  projectId: string,
  deploymentId: string,
  modules: Record<string, string>,
  options: {
    actorId?: string;
    buildId?: string | null;
    recordSizes?: boolean;
    body?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const prefix = `deployment-inputs/${projectId}/${deploymentId}/`;
  const payload = { body: options.body ?? {}, modules: [] as Array<Record<string, unknown>> };
  for (const [index, [name, text]] of Object.entries(modules).entries()) {
    const key = `${prefix}${index}`;
    await env.STATIC_ASSETS_R2.put(key, text);
    payload.modules.push({
      name,
      key,
      digest: sha256Hex(text),
      type: name.endsWith('.map') ? 'application/source-map' : 'application/javascript+module',
      ...(options.recordSizes === false ? {} : { size: new TextEncoder().encode(text).length }),
    });
  }
  const actorId =
    options.actorId ?? (await createTestUser(env.db, `actor-${crypto.randomUUID()}`)).id;
  await env.db.insert(deploymentOperations).values({
    id: deploymentId,
    project_id: projectId,
    actor_id: actorId,
    build_id: options.buildId ?? null,
    idempotency_key: deploymentId,
    input_digest: 'digest',
    input_prefix: prefix,
    payload: payload as never,
    status: 'terminal',
  });
  return prefix;
}

/** Unpacks a scan input tar into a temporary folder: path → text. */
export async function unpackScanInput(
  stream: ReadableStream<Uint8Array>,
): Promise<Map<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), 'scan-input-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
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

/** The coverage line the CLI and page print for a scan row. */
export function coverageLabel(row: typeof securityScans.$inferSelect) {
  return securityCoverageLabel({
    tier: row.tier,
    coverage: row.coverage,
    coverageNotes: row.coverage_notes,
    filesScanned: row.files_scanned,
    backlogFiles: row.backlog_files,
  });
}

export async function r2Text(env: TestEnv, key: string): Promise<string | null> {
  const object = await env.STATIC_ASSETS_R2.get(key);
  return object ? object.text() : null;
}

/** An R2 object read as JSON; the tests check its fields one by one. */
// oxlint-disable-next-line typescript/no-explicit-any
export async function r2Json<T = any>(env: TestEnv, key: string): Promise<T> {
  const text = await r2Text(env, key);
  if (text === null) {
    throw new Error(`no R2 object at ${key}`);
  }
  return JSON.parse(text) as T;
}
