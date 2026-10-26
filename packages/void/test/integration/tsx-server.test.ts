import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  killChild,
  startServer,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';

const repository = join(import.meta.dirname, '../../../..');
const httpExtensions = ['tsx', 'jsx'];
const companionPages = [
  { name: 'foo', extension: 'tsx' },
  { name: 'bar', extension: 'jsx' },
];
// Environment-only pages as [file, text]; each has a server-rendered companion with an action.
const environmentPages = [
  ['debug.dev', 'DEV_ONLY_PAGE'],
  ['greeting.dev', 'Development page'],
  ['greeting.prod', 'Production page'],
];

describe.each(['react', 'hono/jsx'])('server JSX with %s', (jsxImportSource) => {
  let playground: IsolatedPlayground;
  const servers: Array<ReturnType<typeof spawn>> = [];
  const bases: Record<string, string> = {};
  let devTypes: string;

  beforeAll(async () => {
    playground = createIsolatedPlayground(repository, 'playground/node-app');
    const root = playground.root;
    rmSync(join(root, 'routes'), { recursive: true });
    rmSync(join(root, 'pages'), { recursive: true });
    mkdirSync(join(root, 'routes'));
    const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
    tsconfig.compilerOptions.jsxImportSource = jsxImportSource;
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify(tsconfig));
    writeFileSync(
      join(root, 'vite.config.ts'),
      `import { writeFileSync } from 'node:fs';
import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';
${jsxImportSource === 'react' ? "import { voidReact } from '@void/react/plugin';" : ''}
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: ${JSON.stringify(jsxImportSource)} } },
  plugins: [voidPlugin(), ${jsxImportSource === 'react' ? 'voidReact(),' : ''} {
    name: 'record-built-module-graphs',
    generateBundle() {
      writeFileSync('.void/jsx-' + this.environment.name + '.json', JSON.stringify([...this.getModuleIds()]));
    },
  }],
});`,
    );
    const handler = (text: string) => `import { defineHandler } from 'void';
${jsxImportSource === 'react' ? "import { renderToStaticMarkup } from 'react-dom/server';" : ''}
export const GET = defineHandler(c => c.html(${jsxImportSource === 'react' ? `renderToStaticMarkup(<h1>${text}</h1>)` : `<h1>${text}</h1>`}));`;
    for (const ext of httpExtensions) {
      mkdirSync(join(root, 'routes', ext));
      for (const [file, text] of [
        [`jsx.${ext}`, 'JSX handler'],
        [`environment.dev.${ext}`, 'Development JSX handler'],
        [`environment.prod.${ext}`, 'Production JSX handler'],
        [`debug.dev.${ext}`, 'DEV_ONLY_JSX_HANDLER'],
      ]) {
        writeFileSync(join(root, 'routes', ext, file), handler(text));
      }
    }
    if (jsxImportSource === 'react') {
      mkdirSync(join(root, 'pages'));
      for (const { name, extension } of companionPages) {
        writeFileSync(
          join(root, `pages/${name}.${extension}`),
          'export default function Foo({ html }) { return <article dangerouslySetInnerHTML={{ __html: html }} />; }',
        );
        writeFileSync(
          join(root, `pages/${name}.server.${extension}`),
          `import { basename } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { defineHandler } from 'void';
export const ssr = true;
export const prerender = false;
export const loader = defineHandler(() => ({ html: renderToStaticMarkup(<p>{basename('/private/${name}_COMPANION_SERVER_ONLY')}</p>) }));
export const actions = { save: defineHandler(c => c.html(renderToStaticMarkup(<strong>${name}_COMPANION_ACTION_ONLY</strong>))) };`,
        );
      }
      for (const [file, text] of environmentPages) {
        writeFileSync(
          join(root, `pages/${file}.tsx`),
          'export default function Page({ text }) { return <h1>{text}</h1>; }',
        );
        writeFileSync(
          join(root, `pages/${file}.server.tsx`),
          `import { defineHandler } from 'void';
export const ssr = true;
export const prerender = false;
export const loader = defineHandler(() => ({ text: ${JSON.stringify(text)} }));
export const action = defineHandler(c => c.text(${JSON.stringify(text)}));`,
        );
      }
    }

    const dev = await startServer(
      (port) =>
        spawn('vp', ['dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      20_000,
    );
    servers.push(dev.child);
    bases.dev = dev.base;
    devTypes = readFileSync(join(root, '.void/routes.d.ts'), 'utf8');

    const build = spawn.sync('vp', ['build'], {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'production' },
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(build.status, `${build.stdout ?? ''}${build.stderr ?? ''}`).toBe(0);
    const prod = await startServer(
      (port) =>
        spawn(process.execPath, ['dist/ssr/index.js'], {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, NODE_ENV: 'production', PORT: String(port) },
        }),
      20_000,
    );
    servers.push(prod.child);
    bases.prod = prod.base;
  });

  afterAll(async () => {
    await Promise.all(servers.map((child) => killChild(child)));
    playground?.cleanup();
  });

  it.each(httpExtensions.flatMap((ext) => ['dev', 'prod'].map((env) => ({ ext, env }))))(
    'executes .$ext HTTP handlers and selects environment routes in $env',
    async ({ ext, env }) => {
      const response = await fetch(`${bases[env]}/${ext}/jsx`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(await response.text()).toBe('<h1>JSX handler</h1>');
      const selected = await fetch(`${bases[env]}/${ext}/environment`);
      expect(selected.status).toBe(200);
      expect(await selected.text()).toBe(
        `<h1>${env === 'dev' ? 'Development' : 'Production'} JSX handler</h1>`,
      );
      expect((await fetch(`${bases[env]}/${ext}/debug`)).status).toBe(env === 'dev' ? 200 : 404);
    },
  );

  it('generates environment-specific JSX HTTP types and excludes dev routes from the production graph', () => {
    const prodTypes = readFileSync(join(playground.root, '.void/routes.d.ts'), 'utf8');
    for (const [env, types] of [
      ['dev', devTypes],
      ['prod', prodTypes],
    ]) {
      for (const ext of httpExtensions) {
        expect(types).toContain(`"/${ext}/jsx": {`);
        expect(types).toContain(`typeof import("../routes/${ext}/environment.${env}.${ext}")`);
        expect(types).not.toContain(`environment.${env === 'dev' ? 'prod' : 'dev'}.${ext}`);
      }
    }
    const serverGraph = readFileSync(join(playground.root, '.void/jsx-ssr.json'), 'utf8');
    for (const ext of httpExtensions) {
      expect(serverGraph).toContain(`/routes/${ext}/jsx.${ext}`);
      expect(serverGraph).toContain(`/routes/${ext}/environment.prod.${ext}`);
      expect(serverGraph).not.toContain(`/routes/${ext}/environment.dev.${ext}`);
      expect(serverGraph).not.toContain(`/routes/${ext}/debug.dev.${ext}`);
    }
    expect(serverGraph).toContain(`${jsxImportSource}/jsx-runtime`);
  });

  if (jsxImportSource === 'react') {
    it.each(['dev', 'prod'])('serves only the pages for %s', async (env) => {
      const debug = await fetch(`${bases[env]}/debug`);
      expect(debug.status).toBe(env === 'dev' ? 200 : 404);
      if (env === 'dev') {
        expect(await debug.text()).toContain('DEV_ONLY_PAGE');
      }
      const greeting = await fetch(`${bases[env]}/greeting`);
      expect(greeting.status).toBe(200);
      expect(await greeting.text()).toContain(
        `<h1>${env === 'dev' ? 'Development' : 'Production'} page</h1>`,
      );
    });

    it('leaves .dev pages out of the production types and bundles', () => {
      const prodTypes = readFileSync(join(playground.root, '.void/routes.d.ts'), 'utf8');
      expect(devTypes).toContain('pages/greeting.dev.server.tsx');
      expect(devTypes).not.toContain('greeting.prod');
      expect(prodTypes).toContain('pages/greeting.prod.server.tsx');
      expect(prodTypes).not.toContain('greeting.dev');
      expect(prodTypes).not.toContain('debug.dev');
      for (const graph of readdirSync(join(playground.root, '.void')).filter(
        (file) => file.startsWith('jsx-') && file.endsWith('.json'),
      )) {
        const modules = readFileSync(join(playground.root, '.void', graph), 'utf8');
        expect(modules, graph).not.toContain('debug.dev');
        expect(modules, graph).not.toContain('greeting.dev');
      }
      const client = readFileSync(join(playground.root, '.void/jsx-client.json'), 'utf8');
      expect(client).toContain('pages/greeting.prod.tsx');
    });

    it.each(companionPages.flatMap((page) => ['dev', 'prod'].map((env) => ({ ...page, env }))))(
      'executes .server.$extension companion loaders and actions in $env',
      async ({ name, env }) => {
        const response = await fetch(`${bases[env]}/${name}`);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain(
          `<article><p>${name}_COMPANION_SERVER_ONLY</p></article>`,
        );
        const action = await fetch(`${bases[env]}/${name}?save`, { method: 'POST' });
        expect(action.status).toBe(200);
        expect(await action.text()).toBe(`<strong>${name}_COMPANION_ACTION_ONLY</strong>`);
        expect((await fetch(`${bases[env]}/${name}.server`)).status).toBe(404);
      },
    );

    it('includes the companion on the server and excludes it from the client graph and assets', () => {
      const root = playground.root;
      const serverGraph = readFileSync(join(root, '.void/jsx-ssr.json'), 'utf8');
      const clientGraph = readFileSync(join(root, '.void/jsx-client.json'), 'utf8');
      for (const { name, extension } of companionPages) {
        expect(serverGraph).toContain(`/pages/${name}.server.${extension}`);
        expect(clientGraph).toContain(`/pages/${name}.${extension}`);
        expect(clientGraph).not.toContain(`.server.${extension}`);
      }
      expect(clientGraph).not.toContain('/routes/');
      const files = readdirSync(join(root, 'dist/client'), { recursive: true }) as Array<string>;
      const clientCode = files
        .filter((file) => file.endsWith('.js') || file.endsWith('.json'))
        .map((file) => readFileSync(join(root, 'dist/client', file), 'utf8'))
        .join('\n');
      expect(clientCode).not.toContain('COMPANION_SERVER_ONLY');
      expect(clientCode).not.toContain('COMPANION_ACTION_ONLY');
      expect(clientCode).not.toContain('DEV_ONLY_JSX_HANDLER');
      const types = readFileSync(join(root, '.void/routes.d.ts'), 'utf8');
      for (const { name, extension } of companionPages) {
        expect(clientCode).not.toContain(`${name}.server`);
        expect(types).toContain(`typeof import("../pages/${name}.server.${extension}")`);
        expect(types).not.toContain(`"/${name}.server"`);
      }
    });
  }
});
