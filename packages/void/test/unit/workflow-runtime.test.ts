import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { describe, expect, expectTypeOf, it, vi } from 'vite-plus/test';
import { getRuntimeEnv, withRuntimeEnv } from '../../src/runtime/env/runtime.ts';
import {
  defineWorkflow,
  defineWorkflowEntrypoint,
  WorkflowParamsError,
} from '../../src/runtime/workflows/index.ts';
import type { WorkflowApi } from '../../src/runtime/workflows/index.ts';
import type { StandardSchemaV1 } from '../../src/standard-schema.ts';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    protected ctx: unknown;
    protected env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

function binding() {
  const instance = { id: 'instance' } as unknown as WorkflowInstance;
  return {
    instance,
    workflow: {
      create: vi.fn(async (_options?: unknown) => instance),
      createBatch: vi.fn(async (_options: unknown) => ({ created: [instance], errors: [] })),
      get: vi.fn(async (_id: string) => instance),
    },
  };
}

/** A minimal Standard Schema for `{ userId: string }` that trims the id. */
const userSchema: StandardSchemaV1<{ userId: string }, { userId: string }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value) {
      if (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { userId?: unknown }).userId === 'string'
      ) {
        return { value: { userId: (value as { userId: string }).userId.trim() } };
      }
      return { issues: [{ message: 'Expected a string', path: [{ key: 'userId' }] }] };
    },
  },
};

describe('defineWorkflow', () => {
  it('generates an entrypoint that runs inside the Worker env', async () => {
    const seen: Array<unknown> = [];
    const Welcome = defineWorkflow({
      async run(event: WorkflowEvent<{ userId: string }>, step, context) {
        seen.push(event.payload.userId, context.env.GREETING, getRuntimeEnv().GREETING);
        return step.do('greet', async () => 'done');
      },
    });
    const step = { do: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()) };
    const instance = new Welcome.class({} as ExecutionContext, { GREETING: 'hello' });
    expect(instance).toBeInstanceOf(WorkflowEntrypoint);
    const result = await instance.run(
      { payload: { userId: 'u1' } } as WorkflowEvent<{ userId: string }>,
      step as unknown as WorkflowStep,
    );
    expect(result).toBe('done');
    expect(seen).toEqual(['u1', 'hello', 'hello']);
  });

  it('starts, batches, and gets instances through its convention binding', async () => {
    const { workflow, instance } = binding();
    const Welcome = defineWorkflow({
      async run(_event: WorkflowEvent<{ userId: string }>) {},
    });
    await expect(Welcome.create({ params: { userId: 'u1' } })).rejects.toThrow('not bound');
    Welcome.__bind('WORKFLOW_WELCOME');
    await withRuntimeEnv({ WORKFLOW_WELCOME: workflow }, async () => {
      expect(await Welcome.create({ id: 'a', params: { userId: 'u1' } })).toBe(instance);
      expect(await Welcome.get('a')).toBe(instance);
      await Welcome.createBatch([{ params: { userId: 'u2' } }]);
    });
    expect(workflow.create).toHaveBeenCalledWith({ id: 'a', params: { userId: 'u1' } });
    expect(workflow.get).toHaveBeenCalledWith('a');
    expect(workflow.createBatch).toHaveBeenCalledWith({
      instances: [{ params: { userId: 'u2' } }],
    });
    expect(() => Welcome.__bind('OTHER')).toThrow('already bound');
  });

  it('accepts an explicit binding', async () => {
    const { workflow } = binding();
    const Welcome = defineWorkflow({ async run() {} });
    await Welcome.create(workflow as unknown as Workflow, { id: 'b' });
    await Welcome.get(workflow as unknown as Workflow, 'b');
    expect(workflow.create).toHaveBeenCalledWith({ id: 'b' });
    expect(workflow.get).toHaveBeenCalledWith('b');
  });

  it('validates and transforms params with its schema before starting', async () => {
    const { workflow } = binding();
    const Welcome = defineWorkflow({
      params: userSchema,
      async run(event) {
        expectTypeOf(event.payload).toEqualTypeOf<Readonly<{ userId: string }>>();
      },
    });
    Welcome.__bind('WORKFLOW_WELCOME');
    await withRuntimeEnv({ WORKFLOW_WELCOME: workflow }, async () => {
      await Welcome.create({ params: { userId: ' u1 ' } });
      const invalid = Welcome.create({ params: { userId: 1 as unknown as string } });
      await expect(invalid).rejects.toBeInstanceOf(WorkflowParamsError);
      await expect(invalid).rejects.toThrow('workflows: invalid params: userId: Expected a string');
      await expect(Welcome.create()).rejects.toThrow('invalid params');
      await expect(
        Welcome.createBatch([{ params: { userId: 'ok' } }, { params: {} as { userId: string } }]),
      ).rejects.toThrow('invalid params');
    });
    expect(workflow.create).toHaveBeenCalledTimes(1);
    expect(workflow.create).toHaveBeenCalledWith({ params: { userId: 'u1' } });
    expect(workflow.createBatch).not.toHaveBeenCalled();
  });

  it('rejects a runtime identity that differs from static analysis and invalid names', () => {
    const Welcome = defineWorkflow({ name: 'welcome', async run() {} });
    expect(() => Welcome.__bind('WORKFLOW_WELCOME', 'other')).toThrow('statically discoverable');
    expect(() => defineWorkflow({ name: '123', async run() {} })).toThrow('name must contain');
  });
});

describe('defineWorkflowEntrypoint', () => {
  it('keeps the native class and infers params from its run annotation', async () => {
    class Importer extends WorkflowEntrypoint<Record<string, unknown>, { file: string }> {
      override async run(_event: Readonly<WorkflowEvent<{ file: string }>>, _step: WorkflowStep) {
        return 'imported';
      }
    }
    const { workflow } = binding();
    const Import = defineWorkflowEntrypoint({ name: 'import', class: Importer });
    expect(Import.class).toBe(Importer);
    Import.__bind('WORKFLOW_IMPORT', 'import');
    await withRuntimeEnv({ WORKFLOW_IMPORT: workflow }, () =>
      Import.create({ params: { file: 'a.csv' } }),
    );
    expectTypeOf(Import).toEqualTypeOf<WorkflowApi<typeof Importer, { file: string }>>();
    expect(workflow.create).toHaveBeenCalledWith({ params: { file: 'a.csv' } });
  });
});
