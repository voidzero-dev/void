// @vitest-environment happy-dom

import {
  Component,
  StrictMode,
  Suspense,
  act,
  createElement,
  startTransition,
  use,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react';
import { createRoot, type Root, type RootOptions } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { VoidActionError, type VoidRouter } from 'void/pages-client';
import { RouterContext } from '../../src/runtime/context.ts';
import { useForm } from '../../src/runtime/use-form.ts';
import { useIslandForm, type IslandFormReturn } from '../../src/runtime/use-island-form.ts';

declare module 'void/routes' {
  interface PageActionMap {
    '/__form-callbacks/notes': { actions: { create: { body: { title: string } } } };
  }
}

const actionUrl = '/__form-callbacks/notes?create';
type TestForm = ReturnType<typeof useForm<typeof actionUrl>>;
type FormOptions = NonNullable<Parameters<typeof useForm<typeof actionUrl>>[2]>;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function routerWithVisit(visit: VoidRouter['visit']): VoidRouter {
  return {
    _hoverDelay: 75,
    get url() {
      return new URL('http://localhost/');
    },
    get path() {
      return '/';
    },
    get query() {
      return new URLSearchParams();
    },
    get params() {
      return {};
    },
    visit,
    refresh: vi.fn(),
    prefetch: vi.fn(),
    flush: vi.fn(),
    flushAll: vi.fn(),
  };
}

async function mountApp(app: ReactNode, options?: RootOptions) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container, options);
  mountedRoots.push({ root, container });
  await act(async () => {
    root.render(createElement(StrictMode, null, app));
  });
  return container;
}

async function mountForm(visit: VoidRouter['visit'], options?: FormOptions) {
  const router = routerWithVisit(visit);
  const formRef: { current: TestForm | null } = { current: null };
  function App() {
    const form = useForm(actionUrl, { title: '' }, options);
    formRef.current = form;
    return createElement('div', null, form.errors.title || (form.pending ? 'Pending' : 'Ready'));
  }
  const container = await mountApp(
    createElement(RouterContext.Provider, { value: router }, createElement(App)),
  );
  if (!formRef.current) {
    throw new Error('useForm did not mount.');
  }
  return { formRef, container };
}

async function submitPost(form: TestForm) {
  await act(async () => {
    startTransition(() => {
      form.post(new FormData());
    });
  });
}

