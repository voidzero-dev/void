---
outline: deep
---

# Actions & Forms

Use an action to change server data from a form or button. Define it in the page's `.server.ts` file with `defineHandler`, just like a [loader](./loaders) or [server route](../server-routing.md). Actions handle `POST`, `PUT`, `PATCH`, and `DELETE` requests.

## Defining an Action

Export `action` from a `.server.ts` file. Use `withValidator()` with a [schema-derived validator](../database.md#schema-derived-validators) to validate the request body:

```ts
import { users, insertUserSchema } from '@schema';
// pages/users/index.server.ts
import { defineHandler } from 'void';
import { db } from 'void/db';

export const action = defineHandler.withValidator({
  body: insertUserSchema,
})(async (c, { body }) => {
  await db.insert(users).values(body);
  // No return → re-runs loader, page re-renders with fresh data
});
```

| Action returns        | Behavior                                              |
| --------------------- | ----------------------------------------------------- |
| Nothing (void)        | Re-runs the loader, page re-renders with fresh props. |
| `c.redirect('/path')` | Navigates to another page.                            |

## Form

Pair `Form` with `useForm` to submit values and display validation and action errors. Inputs stay editable when a submission fails.

Import `Form` from your adapter. Pass `form` and, optionally, `method="put"`, `"patch"`, or `"delete"`; the default is `"post"`. Use `renderError` for a custom action-error renderer (a snippet in Svelte).

## `useForm`

`useForm` handles submissions, loading state, and validation errors. URLs, form values, and error fields are typed from your action.

Submit to the `/users` action defined above:

::: code-group

```tsx [React]
// pages/users/index.tsx
import { Form, useForm } from '@void/react';
import { useFormStatus } from 'react-dom';

function SubmitButton() {
  const { pending } = useFormStatus();
  return <button disabled={pending}>Create</button>;
}

export default function CreateUser() {
  const form = useForm('/users', { name: '', email: '' });

  return (
    <Form form={form}>
      <input
        name="name"
        value={form.data.name}
        onChange={(e) => form.setData('name', e.target.value)}
      />
      {form.errors.name && <span>{form.errors.name}</span>}

      <input
        name="email"
        value={form.data.email}
        onChange={(e) => form.setData('email', e.target.value)}
      />
      {form.errors.email && <span>{form.errors.email}</span>}

      <SubmitButton />
    </Form>
  );
}
```

```vue [Vue]
<!-- pages/users/index.vue -->
<script setup lang="ts">
import { Form, useForm } from '@void/vue';

const form = useForm('/users', { name: '', email: '' });
</script>

<template>
  <Form :form="form">
    <input v-model="form.data.name" />
    <span v-if="form.errors.name">{{ form.errors.name }}</span>

    <input v-model="form.data.email" />
    <span v-if="form.errors.email">{{ form.errors.email }}</span>

    <button :disabled="form.pending">Create</button>
  </Form>
</template>
```

```svelte [Svelte]
<!-- pages/users/index.svelte -->
<script>
  import { Form, useForm } from "@void/svelte";

  const form = useForm("/users", { name: "", email: "" });
</script>

<Form {form}>
  <input bind:value={form.data.name} />
  {#if form.errors.name}<span>{form.errors.name}</span>{/if}

  <input bind:value={form.data.email} />
  {#if form.errors.email}<span>{form.errors.email}</span>{/if}

  <button disabled={form.pending}>Create</button>
</Form>
```

```tsx [Solid]
// pages/users/index.tsx
import { Form, useForm } from '@void/solid';

export default function CreateUser() {
  const form = useForm('/users', { name: '', email: '' });

  return (
    <Form form={form}>
      <input value={form.data.name} onInput={(e) => form.setData('name', e.target.value)} />
      {form.errors.name && <span>{form.errors.name}</span>}

      <input value={form.data.email} onInput={(e) => form.setData('email', e.target.value)} />
      {form.errors.email && <span>{form.errors.email}</span>}

      <button disabled={form.pending}>Create</button>
    </Form>
  );
}
```

:::

The types are inferred from your action's `withValidator()` schema in the companion `.server.ts` file. If no validator is defined, the body type falls back to `Record<string, unknown>`, and you still get URL autocomplete.

### `useForm` API

`useForm` returns a reactive object with:

| Property / Method                | Purpose                                                                                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data` / `setData`               | Current form values, typed to match the action's body schema.                                                                                                                       |
| `errors`                         | Field-level validation errors, keys typed to body field names.                                                                                                                      |
| `error`                          | Action error, or `null`.                                                                                                                                                            |
| `post`, `put`, `patch`, `delete` | Submit the form with that method. In React these are native form action callbacks.                                                                                                  |
| `pending`                        | `true` while the submission is in flight.                                                                                                                                           |
| `hasChanges`                     | `true` if form data differs from the current defaults. After a successful submit, defaults update to the submitted values so `hasChanges` becomes `false`.                          |
| `wasSuccessful`                  | `true` after a successful submission. Stays `true` until the next submission.                                                                                                       |
| `recentlySuccessful`             | `true` for 2 seconds after a successful submission. Useful for flash messages.                                                                                                      |
| `reset(...fields)`               | Reset form data to the current defaults (last submitted values after success). Field names autocomplete. Pass `{ initial: true }` first to reset to the values passed to `useForm`. |
| `resetOnSuccess` (option)        | When `true`, a successful submit resets both form data and defaults to the mount-time values. Useful for create forms that should clear after save.                                 |
| `setError(field, message)`       | Set a client-side validation error on a field.                                                                                                                                      |
| `clearErrors(...fields)`         | Clear validation errors. Field names autocomplete.                                                                                                                                  |
| `clearError()`                   | Clear `error`.                                                                                                                                                                      |

Use `setError()` to display errors from your own client-side validation. Setting an error preserves errors on other fields. Changing a field clears that field's validation error automatically (`setData` in React and Solid, or assigning to `data` in Vue and Svelte).

For a native React form, use `form.post`, `form.put`, `form.patch`, or `form.delete` as a native form action. For an awaitable mutation, use `action()`. In Vue, Svelte, and Solid, form submissions return `Promise<void>`; catch thrown errors or use your framework's error handling.

For dynamic routes, pass `params` in the options:

```ts
// pages/users/[id].server.ts has an action
const form = useForm('/users/:id', { name: '' }, { params: { id: '42' } });
<Form form={form} method="put">{/* submits to /users/42 */}</Form>
```

Create forms often need empty fields again after a successful save. Either pass `resetOnSuccess: true` in the third argument, or call `form.reset({ initial: true })` when `form.wasSuccessful` becomes `true`.

### React submission callbacks

In React, pass `onSuccess` and `onError` to `useForm()` to respond to a submission:

```tsx
const form = useForm(
  '/users',
  { name: '', email: '' },
  {
    onSuccess: () => setDialogOpen(false),
    onError: (error) => {
      // A field-error map or VoidActionError for a handled action failure.
      console.error(error);
    },
  },
);
```

Each submission uses the callbacks from when it was dispatched. Callbacks run inside the React Action, before the updated UI commits. Use an effect or ref callback to focus an element that appears after submission.

Callbacks can return `Promise<void>`. The Action awaits them, and `form.pending` stays true until they complete. Errors thrown or rejected by callbacks reach the nearest React error boundary. Aborted submissions invoke neither callback.

Vue, Svelte, and Solid submissions return a promise instead; use `await form.post()` to run work after a submission.

## Named Actions

When a page needs multiple mutations, such as updating and deleting a user on the same page, export `actions` (plural) instead of `action`:

```ts
import { users, updateUserSchema } from '@schema';
// pages/users/[id].server.ts
import { defineHandler } from 'void';
import { db, eq } from 'void/db';

export const actions = {
  update: defineHandler.withValidator({
    body: updateUserSchema,
  })(async (c, { body }) => {
    await db
      .update(users)
      .set(body)
      .where(eq(users.id, Number(c.req.param('id'))));
  }),

  delete: defineHandler(async (c) => {
    await db.delete(users).where(eq(users.id, Number(c.req.param('id'))));
  }),
};
```

Named actions are dispatched via a `?actionName` suffix on the URL (e.g. `/users/42?update`). The client primitives `useForm` and `action()` handle this automatically. The action key stays out of the page URL. When `POST /users/42?update&tab=profile` renders the page again, `useForm` and `action()` leave the address bar at `/users/42?tab=profile`, and `c.redirect('/users/42')` goes to `/users/42?tab=profile`.

Use `action` or `actions` in a file, not both.

You can also define an `actions.default` key for the action that runs when no name is specified (i.e. a bare POST to the page URL):

```ts
export const actions = {
  default: defineHandler(async (c) => {
    // runs on POST /users/edit (no ?suffix)
  }),
  delete: defineHandler(async (c) => {
    // runs on POST /users/edit?delete
  }),
};
```

### Named Actions with `useForm`

When a page exports named actions, append `?actionName` to the URL:

```ts
const form = useForm('/users/:id?update', { name: '' }, { params: { id } });
<Form form={form} method="put">{/* submits to /users/42?update */}</Form>
```

Each named action has its own validator schema, which supplies types for its URL, body, and error keys. See [Type Safety](../type-safety#action-%E2%86%92-useform) for an example.

## `action()` Helper

Use `action()` for a button or other mutation that does not need form state. It updates the page after a successful request:

```ts
import { action } from '@void/react'; // or "@void/vue", "@void/svelte", "@void/solid"

const result = await action('/users/:id?delete', {
  params: { id: '42' },
  method: 'DELETE',
});
if (!result.ok) {
  showToast(result.error.message);
}
```

`action()` defaults to `POST`. Pass `data`, `params`, and `method` to set the body, route parameters, or HTTP method.

A successful call returns `{ ok: true, pageData }`. Expected errors, such as validation failures or conflicts, return `{ ok: false, error }`.

## Validation Errors

`withValidator()` and `ValidationError` populate `form.errors` automatically.

Expected errors such as `400`, `404`, `409`, `422`, and `429` stay with the form or action call. `useForm` stores them in `form.errors` or `form.error`; `action()` returns `{ ok: false, error }`.

Authentication errors (`401`, `403`), server errors (`500`, `502`), and unexpected failures are thrown. Handle them with your framework's error boundary or error handling.

Actions can throw `ValidationError` for custom validation logic:

```ts
import { defineHandler, ValidationError } from 'void/handler';

export const action = defineHandler(async (c) => {
  const body = await c.req.json();
  if (await emailExists(body.email)) {
    throw new ValidationError({ email: 'Email already taken' });
  }
  // ...
});
```

### Usage limits

For [AI](../ai.md#usage-limits) and [Sandbox](../sandboxes.md#usage-limits) actions, an uncaught `UsageLimit` automatically produces a structured HTTP 429. To customize the message, catch the error with `instanceof UsageLimit` and return `error.response({ message: 'Try again shortly. Your draft is still editable.' })`. `Form` displays the message and waits until a known retry deadline before allowing resubmission. It keeps the fields editable and never retries automatically.

## Authentication and origin checks

Browser submissions must come from the same origin as the page, including its scheme, hostname, and port. Void rejects cross-origin page actions with `403 Forbidden`. Server clients can call actions without browser origin headers; actions still need authentication and authorization for protected data.

## File Uploads

Set a `File`, `Blob`, or `FileList` in form data and submit. `useForm` sends it as `multipart/form-data`:

::: code-group

```tsx [React]
import { Form, useForm } from '@void/react';

export default function Upload() {
  const form = useForm('/photos', { title: '', photo: null as File | null });

  return (
    <Form form={form}>
      <input value={form.data.title} onChange={(e) => form.setData('title', e.target.value)} />
      <input type="file" onChange={(e) => form.setData('photo', e.target.files?.[0] ?? null)} />
      <button disabled={form.pending}>Upload</button>
    </Form>
  );
}
```

```vue [Vue]
<script setup lang="ts">
import { ref } from 'vue';
import { Form, useForm } from '@void/vue';

const form = useForm('/photos', { title: '', photo: null as File | null });
const fileInput = ref<HTMLInputElement>();

function onFileChange() {
  form.data.photo = fileInput.value?.files?.[0] ?? null;
}
</script>

<template>
  <Form :form="form">
    <input v-model="form.data.title" />
    <input type="file" ref="fileInput" @change="onFileChange" />
    <button :disabled="form.pending">Upload</button>
  </Form>
</template>
```

```svelte [Svelte]
<script>
  import { Form, useForm } from "@void/svelte";

  const form = useForm("/photos", { title: "", photo: null });
</script>

<Form {form}>
  <input bind:value={form.data.title} />
  <input type="file" onchange={(e) => { form.data.photo = e.target.files?.[0] ?? null; }} />
  <button disabled={form.pending}>Upload</button>
</Form>
```

```tsx [Solid]
import { Form, useForm } from '@void/solid';

export default function Upload() {
  const form = useForm('/photos', { title: '', photo: null as File | null });

  return (
    <Form form={form}>
      <input value={form.data.title} onInput={(e) => form.setData('title', e.target.value)} />
      <input type="file" onChange={(e) => form.setData('photo', e.target.files?.[0] ?? null)} />
      <button disabled={form.pending}>Upload</button>
    </Form>
  );
}
```

:::

On the server, use `c.req.parseBody()` to access the uploaded file:

```ts
// pages/photos.server.ts
import { defineHandler, ValidationError } from 'void/handler';
import { storage } from 'void/storage';

// file.name and file.type come from the browser. Don't use them as the key or trust the type.
const imageTypes = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

export const action = defineHandler(async (c) => {
  const body = await c.req.parseBody();
  const file = body['photo'];
  if (!(file instanceof File) || file.size === 0) return;
  const ext = imageTypes.get(file.type);
  if (!ext) {
    throw new ValidationError({ photo: 'Upload a JPEG, PNG, or WebP image.' });
  }
  await storage.put(`uploads/${crypto.randomUUID()}.${ext}`, file.stream(), {
    httpMetadata: { contentType: file.type },
  });
});
```

Pick the storage key on the server and allow only the file types you expect. See [Serving Files](../storage.md#serving-files) to send them back safely.

## Choosing a Primitive

| Primitive        | Page update | Form state                 | Framework-specific |
| ---------------- | ----------- | -------------------------- | ------------------ |
| `useForm`        | Yes         | Yes (errors, dirty, reset) | Yes                |
| `action()`       | Yes         | No                         | Yes                |
| Native `fetch()` | No          | No                         | No                 |
