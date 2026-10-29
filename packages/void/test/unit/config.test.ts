import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('../../src/log', () => ({
  voidLog: vi.fn(),
  voidWarn: vi.fn(),
  voidError: vi.fn(),
}));

import {
  readConfig,
  convertHeadersConfig,
  convertFallbacksConfig,
  convertRedirectsConfig,
  convertRewritesConfig,
  resolveBindingNames,
  isNodeTarget,
  databaseConfigValue,
  getDatabaseCasing,
  getDatabaseDialect,
  VALID_REDIRECT_STATUSES,
  countSplats,
} from '../../src/config.ts';
import { voidWarn } from '../../src/log.ts';
import { resolveSandboxConfig } from '../../src/sandbox/config.ts';

const warnMock = vi.mocked(voidWarn);

const tmpDir = join(import.meta.dirname, '.tmp-config-test');

function setup(content?: string) {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  if (content !== undefined) {
    writeFileSync(join(tmpDir, 'void.json'), content);
  }
}

function cleanup() {
  rmSync(tmpDir, { recursive: true, force: true });
}

describe('routing.alwaysUseHttps', () => {
  it.each([true, false, undefined])('preserves %s without applying a default', (alwaysUseHttps) => {
    setup(JSON.stringify({ routing: { alwaysUseHttps } }));
    try {
      expect(readConfig(tmpDir).routing?.alwaysUseHttps).toBe(alwaysUseHttps);
    } finally {
      cleanup();
    }
  });
  it.each(['true', 1, null, {}])('rejects non-boolean %s', (alwaysUseHttps) => {
    setup(JSON.stringify({ routing: { alwaysUseHttps } }));
    try {
      expect(() => readConfig(tmpDir)).toThrow('routing.alwaysUseHttps');
    } finally {
      cleanup();
    }
  });
  it.each(['node', 'bun', 'deno'])('rejects true with target %s', (target) => {
    setup(JSON.stringify({ target, routing: { alwaysUseHttps: true } }));
    try {
      expect(() => readConfig(tmpDir)).toThrow(
        `"routing.alwaysUseHttps" in void.json requires target: "cloudflare". It is not available with target: "${target}".`,
      );
    } finally {
      cleanup();
    }
  });
  it.each([
    { target: 'node', routing: { alwaysUseHttps: false } },
    { target: 'cloudflare', routing: { alwaysUseHttps: true } },
  ])('accepts %j', (config) => {
    setup(JSON.stringify(config));
    try {
      expect(readConfig(tmpDir).routing?.alwaysUseHttps).toBe(config.routing.alwaysUseHttps);
    } finally {
      cleanup();
    }
  });
});

