import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { packageFixturePath } from '../../../../test/fixture-dir.ts';
import { migrateLegacyVoidConfig } from '../../src/cli/migrate.ts';
import { readConfig } from '../../src/config.ts';

const root = packageFixturePath(import.meta.dirname, '.tmp-framework-config-migrate-test');

function setup(file: string, source: string): void {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'wrangler.jsonc'), '{"name":"app","compatibility_date":"2026-02-24"}');
  writeFileSync(join(root, file), source);
}

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('framework config migration', () => {
  it('wires both SvelteKit build and local proxy to the generated config', () => {
    setup(
      'vite.config.ts',
      "import adapter from '@sveltejs/adapter-cloudflare';\nexport default { adapter: adapter() };\n",
    );
    expect(migrateLegacyVoidConfig(root)).toBe(true);
    const source = readFileSync(join(root, 'vite.config.ts'), 'utf8');
    expect(source).toContain("config: './.void-wrangler.jsonc'");
    expect(source).toContain("platformProxy: { configPath: './.void-wrangler.jsonc' }");
    expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(false);
    expect(readFileSync(join(root, '.void/config-migration/vite.config.ts'), 'utf8')).toContain(
      'adapter()',
    );
  });

  it('migrates a SvelteKit adapter followed by another option', () => {
    setup(
      'vite.config.ts',
      "import adapter from '@sveltejs/adapter-cloudflare';\nexport default { plugins: [sveltekit({ adapter: adapter(), typescript: { config: withVoidTSConfig() } })] };\n",
    );
    expect(migrateLegacyVoidConfig(root)).toBe(true);
    const source = readFileSync(join(root, 'vite.config.ts'), 'utf8');
    expect(source).toContain(
      "adapter: adapter({ config: './.void-wrangler.jsonc', platformProxy: { configPath: './.void-wrangler.jsonc' } })",
    );
    expect(source).toContain('typescript: { config: withVoidTSConfig() }');
    expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(false);
  });

  it('wires a default Astro adapter and Nitro Cloudflare dev module', () => {
    setup(
      'astro.config.mjs',
      "import cloudflare from '@astrojs/cloudflare';\nexport default { adapter: cloudflare() };\n",
    );
    migrateLegacyVoidConfig(root);
    expect(readFileSync(join(root, 'astro.config.mjs'), 'utf8')).toContain(
      "configPath: './.void-wrangler.jsonc'",
    );

    setup(
      'vite.config.ts',
      "export default { nitro: { preset: 'cloudflare-module', modules: ['nitro-cloudflare-dev'] } };\n",
    );
    migrateLegacyVoidConfig(root);
    expect(readFileSync(join(root, 'vite.config.ts'), 'utf8')).toContain(
      "cloudflareDev: { configPath: './.void-wrangler.jsonc' }",
    );
  });

  it.each(['astro.config.js', 'astro.config.mts'])(
    'migrates the Astro adapter in %s before deleting the root config',
    (file) => {
      setup(
        file,
        'import cloudflare from "@astrojs/cloudflare";\nexport default { adapter: cloudflare() };\n',
      );
      expect(migrateLegacyVoidConfig(root)).toBe(true);
      expect(readFileSync(join(root, file), 'utf8')).toContain(
        "configPath: './.void-wrangler.jsonc'",
      );
      expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(false);
    },
  );

  it('migrates an Astro adapter using a custom root Wrangler JSONC file', () => {
    setup(
      'astro.config.mjs',
      'import cloudflare from "@astrojs/cloudflare";\nexport default { adapter: cloudflare({ configPath: "./wrangler.build.jsonc" }) };\n',
    );
    rmSync(join(root, 'wrangler.jsonc'));
    writeFileSync(
      join(root, 'wrangler.build.jsonc'),
      '{"name":"app","compatibility_date":"2026-02-24"}',
    );

    expect(migrateLegacyVoidConfig(root)).toBe(true);
    expect(readFileSync(join(root, 'astro.config.mjs'), 'utf8')).toContain(
      "configPath: './.void-wrangler.jsonc'",
    );
    expect(existsSync(join(root, 'wrangler.build.jsonc'))).toBe(false);
    expect(existsSync(join(root, '.void/config-migration/wrangler.build.jsonc'))).toBe(true);
    expect(readConfig(root).cloudflare).toMatchObject({
      name: 'app',
      compatibility_date: '2026-02-24',
    });
  });

  it('preserves custom SvelteKit adapter options while migrating an explicit path', () => {
    setup(
      'vite.config.ts',
      "import adapter from '@sveltejs/adapter-cloudflare';\nexport default { adapter: adapter({ fallback: 'spa', config: './wrangler.jsonc' }) };\n",
    );
    expect(migrateLegacyVoidConfig(root)).toBe(true);
    const source = readFileSync(join(root, 'vite.config.ts'), 'utf8');
    expect(source).toContain("fallback: 'spa'");
    expect(source).toContain("config: './.void-wrangler.jsonc'");
    expect(source).toContain("platformProxy: { configPath: './.void-wrangler.jsonc' }");
  });

  it('leaves unsupported dynamic adapter options and root config intact', () => {
    setup(
      'vite.config.ts',
      "import adapter from '@sveltejs/adapter-cloudflare';\nexport default { adapter: adapter({ fallback: 'spa' }) };\n",
    );
    writeFileSync(
      join(root, 'vite.config.ts'),
      "import adapter from '@sveltejs/adapter-cloudflare';\nexport default { adapter: adapter(options) };\n",
    );
    expect(() => migrateLegacyVoidConfig(root)).toThrow('Update vite.config.ts');
    expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(true);
    expect(existsSync(join(root, 'void.config.ts'))).toBe(false);
  });

  it('leaves an adapter loaded with require and the root config intact', () => {
    setup(
      'svelte.config.js',
      "const adapter = require('@sveltejs/adapter-cloudflare');\nmodule.exports = { kit: { adapter: adapter() } };\n",
    );
    expect(() => migrateLegacyVoidConfig(root)).toThrow('Update svelte.config.js');
    expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(true);
    expect(existsSync(join(root, 'void.config.ts'))).toBe(false);
  });

  it('ignores adapter and config paths mentioned only in comments', () => {
    setup(
      'vite.config.ts',
      `// import adapter from '@astrojs/cloudflare';
// configPath: './wrangler.example.jsonc'
export default { plugins: [] };`,
    );
    writeFileSync(join(root, 'wrangler.example.jsonc'), '{"name":"example"}');
    expect(migrateLegacyVoidConfig(root)).toBe(true);
    expect(readFileSync(join(root, 'vite.config.ts'), 'utf8')).toContain(
      'export default { plugins: [] };',
    );
    expect(existsSync(join(root, 'wrangler.example.jsonc'))).toBe(true);
  });

  it('updates only the Nitro Cloudflare config path', () => {
    setup(
      'vite.config.ts',
      `const unrelated = { configPath: './wrangler.jsonc' };
export default { nitro: { preset: 'cloudflare-module', modules: ['nitro-cloudflare-dev'], cloudflareDev: { configPath: './wrangler.jsonc' } } };`,
    );
    expect(migrateLegacyVoidConfig(root)).toBe(true);
    const source = readFileSync(join(root, 'vite.config.ts'), 'utf8');
    expect(source).toContain("const unrelated = { configPath: './wrangler.jsonc' }");
    expect(source).toContain("cloudflareDev: { configPath: './.void-wrangler.jsonc' }");
  });
});
