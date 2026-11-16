import { DurableObject as CloudflareDurableObject } from 'cloudflare:workers';
import { isResourceName } from '../shared/resource-name.ts';
import { requireRuntimeBinding, withRuntimeEnv } from './env.ts';

const DEFAULT_STORAGE_KEY = '__void_durable_state';

type NativeDurableClass = new (...args: Array<never>) => CloudflareDurableObject<unknown>;

export type DurableObjectApi<TClass extends NativeDurableClass> = {
  class: TClass;
  /** @internal Called by the generated Worker entry. */
  __bind(bindingName: string, resourceName?: string): void;
  get(name: string): DurableObjectStub<InstanceType<TClass>>;
  get(
    namespace: DurableObjectNamespace<InstanceType<TClass>>,
    name: string,
  ): DurableObjectStub<InstanceType<TClass>>;
  getById(id: DurableObjectId): DurableObjectStub<InstanceType<TClass>>;
  getById(
    namespace: DurableObjectNamespace<InstanceType<TClass>>,
    id: DurableObjectId,
  ): DurableObjectStub<InstanceType<TClass>>;
};

/** Register a native Durable Object class without altering its lifecycle or RPC methods. */
export function defineDurableObject<TClass extends NativeDurableClass>(definition: {
  name?: string;
  class: TClass;
}): DurableObjectApi<TClass> {
  if (definition.name !== undefined && !isResourceName(definition.name)) {
    throw new Error('durable: name must contain a word starting with a letter.');
  }
  let bindingName: string | undefined;
  function boundNamespace(): DurableObjectNamespace<InstanceType<TClass>> {
    if (!bindingName) {
      throw new Error(
        'durable: this definition is not bound. Default-export it from a file in durable-objects/.',
      );
    }
    return requireRuntimeBinding<DurableObjectNamespace<InstanceType<TClass>>>(bindingName);
  }
  return {
    class: definition.class,
    __bind(name, resourceName) {
      if (definition.name !== resourceName) {
        throw new Error(
          'durable: name must be statically discoverable in defineDurableObject(). Run void info to inspect this definition.',
        );
      }
      if (bindingName && bindingName !== name) {
        throw new Error(
          `durable: definition is already bound to '${bindingName}' and cannot also bind to '${name}'.`,
        );
      }
      bindingName = name;
    },
    get(
      namespaceOrName: DurableObjectNamespace<InstanceType<TClass>> | string,
      maybeName?: string,
    ) {
      const namespace = typeof namespaceOrName === 'string' ? boundNamespace() : namespaceOrName;
      return namespace.get(
        namespace.idFromName(typeof namespaceOrName === 'string' ? namespaceOrName : maybeName!),
      );
    },
    getById(
      namespaceOrId: DurableObjectNamespace<InstanceType<TClass>> | DurableObjectId,
      maybeId?: DurableObjectId,
    ) {
      const namespace = maybeId
        ? (namespaceOrId as DurableObjectNamespace<InstanceType<TClass>>)
        : boundNamespace();
      return namespace.get(maybeId ?? (namespaceOrId as DurableObjectId));
    },
  };
}

export type DurableStateContext<TState, TEnv extends Record<string, unknown>> = {
  state: TState;
  readonly env: TEnv;
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
};

export type DurableStateMethod<
  TState,
  TEnv extends Record<string, unknown>,
  TArgs extends Array<unknown> = Array<unknown>,
  TResult = unknown,
> = (context: DurableStateContext<TState, TEnv>, ...args: TArgs) => TResult | Promise<TResult>;

export type DurableStateMethods<TState, TEnv extends Record<string, unknown>> = Record<
  string,
  DurableStateMethod<TState, TEnv, Array<never>, unknown>
>;

export type DurableStateMigration<TState> = {
  /** State version produced by this migration. Versions must be contiguous and start at 1. */
  version: number;
  migrate(state: unknown): TState | Promise<TState>;
};

type MethodArguments<TMethod> = TMethod extends (
  context: infer _TContext,
  ...args: infer TArgs
) => infer _TResult
  ? TArgs
  : never;

type MethodResult<TMethod> = TMethod extends (...args: infer _TArgs) => infer TResult
  ? Awaited<TResult>
  : never;

export type DurableStateRpc<TMethods> = {
  [TName in keyof TMethods]: (
    ...args: MethodArguments<TMethods[TName]>
  ) => Promise<MethodResult<TMethods[TName]>>;
};

