/** Shared set-up of the scan input suites: staged deploy modules with source maps. */
import { deploymentOperations } from '../../src/schema.ts';
import { sha256Hex } from '../../src/security/input/t2.ts';
import { createTestUser } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

/** Split so this file is not read as having a source map itself. */
const MAP_URL = `//# sourceMapping${''}URL=`;

/** A source map whose sources are the given paths, with their text inlined. */
function sourceMapJson(sources: Record<string, string>): string {
  return JSON.stringify({
    version: 3,
    sources: Object.keys(sources),
    sourcesContent: Object.values(sources),
    mappings: '',
  });
}

/** A small Void app's Worker bundle: entry → route chunk, each with its map. */
export function appModules(routeSource: string): Record<string, string> {
  return {
    'index.js': `import"./chunks/users.js";export default{}\n${MAP_URL}index.js.map`,
    'index.js.map': sourceMapJson({ '../src/server.ts': 'export default { fetch }' }),
    'chunks/users.js': `export const users = 1;\n${MAP_URL}users.js.map`,
    'chunks/users.js.map': sourceMapJson({ '../../src/routes/users.ts': routeSource }),
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
): Promise<string> {
  const prefix = `deployment-inputs/${projectId}/${deploymentId}/`;
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
  const actor = await createTestUser(env.db, `actor-${crypto.randomUUID()}`);
  await env.db.insert(deploymentOperations).values({
    id: deploymentId,
    project_id: projectId,
    actor_id: actor.id,
    idempotency_key: deploymentId,
    input_digest: 'digest',
    input_prefix: prefix,
    payload: payload as never,
    status: 'terminal',
  });
  return prefix;
}
