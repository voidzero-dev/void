import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  deriveWebSocketClassName,
  deriveWebSocketClassNameFromName,
  detectWebSocketDefinition,
  inferWebSocketResourceName,
  scanWebSocketRoutesSync,
} from '../../src/router/websocket.ts';

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createRoute(root: string, path: string, source: string): string {
  const file = join(root, 'routes', path);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, source);
  return file;
}

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-websocket-scan-'));
  roots.push(root);
  return root;
}

describe('JSX WebSocket discovery', () => {
  it.each(
    ['tsx', 'jsx'].flatMap((ext) =>
      (['defineRoom', 'defineWebSocket'] as const).map((helper) => ({ ext, helper })),
    ),
  )('discovers .$ext $helper routes and filters environments', ({ ext, helper }) => {
    const root = createRoot();
    const source = `export default ${helper}({ onBeforeConnect() { return <p>Sign in</p>; } });`;
    createRoute(root, `chat/[room].dev.ws.${ext}`, source);
    createRoute(root, `chat/[room].prod.ws.${ext}`, source);
    createRoute(root, `.well-known/status.ws.${ext}`, `export default ${helper}({});`);
    createRoute(root, `_private.ws.${ext}`, source);
    createRoute(root, `_private/hidden.ws.${ext}`, source);
    createRoute(root, `.cache/ignored.ws.${ext}`, source);

    for (const environment of ['dev', 'prod'] as const) {
      expect(scanWebSocketRoutesSync(root, undefined, environment)).toEqual([
        expect.objectContaining({
          filePath: `.well-known/status.ws.${ext}`,
          pattern: '/.well-known/status',
        }),
        expect.objectContaining({
          filePath: `chat/[room].${environment}.ws.${ext}`,
          pattern: '/chat/:room',
          params: ['room'],
          env: environment,
          className: 'ChatRoomWs',
          bindingName: 'ChatRoomWs',
          mode: helper === 'defineRoom' ? 'room' : 'socket',
          hasAuthGate: true,
        }),
      ]);
    }
    expect(scanWebSocketRoutesSync(root)).toHaveLength(3);
  });
});