export type TypedDurableObjectStub<TMethods> = DurableObjectStub & DurableStateRpc<TMethods>;

export type DurableStateClass<TMethods> = {
  new (
    state: DurableObjectState,
    env: Record<string, unknown>,
  ): DurableObject &
    DurableStateRpc<TMethods> & {
      fetch(request: Request): Promise<Response>;
      alarm(): Promise<void>;
    };
};

export type DurableStateDefinition<
  TState,
  TEnv extends Record<string, unknown>,
  TMethods extends DurableStateMethods<TState, TEnv>,
> = {
  /** Optional persistent resource name. Pin the name reported by `void info` before moving this definition. */
  name?: string;
  initialState: TState | ((env: TEnv) => TState | Promise<TState>);
  /** Current persisted state version. Defaults to 0. */
  version?: number;
  migrations?: ReadonlyArray<DurableStateMigration<TState>>;
  methods: TMethods;
  fetch?: DurableStateMethod<TState, TEnv, [request: Request], Response>;
  alarm?: DurableStateMethod<TState, TEnv, [], void>;
  storageKey?: string;
};

export type DurableStateApi<TMethods> = {
  class: DurableStateClass<TMethods>;
  /** @internal Called by Void's generated worker entry. */
  __bind(bindingName: string, resourceName?: string): void;
  get(name: string): TypedDurableObjectStub<TMethods>;
  get(namespace: DurableObjectNamespace, name: string): TypedDurableObjectStub<TMethods>;
  getById(id: DurableObjectId): TypedDurableObjectStub<TMethods>;
  getById(namespace: DurableObjectNamespace, id: DurableObjectId): TypedDurableObjectStub<TMethods>;
};

type StoredState<TState> = {
  __voidDurableState: true;
  version: number;
  value: TState;
};

function assertMigrations<TState>(
  version: number,
  migrations: ReadonlyArray<DurableStateMigration<TState>>,
): Map<number, DurableStateMigration<TState>> {
  const byVersion = new Map<number, DurableStateMigration<TState>>();
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new Error('durable: migration versions must be positive integers.');
    }
    if (migration.version > version) {
      throw new Error(
        `durable: migration version ${migration.version} exceeds the current state version ${version}.`,
      );
    }
    if (byVersion.has(migration.version)) {
      throw new Error(`durable: duplicate migration version ${migration.version}.`);
    }
    byVersion.set(migration.version, migration);
  }
  for (let expected = 1; expected <= version; expected++) {
    if (!byVersion.has(expected)) {
      throw new Error(`durable: missing state migration for version ${expected}.`);
    }
  }
  return byVersion;
}

export function defineDurableState<
  TState,
  TEnv extends Record<string, unknown> = Record<string, unknown>,
  const TMethods extends DurableStateMethods<TState, TEnv> = DurableStateMethods<TState, TEnv>,
