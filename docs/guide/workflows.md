---
description: 'Run durable multi-step jobs with Cloudflare Workflows: retried steps, sleeps, and typed params.'
outline: deep
---

# Workflows

Use a Workflow for work that runs across several steps and must finish even if one fails, such as onboarding emails, imports, or payment follow-ups. Each step's result is saved, failed steps are retried, and a Workflow can sleep for minutes or days between steps.

Create a module in `workflows/` with `defineWorkflow()`. Void creates the Cloudflare Workflow and its binding for you. Workflows run in local development and in direct Cloudflare deployments (`void deploy --platform cloudflare`).

## Define a workflow

```ts
// workflows/onboarding.ts
import { defineWorkflow } from 'void/workflows';
import type { WorkflowEvent } from 'void/workflows';

export const Onboarding = defineWorkflow({
  async run(event: WorkflowEvent<{ userId: string }>, step) {
    await step.do('send welcome email', async () => {
      await sendWelcomeEmail(event.payload.userId);
    });
    await step.sleep('wait a day', '1 day');
    await step.do('send tips', async () => {
      await sendTips(event.payload.userId);
    });
  },
});

export default Onboarding;
```

Default-export the object returned by `defineWorkflow()`. Named-export it too so routes can import it.

TypeScript and JavaScript files are supported. Subdirectories are scanned too, and files or directories starting with `_` are ignored, so keep shared step helpers in files such as `workflows/_email.ts`.

`run` receives:

- `event`, with the `payload` passed to `create()`, the `instanceId`, and a `timestamp`
- `step`, Cloudflare's [`WorkflowStep`](https://developers.cloudflare.com/workflows/build/workers-api/#workflowstep) with `step.do()`, `step.sleep()`, `step.sleepUntil()`, and `step.waitForEvent()`
- a context with the Worker `env`

Imports such as `void/env`, `void/db`, and `void/kv` work inside steps. Keep side effects inside `step.do()` so a retry or a resumed instance doesn't repeat them.

## Start an instance from a route

```ts
// routes/api/signup.ts
import { defineHandler } from 'void';
import { Onboarding } from '../../workflows/onboarding';

export const POST = defineHandler(async () => {
  const instance = await Onboarding.create({ params: { userId: 'user_123' } });
  return { instanceId: instance.id };
});
```

`create()` accepts the same options as Cloudflare's [`Workflow.create()`](https://developers.cloudflare.com/workflows/build/workers-api/#create), such as `id` and `retention`. Its `params` are typed from your definition. Use `createBatch()` to start up to 100 instances at once.

Check on an instance with `get()`:

```ts
// routes/api/onboarding/[id].ts
import { defineHandler } from 'void';
import { Onboarding } from '../../../workflows/onboarding';

export const GET = defineHandler(async (c) => {
  const instance = await Onboarding.get(c.req.param('id'));
  return instance.status();
});
```

The returned instance can also `pause()`, `resume()`, `restart()`, `terminate()`, and `sendEvent()`.

## Validate params

Pass a [Standard Schema](https://standardschema.dev) validator, such as Zod, Valibot, or ArkType, as `params`. `create()` and `createBatch()` validate the params before starting an instance, and `run` receives the parsed value:

```ts
import * as v from 'valibot';
// workflows/import.ts
import { defineWorkflow } from 'void/workflows';

export const Import = defineWorkflow({
  params: v.object({ fileKey: v.string(), notify: v.optional(v.boolean(), false) }),
  async run(event, step) {
    const rows = await step.do('parse', () => parseFile(event.payload.fileKey));
    if (event.payload.notify) {
      await step.do('notify', () => notifyOwner(rows.length));
    }
  },
});

export default Import;
```

Invalid params throw a `WorkflowParamsError`. Its `issues` list each message and path.

## Native Workflow classes

Use `defineWorkflowEntrypoint()` to keep a class that extends Cloudflare's `WorkflowEntrypoint`. Void binds and exports the class without changing it, and reads the params type from its `run` method:

```ts
// workflows/report.ts
import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { defineWorkflowEntrypoint } from 'void/workflows';

class ReportWorkflow extends WorkflowEntrypoint<unknown, { month: string }> {
  async run(event: WorkflowEvent<{ month: string }>, step: WorkflowStep) {
    return step.do('build report', () => buildReport(event.payload.month));
  }
}

export const Report = defineWorkflowEntrypoint({ class: ReportWorkflow });
export default Report;
```

`Report.create()`, `Report.createBatch()`, and `Report.get()` work as they do for `defineWorkflow()`.

## Names and bindings

Void derives the names from the file's path in `workflows/`, joining directories with `-` as it does for [queues](./queues.md#defining-queues). `workflows/send-welcome.ts` creates:

- the `WORKFLOW_SEND_WELCOME` binding
- the exported `SendWelcomeWorkflow` class
- a Cloudflare Workflow named `<worker-name>-send-welcome`, since Workflow names must be unique within your Cloudflare account

`workflows/order/notifications.ts` creates `WORKFLOW_ORDER_NOTIFICATIONS`, `OrderNotificationsWorkflow`, and `<worker-name>-order-notifications`. Each Workflow must have a unique name.

Instances belong to the Workflow name. Renaming the file or the Worker starts a new, empty Workflow, and instances of the old one stop running. To move a file without changing its name, run `void info` first and add the name it suggests:

```ts
export const Onboarding = defineWorkflow({
  name: 'onboarding',
  async run(event, step) {
    // ...
  },
});
```

`name` must be a static string containing words that start with a letter. To choose the Cloudflare Workflow name yourself, add an entry for the generated binding and class in `void.config.ts`:

```ts
// void.config.ts
import { defineConfig } from 'void/config';

export default defineConfig({
  cloudflare: {
    workflows: [
      { name: 'onboarding', binding: 'WORKFLOW_ONBOARDING', class_name: 'OnboardingWorkflow' },
    ],
  },
});
```

## Deployment support

Workflows are available on the Workers Free plan, within [Cloudflare's Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/). Deploy to your own Cloudflare account with `void deploy --platform cloudflare`.

Void platforms do not support Workflows yet: `void deploy` to a Void platform stops with an error while `workflows/` contains modules. Workflows are also unavailable in meta-framework apps and on Node.js, Bun, and Deno.
