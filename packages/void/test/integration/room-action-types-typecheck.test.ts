import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { generateRouteTypes } from '../../src/codegen/route-types.ts';
import { readProjectPaths } from '../../src/project-paths.ts';
import type { ScanResult } from '../../src/router/scan.ts';
import { scanWebSocketRoutesSync } from '../../src/router/websocket.ts';

const voidDist = join(import.meta.dirname, '..', '..', 'dist');
const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const schema = `const schema = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
} as const;`;

const relayRoute = `import { defineRoom } from 'void/ws';
${schema}
export default defineRoom({
  messages: { client: schema, server: schema },
  actions: {
    revokeSession(context, sessionId: string, code: number) {
      return { closed: 1, sessionId, code, id: context.id };
    },
    ping(context) {
      return context.id;
    },
  },
});
`;

const plainRoute = `import { defineRoom } from 'void/ws';
${schema}
export default defineRoom({ messages: { client: schema, server: schema } });
`;

const feedRoute = `import { defineWebSocket } from 'void/ws';
${schema}
export default defineWebSocket({ messages: { client: schema, server: schema } });
`;

const check = `import { getRoom, type RoomHandle } from 'void/ws/server';

const room = getRoom('/relay/[accountId]', { params: { accountId: 'acct_1' } });
const handle: RoomHandle<'/relay/[accountId]'> = room;
const revoked: Promise<{ closed: number; sessionId: string; code: number; id: string }> =
  room.actions.revokeSession('session_1', 4001);
const pinged: Promise<string> = room.actions.ping();

const plain = getRoom('/plain');
const noActions: {} = plain.actions;

// @ts-expect-error routes with parameters require them
getRoom('/relay/[accountId]');
// @ts-expect-error parameter names come from the route
getRoom('/relay/[accountId]', { params: { accountId: 'acct_1', extra: 'x' } });
// @ts-expect-error action arguments are typed
room.actions.revokeSession(1, 4001);
// @ts-expect-error action arguments are required
room.actions.revokeSession('session_1');
// @ts-expect-error only declared actions exist
room.actions.missing();
// @ts-expect-error defineWebSocket() routes expose no actions
getRoom('/feed');
// @ts-expect-error a room without actions has none
plain.actions.missing();
`;

/**
 * Typecheck `getRoom()` against the declarations `generateRouteTypes()` emits for
 * real route files, so codegen and the public handle types cannot drift apart
 * without failing here.
 */
function typecheck(
  routes: Record<string, string>,
  files: Record<string, string>,
  transformDts?: (dts: string) => string,
) {
  const root = mkdtempSync(join(tmpdir(), 'void-room-action-types-'));
  roots.push(root);
  const routesDir = join(root, 'routes');
  for (const [path, content] of Object.entries(routes)) {
    mkdirSync(dirname(join(routesDir, path)), { recursive: true });
    writeFileSync(join(routesDir, path), content);
  }

  const websockets = scanWebSocketRoutesSync(root, readProjectPaths(root));
  const { dts } = generateRouteTypes(
    {
      routes: [],
      websockets,
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    } satisfies ScanResult,
    routesDir,
    join(root, '.void'),
  );

  const all: Record<string, string> = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022'],
        types: [],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        paths: {
          void: [join(voidDist, 'index.d.mts')],
          'void/ws': [join(voidDist, 'runtime/ws.d.mts')],
          'void/ws/server': [join(voidDist, 'runtime/ws-room.d.mts')],
          // Generated declarations augment this base module; the package helper
          // aliases must not hide defects in the generated output.
          'void/routes': [join(root, 'routes-base.d.ts')],
        },
      },
      files: ['.void/routes.d.ts', 'check.ts'],
    }),
    '.void/routes.d.ts': transformDts ? transformDts(dts) : dts,
    'routes-base.d.ts': 'export {};',
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }

  const tsc = join(
    dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
    'bin/tsc',
  );
  return spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')], {
    encoding: 'utf8',
  });
}

describe('getRoom() against generated route types', () => {
  it('accepts the actions the generated declarations expose', () => {
    const result = typecheck(
      {
        'relay/[accountId].ws.ts': relayRoute,
        'plain.ws.ts': plainRoute,
        'feed.ws.ts': feedRoute,
      },
      { 'check.ts': check },
    );
    expect(result.stdout + result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('catches a declaration that drops the generated actions', () => {
    const result = typecheck(
      {
        'relay/[accountId].ws.ts': relayRoute,
        'plain.ws.ts': plainRoute,
        'feed.ws.ts': feedRoute,
      },
      { 'check.ts': check },
      // Same check, but the generated map no longer exposes the room's actions.
      // The assertions above must fail, so this proves they are live.
      (dts) => dts.replace(/^\s*actions: .*$/m, ''),
    );
    expect(result.status).not.toBe(0);
  });
});