describe('useForm callbacks', () => {
  it.each([401, 403, 503])(
    'keeps HTTP %s inline with input intact and calls onError when throwing is disabled',
    async (status) => {
      const failure = new VoidActionError({
        body: { errors: { title: 'Not a validation failure' } },
        status,
        statusText: '',
        url: actionUrl,
      });
      const onError = vi.fn();
      const onCaughtError = vi.fn();
      let form!: TestForm;
      class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
        state = { failed: false };
        static getDerivedStateFromError() {
          return { failed: true };
        }
        render() {
          return this.state.failed ? 'Boundary replaced the form' : this.props.children;
        }
      }
      function App() {
        form = useForm(actionUrl, { title: 'Keep this draft' }, { throwOnError: false, onError });
        return createElement('div', null, form.data.title);
      }
      const container = await mountApp(
        createElement(
          RouterContext.Provider,
          {
            value: routerWithVisit(async () => {
              throw failure;
            }),
          },
          createElement(Boundary, null, createElement(App)),
        ),
        { onCaughtError },
      );

      await submitPost(form);

      expect(onCaughtError).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
      expect(form.error).toBe(failure);
      expect(form.errors).toEqual({});
      expect(form.pending).toBe(false);
      expect(container.textContent).toBe('Keep this draft');
    },
  );

  it.each([true, false])('forwards preserveScroll: %s from useForm()', async (preserveScroll) => {
    const visit = vi.fn(async () => ({}));
    const { formRef } = await mountForm(visit, { preserveScroll });

    await submitPost(formRef.current!);

    expect(visit).toHaveBeenCalledWith(actionUrl, expect.objectContaining({ preserveScroll }));
  });

  it('calls onSuccess once after a successful submit in Strict Mode', async () => {
    const onSuccess = vi.fn();
    const { formRef } = await mountForm(
      vi.fn(async () => ({})),
      { onSuccess },
    );
    await submitPost(formRef.current!);
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(formRef.current!.wasSuccessful).toBe(true);
  });

  it('resets to saved values after awaiting onSuccess work', async () => {
    const { formRef } = await mountForm(
      vi.fn(async () => ({})),
      {
        onSuccess: async () => {
          await Promise.resolve();
          formRef.current!.reset();
        },
      },
    );
    await act(async () => {
      formRef.current!.setData('title', 'Saved');
    });

    await submitPost(formRef.current!);

    expect(formRef.current!.data.title).toBe('Saved');
    expect(formRef.current!.hasChanges).toBe(false);
  });

  it('preserves field errors set after awaiting onSuccess work', async () => {
    const { formRef } = await mountForm(
      vi.fn(async () => ({})),
      {
        onSuccess: async () => {
          await Promise.resolve();
          formRef.current!.setError('title', 'Check the saved value');
        },
      },
    );

    await submitPost(formRef.current!);

    expect(formRef.current!.errors).toEqual({ title: 'Check the saved value' });
  });

  it('calls onError with validation errors before the updated UI commits', async () => {
    const onError = vi.fn(() => {
      expect(container.textContent).not.toBe('Required');
    });
    const { container, formRef } = await mountForm(
      vi.fn(async () => ({ errors: { title: 'Required' } })),
      { onError },
    );
    await submitPost(formRef.current!);
    expect(onError).toHaveBeenCalledExactlyOnceWith({ title: 'Required' });
    expect(formRef.current!.errors).toEqual({ title: 'Required' });
    expect(container.textContent).toBe('Required');
  });

  it('calls onError with VoidActionError for non-validation failures', async () => {
    const actionError = new VoidActionError({
      body: 'Missing',
      status: 404,
      statusText: 'Not Found',
      url: '/notes',
    });
    const onError = vi.fn();
    const { formRef } = await mountForm(
      vi.fn(async () => {
        throw actionError;
      }),
      { onError },
    );
    await submitPost(formRef.current!);
    expect(onError).toHaveBeenCalledExactlyOnceWith(actionError);
    expect(formRef.current!.error).toBe(actionError);
  });

  it('fires onSuccess on each successful submit', async () => {
    const onSuccess = vi.fn();
    const { formRef } = await mountForm(
      vi.fn(async () => ({})),
      { onSuccess },
    );
    await submitPost(formRef.current!);
    await submitPost(formRef.current!);
    expect(onSuccess).toHaveBeenCalledTimes(2);
  });

  it('does not call either callback when a submit is aborted', async () => {
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const { formRef } = await mountForm(
      vi.fn(async () => {
        throw new DOMException('Navigation aborted', 'AbortError');
      }),
      { onSuccess, onError },
    );
    await submitPost(formRef.current!);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(['success', 'validation error', 'action error'] as const)(
    'keeps pending true until the async %s callback completes',
    async (outcome) => {
      const work = deferred<void>();
      const callback = vi.fn(() => work.promise);
      const visit = vi.fn(async () => {
        if (outcome === 'action error') {
          throw new VoidActionError({
            body: 'Missing',
            status: 404,
            statusText: 'Not Found',
            url: '/notes',
          });
        }
        return outcome === 'validation error' ? { errors: { title: 'Required' } } : {};
      });
      const { formRef } = await mountForm(visit, { onSuccess: callback, onError: callback });
      try {
        await submitPost(formRef.current!);
        expect(callback).toHaveBeenCalledOnce();
        expect(formRef.current!.pending).toBe(true);
      } finally {
        await act(async () => {
          work.resolve();
        });
      }
      expect(formRef.current!.pending).toBe(false);
    },
  );

  it.each(['success', 'error'] as const)(
    'uses the submitted %s callback when another render suspends',
    async (outcome) => {
      const visit = deferred<Awaited<ReturnType<VoidRouter['visit']>>>();
      const suspendForever = new Promise<void>(() => {});
      const callbacks = { A: vi.fn(), B: vi.fn() };
      const renderedVersions: Array<string> = [];
      const committedVersions: Array<string> = [];
      let submit!: TestForm['post'];
      let setVersion!: (version: 'A' | 'B') => void;
      function Page({ version }: { version: 'A' | 'B' }) {
        const form = useForm(
          actionUrl,
          { title: '' },
          outcome === 'success'
            ? { onSuccess: callbacks[version] }
            : { onError: callbacks[version] },
        );
        renderedVersions.push(version);
        useLayoutEffect(() => {
          committedVersions.push(version);
        }, [version]);
        submit = form.post;
        if (version === 'B') {
          use(suspendForever);
        }
        return createElement('div', null, version);
      }
      function App() {
        const [version, set] = useState<'A' | 'B'>('A');
        setVersion = set;
        return createElement(Suspense, { fallback: 'Loading' }, createElement(Page, { version }));
      }
      await mountApp(
        createElement(
          RouterContext.Provider,
          { value: routerWithVisit(() => visit.promise) },
          createElement(App),
        ),
      );
      await act(async () => {
        startTransition(() => {
          submit(new FormData());
        });
      });
      await act(async () => {
        setVersion('B');
      });
      expect(renderedVersions).toContain('B');
      expect(committedVersions).not.toContain('B');
      await act(async () => {
        visit.resolve(outcome === 'success' ? {} : { errors: { title: 'Required' } });
      });
      expect(committedVersions).not.toContain('B');
      expect(callbacks.B).not.toHaveBeenCalled();
      expect(callbacks.A).toHaveBeenCalledOnce();
    },
  );

  it.each(['success', 'error'] as const)(
    'routes async %s callback failures to the React error boundary',
    async (outcome) => {
      const failure = new Error('Callback failed');
      const onCaughtError = vi.fn();
      const callback = vi.fn(async () => {
        throw failure;
      });
      let submit!: TestForm['post'];
      class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
        state = { failed: false };
        static getDerivedStateFromError() {
          return { failed: true };
        }
        render() {
          return this.state.failed ? 'Action failed' : this.props.children;
        }
      }
      function App() {
        const form = useForm(
          actionUrl,
          { title: '' },
          outcome === 'success' ? { onSuccess: callback } : { onError: callback },
        );
        submit = form.post;
        return null;
      }
      const router = routerWithVisit(async () =>
        outcome === 'success' ? {} : { errors: { title: 'Required' } },
      );
      const container = await mountApp(
        createElement(
          RouterContext.Provider,
          { value: router },
          createElement(Boundary, null, createElement(App)),
        ),
        { onCaughtError },
      );
      await act(async () => {
        startTransition(() => {
          submit(new FormData());
        });
      });
      expect(callback).toHaveBeenCalledOnce();
      expect(onCaughtError).toHaveBeenCalledWith(failure, expect.anything());
      expect(container.textContent).toBe('Action failed');
    },
  );
});