describe('readConfig', () => {
  it('loads and re-reads a typed Void config', () => {
    setup();
    const path = join(tmpDir, 'void.config.ts');
    writeFileSync(
      path,
      `import { defineConfig } from 'void/config';\nexport default defineConfig({ worker: { compatibility_date: '2026-02-24' } } satisfies import('void/config').VoidConfig);\n`,
    );
    expect(readConfig(tmpDir).worker?.compatibility_date).toBe('2026-02-24');
    writeFileSync(path, `export default { worker: { compatibility_date: '2026-02-25' } };\n`);
    expect(readConfig(tmpDir).worker?.compatibility_date).toBe('2026-02-25');
    cleanup();
  });

  it('rejects ambiguous typed and JSON config files', () => {
    setup('{}');
    writeFileSync(join(tmpDir, 'void.config.ts'), 'export default {};\n');
    expect(() => readConfig(tmpDir)).toThrow('Found both void.config.ts and void.json');
    cleanup();
  });

  it('validates typed config values at runtime', () => {
    setup();
    writeFileSync(join(tmpDir, 'void.config.ts'), 'export default { routing: { isr: 1 } };\n');
    expect(() => readConfig(tmpDir)).toThrow('"routing.isr" in void.config.ts must be a boolean');
    cleanup();
  });

  it('accepts an explicit Cloudflare deploy mode', () => {
    setup(JSON.stringify({ deploy: { cloudflare: { mode: 'atomic' } } }));
    expect(readConfig(tmpDir).deploy?.cloudflare?.mode).toBe('atomic');
    cleanup();
  });

  it('reads the deploy mode from void.config.ts', () => {
    setup();
    writeFileSync(
      join(tmpDir, 'void.config.ts'),
      "export default { deploy: { cloudflare: { mode: 'atomic' } } };\n",
    );
    expect(readConfig(tmpDir).deploy?.cloudflare?.mode).toBe('atomic');
    cleanup();
  });

  it.each(['auto', true, null])('rejects invalid Cloudflare deploy mode: %j', (mode) => {
    setup(JSON.stringify({ deploy: { cloudflare: { mode } } }));
    expect(() => readConfig(tmpDir)).toThrow('"deploy.cloudflare.mode" in void.json');
    cleanup();
  });

  it.each([true, false])('accepts routing.isr: %s', (isr) => {
    setup(JSON.stringify({ routing: { isr } }));
    expect(readConfig(tmpDir).routing?.isr).toBe(isr);
    cleanup();
  });
  it.each([0, 'false', null, {}])('rejects invalid routing.isr: %j', (isr) => {
    setup(JSON.stringify({ routing: { isr } }));
    expect(() => readConfig(tmpDir)).toThrow('"routing.isr" in void.json must be a boolean');
    cleanup();
  });
  it('returns empty config when no file exists', () => {
    setup();
    const config = readConfig(tmpDir);
    expect(config).toEqual({});
    cleanup();
  });

  it('reads a valid config with all fields', () => {
    setup(
      JSON.stringify({
        inference: {
          bindings: { db: true, kv: false },
          appType: 'spa',
          outputDir: 'dist',
        },
        routing: {
          headers: {
            '/assets/*': ['Cache-Control: public, max-age=31536000, immutable'],
            '/*': ['X-Frame-Options: DENY'],
          },
        },
        worker: {
          compatibility_date: '2025-12-01',
          compatibility_flags: ['nodejs_compat'],
          vars: { PUBLIC_VALUE: 'hello' },
        },
        sandbox: {
          binding: 'CODE',
          image: './Dockerfile.sandbox',
          instanceType: 'lite',
        },
      }),
    );
    const config = readConfig(tmpDir);
    expect(config.inference?.bindings).toEqual({ db: true, kv: false });
    expect(config.routing?.headers).toEqual({
      '/assets/*': ['Cache-Control: public, max-age=31536000, immutable'],
      '/*': ['X-Frame-Options: DENY'],
    });
    expect(config.inference?.appType).toBe('spa');
    expect(config.inference?.outputDir).toBe('dist');
    expect(config.worker).toEqual({
      compatibility_date: '2025-12-01',
      compatibility_flags: ['nodejs_compat'],
      vars: { PUBLIC_VALUE: 'hello' },
    });
    expect(config.sandbox).toEqual({
      binding: 'CODE',
      image: './Dockerfile.sandbox',
      instanceType: 'lite',
    });
    cleanup();
  });

  it('throws on non-string worker vars', () => {
    setup(JSON.stringify({ worker: { vars: { PORT: 3000 } } }));
    expect(() => readConfig(tmpDir)).toThrow('"worker.vars.PORT"');
    cleanup();
  });

  it('accepts empty object', () => {
    setup('{}');
    const config = readConfig(tmpDir);
    expect(config).toEqual({});
    cleanup();
  });

  it('accepts top-level auth providers', () => {
    setup(JSON.stringify({ auth: { providers: ['email', 'github', 'discord'] } }));
    const config = readConfig(tmpDir);
    expect(config.auth?.providers).toEqual(['email', 'github', 'discord']);
    cleanup();
  });

  it('accepts an empty top-level auth object', () => {
    setup(JSON.stringify({ auth: {} }));
    const config = readConfig(tmpDir);
    expect(config.auth).toEqual({});
    cleanup();
  });

  it('ignores $schema field', () => {
    setup(JSON.stringify({ $schema: 'https://unpkg.com/void/schema.json' }));
    const config = readConfig(tmpDir);
    expect(config).toEqual({});
    cleanup();
  });

  it('throws on invalid JSON', () => {
    setup('{not json}');
    expect(() => readConfig(tmpDir)).toThrow('Invalid JSON');
    cleanup();
  });

  it('throws if root is not an object', () => {
    setup('"hello"');
    expect(() => readConfig(tmpDir)).toThrow('must be a JSON object');
    cleanup();
  });

  it('rejects inference.auth arrays', () => {
    setup(JSON.stringify({ inference: { auth: ['github', 'twitter'] } }));
    expect(() => readConfig(tmpDir)).toThrow(
      '"inference.auth" in void.json is no longer supported',
    );
    cleanup();
  });

  it('rejects unknown top-level auth providers', () => {
    setup(JSON.stringify({ auth: { providers: ['email', 'patreon'] } }));
    expect(() => readConfig(tmpDir)).toThrow('"auth.providers" value \'patreon\'');
    cleanup();
  });

  it('rejects duplicate top-level auth providers', () => {
    setup(JSON.stringify({ auth: { providers: ['github', 'github'] } }));
    expect(() => readConfig(tmpDir)).toThrow(
      '"auth.providers" in void.json must not contain duplicates',
    );
    cleanup();
  });

  it('throws on invalid bindings type', () => {
    setup(JSON.stringify({ inference: { bindings: 'db' } }));
    expect(() => readConfig(tmpDir)).toThrow('"inference.bindings"');
    cleanup();
  });

  it('throws on unknown binding key', () => {
    setup(JSON.stringify({ inference: { bindings: { db: true, queue: true } } }));
    expect(() => readConfig(tmpDir)).toThrow("Unknown binding 'queue'");
    cleanup();
  });

  it('accepts string binding names for db/kv/storage/ai', () => {
    setup(
      JSON.stringify({
        inference: {
          bindings: { db: 'MY_DB', kv: 'MY_KV', storage: 'MY_R2', ai: 'MY_AI' },
        },
      }),
    );
    const config = readConfig(tmpDir);
    expect(config.inference?.bindings?.db).toBe('MY_DB');
    expect(config.inference?.bindings?.kv).toBe('MY_KV');
    expect(config.inference?.bindings?.storage).toBe('MY_R2');
    expect(config.inference?.bindings?.ai).toBe('MY_AI');
    cleanup();
  });

  it('throws on invalid ai binding value', () => {
    setup(JSON.stringify({ inference: { bindings: { ai: 42 } } }));
    expect(() => readConfig(tmpDir)).toThrow('must be a boolean or a string');
    cleanup();
  });

  it('accepts sandbox boolean and object config', () => {
    setup(JSON.stringify({ sandbox: true }));
    expect(readConfig(tmpDir).sandbox).toBe(true);
    cleanup();

    setup(
      JSON.stringify({
        sandbox: {
          binding: 'CODE',
          className: 'CodeSandbox',
          containerName: 'code-sandbox',
          image: './Dockerfile.sandbox',
          imageBuildContext: '.',
          platformImage:
            'registry.cloudflare.com/account/code-sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          instanceType: 'standard-1',
        },
      }),
    );
    expect(readConfig(tmpDir).sandbox).toEqual({
      binding: 'CODE',
      className: 'CodeSandbox',
      containerName: 'code-sandbox',
      image: './Dockerfile.sandbox',
      imageBuildContext: '.',
      platformImage:
        'registry.cloudflare.com/account/code-sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      instanceType: 'standard-1',
    });
    cleanup();
  });

  it('preserves registry sandbox images when resolving config', () => {
    const config = resolveSandboxConfig(
      {
        sandbox: {
          image:
            'registry.cloudflare.com/account/code-sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      },
      tmpDir,
    );

    expect(config.image).toBe(
      'registry.cloudflare.com/account/code-sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(config.platformImage).toBe(
      'registry.cloudflare.com/account/code-sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
  });

  it('rejects external registries and mutable tags for Sandbox scheduling', () => {
    expect(() =>
      resolveSandboxConfig({ sandbox: { image: 'docker.io/cloudflare/sandbox:1.0.0' } }, tmpDir),
    ).toThrow('digest-pinned');
    expect(() =>
      resolveSandboxConfig(
        { sandbox: { platformImage: 'registry.cloudflare.com/account/sandbox:latest' } },
        tmpDir,
      ),
    ).toThrow('digest-pinned');
  });

  it('uses a packaged native Dockerfile and the managed Node image by default', () => {
    const config = resolveSandboxConfig({ sandbox: true }, tmpDir);

    expect(config.image).toMatch(/sandbox\.Dockerfile$/);
    expect(config.platformImage).toBe('cloudflare/debian-trixie');
  });

  it('throws on invalid sandbox config', () => {
    setup(JSON.stringify({ sandbox: { instanceType: 'huge' } }));
    expect(() => readConfig(tmpDir)).toThrow('"sandbox.instanceType"');
    cleanup();

    setup(JSON.stringify({ sandbox: { maxInstances: 0 } }));
    expect(() => readConfig(tmpDir)).toThrow('sandbox.maxInstances');
    cleanup();
  });

  it('throws on invalid appType', () => {
    setup(JSON.stringify({ inference: { appType: 'serverless' } }));
    expect(() => readConfig(tmpDir)).toThrow('must be one of: spa, static, void');
    cleanup();
  });

  it('throws on non-string outputDir', () => {
    setup(JSON.stringify({ inference: { outputDir: 42 } }));
    expect(() => readConfig(tmpDir)).toThrow('must be a string');
    cleanup();
  });

  it('throws on header pattern not starting with /', () => {
    setup(
      JSON.stringify({
        routing: { headers: { 'assets/*': ['Cache-Control: no-cache'] } },
      }),
    );
    expect(() => readConfig(tmpDir)).toThrow('must start with "/"');
    cleanup();
  });

  it('throws on non-array header values', () => {
    setup(JSON.stringify({ routing: { headers: { '/*': 'X-Frame-Options: DENY' } } }));
    expect(() => readConfig(tmpDir)).toThrow('must be an array of strings');
    cleanup();
  });

  it('throws on invalid worker type', () => {
    setup(JSON.stringify({ worker: 'yes' }));
    expect(() => readConfig(tmpDir)).toThrow('"worker"');
    cleanup();
  });

  it('throws on invalid compatibility_date format', () => {
    setup(JSON.stringify({ worker: { compatibility_date: 'not-a-date' } }));
    expect(() => readConfig(tmpDir)).toThrow('YYYY-MM-DD format');
    cleanup();
  });

  it('accepts valid worker.limits.cpu_ms', () => {
    setup(JSON.stringify({ worker: { limits: { cpu_ms: 50 } } }));
    const config = readConfig(tmpDir);
    expect(config.worker?.limits).toEqual({ cpu_ms: 50 });
    cleanup();
  });

  it('accepts worker.limits.cpu_ms boundary values (1 and 300000)', () => {
    setup(JSON.stringify({ worker: { limits: { cpu_ms: 1 } } }));
    expect(readConfig(tmpDir).worker?.limits?.cpu_ms).toBe(1);
    setup(JSON.stringify({ worker: { limits: { cpu_ms: 300000 } } }));
    expect(readConfig(tmpDir).worker?.limits?.cpu_ms).toBe(300000);
    cleanup();
  });

  it('throws on non-object worker.limits', () => {
    setup(JSON.stringify({ worker: { limits: 50 } }));
    expect(() => readConfig(tmpDir)).toThrow('"worker.limits" in void.json must be an object');
    cleanup();
  });

  it('throws on unknown key inside worker.limits', () => {
    setup(JSON.stringify({ worker: { limits: { cpuMs: 50 } } }));
    expect(() => readConfig(tmpDir)).toThrow("Unknown key 'worker.limits.cpuMs'");
    cleanup();
  });

  it.each([0, -5, 50.5, 300001])('throws on invalid worker.limits.cpu_ms: %s', (cpuMs) => {
    setup(JSON.stringify({ worker: { limits: { cpu_ms: cpuMs } } }));
    expect(() => readConfig(tmpDir)).toThrow('"worker.limits.cpu_ms"');
    cleanup();
  });

  it('accepts routing.revalidate as a number', () => {
    setup(JSON.stringify({ routing: { revalidate: 60 } }));
    const config = readConfig(tmpDir);
    expect(config.routing?.revalidate).toBe(60);
    cleanup();
  });

  it('accepts routing.revalidate as zero', () => {
    setup(JSON.stringify({ routing: { revalidate: 0 } }));
    const config = readConfig(tmpDir);
    expect(config.routing?.revalidate).toBe(0);
    cleanup();
  });

  it('accepts routing.revalidate as a path map', () => {
    setup(
      JSON.stringify({
        routing: { revalidate: { '/': 60, '/docs/*': 31536000, '*': 30 } },
      }),
    );
    const config = readConfig(tmpDir);
    expect(config.routing?.revalidate).toEqual({ '/': 60, '/docs/*': 31536000, '*': 30 });
    cleanup();
  });

  it('throws on negative routing.revalidate number', () => {
    setup(JSON.stringify({ routing: { revalidate: -1 } }));
    expect(() => readConfig(tmpDir)).toThrow('"routing.revalidate"');
    cleanup();
  });

  it('throws on string routing.revalidate', () => {
    setup(JSON.stringify({ routing: { revalidate: '60' } }));
    expect(() => readConfig(tmpDir)).toThrow('"routing.revalidate"');
    cleanup();
  });

  it('throws on non-numeric routing.revalidate path map value', () => {
    setup(JSON.stringify({ routing: { revalidate: { '/': '60' } } }));
    expect(() => readConfig(tmpDir)).toThrow('"routing.revalidate"');
    cleanup();
  });

  it('throws on negative routing.revalidate path map value', () => {
    setup(JSON.stringify({ routing: { revalidate: { '/': -10 } } }));
    expect(() => readConfig(tmpDir)).toThrow('"routing.revalidate"');
    cleanup();
  });

  it('throws on routing.revalidate path map key not starting with / or *', () => {
    setup(JSON.stringify({ routing: { revalidate: { docs: 60 } } }));
    expect(() => readConfig(tmpDir)).toThrow('"routing.revalidate"');
    cleanup();
  });

  // `routing.notFound` is written straight into `assets.not_found_handling`, so a typo
  // must fail here instead of when Cloudflare rejects the deployed config.
  it.each(['404-page', 'single-page-application', 'none'])(
    'accepts routing.notFound: %j',
    (notFound) => {
      setup(JSON.stringify({ routing: { notFound } }));
      expect(readConfig(tmpDir).routing?.notFound).toBe(notFound);
      cleanup();
    },
  );

  it('leaves routing.notFound undefined when omitted', () => {
    setup(JSON.stringify({ routing: { revalidate: 60 } }));
    expect(readConfig(tmpDir).routing?.notFound).toBeUndefined();
    cleanup();
  });

  it('throws on an unknown routing.notFound value', () => {
    setup(JSON.stringify({ routing: { notFound: '404' } }));
    expect(() => readConfig(tmpDir)).toThrow('"routing.notFound"');
    cleanup();
  });

  it('throws on a non-string routing.notFound', () => {
    setup(JSON.stringify({ routing: { notFound: true } }));
    expect(() => readConfig(tmpDir)).toThrow('"routing.notFound"');
    cleanup();
  });

  it('throws on invalid routing type', () => {
    setup(JSON.stringify({ routing: 'invalid' }));
    expect(() => readConfig(tmpDir)).toThrow('"routing" in void.json must be an object');
    cleanup();
  });

  it('accepts empty routing object', () => {
    setup(JSON.stringify({ routing: {} }));
    const config = readConfig(tmpDir);
    expect(config.routing).toEqual({});
    cleanup();
  });

  it('accepts build command string', () => {
    setup(JSON.stringify({ inference: { build: 'nuxt build' } }));
    const config = readConfig(tmpDir);
    expect(config.inference?.build).toBe('nuxt build');
    cleanup();
  });

  it('throws on non-string build', () => {
    setup(JSON.stringify({ inference: { build: true } }));
    expect(() => readConfig(tmpDir)).toThrow('"inference.build" in void.json must be a string');
    cleanup();
  });

  it('accepts routing.prerender paths', () => {
    setup(JSON.stringify({ routing: { prerender: ['/', '/about', '/docs/intro'] } }));
    const config = readConfig(tmpDir);
    expect(config.routing?.prerender).toEqual(['/', '/about', '/docs/intro']);
    cleanup();
  });

  it('throws on non-array routing.prerender', () => {
    setup(JSON.stringify({ routing: { prerender: '/about' } }));
    expect(() => readConfig(tmpDir)).toThrow('"routing.prerender" in void.json must be an array');
    cleanup();
  });

  it('throws on routing.prerender path not starting with /', () => {
    setup(JSON.stringify({ routing: { prerender: ['about'] } }));
    expect(() => readConfig(tmpDir)).toThrow('must start with "/"');
    cleanup();
  });

  it('accepts scanDirs as array of strings', () => {
    setup(JSON.stringify({ inference: { scanDirs: ['src', 'lib', 'server'] } }));
    const config = readConfig(tmpDir);
    expect(config.inference?.scanDirs).toEqual(['src', 'lib', 'server']);
    cleanup();
  });

  it('throws on non-array scanDirs', () => {
    setup(JSON.stringify({ inference: { scanDirs: 'src' } }));
    expect(() => readConfig(tmpDir)).toThrow('"inference.scanDirs" in void.json must be an array');
    cleanup();
  });

  it('throws on absolute path in scanDirs', () => {
    setup(JSON.stringify({ inference: { scanDirs: ['/etc/passwd'] } }));
    expect(() => readConfig(tmpDir)).toThrow('must be a relative directory');
    cleanup();
  });

  it('throws on parent traversal in scanDirs', () => {
    setup(JSON.stringify({ inference: { scanDirs: ['../secrets'] } }));
    expect(() => readConfig(tmpDir)).toThrow('must be a relative directory');
    cleanup();
  });
});

describe('top-level ai config validation', () => {
  it('accepts an ai.gateway string', () => {
    setup(JSON.stringify({ ai: { gateway: 'my-gateway' } }));
    const config = readConfig(tmpDir);
    expect(config.ai?.gateway).toBe('my-gateway');
    cleanup();
  });

  it('accepts an empty top-level ai object', () => {
    setup(JSON.stringify({ ai: {} }));
    const config = readConfig(tmpDir);
    expect(config.ai).toEqual({});
    cleanup();
  });

  it('throws when ai is not an object (string)', () => {
    setup(JSON.stringify({ ai: 'my-gateway' }));
    expect(() => readConfig(tmpDir)).toThrow('"ai" in void.json must be an object');
    cleanup();
  });

  it('throws when ai is an array', () => {
    setup(JSON.stringify({ ai: ['my-gateway'] }));
    expect(() => readConfig(tmpDir)).toThrow('"ai" in void.json must be an object');
    cleanup();
  });

  it('throws when ai.gateway is not a string', () => {
    setup(JSON.stringify({ ai: { gateway: 123 } }));
    expect(() => readConfig(tmpDir)).toThrow(
      '"ai.gateway" in void.json must be a non-empty string',
    );
    cleanup();
  });

  it('throws when ai.gateway is an empty string', () => {
    setup(JSON.stringify({ ai: { gateway: '' } }));
    expect(() => readConfig(tmpDir)).toThrow(
      '"ai.gateway" in void.json must be a non-empty string',
    );
    cleanup();
  });

  it('rejects an unknown ai.* key', () => {
    setup(JSON.stringify({ ai: { gateway: 'gw', provider: 'openai' } }));
    expect(() => readConfig(tmpDir)).toThrow("Unknown key 'ai.provider'");
    cleanup();
  });

  it('allows ai.gateway and inference.bindings.ai to coexist', () => {
    setup(
      JSON.stringify({
        ai: { gateway: 'my-gw' },
        inference: { bindings: { ai: true } },
      }),
    );
    const config = readConfig(tmpDir);
    expect(config.ai?.gateway).toBe('my-gw');
    expect(config.inference?.bindings?.ai).toBe(true);
    cleanup();
  });
});

describe('readConfig migration errors', () => {
  it('throws when auth is not an object', () => {
    setup(JSON.stringify({ auth: ['github'] }));
    expect(() => readConfig(tmpDir)).toThrow('"auth" in void.json must be an object');
    cleanup();
  });

  it.each([
    ['bindings', { db: true }, '"bindings" has moved to "inference.bindings"'],
    ['headers', { '/*': ['X-Frame-Options: DENY'] }, '"headers" has moved to "routing.headers"'],
    ['redirects', { '/old': '/new' }, '"redirects" has moved to "routing.redirects"'],
    ['cache', { revalidate: 60 }, '"cache" has been replaced by "routing"'],
    ['wrangler', { compatibility_date: '2025-12-01' }, '"wrangler" has been renamed to "worker"'],
    ['mode', 'spa', '"mode" has been renamed to "inference.appType"'],
    ['build', 'nuxt build', '"build" has moved to "inference.build"'],
    ['scanDirs', ['src'], '"scanDirs" has moved to "inference.scanDirs"'],
    ['appType', 'spa', '"appType" has moved to "inference.appType"'],
    ['outputDir', 'dist', '"outputDir" has moved to "inference.outputDir"'],
    ['revalidate', 60, '"revalidate" has moved to "routing.revalidate"'],
  ])('throws a migration error for the old %s key', (key, value, message) => {
    setup(JSON.stringify({ [key]: value }));
    expect(() => readConfig(tmpDir)).toThrow(message);
    cleanup();
  });
});

describe('readConfig target', () => {
  it('accepts valid target values', () => {
    for (const target of ['cloudflare', 'node', 'bun', 'deno']) {
      setup(JSON.stringify({ target }));
      const config = readConfig(tmpDir);
      expect(config.target).toBe(target);
      cleanup();
    }
  });

  it('rejects invalid target value', () => {
    setup(JSON.stringify({ target: 'lambda' }));
    expect(() => readConfig(tmpDir)).toThrow('"target" in void.json must be one of');
    cleanup();
  });

  it('isNodeTarget recognizes node, bun and deno', () => {
    expect(isNodeTarget('node')).toBe(true);
    expect(isNodeTarget('bun')).toBe(true);
    expect(isNodeTarget('deno')).toBe(true);
    expect(isNodeTarget(undefined)).toBe(false);
    expect(isNodeTarget('cloudflare')).toBe(false);
  });
});

describe('readConfig redirects', () => {
  it('accepts redirects with string destinations', () => {
    setup(JSON.stringify({ routing: { redirects: { '/old': '/new' } } }));
    const config = readConfig(tmpDir);
    expect(config.routing?.redirects).toEqual({ '/old': '/new' });
    cleanup();
  });

  it('accepts redirects with object destinations', () => {
    setup(JSON.stringify({ routing: { redirects: { '/old': { to: '/new', status: 301 } } } }));
    const config = readConfig(tmpDir);
    expect(config.routing?.redirects).toEqual({ '/old': { to: '/new', status: 301 } });
    cleanup();
  });

  it('accepts mixed string and object destinations', () => {
    setup(
      JSON.stringify({
        routing: {
          redirects: {
            '/a': '/b',
            '/c': { to: '/d', status: 308 },
          },
        },
      }),
    );
    const config = readConfig(tmpDir);
    expect(config.routing?.redirects).toEqual({
      '/a': '/b',
      '/c': { to: '/d', status: 308 },
    });
    cleanup();
  });

  it('throws on redirect source not starting with /', () => {
    setup(JSON.stringify({ routing: { redirects: { old: '/new' } } }));
    expect(() => readConfig(tmpDir)).toThrow('must start with "/"');
    cleanup();
  });

  it('throws on invalid redirects type', () => {
    setup(JSON.stringify({ routing: { redirects: ['/old', '/new'] } }));
    expect(() => readConfig(tmpDir)).toThrow('"routing.redirects" in void.json must be an object');
    cleanup();
  });

  it('throws on invalid destination type', () => {
    setup(JSON.stringify({ routing: { redirects: { '/old': 42 } } }));
    expect(() => readConfig(tmpDir)).toThrow('must be a string or an object');
    cleanup();
  });

  it("throws on missing 'to' in object destination", () => {
    setup(JSON.stringify({ routing: { redirects: { '/old': { status: 301 } } } }));
    expect(() => readConfig(tmpDir)).toThrow('must have a "to" string');
    cleanup();
  });

  it('throws on invalid status code', () => {
    setup(JSON.stringify({ routing: { redirects: { '/old': { to: '/new', status: 200 } } } }));
    expect(() => readConfig(tmpDir)).toThrow('must be 301, 302, 303, 307, or 308');
    cleanup();
  });

  it('accepts status 303', () => {
    setup(JSON.stringify({ routing: { redirects: { '/old': { to: '/new', status: 303 } } } }));
    const config = readConfig(tmpDir);
    expect(config.routing?.redirects).toEqual({ '/old': { to: '/new', status: 303 } });
    cleanup();
  });

  it('schema.json redirect status enum matches VALID_REDIRECT_STATUSES', () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dirname, '../../schema.json'), 'utf8'));
    const schemaEnum: Array<number> =
      schema.properties.routing.properties.redirects.patternProperties['^(/|https://)'].oneOf[1]
        .properties.status.enum;
    expect(new Set(schemaEnum)).toEqual(VALID_REDIRECT_STATUSES);
  });

  it('schema.json revalidate key pattern matches runtime validation', () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dirname, '../../schema.json'), 'utf8'));
    const objectForm = schema.properties.routing.properties.revalidate.oneOf.find(
      (s: { type?: string }) => s.type === 'object',
    );
    const keyPattern = new RegExp(Object.keys(objectForm.patternProperties)[0]);

    for (const key of ['*', '/x', '/docs/*']) {
      expect(keyPattern.test(key)).toBe(true);
    }
    for (const key of ['*foo', '**', '*/', 'foo']) {
      expect(keyPattern.test(key)).toBe(false);
    }
  });

  it('schema.json sourceDir pattern matches runtime validation', () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dirname, '../../schema.json'), 'utf8'));
    const sourceDirPattern = new RegExp(schema.properties.sourceDir.pattern);

    for (const value of ['src', 'app/server', './src', 's']) {
      expect(sourceDirPattern.test(value)).toBe(true);
    }

    for (const value of [
      '',
      ' src',
      'src ',
      '/',
      '.',
      './',
      '..',
      '../src',
      'src/../app',
      'src/..',
    ]) {
      expect(sourceDirPattern.test(value)).toBe(false);
    }
  });

  it('schema.json rewrite/fallback dest pattern rejects protocol-relative "//"', () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dirname, '../../schema.json'), 'utf8'));
    for (const field of ['rewrites', 'fallbacks']) {
      const destPattern = new RegExp(
        schema.properties.routing.properties[field].patternProperties['^(/|https://)'].pattern,
      );
      for (const dest of ['/en/docs', '/', '/index.html']) {
        expect(destPattern.test(dest)).toBe(true);
      }
      for (const dest of ['//evil.com/x', '//', '///x', '/x?a=1', 'en/docs']) {
        expect(destPattern.test(dest)).toBe(false);
      }
    }
  });

  it('schema.json worker.limits.cpu_ms bounds match runtime validation', () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dirname, '../../schema.json'), 'utf8'));
    const limits = schema.properties.worker.properties.limits;
    expect(limits.type).toBe('object');
    expect(limits.additionalProperties).toBe(false);
    expect(Object.keys(limits.properties)).toEqual(['cpu_ms']);
    expect(limits.properties.cpu_ms.type).toBe('integer');
    expect(limits.properties.cpu_ms.minimum).toBe(1);
    expect(limits.properties.cpu_ms.maximum).toBe(300000);
  });

  it('publishes schema.json as a package file and subpath export', () => {
    const packageJson = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8'),
    );

    expect(packageJson.files).toContain('schema.json');
    expect(packageJson.exports['./schema.json']).toBe('./schema.json');
  });
});

