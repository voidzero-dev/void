import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { describe, expect, it } from 'vite-plus/test';
import { createPagesStarterTemplate, SCAFFOLD_FRAMEWORKS } from '../../src/cli/template.ts';

describe.each(['react', 'vue', 'svelte', 'solid'] as const)('%s starter toolchain', (framework) => {
  it.each(['vite-plus', 'vite'] as const)('configures linting for %s', (toolchain) => {
    const template = createPagesStarterTemplate({
      framework,
      starterMode: 'static',
      toolchain,
      voidPackageSpec: '^1.11.0',
      adapterPackageSpec: '^1.11.0',
    });
    const config = template.files['vite.config.ts'];
    expect(config).toContain(`from "${toolchain}"`);
    expect(config).toContain(`from "${SCAFFOLD_FRAMEWORKS[framework].adapterPlugin}"`);
    if (toolchain === 'vite-plus') {
      expect(template.devDependencies['@cloudflare/oxlint-config']).toBe('^0.2.0');
      expect(config).toContain('from "@cloudflare/oxlint-config/vite-plus"');
      expect(config).toContain('extends: [cloudflare]');
      expect(config).toContain('env: cloudflare.env');
      expect(config).toContain('...cloudflare.ignorePatterns');
      expect(config).toContain('"**/.void/**"');
    } else {
      expect(template.devDependencies['@cloudflare/oxlint-config']).toBeUndefined();
      expect(config).not.toContain('lint:');
      expect(config).not.toContain('@cloudflare/oxlint-config');
    }
  });
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
    const pluginReact = JSON.parse(readFileSync(pluginReactManifest!, 'utf8'));

    expect(SCAFFOLD_FRAMEWORKS.react.devDependencies?.['oxc-transform-react']).toBe(
      pluginReact.peerDependencies['oxc-transform-react'],
    );
  });
});
