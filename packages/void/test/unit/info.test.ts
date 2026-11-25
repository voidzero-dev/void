import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { parseInfoArgs } from '../../src/cli/info-args.ts';
import { formatProjectInfo, getProjectInfo, runInfoCommand } from '../../src/cli/info.ts';

const roots: Array<string> = [];
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-info-'));
  roots.push(root);
  return root;
}
function write(root: string, path: string, source: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), source);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('void info', () => {
  it('parses JSON output and rejects unknown flags or positional arguments', () => {
    expect(parseInfoArgs([])).toEqual({ json: false });
    expect(parseInfoArgs(['--json'])).toEqual({ json: true });
    expect(() => parseInfoArgs(['--remote'])).toThrow();
    expect(() => parseInfoArgs(['another-project'])).toThrow(
      "info: Unexpected argument 'another-project'.",
    );
  });

  it('reports exact inferred identities with copyable pin instructions without writing files', () => {
    const root = project();
    write(root, 'routes/chat/[room].ws.ts', 'export default defineRoom({ messages: {} });');
    write(root, 'routes/events.ws.ts', 'export default defineWebSocket({});');
    write(
      root,
      'durable-objects/counter-store.ts',
      'export default defineDurableState({ initialState: { count: 0 } });',
    );
    const files = readdirSync(root);
    const info = getProjectInfo(root);
    expect(info.resources).toEqual([
      {
        file: 'durable-objects/counter-store.ts',
        definition: 'defineDurableState',
        name: 'counter-store',
        nameSource: 'inferred',
        className: 'CounterStoreDurableObject',
        bindingName: 'COUNTER_STORE',
      },
      {
        file: 'routes/chat/[room].ws.ts',
        definition: 'defineRoom',
        name: 'chat-room',
        nameSource: 'inferred',
        className: 'ChatRoomWs',
        bindingName: 'ChatRoomWs',
        route: '/chat/:room',
      },
      {
        file: 'routes/events.ws.ts',
        definition: 'defineWebSocket',
        name: 'events',
        nameSource: 'inferred',
        className: 'EventsWs',
        bindingName: 'EventsWs',
        route: '/events',
      },
    ]);
    const output = formatProjectInfo(info);
    expect(output).toContain('Inferred name: chat-room');
    expect(output).toContain(
      "To preserve this resource when moving its code, add this to 'defineRoom':",
    );
    expect(output).toContain('name: "chat-room",');
    expect(output).toContain("add this to 'defineDurableState':");
    expect(output).toContain("add this to 'defineWebSocket':");
    expect(readdirSync(root)).toEqual(files);
    expect(existsSync(join(root, '.void'))).toBe(false);
  });

  it('reports Workflow identities with inferred and explicit names', () => {
    const root = project();
    write(root, 'workflows/send-welcome.ts', 'export default defineWorkflow({ async run() {} });');
    write(
      root,
      'workflows/import-v2.ts',
      `import { defineWorkflowEntrypoint } from 'void/workflows';
export default defineWorkflowEntrypoint({ name: 'import', class: Importer });`,
    );
    const info = getProjectInfo(root);
    expect(info.resources).toEqual([
      {
        file: 'workflows/import-v2.ts',
        definition: 'defineWorkflow',
        name: 'import',
        nameSource: 'explicit',
        className: 'ImportWorkflow',
        bindingName: 'WORKFLOW_IMPORT',
      },
      {
        file: 'workflows/send-welcome.ts',
        definition: 'defineWorkflow',
        name: 'send-welcome',
        nameSource: 'inferred',
        className: 'SendWelcomeWorkflow',
        bindingName: 'WORKFLOW_SEND_WELCOME',
      },
    ]);
    expect(formatProjectInfo(info)).toContain("add this to 'defineWorkflow':");
  });

  it('keeps explicit names visible after moving code and respects configured source paths', () => {
    const root = project();
    write(root, 'void.config.ts', "export default { sourceDir: 'src' };");
    write(
      root,
      'src/routes/rooms/[room].ws.ts',
      "export default defineRoom({ name: 'chat-room', messages: {} });",
    );
    write(root, 'routes/ignored.ws.ts', 'export default defineRoom({});');
    const info = getProjectInfo(root);
    expect(info.resources).toEqual([
      {
        file: 'src/routes/rooms/[room].ws.ts',
        definition: 'defineRoom',
        name: 'chat-room',
        nameSource: 'explicit',
        className: 'ChatRoomWs',
        bindingName: 'ChatRoomWs',
        route: '/rooms/:room',
      },
    ]);
    expect(formatProjectInfo(info)).toContain('Explicit name: chat-room');
    expect(formatProjectInfo(info)).not.toContain('add this');
    expect(readFileSync(join(root, 'void.config.ts'), 'utf8')).toBe(
      "export default { sourceDir: 'src' };",
    );
  });

  it('shows unmatched recorded identities without guessing a source or revealing other lock values', () => {
    const root = project();
    write(root, 'routes/chat/[room].ws.ts', 'export default defineRoom({ messages: {} });');
    write(
      root,
      'void.lock.json',
      JSON.stringify({
        version: 1,
        resolved: {
          vars: { API_TOKEN: 'not-for-output' },
          migrations: [
            {
              tag: 'void-durable-counter-store-v1',
              new_sqlite_classes: ['CounterStoreDurableObject'],
            },
          ],
          durable_objects: {
            bindings: [
              { name: 'ChatRoomWs', class_name: 'ChatRoomWs' },
              { name: 'COUNTER_STORE', class_name: 'CounterStoreDurableObject' },
              { name: 'External', class_name: 'RemoteWs', script_name: 'another-worker' },
              { name: 'LEGACY', class_name: 'CustomState' },
            ],
          },
        },
      }),
    );
    const info = getProjectInfo(root);
    expect(info.recordedResources).toEqual([
      {
        className: 'CounterStoreDurableObject',
        bindingName: 'COUNTER_STORE',
        name: 'counter-store',
        definition: 'defineDurableState',
      },
      { className: 'CustomState', bindingName: 'LEGACY' },
    ]);
    const output = formatProjectInfo(info);
    expect(output).toContain('no matching source definition');
    expect(output).toContain('If this is the resource you moved');
    expect(output).toContain('Restore the original definition from source history');
    expect(output).not.toContain('not-for-output');
    expect(output).not.toContain('RemoteWs');
    expect(JSON.stringify(info)).not.toContain('API_TOKEN');
  });

  it('does not suggest a durable name unless the recorded migration tag also matches', () => {
    const root = project();
    write(
      root,
      'void.lock.json',
      JSON.stringify({
        version: 1,
        resolved: {
          migrations: [
            { tag: 'legacy-counter-v1', new_sqlite_classes: ['CounterStoreDurableObject'] },
          ],
          durable_objects: {
            bindings: [{ name: 'COUNTER_STORE', class_name: 'CounterStoreDurableObject' }],
          },
        },
      }),
    );
    expect(getProjectInfo(root).recordedResources).toEqual([
      { className: 'CounterStoreDurableObject', bindingName: 'COUNTER_STORE' },
    ]);
  });

  it('recovers WebSocket names from recorded classes while preserving acronym case', () => {
    const root = project();
    write(
      root,
      'void.lock.json',
      JSON.stringify({
        version: 1,
        resolved: {
          durable_objects: { bindings: [{ name: 'APIChatWs', class_name: 'APIChatWs' }] },
        },
      }),
    );
    expect(getProjectInfo(root).recordedResources).toEqual([
      {
        className: 'APIChatWs',
        bindingName: 'APIChatWs',
        name: 'APIChat',
        definition: 'defineRoom | defineWebSocket',
      },
    ]);
  });

  it('has useful empty-project output and valid JSON without log decoration', async () => {
    const root = project();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runInfoCommand(root, { json: false });
    expect(output).toHaveBeenLastCalledWith(
      'No persistent resource definitions found in this project.',
    );
    await runInfoCommand(root, { json: true });
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual({
      resources: [],
      recordedResources: [],
    });
    expect(readdirSync(root)).toEqual([]);
  });
});