describe('routing.rewrites and routing.fallbacks validation', () => {
  it('accepts static rewrites without wildcards', () => {
    setup(JSON.stringify({ routing: { rewrites: { '/docs': '/en/docs' } } }));
    const config = readConfig(tmpDir);
    expect(config.routing?.rewrites).toEqual({ '/docs': '/en/docs' });
    cleanup();
  });

  it('accepts valid fallbacks', () => {
    setup(JSON.stringify({ routing: { fallbacks: { '/*': '/index.html' } } }));
    const config = readConfig(tmpDir);
    expect(config.routing?.fallbacks).toEqual({ '/*': '/index.html' });
    cleanup();
  });

  describe.each(['rewrites', 'fallbacks'])('routing.%s', (field) => {
    it.each<[unknown, string]>([
      [['/old', '/new'], `"routing.${field}" in void.json must be an object`],
      [{ docs: '/en/docs' }, 'must start with "/"'],
      [{ '/docs': 42 }, 'must be a string'],
      [{ '/docs': 'en/docs' }, 'must start with "/"'],
      [{ '/docs': '/en/docs?lang=en' }, 'must not contain "?"'],
      [{ '/docs': '//evil.com/x' }, 'must not start with "//"'],
    ])('rejects %j', (rules, message) => {
      setup(JSON.stringify({ routing: { [field]: rules } }));
      expect(() => readConfig(tmpDir)).toThrow(message);
      cleanup();
    });
  });
});

