import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { isResourceName } from '../../shared/resource-name.ts';
import type { StandardSchemaV1 } from '../../standard-schema.ts';
import { requireRuntimeBinding, withRuntimeEnv } from '../env/runtime.ts';

export type { WorkflowEvent, WorkflowStep };

type NativeWorkflowClass = new (...args: Array<never>) => {
  run(event: never, step: never): Promise<unknown>;
};

/** Params type of a native class, read from its `run(event)` annotation. */
export type NativeWorkflowParams<TClass extends NativeWorkflowClass> =
  InstanceType<TClass> extends {
    run(event: Readonly<WorkflowEvent<infer TParams>>, ...rest: Array<never>): unknown;
  }
    ? TParams
    : unknown;

/** Context passed to a `defineWorkflow()` run function next to the event and step. */
export type WorkflowContext<TEnv> = {
  readonly env: TEnv;
  readonly ctx: ExecutionContext;
};

/** Options for starting one Workflow instance. */
export type WorkflowCreateOptions<TParams> = Omit<WorkflowInstanceCreateOptions, 'params'> & {
  params?: TParams;
};

export type WorkflowApi<TClass, TParams> = {
  class: TClass;
  /** @internal Called by Void's generated Worker entry. */
  __bind(bindingName: string, resourceName?: string): void;
  /** Start a new instance. Params are validated when the definition has a `params` schema. */
  create(options?: WorkflowCreateOptions<TParams>): Promise<WorkflowInstance>;
  create(binding: Workflow, options?: WorkflowCreateOptions<TParams>): Promise<WorkflowInstance>;
  /** Start up to 100 instances. Each instance's params are validated first. */
  createBatch(
    instances: ReadonlyArray<WorkflowCreateOptions<TParams>>,
  ): Promise<WorkflowBatchCreateResult>;
  createBatch(
    binding: Workflow,
    instances: ReadonlyArray<WorkflowCreateOptions<TParams>>,
  ): Promise<WorkflowBatchCreateResult>;
  /** Get a handle to an existing instance. */
  get(id: string): Promise<WorkflowInstance>;
  get(binding: Workflow, id: string): Promise<WorkflowInstance>;
};

export type WorkflowRun<TParams, TEnv> = (
  event: Readonly<WorkflowEvent<TParams>>,
  step: WorkflowStep,
  context: WorkflowContext<TEnv>,
) => Promise<unknown>;

export type WorkflowClass<TParams> = new (
  ctx: ExecutionContext,
  env: Record<string, unknown>,
) => WorkflowEntrypoint<Record<string, unknown>, TParams>;

/** Error thrown by `create()` and `createBatch()` when params fail the definition's schema. */
export class WorkflowParamsError extends Error {
  readonly issues: ReadonlyArray<{ message: string; path?: string }>;

  constructor(issues: ReadonlyArray<StandardSchemaV1.Issue>) {
    const flattened = Array.from(issues, (issue) => ({
      message: issue.message,
      ...(issue.path?.length
        ? {
            path: issue.path
              .map((segment) => String(typeof segment === 'object' ? segment.key : segment))
              .join('.'),
          }
        : {}),
    }));
    super(
      `workflows: invalid params: ${flattened
        .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
        .join('; ')}`,
    );
    this.name = 'WorkflowParamsError';
    this.issues = flattened;
  }
}

function isWorkflowBinding<TOther>(value: Workflow | TOther): value is Workflow {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { create?: unknown }).create === 'function' &&
    typeof (value as { get?: unknown }).get === 'function'
  );
}

