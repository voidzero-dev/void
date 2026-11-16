import { DurableObject } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vite-plus/test';
import { defineDurableObject } from '../../src/runtime/durable/index.ts';
import { withRuntimeEnv } from '../../src/runtime/env/runtime.ts';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

describe('defineDurableObject', () => {
  it('retains the native class and resolves a named namespace without wrapping its lifecycle', () => {
    class Native extends DurableObject {
      async ask() {
        return 'answer';
      }
      async alarm() {
        return;
      }
    }
    const Agent = defineDurableObject({ name: 'workspace', class: Native });
    const id = {} as DurableObjectId;
    const stub = { ask: vi.fn(async () => 'answer') };
    const namespace = {
      idFromName: vi.fn(() => id),
      get: vi.fn(() => stub),
    } as unknown as DurableObjectNamespace<Native>;
    expect(Agent.class).toBe(Native);
    expect(() => Agent.get('room')).toThrow('not bound');
    Agent.__bind('WORKSPACE', 'workspace');
    expect(withRuntimeEnv({ WORKSPACE: namespace }, () => Agent.get('room'))).toBe(stub);
    expect(namespace.idFromName).toHaveBeenCalledWith('room');
    expect(Agent.getById(namespace, id)).toBe(stub);
    expect(() => Agent.__bind('OTHER', 'workspace')).toThrow('already bound');
  });

  it('rejects a runtime resource identity that differs from static analysis', () => {
    class Native extends DurableObject {}
    const Agent = defineDurableObject({ name: 'workspace', class: Native });
    expect(() => Agent.__bind('WORKSPACE', 'other')).toThrow('statically discoverable');
    expect(() => defineDurableObject({ name: '123', class: Native })).toThrow('name must contain');
  });
});
