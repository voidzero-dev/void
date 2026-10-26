import { describe, expect, it } from 'vite-plus/test';
import { generateRouteTypes } from '../../src/codegen/route-types.ts';
import type { PageDefinition } from '../../src/pages/types.ts';
import type { ScanResult } from '../../src/router/scan.ts';

const pageRenderingDefaults = {
  ssrMode: 'auto',
  prerenderMode: 'auto',
  renderMode: 'server',
  shouldPrerender: false,
} satisfies Pick<PageDefinition, 'ssrMode' | 'prerenderMode' | 'renderMode' | 'shouldPrerender'>;

function makeScan({
  routes = [],
  websockets,
  pages = [],
}: {
  routes?: ScanResult['routes'];
  websockets?: ScanResult['websockets'];
  pages?: Array<PageDefinition>;
} = {}): ScanResult {
  return {
    routes,
    websockets,
    middleware: [],
    jobs: [],
    queues: [],
    pages: { pages, layouts: [], namedLayouts: [] },
  };
}

describe('generateRouteTypes', () => {
  it('generates route type declarations for single-method routes', () => {
    const scan = makeScan({
      routes: [
        {
          pattern: '/api/hello',
          methods: ['GET'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/hello.ts',
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void');

    expect(dts).toContain('declare module "void/routes"');
    expect(dts).toContain('"/api/hello"');
    expect(dts).toContain('GET: {');
    expect(dts).toContain('typeof import("../routes/api/hello.ts")');
    expect(dts).toContain('input:');
    expect(dts).toContain('output:');
  });

  it('generates multi-method routes', () => {
    const scan = makeScan({
      routes: [
        {
          pattern: '/api/users',
          methods: ['GET', 'POST'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/users/index.ts',
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void');

    expect(dts).toContain('GET: {');
    expect(dts).toContain('POST: {');
    expect(dts).toContain('typeof import("../routes/api/users/index.ts")');
  });

  it('emits one route key and preserves methods from colliding route files', () => {
    const scan = makeScan({
      routes: [
        {
          pattern: '/api/health',
          methods: ['GET'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/health.ts',
        },
        {
          pattern: '/api/health',
          methods: ['POST'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/health/index.ts',
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void');
    const routeMap = dts
      .split('  interface RouteMap {')[1]!
      .split('  interface WebSocketRouteMap {')[0]!;

    expect(routeMap.match(/"\/api\/health": \{/g)).toHaveLength(1);
    expect(routeMap).toContain('GET: {');
    expect(routeMap).toContain('POST: {');
    expect(routeMap).toContain('typeof import("../routes/api/health.ts")');
    expect(routeMap).toContain('typeof import("../routes/api/health/index.ts")');
  });

  it('combines colliding environment-specific methods conservatively', () => {
    const scan = makeScan({
      routes: [
        {
          pattern: '/api/health',
          methods: ['GET'],
          params: [],
          catchAll: false,
          env: 'dev',
          filePath: 'api/health.dev.ts',
        },
        {
          pattern: '/api/health',
          methods: ['GET'],
          params: [],
          catchAll: false,
          env: 'prod',
          filePath: 'api/health.prod.ts',
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void');
    const routeMap = dts
      .split('  interface RouteMap {')[1]!
      .split('  interface WebSocketRouteMap {')[0]!;

    expect(routeMap.match(/"\/api\/health": \{/g)).toHaveLength(1);
    expect(routeMap.match(/GET: \{/g)).toHaveLength(1);
    expect(routeMap).toMatch(/input: .*health\.dev\.ts.* & .*health\.prod\.ts/);
    expect(routeMap).toMatch(/output: .*health\.dev\.ts.* \| .*health\.prod\.ts/);
  });

  it('skips routes with no methods', () => {
    const scan = makeScan({
      routes: [
        {
          pattern: '/api/legacy',
          methods: [],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/legacy.ts',
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void');

    expect(dts).not.toContain('/api/legacy');
  });

  it('handles dynamic params in patterns', () => {
    const scan = makeScan({
      routes: [
        {
          pattern: '/api/users/:id',
          methods: ['GET'],
          params: ['id'],
          catchAll: false,
          env: null,
          filePath: 'api/users/[id].ts',
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void');

    expect(dts).toContain('"/api/users/:id"');
    expect(dts).toContain('typeof import("../routes/api/users/[id].ts")');
  });

  it('includes Serialize and ExtractInput helper types', () => {
    const { dts } = generateRouteTypes(makeScan(), '/project/routes', '/project/.void');

    expect(dts).toContain('type Serialize<T>');
    expect(dts).toContain('type ExtractInput<V>');
    expect(dts).toContain('StandardSchemaV1');
  });

  it('includes export {} so declare module is an augmentation', () => {
    const { dts } = generateRouteTypes(makeScan(), '/project/routes', '/project/.void');

    expect(dts).toContain('export {}');
  });

  it('emits RouteName and RewriteDestination aliases on void/routes', () => {
    const scan = makeScan({
      routes: [
        {
          pattern: '/api/hello',
          methods: ['GET'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/hello.ts',
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void');

    // Both exports must live inside the `declare module "void/routes"` block so
    // consumers importing from `void/routes` pick them up after codegen.
    const moduleBlockStart = dts.indexOf('declare module "void/routes"');
    expect(moduleBlockStart).toBeGreaterThan(-1);
    const moduleBlock = dts.slice(moduleBlockStart);

    expect(moduleBlock).toContain('export type RouteName = keyof RouteMap;');
    // The `(string & {})` trick is load-bearing: it keeps route-name
    // autocomplete while still accepting dynamic paths like `/users/${id}`.
    expect(moduleBlock).toContain('export type RewriteDestination = RouteName | (string & {});');
  });

  it('generates PageActionMap for pages with actions', () => {
    const scan = makeScan({
      pages: [
        {
          ...pageRenderingDefaults,
          pattern: '/users',
          params: [],
          catchAll: false,
          componentPath: 'users/index.vue',
          serverPath: 'users/index.server.ts',
          methods: ['loader', 'action'],
          componentId: 'users',
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void', '/project/pages');

    expect(dts).toContain('interface PageActionMap');
    expect(dts).toContain('"/users"');
    expect(dts).toContain('typeof import("../pages/users/index.server.ts")');
    expect(dts).toContain('body:');
  });

  it('generates params in PageActionMap for dynamic routes', () => {
    const scan = makeScan({
      pages: [
        {
          ...pageRenderingDefaults,
          pattern: '/users/:id',
          params: ['id'],
          catchAll: false,
          componentPath: 'users/[id].vue',
          serverPath: 'users/[id].server.ts',
          methods: ['loader', 'action'],
          componentId: 'users/[id]',
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void', '/project/pages');

    expect(dts).toContain('"/users/:id"');
    expect(dts).toContain('params: { id: string }');
  });

  it('joins a .dev + .prod page pair into one PageActionMap key', () => {
    const page = {
      ...pageRenderingDefaults,
      pattern: '/users/:id',
      params: ['id'],
      catchAll: false,
    };
    const scan = makeScan({
      pages: [
        {
          ...page,
          componentPath: 'users/[id].dev.vue',
          serverPath: 'users/[id].dev.server.ts',
          methods: ['action'],
          componentId: 'users/[id].dev',
          env: 'dev',
        },
        {
          ...page,
          componentPath: 'users/[id].prod.vue',
          serverPath: 'users/[id].prod.server.ts',
          methods: ['actions'],
          componentId: 'users/[id].prod',
          env: 'prod',
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void', '/project/pages');
    const actionMap = dts.split('  interface PageActionMap {')[1]!;
    const dev = '(typeof import("../pages/users/[id].dev.server.ts"))["action"]';
    const prod = '(typeof import("../pages/users/[id].prod.server.ts"))["actions"]';

    expect(actionMap.split('"/users/:id"')).toHaveLength(2);
    expect(actionMap).toContain(
      [
        '    "/users/:id": {',
        `      body: ExtractInput<${dev}["__validators"]> extends { body: infer B } ? B : Record<string, unknown>;`,
        '      params: { id: string };',
        '    } | {',
        `      actions: { [K in keyof ${prod}]: {`,
      ].join('\n'),
    );
    expect(actionMap).toContain(['      params: { id: string };', '    };', '  }'].join('\n'));
  });

  it('generates WebSocketRouteMap entries', () => {
    const scan = makeScan({
      websockets: [
        {
          pattern: '/chat/:room',
          methods: [],
          params: ['room'],
          catchAll: false,
          env: null,
          filePath: 'chat/[room].ws.ts',
          className: 'ChatRoomWs',
          bindingName: 'ChatRoomWs',
          mode: 'room',
          hasAuthGate: true,
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void');

    expect(dts).toContain('interface WebSocketRouteMap');
    expect(dts).toContain('"/chat/:room"');
    expect(dts).toContain('typeof import("../routes/chat/[room].ws.ts")');
    expect(dts).toContain('client:');
    expect(dts).toContain('server:');
    expect(dts).toContain('params: RouteParams<["room"]>');
  });

  it('emits one WebSocket route key for colliding route files', () => {
    const websocket = {
      pattern: '/chat/:room',
      methods: [],
      params: ['room'],
      catchAll: false,
      env: 'dev' as const,
      filePath: 'chat/[room].dev.ws.ts',
      className: 'ChatRoomDevWs',
      bindingName: 'ChatRoomDevWs',
      mode: 'room' as const,
      hasAuthGate: true,
    };
    const scan = makeScan({
      websockets: [
        websocket,
        {
          ...websocket,
          env: 'prod',
          filePath: 'chat/[room].prod.ws.ts',
          className: 'ChatRoomProdWs',
          bindingName: 'ChatRoomProdWs',
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void');
    const websocketMap = dts.split('  interface WebSocketRouteMap {')[1]!.split('\n  }\n}')[0]!;

    expect(websocketMap.match(/"\/chat\/:room": \{/g)).toHaveLength(1);
    expect(websocketMap).toContain('chat/[room].dev.ws.ts');
    expect(websocketMap).toContain('chat/[room].prod.ws.ts');
    expect(websocketMap).toMatch(/client: .*dev\.ws\.ts.* & .*prod\.ws\.ts/);
    expect(websocketMap).toMatch(/server: .*dev\.ws\.ts.* \| .*prod\.ws\.ts/);
  });

  it('skips pages without action in PageActionMap', () => {
    const scan = makeScan({
      pages: [
        {
          ...pageRenderingDefaults,
          pattern: '/about',
          params: [],
          catchAll: false,
          componentPath: 'about.vue',
          serverPath: 'about.server.ts',
          methods: ['loader'],
          componentId: 'about',
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void', '/project/pages');

    expect(dts).toContain('export interface PageActionMap {}');
    expect(dts).not.toContain('"/about"');
  });

  it('generates PageActionMap with named actions', () => {
    const scan = makeScan({
      pages: [
        {
          ...pageRenderingDefaults,
          pattern: '/users',
          params: [],
          catchAll: false,
          componentPath: 'users/index.vue',
          serverPath: 'users/index.server.ts',
          methods: ['loader', 'actions'],
          componentId: 'users',
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void', '/project/pages');

    expect(dts).toContain('interface PageActionMap');
    expect(dts).toContain('"/users"');
    expect(dts).toContain('[K in keyof');
    expect(dts).toContain('["actions"]');
    expect(dts).toContain('ParseActionUrl<U>["action"]');
  });

  it('errors when both action and actions are present', () => {
    const scan = makeScan({
      pages: [
        {
          ...pageRenderingDefaults,
          pattern: '/users',
          params: [],
          catchAll: false,
          componentPath: 'users/index.vue',
          serverPath: 'users/index.server.ts',
          methods: ['loader', 'action', 'actions'],
          componentId: 'users',
        },
      ],
    });

    expect(() =>
      generateRouteTypes(scan, '/project/routes', '/project/.void', '/project/pages'),
    ).toThrow(/both.*action.*actions/i);
  });

  it('omits PageActionMap when pagesDir is not provided', () => {
    const scan = makeScan({
      pages: [
        {
          ...pageRenderingDefaults,
          pattern: '/users',
          params: [],
          catchAll: false,
          componentPath: 'users/index.vue',
          serverPath: 'users/index.server.ts',
          methods: ['loader', 'action'],
          componentId: 'users',
        },
      ],
    });

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void');

    expect(dts).toContain('export interface PageActionMap {}');
    expect(dts).not.toContain('"/users"');
  });
});