>(definition: DurableStateDefinition<TState, TEnv, TMethods>): DurableStateApi<TMethods> {
  if (definition.name !== undefined && !isResourceName(definition.name)) {
    throw new Error('durable: name must contain a word starting with a letter.');
  }
  const version = definition.version ?? 0;
  if (!Number.isInteger(version) || version < 0) {
    throw new Error('durable: version must be a non-negative integer.');
  }
  const migrations = assertMigrations(version, definition.migrations ?? []);
  const storageKey = definition.storageKey ?? DEFAULT_STORAGE_KEY;
  let bindingName: string | undefined;

  function boundNamespace(): DurableObjectNamespace {
    if (!bindingName) {
      throw new Error(
        'durable: this state definition is not bound. Default-export it from a file in durable-objects/.',
      );
    }
    return requireRuntimeBinding<DurableObjectNamespace>(bindingName);
  }

  class VoidDurableState extends CloudflareDurableObject<TEnv> {
    #value!: TState;
    #ready: Promise<void>;
    #queue: Promise<void> = Promise.resolve();

    readonly #objectState: DurableObjectState;
    readonly #runtimeEnv: TEnv;

    constructor(objectState: DurableObjectState, env: TEnv) {
      super(objectState, env);
      this.#objectState = objectState;
      this.#runtimeEnv = env;
      this.#ready = objectState.blockConcurrencyWhile(() =>
        withRuntimeEnv(this.#runtimeEnv, () => this.#load()),
      );
    }

    async #load(): Promise<void> {
      const stored = await this.#objectState.storage.get<StoredState<TState>>(storageKey);
      if (!stored) {
        const initial =
          typeof definition.initialState === 'function'
            ? await (definition.initialState as (env: TEnv) => TState | Promise<TState>)(
                this.#runtimeEnv,
              )
            : structuredClone(definition.initialState);
        this.#value = initial;
        await this.#persist();
        return;
      }
      if (stored.__voidDurableState !== true || !Number.isInteger(stored.version)) {
        throw new Error(`durable: invalid state record at storage key '${storageKey}'.`);
      }
      if (stored.version > version) {
        throw new Error(
          `durable: stored state version ${stored.version} is newer than supported version ${version}.`,
        );
      }

      let value: unknown = stored.value;
      // assertMigrations() guarantees a migration for every version in 1..version.
      for (let nextVersion = stored.version + 1; nextVersion <= version; nextVersion++) {
        value = await migrations.get(nextVersion)!.migrate(value);
      }
      this.#value = value as TState;
      if (stored.version !== version) {
        await this.#persist();
      }
    }

    #persist(): Promise<void> {
      return this.#objectState.storage.put(storageKey, {
        __voidDurableState: true,
        version,
        value: this.#value,
      } satisfies StoredState<TState>);
    }

    #context(): DurableStateContext<TState, TEnv> {
      const instance = this;
      return {
        get state() {
          return instance.#value;
        },
        set state(value: TState) {
          instance.#value = value;
        },
        env: this.#runtimeEnv,
        id: this.#objectState.id,
        storage: this.#objectState.storage,
        setAlarm: (scheduledTime) => this.#objectState.storage.setAlarm(scheduledTime),
        deleteAlarm: () => this.#objectState.storage.deleteAlarm(),
      };
    }

    #run<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
      return withRuntimeEnv(this.#runtimeEnv, () => {
        const result = this.#queue.then(async () => {
          await this.#ready;
          const previousValue = structuredClone(this.#value);
          try {
            const operationResult = await operation();
            await this.#persist();
            return operationResult;
          } catch (error) {
            this.#value = previousValue;
            throw error;
          }
        });
        this.#queue = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      });
    }

    fetch(request: Request): Promise<Response> {
      if (!definition.fetch) {
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      }
      return this.#run(async () => {
        return definition.fetch!(this.#context(), request);
      });
    }

    alarm(): Promise<void> {
      if (!definition.alarm) {
        return Promise.resolve();
      }
      return this.#run(async () => {
        await definition.alarm!(this.#context());
      });
    }
    static {
      for (const [name, method] of Object.entries(definition.methods)) {
        if (name === 'fetch' || name === 'alarm' || name === 'constructor') {
          throw new Error(`durable: method name '${name}' is reserved.`);
        }
        Object.defineProperty(this.prototype, name, {
          enumerable: false,
          value(this: VoidDurableState, ...args: Array<unknown>) {
            return this.#run(async () => {
              const runtimeMethod = method as DurableStateMethod<
                TState,
                TEnv,
                Array<unknown>,
                unknown
              >;
              return runtimeMethod(this.#context(), ...args);
            });
          },
        });
      }
    }
  }

  return {
    class: VoidDurableState as unknown as DurableStateClass<TMethods>,
    __bind(name, resourceName) {
      if (definition.name !== resourceName) {
        throw new Error(
          'durable: name must be statically discoverable in defineDurableState(). Run void info to inspect this definition.',
        );
      }
      if (bindingName && bindingName !== name) {
        throw new Error(
          `durable: state definition is already bound to '${bindingName}' and cannot also bind to '${name}'.`,
        );
      }
      bindingName = name;
    },
    get(namespaceOrName: DurableObjectNamespace | string, maybeName?: string) {
      const namespace = typeof namespaceOrName === 'string' ? boundNamespace() : namespaceOrName;
      const name = typeof namespaceOrName === 'string' ? namespaceOrName : maybeName!;
      return namespace.get(namespace.idFromName(name)) as TypedDurableObjectStub<TMethods>;
    },
    getById(namespaceOrId: DurableObjectNamespace | DurableObjectId, maybeId?: DurableObjectId) {
      const namespace = maybeId ? (namespaceOrId as DurableObjectNamespace) : boundNamespace();
      const id = maybeId ?? (namespaceOrId as DurableObjectId);
      return namespace.get(id) as TypedDurableObjectStub<TMethods>;
    },
  };
}
