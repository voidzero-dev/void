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
