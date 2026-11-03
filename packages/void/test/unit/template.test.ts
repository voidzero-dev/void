import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { describe, expect, it } from 'vite-plus/test';
import { SCAFFOLD_FRAMEWORKS } from '../../src/cli/template.ts';

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
