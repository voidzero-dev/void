import { createComponent, createRoot } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { VoidRouter } from 'void/pages-client';
import { RouterContext } from '../../src/runtime/context.ts';
import { useForm as typedUseForm } from '../../src/runtime/use-form.ts';
import { useIslandForm } from '../../src/runtime/use-island-form.ts';

// Client memos must react to edits; Solid's server runtime evaluates them only once.
vi.mock('solid-js', () => vi.importActual<typeof import('solid-js')>('solid-js/dist/solid.js'));
vi.mock('solid-js/store', () =>
  vi.importActual<typeof import('solid-js/store')>('solid-js/store/dist/store.js'),
);

type TestForm = {
  readonly data: Record<string, unknown>;
  readonly errors: Record<string, string>;
  readonly pending: boolean;
  readonly wasSuccessful: boolean;
  setData(field: string, value: unknown): void;
  reset(): void;
  post(): Promise<void>;
};

// The public overload only accepts generated action URLs; these tests use plain paths.
const useForm = typedUseForm as unknown as (
  url: string,
  defaults: Record<string, unknown>,
  options?: { resetOnSuccess?: boolean },
) => TestForm;

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function validationResponse(errors: Record<string, string>): Response {
  return new Response(JSON.stringify({ errors }), {
    status: 422,
    headers: { 'Content-Type': 'application/json' },
  });
}

const disposers: Array<() => void> = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});

function mountOverlappingForm(options?: { resetOnSuccess?: boolean }) {
  const visits: Array<Deferred<unknown>> = [];
  const sent: Array<unknown> = [];
  const router = {
    visit: (_url: string, visitOptions: { data?: unknown }) => {
      sent.push(visitOptions.data);
      const visit = deferred<unknown>();
      visits.push(visit);
      return visit.promise;
    },
  } as unknown as VoidRouter;
  let form!: TestForm;
  createRoot((dispose) => {
    disposers.push(dispose);
    createComponent(RouterContext.Provider, {
      value: router,
      get children() {
        form = useForm('/notes?create', { title: '' }, options);
        return null;
      },
    });
  });
  return { form, visits, sent };
}

describe('useForm overlapping submits', () => {
  it('stays pending when the router aborts an older submit', async () => {
    const { form, visits } = mountOverlappingForm();
    const first = form.post();
    const second = form.post();

    visits[0].reject(new DOMException('Navigation aborted', 'AbortError'));
    await first;
    expect(form.pending).toBe(true);

    visits[1].resolve({});
    await second;
    expect(form.pending).toBe(false);
    expect(form.wasSuccessful).toBe(true);
  });

  it('ignores an older submit that finishes first', async () => {
    const { form, visits } = mountOverlappingForm();
    const first = form.post();
    const second = form.post();

    visits[0].resolve({ errors: { title: 'Stale' } });
    await first;
    expect(form.pending).toBe(true);
    expect(form.errors).toEqual({});

    visits[1].resolve({ errors: { title: 'Invalid' } });
    await second;
    expect(form.pending).toBe(false);
    expect(form.errors).toEqual({ title: 'Invalid' });
  });

  it('ignores an older submit that finishes last', async () => {
    const { form, visits } = mountOverlappingForm();
    form.setData('title', 'Edited');
    const first = form.post();
    const second = form.post();

    visits[1].resolve({ errors: { title: 'Invalid' } });
    await second;
    visits[0].resolve({});
    await first;

    expect(form.wasSuccessful).toBe(false);
    expect(form.errors).toEqual({ title: 'Invalid' });
    // The older success did not save its values as the new defaults.
    form.reset();
    expect(form.data.title).toBe('');
  });

  it('rejects an older submit that fails without changing the form', async () => {
    const { form, visits } = mountOverlappingForm();
    const first = form.post();
    const second = form.post();

    visits[0].reject(new Error('Older failure'));
    await expect(first).rejects.toThrow('Older failure');
    expect(form.pending).toBe(true);

    visits[1].resolve({});
    await second;
    expect(form.pending).toBe(false);
  });
});

function mountIslandForm() {
  const responses: Array<Deferred<Response>> = [];
  const reload = vi.fn();
  vi.stubGlobal('window', { location: { href: 'http://localhost/test', reload } });
  vi.stubGlobal('fetch', () => {
    const response = deferred<Response>();
    responses.push(response);
    return response.promise;
  });
  const form = createRoot((dispose) => {
    disposers.push(dispose);
    return useIslandForm({ title: '' });
  });
  return { form, responses, reload };
}

describe('useIslandForm overlapping submits', () => {
  it('ignores an older submit that finishes first', async () => {
    const { form, responses } = mountIslandForm();
    const first = form.post('/island');
    const second = form.post('/island');

    responses[0].resolve(validationResponse({ title: 'Stale' }));
    await first;
    expect(form.pending).toBe(true);
    expect(form.errors).toEqual({});

    responses[1].resolve(validationResponse({ title: 'Invalid' }));
    await second;
    expect(form.pending).toBe(false);
    expect(form.errors).toEqual({ title: 'Invalid' });
  });

  it('does not reload for an older submit that finishes last', async () => {
    const { form, responses, reload } = mountIslandForm();
    const first = form.post('/island');
    const second = form.post('/island');

    responses[1].resolve(validationResponse({ title: 'Invalid' }));
    await second;
    responses[0].resolve(new Response('{}', { status: 200 }));
    await first;

    expect(reload).not.toHaveBeenCalled();
    expect(form.wasSuccessful).toBe(false);
    expect(form.errors).toEqual({ title: 'Invalid' });
  });
});

describe('useForm edits made during a submit', () => {
  it('sends and saves the values from when the submit started', async () => {
    const { form, visits, sent } = mountOverlappingForm();
    form.setData('title', 'Sent');
    const submit = form.post();
    form.setData('title', 'Typed while in flight');

    visits[0].resolve({});
    await submit;

    expect(sent).toEqual([{ title: 'Sent' }]);
    expect(form.data.title).toBe('Typed while in flight');
    form.reset();
    expect(form.data).toEqual({ title: 'Sent' });
  });

  it('resetOnSuccess keeps an edit made during the submit', async () => {
    const { form, visits } = mountOverlappingForm({ resetOnSuccess: true });
    form.setData('title', 'Sent');
    const submit = form.post();
    form.setData('title', 'Typed while in flight');

    visits[0].resolve({});
    await submit;

    expect(form.data.title).toBe('Typed while in flight');
    form.reset();
    expect(form.data.title).toBe('');
  });

  it('resetOnSuccess clears the form when nothing changed during the submit', async () => {
    const { form, visits } = mountOverlappingForm({ resetOnSuccess: true });
    form.setData('title', 'Sent');
    const submit = form.post();

    visits[0].resolve({});
    await submit;

    expect(form.data.title).toBe('');
  });
});

describe('useIslandForm edits made during a submit', () => {
  it('saves the values from when the submit started', async () => {
    const { form, responses, reload } = mountIslandForm();
    form.setData('title', 'Sent');
    const submit = form.post('/island');
    form.setData('title', 'Typed while in flight');

    responses[0].resolve(new Response('{}', { status: 200 }));
    await submit;

    expect(reload).toHaveBeenCalledTimes(1);
    expect(form.data.title).toBe('Typed while in flight');
    form.reset();
    expect(form.data.title).toBe('Sent');
  });
});