describe('routing.redirects protocol-relative guard', () => {
  // Redirects legitimately support external destinations ("https://..."), so
  // the guard only applies when the destination is an internal path ("/..").
  it('throws on string destination starting with "//"', () => {
    setup(JSON.stringify({ routing: { redirects: { '/old': '//evil.com/new' } } }));
    expect(() => readConfig(tmpDir)).toThrow('must not start with "//"');
    cleanup();
  });

  it('throws on object destination with `to` starting with "//"', () => {
    setup(
      JSON.stringify({
        routing: { redirects: { '/old': { to: '//evil.com/new', status: 301 } } },
      }),
    );
    expect(() => readConfig(tmpDir)).toThrow('must not start with "//"');
    cleanup();
  });

  it('still accepts explicit "https://" external destinations', () => {
    setup(
      JSON.stringify({
        routing: { redirects: { '/old': 'https://example.com/new' } },
      }),
    );
    const config = readConfig(tmpDir);
    expect(config.routing?.redirects).toEqual({ '/old': 'https://example.com/new' });
    cleanup();
  });
});

describe('routing rules: host-prefixed sources', () => {
  it('accepts a redirect with https:// prefixed source and emits host on rule', () => {
    setup(
      JSON.stringify({
        routing: { redirects: { 'https://www.foo.com/*': 'https://foo.com/:splat' } },
      }),
    );
    const config = readConfig(tmpDir);
    const rules = convertRedirectsConfig(config.routing?.redirects);
    expect(rules).toEqual([
      {
        source: '/*',
        destination: 'https://foo.com/:splat',
        status: 302,
        host: 'www.foo.com',
        origin: 'void.json#routing.redirects',
      },
    ]);
    cleanup();
  });

  it('lowercases mixed-case host on redirect source', () => {
    setup(JSON.stringify({ routing: { redirects: { 'https://WWW.FOO.COM/about': '/new' } } }));
    const config = readConfig(tmpDir);
    const rules = convertRedirectsConfig(config.routing?.redirects);
    expect(rules?.[0].host).toBe('www.foo.com');
    expect(rules?.[0].source).toBe('/about');
    cleanup();
  });

  it('accepts a rewrite with https:// prefixed source', () => {
    setup(
      JSON.stringify({ routing: { rewrites: { 'https://app.foo.com/api/*': '/api/:splat' } } }),
    );
    const config = readConfig(tmpDir);
    const rules = convertRewritesConfig(config.routing?.rewrites);
    expect(rules?.[0]).toMatchObject({
      source: '/api/*',
      destination: '/api/:splat',
      status: 200,
      force: true,
      host: 'app.foo.com',
    });
    cleanup();
  });

  it('accepts a fallback with https:// prefixed source', () => {
    setup(JSON.stringify({ routing: { fallbacks: { 'https://app.foo.com/*': '/index.html' } } }));
    const config = readConfig(tmpDir);
    const rules = convertFallbacksConfig(config.routing?.fallbacks);
    expect(rules?.[0]).toMatchObject({
      source: '/*',
      destination: '/index.html',
      status: 200,
      force: false,
      host: 'app.foo.com',
    });
    cleanup();
  });

  it('omits host when source is path-only', () => {
    setup(JSON.stringify({ routing: { redirects: { '/old': '/new' } } }));
    const config = readConfig(tmpDir);
    const rules = convertRedirectsConfig(config.routing?.redirects);
    expect(rules?.[0]).not.toHaveProperty('host');
    cleanup();
  });

  it('rejects http:// source on redirect', () => {
    setup(JSON.stringify({ routing: { redirects: { 'http://www.foo.com/*': '/x' } } }));
    expect(() => readConfig(tmpDir)).toThrow(/http:\/\//);
    cleanup();
  });

  it('rejects protocol-relative // source on redirect', () => {
    setup(JSON.stringify({ routing: { redirects: { '//www.foo.com/*': '/x' } } }));
    expect(() => readConfig(tmpDir)).toThrow(/protocol-relative/);
    cleanup();
  });

  it('rejects non-literal host (wildcard)', () => {
    setup(JSON.stringify({ routing: { redirects: { 'https://*.foo.com/*': '/x' } } }));
    expect(() => readConfig(tmpDir)).toThrow(/literal hostname/);
    cleanup();
  });

  it('rejects host with port', () => {
    setup(JSON.stringify({ routing: { redirects: { 'https://www.foo.com:8080/*': '/x' } } }));
    expect(() => readConfig(tmpDir)).toThrow(/literal hostname/);
    cleanup();
  });

  it('rejects host with userinfo', () => {
    setup(JSON.stringify({ routing: { redirects: { 'https://user@www.foo.com/*': '/x' } } }));
    expect(() => readConfig(tmpDir)).toThrow(/literal hostname/);
    cleanup();
  });

  it('treats https://host (no path) as https://host/', () => {
    setup(JSON.stringify({ routing: { redirects: { 'https://www.foo.com': '/x' } } }));
    const config = readConfig(tmpDir);
    const rules = convertRedirectsConfig(config.routing?.redirects);
    expect(rules?.[0]).toMatchObject({ source: '/', host: 'www.foo.com' });
    cleanup();
  });
});

describe('duplicate "*" wildcards in rule sources', () => {
  // Dispatch compiles each `*` into a `(?<splat>...)` capture group, so two
  // in one source makes `new RegExp()` throw on duplicate group name at
  // startup. Catch these at config-read time with a clear message.
  it.each<[string, Record<string, unknown>]>([
    ['redirect source', { redirects: { '/a/*/b/*': '/dest' } }],
    ['rewrite source', { rewrites: { '/*/docs/*': '/dest' } }],
    ['fallback source', { fallbacks: { '/*/*': '/index.html' } }],
    ['header pattern', { headers: { '/assets/*/img/*': ['Cache-Control: no-cache'] } }],
    ['revalidateQueryAllowlist pattern', { revalidateQueryAllowlist: { '/a/*/b/*': ['q'] } }],
  ])('rejects a %s with two "*"', (_kind, routing) => {
    setup(JSON.stringify({ routing }));
    expect(() => readConfig(tmpDir)).toThrow('must contain at most one "*" wildcard');
    cleanup();
  });

  it('accepts a source with exactly one "*"', () => {
    setup(JSON.stringify({ routing: { rewrites: { '/docs/*': '/en/docs/:splat' } } }));
    const config = readConfig(tmpDir);
    expect(config.routing?.rewrites).toEqual({ '/docs/*': '/en/docs/:splat' });
    cleanup();
  });

  // `countSplats` only counts anonymous `*` wildcards. The `*` that terminates
  // a `:name*` multi-segment named capture compiles to `(?<name>.*)` (distinct
  // group name from the legacy `(?<splat>.*)`), so it doesn't trigger the
  // duplicate-group-name `RegExp` failure that `assertSingleSplat` guards.
  describe('countSplats', () => {
    it('returns 0 for a path with no wildcards', () => {
      expect(countSplats('/foo')).toBe(0);
    });

    it('counts a bare trailing splat', () => {
      expect(countSplats('/foo/*')).toBe(1);
    });

    it('counts multiple anonymous splats', () => {
      expect(countSplats('/foo/*/bar/*')).toBe(2);
    });

    it('does not count the "*" inside a named multi-segment capture', () => {
      expect(countSplats('/users/:id*/files/*')).toBe(1);
    });

    it('returns 0 when both "*"s are tails of named captures', () => {
      expect(countSplats('/users/:id*/files/:rest*')).toBe(0);
    });

    it('counts a single bare splat alongside a single-segment named param', () => {
      expect(countSplats('/users/:id/files/*')).toBe(1);
    });
  });

  it('accepts a rewrite combining ":name*" and "*"', () => {
    // `:id*` → `(?<id>.*)` and `*` → `(?<splat>.*)` are distinct named groups.
    // The validator must not reject this pattern as a duplicate-splat pattern.
    setup(
      JSON.stringify({
        routing: { rewrites: { '/users/:id*/files/*': '/v2/:id/files/:splat' } },
      }),
    );
    const config = readConfig(tmpDir);
    expect(config.routing?.rewrites).toEqual({
      '/users/:id*/files/*': '/v2/:id/files/:splat',
    });
    cleanup();
  });

  it('rejects a redirect with two ":name" tokens sharing an identifier', () => {
    // `/:id/:id` would compile to `(?<id>...)/(?<id>...)`, which throws
    // `SyntaxError: Duplicate capture group name` at request time. The
    // validator must reject this at config-read time.
    setup(JSON.stringify({ routing: { redirects: { '/:id/:id': '/x' } } }));
    expect(() => readConfig(tmpDir)).toThrow(/duplicate capture group name/);
    cleanup();
  });

  it('rejects a rewrite with ":splat" colliding with a bare "*"', () => {
    // The bare `*` emits `(?<splat>.*)`; an explicit `:splat` token also
    // emits a `<splat>` group. Both compile to a duplicate group name.
    setup(JSON.stringify({ routing: { rewrites: { '/:splat/*': '/x' } } }));
    expect(() => readConfig(tmpDir)).toThrow(/duplicate capture group name/);
    cleanup();
  });

  it('rejects a fallback with two ":name*" tokens sharing an identifier', () => {
    // `/:rest{splat-suffix}/:rest{splat-suffix}` would emit two `<rest>` groups.
    setup(
      JSON.stringify({
        routing: { fallbacks: { '/api/:rest*/v2/:rest*': '/index.html' } },
      }),
    );
    expect(() => readConfig(tmpDir)).toThrow(/duplicate capture group name/);
    cleanup();
  });
});

describe('routing.revalidateQueryAllowlist validation', () => {
  it('accepts path-pattern arrays', () => {
    setup(
      JSON.stringify({
        routing: {
          revalidateQueryAllowlist: {
            '/search': ['q'],
            '/products/*': ['variant'],
            '*': [],
          },
        },
      }),
    );
    const config = readConfig(tmpDir);
    expect(config.routing?.revalidateQueryAllowlist).toEqual({
      '/search': ['q'],
      '/products/*': ['variant'],
      '*': [],
    });
    cleanup();
  });

  it('throws when allowlist is not an object', () => {
    setup(JSON.stringify({ routing: { revalidateQueryAllowlist: ['/search'] } }));
    expect(() => readConfig(tmpDir)).toThrow(
      '"routing.revalidateQueryAllowlist" in void.json must be an object',
    );
    cleanup();
  });

  it('throws when pattern does not start with /', () => {
    setup(JSON.stringify({ routing: { revalidateQueryAllowlist: { search: ['q'] } } }));
    expect(() => readConfig(tmpDir)).toThrow('must start with "/" or be "*"');
    cleanup();
  });

  it('throws when params are not string arrays', () => {
    setup(JSON.stringify({ routing: { revalidateQueryAllowlist: { '/search': ['q', 1] } } }));
    expect(() => readConfig(tmpDir)).toThrow('must be an array of strings');
    cleanup();
  });
});

describe('convertHeadersConfig', () => {
  it('returns undefined for undefined input', () => {
    expect(convertHeadersConfig(undefined)).toBeUndefined();
  });

  it('returns undefined for empty object', () => {
    expect(convertHeadersConfig({})).toBeUndefined();
  });

  it('converts a single pattern with one header', () => {
    const result = convertHeadersConfig({
      '/assets/*': ['Cache-Control: public, max-age=31536000, immutable'],
    });
    expect(result).toEqual([
      {
        pattern: '/assets/*',
        headers: [['Cache-Control', 'public, max-age=31536000, immutable']],
      },
    ]);
  });

  it('converts multiple patterns with multiple headers', () => {
    const result = convertHeadersConfig({
      '/assets/*': ['Cache-Control: public, max-age=31536000, immutable'],
      '/*': ['X-Frame-Options: DENY', 'X-Content-Type-Options: nosniff'],
    });
    expect(result).toEqual([
      {
        pattern: '/assets/*',
        headers: [['Cache-Control', 'public, max-age=31536000, immutable']],
      },
      {
        pattern: '/*',
        headers: [
          ['X-Frame-Options', 'DENY'],
          ['X-Content-Type-Options', 'nosniff'],
        ],
      },
    ]);
  });

  it('handles header values with colons', () => {
    const result = convertHeadersConfig({
      '/api/*': ['Link: <https://example.com>; rel="preconnect"'],
    });
    expect(result).toEqual([
      {
        pattern: '/api/*',
        headers: [['Link', '<https://example.com>; rel="preconnect"']],
      },
    ]);
  });

  it('skips entries without colons', () => {
    const result = convertHeadersConfig({
      '/*': ['not-a-header', 'X-Frame-Options: DENY'],
    });
    expect(result).toEqual([
      {
        pattern: '/*',
        headers: [['X-Frame-Options', 'DENY']],
      },
    ]);
  });

  it('skips patterns with only invalid entries', () => {
    const result = convertHeadersConfig({
      '/assets/*': ['Cache-Control: ok'],
      '/*': ['not-a-header'],
    });
    expect(result).toEqual([
      {
        pattern: '/assets/*',
        headers: [['Cache-Control', 'ok']],
      },
    ]);
  });
});

describe('convertRedirectsConfig', () => {
  it('returns undefined for undefined input', () => {
    expect(convertRedirectsConfig(undefined)).toBeUndefined();
  });

  it('returns undefined for empty object', () => {
    expect(convertRedirectsConfig({})).toBeUndefined();
  });

  it('converts string destinations with default 302', () => {
    const result = convertRedirectsConfig({ '/old': '/new' });
    expect(result).toEqual([
      { source: '/old', destination: '/new', status: 302, origin: 'void.json#routing.redirects' },
    ]);
  });

  it('converts object destinations with explicit status', () => {
    const result = convertRedirectsConfig({ '/old': { to: '/new', status: 301 } });
    expect(result).toEqual([
      { source: '/old', destination: '/new', status: 301, origin: 'void.json#routing.redirects' },
    ]);
  });

  it('converts mixed entries preserving order', () => {
    const result = convertRedirectsConfig({
      '/a': '/b',
      '/c/*': { to: '/d/:splat', status: 308 },
    });
    expect(result).toEqual([
      { source: '/a', destination: '/b', status: 302, origin: 'void.json#routing.redirects' },
      {
        source: '/c/*',
        destination: '/d/:splat',
        status: 308,
        origin: 'void.json#routing.redirects',
      },
    ]);
  });
});

describe('convertRewritesConfig', () => {
  it('returns undefined for undefined input', () => {
    expect(convertRewritesConfig(undefined)).toBeUndefined();
  });

  it('returns undefined for empty object', () => {
    expect(convertRewritesConfig({})).toBeUndefined();
  });

  it('converts entries with status 200 and force=true (always-rewrite)', () => {
    const result = convertRewritesConfig({ '/docs': '/en/docs' });
    expect(result).toEqual([
      {
        source: '/docs',
        destination: '/en/docs',
        status: 200,
        force: true,
        origin: 'void.json#routing.rewrites',
      },
    ]);
  });

  it('converts multiple entries preserving order', () => {
    const result = convertRewritesConfig({
      '/': '/en',
      '/docs/*': '/en/docs/:splat',
    });
    expect(result).toEqual([
      {
        source: '/',
        destination: '/en',
        status: 200,
        force: true,
        origin: 'void.json#routing.rewrites',
      },
      {
        source: '/docs/*',
        destination: '/en/docs/:splat',
        status: 200,
        force: true,
        origin: 'void.json#routing.rewrites',
      },
    ]);
  });
});

describe('convertFallbacksConfig', () => {
  it('returns undefined for undefined input', () => {
    expect(convertFallbacksConfig(undefined)).toBeUndefined();
  });

  it('returns undefined for empty object', () => {
    expect(convertFallbacksConfig({})).toBeUndefined();
  });

  it('converts entries with status 200 and force=false (asset-miss only)', () => {
    const result = convertFallbacksConfig({ '/*': '/index.html' });
    expect(result).toEqual([
      {
        source: '/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: 'void.json#routing.fallbacks',
      },
    ]);
  });

  it('converts multiple entries preserving order', () => {
    const result = convertFallbacksConfig({
      '/api/*': '/api/fallback',
      '/*': '/index.html',
    });
    expect(result).toEqual([
      {
        source: '/api/*',
        destination: '/api/fallback',
        status: 200,
        force: false,
        origin: 'void.json#routing.fallbacks',
      },
      {
        source: '/*',
        destination: '/index.html',
        status: 200,
        force: false,
        origin: 'void.json#routing.fallbacks',
      },
    ]);
  });
});

describe('lintDestinationSplats', () => {
  beforeEach(() => {
    warnMock.mockClear();
  });

  // Platform `substituteParams` only replaces `:name` tokens — a literal `*`
  // in a destination passes through unchanged, which is almost never what the
  // author meant. Warn (not fail) so misuse surfaces at deploy-time without
  // blocking otherwise-valid configs.
  it('emits no warning when destinations only contain :splat / :name', async () => {
    const { lintDestinationSplats } = await import('../../src/cli/headers.ts');
    const rules = convertRewritesConfig({
      '/docs/*': '/en/docs/:splat',
      '/posts/:id': '/archive/:id',
    });
    lintDestinationSplats(rules, 'rewrites');
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('emits a single aggregated warning for a redirect destination with *', async () => {
    const { lintDestinationSplats } = await import('../../src/cli/headers.ts');
    const rules = convertRedirectsConfig({ '/old/*': '/new/*' });
    lintDestinationSplats(rules, 'redirects/rewrites (pre-asset)');
    expect(warnMock).toHaveBeenCalledOnce();
    const msg = warnMock.mock.calls[0][0];
    expect(msg).toContain('/old/*');
    expect(msg).toContain('/new/*');
    expect(msg).toContain('void.json#routing.redirects');
  });

  it('emits a single aggregated warning covering all affected rules', async () => {
    const { lintDestinationSplats } = await import('../../src/cli/headers.ts');
    const rules = [
      ...(convertRewritesConfig({ '/a/*': '/x/*' }) ?? []),
      ...(convertRewritesConfig({ '/b/*': '/y/:splat' }) ?? []),
      ...(convertRewritesConfig({ '/c': '/z/*' }) ?? []),
    ];
    lintDestinationSplats(rules, 'rewrites');
    expect(warnMock).toHaveBeenCalledOnce();
    const msg = warnMock.mock.calls[0][0];
    expect(msg).toContain('/a/*');
    expect(msg).toContain('/x/*');
    expect(msg).toContain('/c');
    expect(msg).toContain('/z/*');
    // The rule with a clean `:splat` destination must not appear.
    expect(msg).not.toContain('/y/:splat');
  });

  it('works with fallbacks output shape as well', async () => {
    const { lintDestinationSplats } = await import('../../src/cli/headers.ts');
    const rules = convertFallbacksConfig({ '/docs/*': '/docs/*' });
    lintDestinationSplats(rules, 'fallbacks (post-asset)');
    expect(warnMock).toHaveBeenCalledOnce();
    expect(warnMock.mock.calls[0][0]).toContain('void.json#routing.fallbacks');
  });
});

describe('database config', () => {
  it('defaults to sqlite when omitted', () => {
    setup('{}');
    const config = readConfig(tmpDir);
    expect(getDatabaseDialect(config)).toBe('sqlite');
    cleanup();
  });

  it('accepts pg', () => {
    setup(JSON.stringify({ database: 'pg' }));
    const config = readConfig(tmpDir);
    expect(getDatabaseDialect(config)).toBe('postgresql');
    cleanup();
  });

  it('accepts mysql', () => {
    setup(JSON.stringify({ database: 'mysql' }));
    const config = readConfig(tmpDir);
    expect(getDatabaseDialect(config)).toBe('mysql');
    cleanup();
  });

  it('has no casing in the string form', () => {
    setup(JSON.stringify({ database: 'pg' }));
    expect(getDatabaseCasing(readConfig(tmpDir))).toBeUndefined();
    cleanup();
  });

  it.each([
    [{ dialect: 'pg', casing: 'snake_case' }, 'postgresql', 'snake_case'],
    [{ dialect: 'mysql', casing: 'camelCase' }, 'mysql', 'camelCase'],
    [{ dialect: 'sqlite', casing: 'snake_case' }, 'sqlite', 'snake_case'],
    [{ casing: 'snake_case' }, 'sqlite', 'snake_case'],
    [{ dialect: 'pg' }, 'postgresql', undefined],
    [{}, 'sqlite', undefined],
  ])('accepts the object form %j', (database, dialect, casing) => {
    setup(JSON.stringify({ database }));
    const config = readConfig(tmpDir);
    expect(config.database).toEqual(database);
    expect(getDatabaseDialect(config)).toBe(dialect);
    expect(getDatabaseCasing(config)).toBe(casing);
    cleanup();
  });

  it.each([
    ['mariadb', '"database" in void.json must be "pg", "mysql" or an object'],
    [1, '"database" in void.json must be "pg", "mysql" or an object'],
    [['pg'], '"database" in void.json must be "pg", "mysql" or an object'],
    [{ dialect: 'mariadb' }, '"database.dialect" in void.json must be "sqlite", "pg" or "mysql"'],
    [
      { dialect: 'postgresql' },
      '"database.dialect" in void.json must be "sqlite", "pg" or "mysql"',
    ],
    [{ casing: 'snake' }, '"database.casing" in void.json must be "snake_case" or "camelCase"'],
    [{ casing: 'preserve' }, '"database.casing" in void.json must be "snake_case" or "camelCase"'],
    [
      { dialect: 'pg', url: 'x' },
      "Unknown key 'database.url' in void.json. Valid: dialect, casing.",
    ],
  ])('rejects %j', (database, message) => {
    setup(JSON.stringify({ database }));
    expect(() => readConfig(tmpDir)).toThrow(message);
    cleanup();
  });

  it('writes the string form unless a casing is set', () => {
    expect(databaseConfigValue('sqlite', undefined)).toBeUndefined();
    expect(databaseConfigValue('postgresql', undefined)).toBe('pg');
    expect(databaseConfigValue('mysql', undefined)).toBe('mysql');
    expect(databaseConfigValue('sqlite', 'snake_case')).toEqual({ casing: 'snake_case' });
    expect(databaseConfigValue('postgresql', 'snake_case')).toEqual({
      dialect: 'pg',
      casing: 'snake_case',
    });
  });

  it('schema.json database matches runtime validation', () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dirname, '../../schema.json'), 'utf8'));
    const [shorthand, object] = schema.properties.database.oneOf;
    expect(shorthand.enum).toEqual(['pg', 'mysql']);
    expect(Object.keys(object.properties)).toEqual(['dialect', 'casing']);
    expect(object.properties.dialect.enum).toEqual(['sqlite', 'pg', 'mysql']);
    expect(object.properties.casing.enum).toEqual(['snake_case', 'camelCase']);
    expect(object.additionalProperties).toBe(false);
  });
});

