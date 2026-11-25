---
description: 'Durable multi-step Workflows from void/workflows.'
outline: deep
---

# Workflows

Imported from `"void/workflows"`. See [Workflows](../../guide/workflows.md) for the file convention and deployment support.

## `defineWorkflow(definition)` {#defineworkflow-definition}

Defines a Cloudflare Workflow from a run function. The returned object must be the default export of a module under `workflows/`; named-export the same object to start instances elsewhere in the app.

```ts
function defineWorkflow<TParams, TEnv>(definition: {
  name?: string;
  params?: StandardSchemaV1;
  run(
    event: Readonly<WorkflowEvent<TParams>>,
    step: WorkflowStep,
    context: { env: TEnv; ctx: ExecutionContext },
  ): Promise<unknown>;
}): WorkflowApi<WorkflowClass<TParams>, TParams>;
```

With `params`, `run` receives the schema's output type and `create()` accepts its input type. Without it, the params type comes from the `event` annotation.

## `defineWorkflowEntrypoint(definition)` {#defineworkflowentrypoint-definition}

Registers a class that extends Cloudflare's `WorkflowEntrypoint` without changing it. The params type is read from the class's `run(event)` annotation.

```ts
function defineWorkflowEntrypoint<TClass>(definition: {
  name?: string;
  class: TClass;
}): WorkflowApi<TClass, TParams>;
```

## `WorkflowApi` {#workflowapi}

| Member                         | Description                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `class`                        | The Workflow class Void exports from the Worker.                                                      |
| `create(options?)`             | Starts an instance. Options match Cloudflare's `create()`; `params` are typed and validated.          |
| `createBatch(instances)`       | Starts up to 100 instances and returns Cloudflare's `{ created, errors }` result.                     |
| `get(id)`                      | Returns a `WorkflowInstance` for `status()`, `pause()`, `resume()`, `terminate()`, and `sendEvent()`. |
| `create(binding, options?)`, … | Each method also accepts an explicit `Workflow` binding as its first argument.                        |

`name` optionally fixes the resource identity instead of deriving it from the filename. Run `void info` and pin the displayed name before moving a deployed definition.

## `WorkflowParamsError` {#workflowparamserror}

Thrown by `create()` and `createBatch()` when params fail the definition's schema. `issues` is an array of `{ message, path? }`.

## Types {#types}

`WorkflowEvent`, `WorkflowStep`, `WorkflowContext`, `WorkflowCreateOptions`, `WorkflowApi`, and `WorkflowRun`.