function createWorkflowApi<TClass, TParams>(
  definitionName: string | undefined,
  workflowClass: TClass,
  schema: StandardSchemaV1 | undefined,
): WorkflowApi<TClass, TParams> {
  if (definitionName !== undefined && !isResourceName(definitionName)) {
    throw new Error('workflows: name must contain a word starting with a letter.');
  }
  let bindingName: string | undefined;

  function boundWorkflow(): Workflow {
    if (!bindingName) {
      throw new Error(
        'workflows: this definition is not bound. Default-export it from a file in workflows/.',
      );
    }
    return requireRuntimeBinding<Workflow>(bindingName);
  }

  async function prepare(
    options: WorkflowCreateOptions<TParams> | undefined,
  ): Promise<WorkflowInstanceCreateOptions | undefined> {
    if (!schema) {
      return options;
    }
    const result = await schema['~standard'].validate(options?.params);
    if (result.issues) {
      throw new WorkflowParamsError(result.issues);
    }
    return { ...options, params: result.value };
  }

  return {
    class: workflowClass,
    __bind(name, resourceName) {
      if (definitionName !== resourceName) {
        throw new Error(
          'workflows: name must be statically discoverable in the workflow definition. Run void info to inspect this definition.',
        );
      }
      if (bindingName && bindingName !== name) {
        throw new Error(
          `workflows: definition is already bound to '${bindingName}' and cannot also bind to '${name}'.`,
        );
      }
      bindingName = name;
    },
    async create(
      bindingOrOptions?: Workflow | WorkflowCreateOptions<TParams>,
      maybeOptions?: WorkflowCreateOptions<TParams>,
    ) {
      const explicit = isWorkflowBinding(bindingOrOptions);
      const binding = explicit ? bindingOrOptions : boundWorkflow();
      const options = explicit ? maybeOptions : bindingOrOptions;
      return binding.create(await prepare(options));
    },
    async createBatch(
      bindingOrInstances: Workflow | ReadonlyArray<WorkflowCreateOptions<TParams>>,
      maybeInstances?: ReadonlyArray<WorkflowCreateOptions<TParams>>,
    ) {
      const explicit = isWorkflowBinding(bindingOrInstances);
      const binding = explicit ? bindingOrInstances : boundWorkflow();
      const instances = explicit ? (maybeInstances ?? []) : bindingOrInstances;
      const prepared = await Promise.all(
        Array.from(instances, async (instance) => (await prepare(instance)) ?? {}),
      );
      return binding.createBatch({ instances: prepared });
    },
    get(bindingOrId: Workflow | string, maybeId?: string) {
      if (typeof bindingOrId === 'string') {
        return boundWorkflow().get(bindingOrId);
      }
      if (maybeId === undefined) {
        throw new Error('workflows: get(binding, id) requires an instance id.');
      }
      return bindingOrId.get(maybeId);
    },
  };
}

type WorkflowDefinitionBase = {
  /** Optional persistent resource name. Pin the name reported by `void info` before moving this definition. */
  name?: string;
};

/**
 * Define a Workflow from a run function. Void generates the Cloudflare
 * `WorkflowEntrypoint` class. Default-export the result from a file in `workflows/`.
 */
export function defineWorkflow<
  TSchema extends StandardSchemaV1,
  TEnv extends Record<string, unknown> = Record<string, unknown>,
>(
  definition: WorkflowDefinitionBase & {
    /** Standard Schema that validates params in `create()` and `createBatch()`. */
    params: TSchema;
    run: WorkflowRun<StandardSchemaV1.InferOutput<TSchema>, TEnv>;
  },
): WorkflowApi<
  WorkflowClass<StandardSchemaV1.InferOutput<TSchema>>,
  StandardSchemaV1.InferInput<TSchema>
>;
export function defineWorkflow<
  TParams = unknown,
  TEnv extends Record<string, unknown> = Record<string, unknown>,
>(
  definition: WorkflowDefinitionBase & {
    params?: undefined;
    run: WorkflowRun<TParams, TEnv>;
  },
): WorkflowApi<WorkflowClass<TParams>, TParams>;
export function defineWorkflow(
  definition: WorkflowDefinitionBase & {
    params?: StandardSchemaV1;
    run: WorkflowRun<unknown, Record<string, unknown>>;
  },
): WorkflowApi<WorkflowClass<unknown>, unknown> {
  if (typeof definition.run !== 'function') {
    throw new Error('workflows: defineWorkflow() requires a run function.');
  }
  const run = definition.run;

  class VoidWorkflow extends WorkflowEntrypoint<Record<string, unknown>, unknown> {
    override run(event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<unknown> {
      const env = this.env;
      const ctx = this.ctx;
      return withRuntimeEnv(env, () => run(event, step, { env, ctx }));
    }
  }

  return createWorkflowApi(definition.name, VoidWorkflow, definition.params);
}

/**
 * Register a native Cloudflare `WorkflowEntrypoint` class without changing it.
 * Default-export the result from a file in `workflows/`.
 */
export function defineWorkflowEntrypoint<
  TClass extends NativeWorkflowClass,
  TParams = NativeWorkflowParams<TClass>,
>(
  definition: WorkflowDefinitionBase & {
    class: TClass;
  },
): WorkflowApi<TClass, TParams> {
  if (typeof definition.class !== 'function') {
    throw new Error('workflows: defineWorkflowEntrypoint() requires a class.');
  }
  return createWorkflowApi(definition.name, definition.class, undefined);
}