describe('resolveBindingNames', () => {
  it('returns undefined for no bindings', () => {
    expect(resolveBindingNames(undefined)).toBeUndefined();
  });

  it('returns undefined for boolean-only bindings', () => {
    expect(resolveBindingNames({ db: true, kv: true })).toBeUndefined();
  });

  it('returns custom names for string bindings', () => {
    expect(resolveBindingNames({ db: 'MY_DB', kv: true, storage: 'BUCKET' })).toEqual({
      d1: 'MY_DB',
      r2: 'BUCKET',
    });
  });

  it('returns all custom names', () => {
    expect(resolveBindingNames({ db: 'D', kv: 'K', storage: 'S', ai: 'A' })).toEqual({
      d1: 'D',
      kv: 'K',
      r2: 'S',
      ai: 'A',
    });
  });
});

describe('top-level email config validation', () => {
  it('accepts a bare email.from address', () => {
    setup(JSON.stringify({ email: { from: 'noreply@mail.acme.com' } }));
    expect(readConfig(tmpDir).email?.from).toBe('noreply@mail.acme.com');
    cleanup();
  });

  it('accepts email.from with a display name', () => {
    setup(JSON.stringify({ email: { from: 'Acme <noreply@mail.acme.com>' } }));
    expect(readConfig(tmpDir).email?.from).toBe('Acme <noreply@mail.acme.com>');
    cleanup();
  });

  it('accepts email.from with a quoted display name', () => {
    setup(JSON.stringify({ email: { from: '"Acme, Inc." <noreply@mail.acme.com>' } }));
    expect(readConfig(tmpDir).email?.from).toBe('"Acme, Inc." <noreply@mail.acme.com>');
    cleanup();
  });

  it('accepts an empty top-level email object', () => {
    setup(JSON.stringify({ email: {} }));
    expect(readConfig(tmpDir).email).toEqual({});
    cleanup();
  });

  it('throws when email is not an object', () => {
    setup(JSON.stringify({ email: 'noreply@mail.acme.com' }));
    expect(() => readConfig(tmpDir)).toThrow('"email" in void.json must be an object');
    setup(JSON.stringify({ email: ['noreply@mail.acme.com'] }));
    expect(() => readConfig(tmpDir)).toThrow('"email" in void.json must be an object');
    cleanup();
  });

  it('throws when email.from is not a non-empty string', () => {
    setup(JSON.stringify({ email: { from: 123 } }));
    expect(() => readConfig(tmpDir)).toThrow(
      '"email.from" in void.json must be a non-empty string',
    );
    setup(JSON.stringify({ email: { from: '' } }));
    expect(() => readConfig(tmpDir)).toThrow(
      '"email.from" in void.json must be a non-empty string',
    );
    cleanup();
  });

  // The same shapes `sendEmail()` refuses for `from`: no `@`, two addresses,
  // a list, whitespace, a smuggled header, an `@` in the display name.
  it.each([
    'noreply',
    'noreply@',
    '@mail.acme.com',
    'a@mail.acme.com,b@mail.acme.com',
    'a@mail.acme.com b@mail.acme.com',
    'Acme <noreply@mail.acme.com>, Sales <sales@mail.acme.com>',
    'noreply@mail.acme.com\r\nBcc: x@evil.example',
    'a@x.dev<b@evil.dev>',
    '"Acme <noreply@mail.acme.com>',
  ])('rejects email.from %j', (from) => {
    setup(JSON.stringify({ email: { from } }));
    expect(() => readConfig(tmpDir)).toThrow(
      '"email.from" in void.json must be a single email address, optionally with a display name',
    );
    cleanup();
  });

  it('rejects an unknown email.* key', () => {
    setup(JSON.stringify({ email: { from: 'noreply@mail.acme.com', domain: 'mail.acme.com' } }));
    expect(() => readConfig(tmpDir)).toThrow("Unknown key 'email.domain'");
    cleanup();
  });

  it('allows email.from and inference.bindings.email to coexist', () => {
    setup(
      JSON.stringify({
        email: { from: 'noreply@mail.acme.com' },
        inference: { bindings: { email: true } },
      }),
    );
    const config = readConfig(tmpDir);
    expect(config.email?.from).toBe('noreply@mail.acme.com');
    expect(config.inference?.bindings?.email).toBe(true);
    cleanup();
  });
});
