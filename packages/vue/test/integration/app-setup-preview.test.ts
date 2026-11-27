import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vite-plus/test';
import {
  collectBrowserDiagnostics,
  waitForIslandsHydrated,
} from '../../../../test/browser-helpers.ts';
import {
  createIsolatedPlayground,
  killChild,
  spawnFixtureServer,
  startServer,
} from '../../../../test/integration-helpers.ts';
import type { IsolatedPlayground, StartedServer } from '../../../../test/integration-helpers.ts';
import { launchPagesBrowser } from '../../../../test/pages-browser.ts';

const APP_STATE_ID = '__VOID_APP_STATE__';
const files = {
  'app-setup.ts': `import { reactive, type App } from 'vue';

export default function setup(app: App) {
  const state = reactive({
    form: { ready: true, notices: [] as string[] },
    island: 'from setup',
    hydrations: 0,
  });
  let dehydrated = false;
  app.provide('app-state', state);
  return {
    dehydrate() {
      if (dehydrated || state.island !== 'from setup') throw new Error('Unexpected dehydrate() call');
      dehydrated = true;
      return { ready: state.form.ready, notices: state.form.notices.splice(0) };
    },
    hydrate(form: typeof state.form) {
      state.form = form;
      state.hydrations++;
    },
  };
}
`,
  'pages/setup-defer.server.ts': `import { defer, defineHandler } from 'void';

export const loader = defineHandler(c => {
  const form = { ready: false, notices: ['server notice'] };
  const port = c.req.query('gate');
  return {
    form,
    later: defer(async () => {
      const response = await fetch('http://127.0.0.1:' + port);
      if (!response.ok) throw new Error('Deferred gate failed');
      await response.text();
      form.ready = true;
      return 'resolved';
    }),
  };
});
`,
  'pages/setup-defer.vue': `<script setup>
import { inject, onMounted, ref } from 'vue';
const props = defineProps(['form', 'later']);
const state = inject('app-state');
if (import.meta.env.SSR) state.form = props.form;
const field = ref(null);
const text = ref('server default');
const mounted = ref('');
onMounted(() => {
  mounted.value = [
    props.later.loading ? 'pending' : 'resolved', field.value?.value, text.value, state.hydrations,
  ].join('|');
});
</script>
<template>
  <div v-if="!state.form.ready && props.form.notices.length">
    <input id="entry" ref="field" type="text" v-model="text">
    <output id="model">{{ text }}</output>
  </div>
  <p v-else>Ready branch</p>
  <output id="mounted">{{ mounted }}</output>
  <output id="deferred">{{ props.later.loading ? 'pending' : props.later.value }}</output>
</template>
`,
  'pages/setup-islands.island.vue': `<script setup>
import { inject } from 'vue';
import Editor from './_SetupEditor.vue' with { island: 'load' };
const state = inject('app-state');
state.island = 'from page';
const initial = state.island;
</script>
<template><Editor name="first" :initial="initial" /><Editor name="second" :initial="initial" /></template>
`,
  'pages/_SetupEditor.vue': `<script setup>
import { inject, onMounted, ref } from 'vue';
const props = defineProps({ name: String, initial: String });
const state = inject('app-state');
if (import.meta.env.SSR && props.name === 'second') {
  if (state.island !== props.initial) throw new Error('Expected the page app state');
  state.island = 'from second island';
}
const text = ref(props.initial);
const mountedState = ref('');
onMounted(() => {
  mountedState.value = [state.island, state.hydrations].join('|');
  state.island = props.name;
});
</script>
<template>
  <input :id="name" type="text" v-model="text">
  <output :id="name + '-model'">{{ text }}</output>
  <output :id="name + '-setup'">{{ mountedState }}</output>
</template>
`,
};

let fixture: IsolatedPlayground;
let server: StartedServer;
let browser: Browser;

