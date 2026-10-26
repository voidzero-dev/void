import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vite-plus/test';
import { islandsPlugin } from '../../src/plugin-islands.ts';

const TMP = join(import.meta.dirname, '__tmp_islands_plugin__');
const PAGES_DIR = join(TMP, 'pages');

function writeFile(relativePath: string, content: string): void {
  const full = join(PAGES_DIR, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function setupPlugin(options?: { dev?: boolean }) {
  const plugins = islandsPlugin(PAGES_DIR);
  const plugin = plugins[0] as unknown as {
    configResolved(config: {
      root: string;
      command: 'serve' | 'build';
      plugins: ReadonlyArray<unknown>;
    }): void;
    buildStart: { call(thisArg: unknown): Promise<void> | void };
    load: { handler(id: string): string | undefined };
  };

  const command = options?.dev ? 'serve' : 'build';
  const config = { root: TMP, command: command as 'serve' | 'build', plugins: [] };
  plugin.configResolved(config);

  return {
    async buildStart() {
      await plugin.buildStart.call({});
    },
    loadClientEntry(): string | undefined {
      return plugin.load.handler('\0virtual:void-islands-client');
    },
  };
}

describe('islandsPlugin — layout island import scanning', () => {
  beforeEach(() => {
    mkdirSync(PAGES_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('pre-scans island imports from island layouts into the manifest', async () => {
    writeFile(
      'blog/layout.island.tsx',
      `import Counter from "../_components/Counter" with { island: "load" }
export default function Layout(props) { return <div><Counter />{props.children}</div>; }`,
    );
    writeFile(
      'blog/index.island.tsx',
      `export default function Blog() { return <div>Blog</div>; }`,
    );
    writeFile(
      '_components/Counter.tsx',
      `export default function Counter() { return <button>0</button>; }`,
    );

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toBeDefined();
    expect(clientEntry).toContain('pages/_components/Counter');
  });

  it('pre-scans island imports from island pages into the manifest', async () => {
    writeFile(
      'index.island.tsx',
      `import Toggle from "./Toggle" with { island: "idle" }
export default function Home() { return <Toggle />; }`,
    );
    writeFile('Toggle.tsx', `export default function Toggle() { return <button>off</button>; }`);

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toBeDefined();
    expect(clientEntry).toContain('pages/Toggle');
  });

  it('pre-scans island imports from named island layouts into the manifest', async () => {
    writeFile(
      '_layouts/sidebar.island.tsx',
      `import Clock from "../_components/Clock" with { island: "load" }
export default function Sidebar(props) { return <div><Clock />{props.children}</div>; }`,
    );
    writeFile(
      '_components/Clock.tsx',
      `export default function Clock() { return <span>12:00</span>; }`,
    );
    writeFile(
      'index.island.tsx',
      `export const layout = "sidebar"
export default function Home() { return <div>Home</div>; }`,
    );

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toBeDefined();
    expect(clientEntry).toContain('pages/_components/Clock');
  });

  it('skips non-island layouts during pre-scan', async () => {
    writeFile(
      'layout.tsx',
      `import Sidebar from "./Sidebar" with { island: "load" }
export default function Layout(props) { return <div>{props.children}</div>; }`,
    );
    writeFile('index.island.tsx', `export default function Home() { return <div>Home</div>; }`);
    writeFile('Sidebar.tsx', `export default function Sidebar() { return <aside />; }`);

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).not.toContain('Sidebar');
  });
});

describe('islandsPlugin — environment suffixes', () => {
  beforeEach(() => {
    mkdirSync(PAGES_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('registers no .dev island page in a build', async () => {
    writeFile(
      'x.dev.island.tsx',
      `import Toggle from "./Toggle" with { island: "load" }
export default function X() { return <Toggle />; }`,
    );
    writeFile('Toggle.tsx', `export default function Toggle() { return <button>Toggle</button>; }`);

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();

    expect(loadClientEntry()).not.toContain('pages/Toggle');
  });

  it('registers the .prod island page of a .dev + .prod pair in a build', async () => {
    writeFile(
      'x.dev.island.tsx',
      `import Toggle from "./Toggle" with { island: "load" }
export default function X() { return <Toggle />; }`,
    );
    writeFile(
      'x.prod.island.tsx',
      `import Counter from "./Counter" with { island: "load" }
export default function X() { return <Counter />; }`,
    );
    writeFile('Toggle.tsx', `export default function Toggle() { return <button>Toggle</button>; }`);
    writeFile(
      'Counter.tsx',
      `export default function Counter() { return <button>Counter</button>; }`,
    );

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toContain('pages/Counter');
    expect(clientEntry).not.toContain('pages/Toggle');
  });

  it('registers the .dev island page of a .dev + .prod pair in dev', async () => {
    writeFile(
      'x.dev.island.tsx',
      `import Toggle from "./Toggle" with { island: "load" }
export default function X() { return <Toggle />; }`,
    );
    writeFile(
      'x.prod.island.tsx',
      `import Counter from "./Counter" with { island: "load" }
export default function X() { return <Counter />; }`,
    );
    writeFile('Toggle.tsx', `export default function Toggle() { return <button>Toggle</button>; }`);
    writeFile(
      'Counter.tsx',
      `export default function Counter() { return <button>Counter</button>; }`,
    );

    const { buildStart, loadClientEntry } = setupPlugin({ dev: true });
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toContain('pages/Toggle');
    expect(clientEntry).not.toContain('pages/Counter');
  });
});
