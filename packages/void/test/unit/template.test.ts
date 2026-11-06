import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { describe, expect, it } from 'vite-plus/test';
import { createPagesStarterTemplate, SCAFFOLD_FRAMEWORKS } from '../../src/cli/template.ts';

describe('React starter', () => {
  // The starter copies this range from the optional peer of the @vitejs/plugin-react that
  // @void/react installs, so a catalog bump that moves the peer must update the starter too.
  it("pins oxc-transform-react to @vitejs/plugin-react's peer range", () => {
    const pluginReactManifest = findPackageJSON(
      '@vitejs/plugin-react',
      new URL('../../../react/package.json', import.meta.url),
    );
    expect(pluginReactManifest).toBeDefined();
    const pluginReact = JSON.parse(readFileSync(pluginReactManifest!, 'utf-8'));

    expect(SCAFFOLD_FRAMEWORKS.react.devDependencies?.['oxc-transform-react']).toBe(
      pluginReact.peerDependencies['oxc-transform-react'],
    );
  });
});

describe('Hono starter', () => {
  function createStarter(starterMode: 'sqlite' | 'static') {
    return createPagesStarterTemplate({
      framework: 'hono',
      starterMode,
      voidPackageSpec: '^1.0.0',
      adapterPackageSpec: '^1.0.0',
    });
  }

  it('installs the adapter and a Hono version it supports', () => {
    const starter = createStarter('static');

    expect(starter.devDependencies['@void/hono']).toBe('^1.0.0');
    expect(starter.dependencies.hono).toBe(SCAFFOLD_FRAMEWORKS.hono.dependencies.hono);
    expect(SCAFFOLD_FRAMEWORKS.hono.tsconfigCompilerOptions).toEqual({
      jsx: 'react-jsx',
      jsxImportSource: 'hono/jsx',
    });
  });

  it('scaffolds a TSX page that registers the adapter plugin', () => {
    const starter = createStarter('static');

    expect(starter.files['vite.config.ts']).toContain(
      'import { voidHono } from "@void/hono/plugin";',
    );
    expect(starter.files['vite.config.ts']).toContain('plugins: [voidPlugin(), voidHono()]');
    expect(starter.files['public/hono.svg']).toContain('<svg');
    expect(starter.files['pages/index.tsx']).toContain('<main class="starter">');
    expect(starter.files['pages/index.tsx']).not.toContain('useForm');
  });

  it('renders the messages demo with Hono JSX', () => {
    const page = createStarter('sqlite').files['pages/index.tsx'];

    expect(page).toContain('import { Form, useForm } from "@void/hono";');
    expect(page).toContain('export default function HomePage(props: Props) {');
    expect(page).toContain('{props.messages.map((message) => (');
    expect(page).toContain('<Form form={form} class="message-form">');
  });
});