beforeAll(async () => {
  const workspace = join(import.meta.dirname, '../../../..');
  fixture = createIsolatedPlayground(workspace, 'playground/vue-pages');
  const config = join(fixture.root, 'vite.config.ts');
  writeFileSync(
    config,
    readFileSync(config, 'utf8').replace('voidVue()', "voidVue({ appSetup: './app-setup.ts' })"),
  );
  mkdirSync(join(fixture.root, 'pages'), { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(fixture.root, name), source);
  }
  execFileSync('vp', ['run', 'build'], { cwd: fixture.root, stdio: 'pipe' });
  server = await startServer((port) => spawnFixtureServer(fixture.root, 'preview', port), 30_000);
  browser = await launchPagesBrowser();
}, 70_000);

afterAll(async () => {
  await browser?.close();
  if (server) {
    await killChild(server.child);
  }
  fixture?.cleanup();
});

it('hydrates a Vue page from the initial state after deferred server work changes the store', async () => {
  const page = await browser.newPage();
  const diagnostics = collectBrowserDiagnostics(page);
  let release!: () => void;
  const waitForInput = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gate = createServer(async (_request, response) => {
    await waitForInput;
    response.end();
  });
  await once(gate.listen(0, '127.0.0.1'), 'listening');
  const { port } = gate.address() as AddressInfo;
  try {
    const response = await page.goto(`${server.base}/setup-defer?gate=${port}`, {
      waitUntil: 'commit',
    });
    expect(response?.status(), server.output()).toBe(200);
    const field = page.locator('#entry');
    const original = await field.elementHandle();
    expect(await field.inputValue()).toBe('server default');
    await field.fill('typed before deferred');
    expect(await page.locator('#deferred').textContent()).toBe('pending');
    expect(await page.locator('#app').getAttribute('data-hydrated')).toBeNull();
    const snapshot = await page.locator(`#${APP_STATE_ID}`).allTextContents();
    release();

    const html = await response?.text();
    expect(snapshot).toEqual(['[{"ready":1,"notices":2},false,[3],"server notice"]']);
    expect(html).toMatch(
      /id="__VOID_APP_STATE__">[^<]+<\/script>\s*<\/body>\s*<\/html>\s*<script>.*__resolveDeferred/,
    );
    await page.waitForFunction(
      () => document.querySelector('#deferred')?.textContent === 'resolved',
    );
    expect(await page.locator('#mounted').textContent()).toBe(
      'pending|typed before deferred|typed before deferred|1',
    );
    expect(await field.inputValue()).toBe('typed before deferred');
    expect(await page.locator('#model').textContent()).toBe('typed before deferred');
    expect(await field.evaluate((input, node) => input === node, original)).toBe(true);
    expect(diagnostics()).not.toMatch(/hydration.*mismatch|pageerror:/i);
  } finally {
    release();
    await page.context().close();
    gate.close();
    gate.closeAllConnections();
    await once(gate, 'close');
  }
});

it('hydrates two islands from their props after the page and a later island write to the server store', async () => {
  const page = await browser.newPage();
  const diagnostics = collectBrowserDiagnostics(page);
  let activate!: () => void;
  const waitForInput = new Promise<void>((resolve) => {
    activate = resolve;
  });
  try {
    await page.route('**/assets/islands-client-*.js', async (route) => {
      await waitForInput;
      await route.continue();
    });
    const response = await page.goto(`${server.base}/setup-islands`, { waitUntil: 'commit' });
    expect(response?.status(), server.output()).toBe(200);
    const labels = ['first', 'second'];
    for (const label of labels) {
      const field = page.locator(`#${label}`);
      expect(await field.inputValue()).toBe('from page');
      await field.fill(`typed in ${label}`);
    }
    expect(await page.locator('[data-island][data-hydrated]').count()).toBe(0);
    activate();

    await waitForIslandsHydrated(page, 2);
    expect(await page.locator(`#${APP_STATE_ID}`).count()).toBe(0);
    for (const label of labels) {
      expect(await page.locator(`#${label}`).inputValue()).toBe(`typed in ${label}`);
      expect(await page.locator(`#${label}-model`).textContent()).toBe(`typed in ${label}`);
      expect(await page.locator(`#${label}-setup`).textContent()).toBe('from setup|0');
    }
    expect(diagnostics()).not.toMatch(/hydration.*mismatch|pageerror:/i);
  } finally {
    activate();
    await page.context().close();
  }
});