describe('WebSocket resource names', () => {
  it.each([
    ['chat/[room].ws.ts', 'chat-room', 'ChatRoomWs'],
    ['(admin)/API/[...IDs].prod.ws.mts', 'API-IDs', 'APIIDsWs'],
    ['chat/index.dev.ws.js', 'chat-index', 'ChatIndexWs'],
    ['API_chat/roomID.ws.mjs', 'API-chat-roomID', 'APIChatRoomIDWs'],
    ['[...].ws.ts', 'WebSocket', 'WebSocketWs'],
    ['chat\\[room].ws.ts', 'chat-room', 'ChatRoomWs'],
    ['chat/[room].ws.tsx', 'chat-room', 'ChatRoomWs'],
    ['chat/[room].dev.ws.jsx', 'chat-room', 'ChatRoomWs'],
    ['(admin)/API/[...IDs].prod.ws.tsx', 'API-IDs', 'APIIDsWs'],
    ['chat\\[room].ws.jsx', 'chat-room', 'ChatRoomWs'],
  ])('preserves legacy identity for %s', (path, name, className) => {
    expect(inferWebSocketResourceName(path)).toBe(name);
    expect(deriveWebSocketClassName(path)).toBe(className);
    expect(deriveWebSocketClassNameFromName(name)).toBe(className);
  });

  it.each(['defineRoom', 'defineWebSocket'])(
    'pins %s identity unchanged, then preserves it after moving the route',
    (helper) => {
      const root = createRoot();
      const file = createRoute(root, 'chat/[room].ws.ts', `export default ${helper}({})`);
      const [original] = scanWebSocketRoutesSync(root);
      const name = inferWebSocketResourceName(original!.filePath);
      writeFileSync(file, `export default ${helper}({ name: '${name}' })`);
      expect(scanWebSocketRoutesSync(root)[0]).toEqual({ ...original, name });
      const moved = join(root, 'routes', 'rooms', '[room].ws.ts');
      mkdirSync(join(moved, '..'), { recursive: true });
      renameSync(file, moved);
      expect(scanWebSocketRoutesSync(root)[0]).toEqual({
        ...original,
        name,
        filePath: 'rooms/[room].ws.ts',
        pattern: '/rooms/:room',
      });
    },
  );

  it('reads exported default constants, local options, template literals and auth gates', () => {
    const root = createRoot();
    const file = createRoute(
      root,
      'chat.ws.ts',
      `
      const name = \`API-chat\`;
      const options = { ['name']: name, onBeforeConnect() {} };
      export const Chat = defineRoom(options);
      export default Chat;
    `,
    );
    expect(detectWebSocketDefinition(file)).toEqual({
      mode: 'room',
      hasAuthGate: true,
      name: 'API-chat',
    });
    expect(scanWebSocketRoutesSync(root)[0]).toMatchObject({
      className: 'APIChatWs',
      name: 'API-chat',
    });
  });

  it.each(["''", "'---'", '42', 'importedName', "'123-room'"])(
    'rejects invalid or unresolved explicit name %s',
    (name) => {
      const root = createRoot();
      createRoute(root, 'chat.ws.ts', `export default defineRoom({ name: ${name} })`);
      expect(() => scanWebSocketRoutesSync(root)).toThrow('resource name must be');
    },
  );

  it.each([
    `import { defineRoom as room } from 'void/ws'; export default room({ name: 'chat-room' });`,
    `import { defineWebSocket as socket } from 'void/ws'; const chat = socket({ name: 'chat-room' }); export default chat;`,
    `import * as ws from 'void/ws'; export default ws.defineRoom({ name: 'chat-room' });`,
    `import * as ws from 'void/ws'; export default ws['defineWebSocket']({ name: 'chat-room' });`,
  ])('reads explicit identities through aliased or namespace imports', (source) => {
    const root = createRoot();
    createRoute(root, 'moved.ws.ts', source);
    expect(scanWebSocketRoutesSync(root)[0]).toMatchObject({
      name: 'chat-room',
      className: 'ChatRoomWs',
    });
  });

  it.each([
    'export default defineRoom({ name: undefined });',
    'const identity = undefined; export default defineRoom({ name: identity });',
    `const base = { name: 'room' }; export default defineRoom({ ...base, name: undefined });`,
    `const noName = { name: undefined }; export default defineRoom({ name: 'room', ...noName });`,
    `import { defineRoom as room } from 'void/ws'; export default room({ name: undefined });`,
  ])('treats statically undefined names exactly as absent', (source) => {
    const root = createRoot();
    createRoute(root, 'chat.ws.ts', source);
    const [route] = scanWebSocketRoutesSync(root);
    expect(route).not.toHaveProperty('name');
    expect(route?.className).toBe('ChatWs');
  });

  it.each([
    `import { defineRoom as room } from 'void/ws'; export default room({ name: getName() });`,
    `import * as ws from 'void/ws'; export default ws.defineRoom({ name: process.env.NAME });`,
    `const undefined = getName(); export default defineRoom({ name: undefined });`,
    `const { undefined } = options; export default defineRoom({ name: undefined });`,
    `function undefined() {} export default defineRoom({ name: undefined });`,
  ])('rejects unresolved identities instead of inferring from the moved filename', (source) => {
    const root = createRoot();
    createRoute(root, 'moved.ws.ts', source);
    expect(() => scanWebSocketRoutesSync(root)).toThrow('resource name must be');
  });

  it('reads static spreads and rejects dynamic overrides of explicit names', () => {
    const root = createRoot();
    const file = createRoute(
      root,
      'chat.ws.ts',
      `
      const identity = { name: 'chat' };
      export default defineRoom({ ...identity });
    `,
    );
    expect(scanWebSocketRoutesSync(root)[0]?.name).toBe('chat');
    writeFileSync(file, `export default defineRoom({ name: 'chat', ...loadOptions() })`);
    expect(() => scanWebSocketRoutesSync(root)).toThrow('dynamic spread');
  });

  it('leaves legacy dynamic unnamed and let-default definitions unchanged', () => {
    const root = createRoot();
    const file = createRoute(
      root,
      'chat.ws.ts',
      'let chat = defineRoom(loadOptions()); export default chat;',
    );
    expect(detectWebSocketDefinition(file)).toEqual({ mode: 'room', hasAuthGate: false });
    expect(scanWebSocketRoutesSync(root)[0]).not.toHaveProperty('name');
  });

  it('detects generated collisions even when raw names differ', () => {
    const root = createRoot();
    createRoute(root, 'a.ws.ts', `export default defineRoom({ name: 'chat-room' })`);
    createRoute(root, 'b.ws.ts', `export default defineRoom({ name: 'chat_room' })`);
    expect(() => scanWebSocketRoutesSync(root)).toThrow('duplicate generated name');
  });

  it('detects legacy generated collisions across route groups', () => {
    const root = createRoot();
    createRoute(root, '(a)/chat.ws.ts', 'export default defineRoom({})');
    createRoute(root, '(b)/chat.ws.ts', 'export default defineRoom({})');
    expect(() => scanWebSocketRoutesSync(root)).toThrow('duplicate generated name');
  });

  it('allows mutually exclusive dev/prod variants and rejects collisions within one environment', () => {
    const root = createRoot();
    createRoute(root, 'chat.dev.ws.ts', `export default defineRoom({ name: 'chat' })`);
    createRoute(root, 'chat.prod.ws.ts', `export default defineRoom({ name: 'chat' })`);
    expect(scanWebSocketRoutesSync(root)).toHaveLength(2);
    expect(scanWebSocketRoutesSync(root, undefined, 'prod')).toHaveLength(1);
    createRoute(root, 'other.dev.ws.ts', `export default defineRoom({ name: 'chat' })`);
    expect(() => scanWebSocketRoutesSync(root)).toThrow('duplicate generated name');
    expect(scanWebSocketRoutesSync(root, undefined, 'prod')).toHaveLength(1);
  });
});
