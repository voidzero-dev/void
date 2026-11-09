import { isVoidActionError } from './action-result.ts';
import type { BoundaryManifest } from './boundary-plans.ts';
import type { PageError } from './types.ts';

export type ClientPageBoundary = {
  id: string;
  key: string;
  depth: number;
  load: () => Promise<{ default: unknown }>;
};
export function pageBoundarySlots(
  manifest: BoundaryManifest | undefined,
  component: string,
  components: Record<string, () => Promise<{ default: unknown }>>,
): Array<ClientPageBoundary> {
  if (!manifest) {
    return [];
  }
  const current = manifest.plans[component];
  const source = current?.source ?? component;
  return (manifest.pages[source]?.catches ?? [])
    .filter((c) => {
      const plan = manifest.plans[c.plan];
      return (
        !current ||
        (current.kind === 'not-found'
          ? plan.directory.length <= current.directory.length
          : plan.directory.length < current.directory.length)
      );
    })
    .map((c) => ({
      id: c.plan,
      key: manifest.plans[c.plan].componentId,
      depth: Math.min(c.depth, current?.layouts.length ?? Infinity),
      load: components[c.plan],
    }));
}

export function clientPageError(error: unknown, dev = false): PageError {
  if (isVoidActionError(error)) {
    return { status: error.status, message: error.message };
  }
  return {
    status: 500,
    message: dev && error instanceof Error ? error.message : 'Internal Server Error',
  };
}

/** Terminal recovery cannot depend on the failed adapter, imports, or component tree. */
export function showTerminalPageError(url: string = window.location.href): void {
  const target = new URL(url, window.location.href);
  if (target.origin !== window.location.origin) {
    throw new Error('Invalid error page destination');
  }
  try {
    history.replaceState(history.state, '', target.href);
  } catch {
    /* Keep the recovery links usable if history is unavailable. */
  }
  const main = document.createElement('main');
  const heading = document.createElement('h1');
  heading.textContent = 'Something went wrong';
  main.appendChild(heading);
  for (const [label, href] of [
    ['Try again', target.href],
    ['Go home', '/'],
  ]) {
    const link = document.createElement('a');
    link.textContent = label;
    link.href = href;
    link.style.marginRight = '1rem';
    main.appendChild(link);
  }
  main.style.cssText = 'font-family:system-ui,sans-serif;padding:2rem';
  document.body.replaceChildren(main);
}
