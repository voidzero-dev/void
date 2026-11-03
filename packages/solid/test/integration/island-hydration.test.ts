import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { preview, type PreviewServer } from 'vite';
import solid from 'vite-plugin-solid';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { collectBrowserDiagnostics } from '../../../../test/browser-helpers.ts';
import { buildIslandApp } from '../../../../test/island-css-build.ts';
import { openIslandPage, type IslandPageVisit } from '../../../../test/island-page-browser.ts';
import { islandsPlugin } from '../../src/plugin-islands.ts';

type SnapshotWindow = Window & {
  __ssrCounters?: Record<string, { button: HTMLButtonElement; input: HTMLInputElement }>;
};

const counter = `import { createSignal, createUniqueId, useContext } from 'solid-js';
import { FrontmatterContext } from '@void/solid';
export default function Counter(props) {
  const [count, setCount] = createSignal(props.initial);
  const id = createUniqueId();
  return <section data-counter={props.name} data-frontmatter={useContext(FrontmatterContext).title}>
    <label for={id}>{props.name}</label><input id={id} />
    <button onClick={() => setCount(count() + 1)}>{count()}</button>
  </section>;
}`;

const capture = `window.__ssrCounters = Object.fromEntries(
  Array.from(document.querySelectorAll('[data-counter]')).map(host => {
    const input = host.querySelector('input');
    input.value = 'draft-' + host.dataset.counter;
    return [host.dataset.counter, { button: host.querySelector('button'), input }];
  })
);`;

const files = {
  'components/Counter.tsx': counter,
  'components/AsyncCounter.tsx': `
import { createResource, Suspense } from 'solid-js';
import Counter from './Counter';
export default function AsyncCounter() {
  const [name] = createResource(async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return 'async';
  });
  return <Suspense fallback={<p>Loading</p>}>
    <Counter name={name()} initial={50} />
  </Suspense>;
}`,
  'pages/layout.island.tsx': `
import Counter from '../components/Counter' with { island: 'load' };
export default function Layout(props) {
  return <div><Counter name="layout" initial={30} />{props.children}</div>;
}`,
  'pages/index.island.tsx': `
import Counter from '../components/Counter' with { island: 'load' };
import VisibleCounter from '../components/Counter' with { island: 'visible' };
import AsyncCounter from '../components/AsyncCounter' with { island: 'load' };
export const frontmatter = { title: 'Island metadata' };
export default function Page() {
  return <main>
    <Counter name="first" initial={0} /><Counter name="second" initial={10} />
    <AsyncCounter />
    <div style={{ height: '1600px' }} />
    <VisibleCounter name="visible-first" initial={20} />
    <div style={{ height: '1600px' }} />
    <VisibleCounter name="visible-second" initial={40} />
    <script innerHTML={${JSON.stringify(capture)}} />
  </main>;
}`,
  'pages/plain.island.tsx': `
import Counter from '../components/Counter' with { island: 'load' };
export default function Plain() {
  return <main>
    <Counter name="plain" initial={60} />
    <script innerHTML={${JSON.stringify(capture)}} />
  </main>;
}`,
};

