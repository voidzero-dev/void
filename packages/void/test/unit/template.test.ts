import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { describe, expect, it } from 'vite-plus/test';
import {
  createPagesStarterTemplate,
  getScaffoldTsconfigCompilerOptions,
  SCAFFOLD_FRAMEWORKS,
  SCAFFOLD_FRAMEWORK_OPTIONS,
} from '../../src/cli/template.ts';

it('offers None first and scaffolds a standalone JSX page without an adapter', () => {
  expect(SCAFFOLD_FRAMEWORK_OPTIONS[0].value).toBe('none');
  const starter = createPagesStarterTemplate({
    framework: 'none',
    starterMode: 'static',
    voidPackageSpec: '^3.0.2',
    adapterPackageSpec: '',
  });
  expect(starter.files['pages/index.server.tsx']).toContain('export default function Page');
  expect(starter.files['vite.config.ts']).toContain('plugins: [voidPlugin()]');
  expect(
    Object.keys(starter.devDependencies).some((dependency) => dependency.startsWith('@void/')),
  ).toBe(false);
  expect(getScaffoldTsconfigCompilerOptions('none')).toMatchObject({ jsxImportSource: 'void/jsx' });
});

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