describe('useForm state derivation and error management', () => {
  it('snapshots synchronous setData() before submit, in-flight edits, and queued actions', async () => {
    const firstFlight = deferred<Record<string, unknown>>();
    const secondFlight = deferred<Record<string, unknown>>();
    let callCount = 0;
    const visit = vi.fn(() => (++callCount === 1 ? firstFlight.promise : secondFlight.promise));
    const { formRef } = await mountForm(visit);

    // 1. Synchronous setData() immediately followed by post() in the same turn
    await act(async () => {
      formRef.current!.setData('title', 'First');
      startTransition(() => {
        formRef.current!.post(new FormData());
      });
    });

    // 2 & 3. Queued action with its own snapshot + in-flight edit while both are pending
    await act(async () => {
      formRef.current!.setData('title', 'Second');
      startTransition(() => {
        formRef.current!.post(new FormData());
      });
      formRef.current!.setData('title', 'Edited in-flight');
    });

    await act(async () => {
      firstFlight.resolve({});
    });
    expect(visit).toHaveBeenNthCalledWith(
      1,
      actionUrl,
      expect.objectContaining({ data: { title: 'First' } }),
    );
    expect(visit).toHaveBeenNthCalledWith(
      2,
      actionUrl,
      expect.objectContaining({ data: { title: 'Second' } }),
    );

    await act(async () => {
      secondFlight.resolve({});
    });
    expect(formRef.current!.data.title).toBe('Edited in-flight');
    expect(formRef.current!.hasChanges).toBe(true);

    await act(async () => {
      formRef.current!.reset();
    });
    expect(formRef.current!.data.title).toBe('Second');
    expect(formRef.current!.hasChanges).toBe(false);
  });

  it('applies form helpers during callbacks and only resets to a new baseline after the request succeeds', async () => {
    let mode: 'success-reset' | 'async-external-reset' | 'validation' | 'action-error' =
      'success-reset';
    const requestGate = deferred<Record<string, unknown>>();
    const callbackGate = deferred<void>();
    const visit = vi.fn(async () => {
      if (mode === 'async-external-reset') {
        return requestGate.promise;
      }
      if (mode === 'validation') {
        return { errors: { title: 'Server invalid', extra: 'Keep me' } };
      }
      if (mode === 'action-error') {
        throw new VoidActionError({
          body: 'Conflict',
          status: 409,
          statusText: 'Conflict',
          url: actionUrl,
        });
      }
      return {};
    });

    const { formRef } = await mountForm(visit, {
      onSuccess: async () => {
        if (mode === 'async-external-reset') {
          await callbackGate.promise;
          return;
        }
        formRef.current!.reset();
      },
      onError: async (err) => {
        await Promise.resolve();
        if (err instanceof VoidActionError) {
          formRef.current!.clearError();
        } else {
          formRef.current!.clearErrors();
          formRef.current!.setError('title', 'Custom error from onError');
        }
      },
    });

    // onSuccess -> reset() uses the newly saved snapshot baseline
    await act(async () => {
      formRef.current!.setData('title', 'Saved');
    });
    await submitPost(formRef.current!);
    expect(formRef.current!.data).toEqual({ title: 'Saved' });
    expect(formRef.current!.hasChanges).toBe(false);

    // Until the request succeeds, reset() still uses the previous saved values.
    mode = 'async-external-reset';
    await act(async () => {
      formRef.current!.setData('title', 'Next saved');
    });
    await submitPost(formRef.current!);
    expect(formRef.current!.pending).toBe(true);
    await act(async () => {
      formRef.current!.reset();
    });
    expect(formRef.current!.data).toEqual({ title: 'Saved' });

    // The server has accepted the new snapshot, even while onSuccess is still pending.
    await act(async () => {
      requestGate.resolve({});
    });
    expect(formRef.current!.pending).toBe(true);
    expect(formRef.current!.wasSuccessful).toBe(false);
    await act(async () => {
      formRef.current!.reset();
    });
    expect(formRef.current!.data).toEqual({ title: 'Next saved' });
    await act(async () => {
      callbackGate.resolve();
    });
    expect(formRef.current!.pending).toBe(false);
    expect(formRef.current!.hasChanges).toBe(false);

    // onError -> clearErrors() + setError()
    mode = 'validation';
    await act(async () => {
      formRef.current!.setData('title', 'Bad');
    });
    await submitPost(formRef.current!);
    expect(formRef.current!.errors).toEqual({ title: 'Custom error from onError' });

    // onError -> clearError()
    mode = 'action-error';
    await submitPost(formRef.current!);
    expect(formRef.current!.error).toBeNull();
  });

  it('clears stale errors while resubmitting, preserves in-flight edits under resetOnSuccess, and does not revive errors or success after abort', async () => {
    const firstSubmit = deferred<Record<string, unknown>>();
    const secondSubmit = deferred<Record<string, unknown>>();
    const thirdSubmit = deferred<Record<string, unknown>>();
    const thirdCallback = deferred<void>();
    const fourthSubmit = deferred<Record<string, unknown>>();
    const fifthSubmit = deferred<Record<string, unknown>>();
    let call = 0;
    const visit = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return firstSubmit.promise;
      }
      if (call === 2) {
        await secondSubmit.promise;
        throw new DOMException('Navigation aborted', 'AbortError');
      }
      if (call === 3) {
        return thirdSubmit.promise;
      }
      if (call === 4) {
        await fourthSubmit.promise;
        throw new DOMException('Navigation aborted', 'AbortError');
      }
      return fifthSubmit.promise;
    });

    const { formRef } = await mountForm(visit, {
      resetOnSuccess: true,
      onSuccess: () => (call === 3 ? thirdCallback.promise : undefined),
    });

    await act(async () => {
      formRef.current!.setData('title', 'Attempt 1');
    });
    await submitPost(formRef.current!);
    await act(async () => {
      firstSubmit.resolve({ errors: { title: 'First failed' } });
    });
    expect(formRef.current!.errors).toEqual({ title: 'First failed' });

    // Submit 2 starts (clearing errors) and aborts — Submit 1's validation errors must not revive
    await submitPost(formRef.current!);
    expect(formRef.current!.pending).toBe(true);
    expect(formRef.current!.errors).toEqual({});

    await act(async () => {
      secondSubmit.resolve({});
    });
    expect(formRef.current!.pending).toBe(false);
    expect(formRef.current!.errors).toEqual({});

    // Submit 3 succeeds with async onSuccess callback and resetOnSuccess (no in-flight edit)
    await submitPost(formRef.current!);
    await act(async () => {
      thirdSubmit.resolve({});
    });
    expect(formRef.current!.pending).toBe(true);
    expect(formRef.current!.data.title).toBe('Attempt 1');

    await act(async () => {
      thirdCallback.resolve();
    });
    expect(formRef.current!.wasSuccessful).toBe(true);
    expect(formRef.current!.recentlySuccessful).toBe(true);
    expect(formRef.current!.data.title).toBe('');
    expect(formRef.current!.hasChanges).toBe(false);

    // Submit 4 starts and aborts — Submit 3's success state must not revive
    await submitPost(formRef.current!);
    expect(formRef.current!.wasSuccessful).toBe(false);
    expect(formRef.current!.recentlySuccessful).toBe(false);

    await act(async () => {
      fourthSubmit.resolve({});
    });
    expect(formRef.current!.pending).toBe(false);
    expect(formRef.current!.wasSuccessful).toBe(false);
    expect(formRef.current!.recentlySuccessful).toBe(false);

    // Submit 5: in-flight edit while request is pending must NOT be wiped by resetOnSuccess
    await act(async () => {
      formRef.current!.setData('title', 'Submitted 5');
    });
    await submitPost(formRef.current!);
    await act(async () => {
      formRef.current!.setData('title', 'Typed while in flight');
    });
    await act(async () => {
      fifthSubmit.resolve({});
    });
    expect(formRef.current!.data.title).toBe('Typed while in flight');
    expect(formRef.current!.hasChanges).toBe(true);
  });

  it('useIslandForm lets latest submission own UI state across completion orders and preserves post-success state', async () => {
    const originalLocation = window.location;
    const reloadMock = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { href: 'http://localhost/test', reload: reloadMock },
      writable: true,
      configurable: true,
    });

    try {
      const submit1 = deferred<Response>();
      const submit2 = deferred<Response>();
      const submit3 = deferred<Response>();
      const submit4 = deferred<Response>();
      const requestBodies: Array<Record<string, unknown>> = [];
      let call = 0;

      vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
        call += 1;
        requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (call === 1) {
          return submit1.promise;
        }
        if (call === 2) {
          return submit2.promise;
        }
        return call === 3 ? submit3.promise : submit4.promise;
      });

      const defaults = { profile: { name: 'Initial' }, tags: ['a'] };
      const islandFormRef: { current: IslandFormReturn<typeof defaults> | null } = {
        current: null,
      };

      function IslandApp() {
        islandFormRef.current = useIslandForm(defaults);
        return null;
      }

      await mountApp(createElement(IslandApp));
      const getForm = () => islandFormRef.current!;

      // Order 1: older submission (submit1) finishes before latest (submit2)
      await act(async () => {
        getForm().setData('profile', { name: 'First' });
      });
      let p1!: Promise<void>;
      let p2!: Promise<void>;
      await act(async () => {
        p1 = getForm().post('/island-action');
      });
      await act(async () => {
        getForm().setData('profile', { name: 'Second' });
      });
      await act(async () => {
        p2 = getForm().post('/island-action');
      });
      expect(requestBodies).toEqual([
        { profile: { name: 'First' }, tags: ['a'] },
        { profile: { name: 'Second' }, tags: ['a'] },
      ]);

      await act(async () => {
        submit1.resolve(
          new Response(JSON.stringify({ errors: { profile: 'Stale error' } }), {
            status: 422,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
        await p1;
      });
      expect(getForm().pending).toBe(true);
      expect(getForm().errors).toEqual({});

      await act(async () => {
        submit2.resolve(
          new Response(JSON.stringify({ errors: { profile: 'Profile invalid' } }), {
            status: 422,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
        await p2;
      });
      expect(getForm().pending).toBe(false);
      expect(getForm().errors).toEqual({ profile: 'Profile invalid' });

      // Order 2: latest submission (submit4) finishes before older (submit3)
      let p3!: Promise<void>;
      let p4!: Promise<void>;
      await act(async () => {
        p3 = getForm().post('/island-action');
      });
      await act(async () => {
        getForm().setData('profile', { name: 'Saved V4' });
      });
      await act(async () => {
        p4 = getForm().post('/island-action');
      });
      await act(async () => {
        getForm().setData('profile', { name: 'Edited after V4' });
      });

      vi.useFakeTimers();

      await act(async () => {
        submit4.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
        await p4;
      });
      expect(getForm().pending).toBe(false);
      expect(getForm().wasSuccessful).toBe(true);
      expect(getForm().recentlySuccessful).toBe(true);
      expect(getForm().hasChanges).toBe(true);
      expect(reloadMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        getForm().reset();
      });
      expect(getForm().data).toEqual({ profile: { name: 'Saved V4' }, tags: ['a'] });
      expect(getForm().hasChanges).toBe(false);

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(getForm().wasSuccessful).toBe(true);
      expect(getForm().recentlySuccessful).toBe(false);

      await act(async () => {
        submit3.resolve(
          new Response(JSON.stringify({ errors: { profile: 'Stale V3 error' } }), {
            status: 422,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
        await p3;
      });
      expect(getForm().pending).toBe(false);
      expect(getForm().errors).toEqual({});
      expect(getForm().wasSuccessful).toBe(true);
    } finally {
      vi.useRealTimers();
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      });
    }
  });
});