async function visitFixture(): Promise<{ visit: IslandPageVisit; close(): Promise<void> }> {
  const root = mkdtempSync(join(import.meta.dirname, '__tmp_island_hydration_'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  try {
    const visit = await openIslandPage(root, {
      alias: { '@void/solid': join(import.meta.dirname, '../../src/runtime/index.ts') },
      plugins: [solid({ ssr: true }), ...islandsPlugin(join(root, 'pages'))],
    });
    return {
      visit,
      async close() {
        await visit.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function visitProductionFixture(
  browser: Browser,
  base: string,
): Promise<{
  visit: IslandPageVisit;
  close(): Promise<void>;
}> {
  const context = await browser.newContext();
  const close = () => context.close();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const diagnostics = collectBrowserDiagnostics(page);
    const response = await page.goto(base);
    const visit = { page, diagnostics, html: await response!.text(), close };
    return { visit, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function expectReused(
  visit: IslandPageVisit,
  name: string,
  frontmatter: string | null = 'Island metadata',
): Promise<void> {
  const { page } = visit;
  await page.waitForFunction(
    (name) =>
      document
        .querySelector(`[data-counter="${name}"]`)
        ?.closest('[data-island]')
        ?.getAttribute('data-hydrated') === 'true',
    name,
  );
  expect(
    await page.evaluate((name) => {
      const nodes = (window as SnapshotWindow).__ssrCounters![name];
      const host = document.querySelector(`[data-counter="${name}"]`)!;
      return {
        button: nodes.button === host.querySelector('button'),
        input: nodes.input === host.querySelector('input'),
        value: host.querySelector('input')!.value,
        labelled: host.querySelector('label')!.htmlFor === host.querySelector('input')!.id,
        frontmatter: host.getAttribute('data-frontmatter'),
      };
    }, name),
  ).toEqual({
    button: true,
    input: true,
    value: `draft-${name}`,
    labelled: true,
    frontmatter,
  });
}

describe.each(['dev', 'production'])('%s island hydration', (mode) => {
  let productionBuild: ReturnType<typeof buildIslandApp> | undefined;
  let productionServer: PreviewServer | undefined;
  let productionBrowser: Browser | undefined;

  beforeAll(async () => {
    if (mode === 'production') {
      productionBuild = buildIslandApp({
        packageDir: join(import.meta.dirname, '../..'),
        pluginName: 'voidSolid',
        files,
      });
      productionServer = await preview({
        root: productionBuild.root,
        configFile: false,
        logLevel: 'silent',
        build: { outDir: 'dist/client' },
        preview: { host: '127.0.0.1', port: 0 },
      });
      productionBrowser = await chromium.launch();
    }
  });

  afterAll(async () => {
    await productionBrowser?.close();
    await productionServer?.close();
    productionBuild?.cleanup();
  });

  function newFixture(path = '') {
    return mode === 'production'
      ? visitProductionFixture(productionBrowser!, productionServer!.resolvedUrls!.local[0] + path)
      : visitFixture();
  }

  it('reuses SSR DOM and preserves input in repeated islands and an island layout', async () => {
    const fixture = await newFixture();
    try {
      for (const name of ['layout', 'first', 'second']) {
        await expectReused(fixture.visit, name);
      }
      const { page } = fixture.visit;
      await page.locator('[data-counter="first"] button').click();
      await expect
        .poll(() => page.locator('[data-counter="first"] button').textContent())
        .toBe('1');
      await expect
        .poll(() => page.locator('[data-counter="second"] button').textContent())
        .toBe('10');
      expect(fixture.visit.diagnostics()).not.toContain('pageerror');
    } finally {
      await fixture.close();
    }
  });

  it('hydrates visible islands in reverse order after another island handles an event', async () => {
    const fixture = await newFixture();
    try {
      const { page } = fixture.visit;
      await page.waitForSelector('[data-counter="first"]');
      await page.waitForFunction(() =>
        document.querySelector('[data-island][data-hydrated="true"]'),
      );
      await page.locator('[data-counter="first"] button').click();
      for (const [name, initial] of [
        ['visible-second', 40],
        ['visible-first', 20],
      ] as const) {
        expect(
          await page
            .locator(`[data-counter="${name}"]`)
            .evaluate((host) => host.closest('[data-island]')!.hasAttribute('data-hydrated')),
        ).toBe(false);
        await page.locator(`[data-counter="${name}"]`).scrollIntoViewIfNeeded();
        await expectReused(fixture.visit, name);
        await page.locator(`[data-counter="${name}"] button`).click();
        await expect
          .poll(() => page.locator(`[data-counter="${name}"] button`).textContent())
          .toBe(String(initial + 1));
      }
      expect(fixture.visit.diagnostics()).not.toContain('pageerror');
    } finally {
      await fixture.close();
    }
  });

  // The dev helper serves only the index page.
  it.runIf(mode === 'production')(
    'reuses SSR DOM on an island page without frontmatter',
    async () => {
      const fixture = await newFixture('plain');
      try {
        await expectReused(fixture.visit, 'plain', null);
        const button = fixture.visit.page.locator('[data-counter="plain"] button');
        await button.click();
        await expect.poll(() => button.textContent()).toBe('61');
        expect(fixture.visit.diagnostics()).not.toContain('pageerror');
      } finally {
        await fixture.close();
      }
    },
  );

  it('hydrates an async resource inside Suspense without replacing the resolved SSR DOM', async () => {
    const fixture = await newFixture();
    try {
      expect(fixture.visit.html).toContain('data-counter="async"');
      await expectReused(fixture.visit, 'async');
      const button = fixture.visit.page.locator('[data-counter="async"] button');
      await button.click();
      await expect.poll(() => button.textContent()).toBe('51');
      expect(fixture.visit.diagnostics()).not.toContain('pageerror');
    } finally {
      await fixture.close();
    }
  });
});
