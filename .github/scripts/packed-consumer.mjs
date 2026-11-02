import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path/posix';
import { fileURLToPath } from 'node:url';
import { collectBrowserDiagnostics } from '../../test/browser-helpers.ts';
import { inspectPackage, startPackedRegistry } from './packed-registry.mjs';
import { packedServerUrl } from './packed-server.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const suite = process.env.VOID_PACKED_SUITE ?? 'smoke';
assert(['smoke', 'full'].includes(suite), 'VOID_PACKED_SUITE must be smoke or full');
const full = suite === 'full';
const toolchain = process.env.VOID_PACKED_TOOLCHAIN ?? 'vite';
assert(
  ['vite', 'vite-plus'].includes(toolchain),
  'VOID_PACKED_TOOLCHAIN must be vite or vite-plus',
);
const useVitePlus = toolchain === 'vite-plus';
const vitePlusVersion = JSON.parse(
  readFileSync(join(root, 'node_modules/vite-plus/package.json'), 'utf8'),
).version;
const work = mkdtempSync(join(tmpdir(), 'void-packed-consumer-'));
const archiveDir = join(work, 'archives');
mkdirSync(archiveDir);
console.log(`Packed consumer artifacts: ${work}`);
console.log(`Packed consumer suite: ${suite}`);
console.log(`Packed consumer toolchain: ${toolchain}`);
const environment = { ...process.env, CI: 'true' };
for (const key of Object.keys(environment)) {
  if (/^(VOID_|VP_|CLOUDFLARE_|CF_|WRANGLER_|NPM_TOKEN$|NODE_AUTH_TOKEN$)/i.test(key)) {
    delete environment[key];
  }
}
const config = join(work, 'npmrc');
writeFileSync(config, 'audit=false\nfund=false\nengine-strict=true\n');
environment.npm_config_userconfig = config;
environment.NPM_CONFIG_USERCONFIG = config;
environment.PNPM_CONFIG_NPMRC_AUTH_FILE = config;
let commandNumber = 0;

function launch(command, args, cwd, env = environment) {
  const logPath = join(work, `command-${++commandNumber}.log`);
  const log = createWriteStream(logPath, { mode: 0o600 });
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let tail = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      log.write(chunk);
      tail = (tail + chunk.toString()).slice(-16000);
    });
  }
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      log.end();
      resolve(code);
    });
  });
  return {
    child,
    completion,
    logPath,
    failure() {
      return `${command} ${args.join(' ')} failed; ${logPath}\n${tail}`;
    },
    output() {
      return tail;
    },
    async stop() {
      if (child.exitCode === null) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          /* already exited */
        }
        const force = setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* already exited */
          }
        }, 5000);
        await completion.finally(() => clearTimeout(force));
      }
    },
  };
}

async function run(command, args, cwd, env = environment) {
  const task = launch(command, args, cwd, env);
  const timeout = setTimeout(() => {
    void task.stop();
  }, 300_000);
  try {
    const code = await task.completion;
    assert.equal(code, 0, task.failure());
  } finally {
    clearTimeout(timeout);
    await task.stop();
  }
}

const packages = [];
for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    continue;
  }
  const directory = join(root, 'packages', entry.name);
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  if (manifest.private) {
    continue;
  }
  const archive = join(archiveDir, `${entry.name}.tgz`);
  await run('vp', ['pm', 'pack', '--out', archive], directory);
  packages.push(inspectPackage(archive));
}
const registry = await startPackedRegistry(packages);
// Packed tests must install new local builds, even when the matching npm release
// is less than a day old. Keep this policy inside the temporary fixture config.
environment.XDG_CONFIG_HOME = join(work, 'config');
const pnpmConfigDirectory = join(environment.XDG_CONFIG_HOME, 'pnpm');
mkdirSync(pnpmConfigDirectory, { recursive: true });
writeFileSync(
  join(pnpmConfigDirectory, 'config.yaml'),
  `registries:\n  default: ${registry.origin}\nminimumReleaseAge: 0\n`,
);
environment.npm_config_registry = registry.origin;
environment.NPM_CONFIG_REGISTRY = registry.origin;
environment.PNPM_CONFIG_REGISTRY = registry.origin;
const version = packages.find((pkg) => pkg.manifest.name === 'void').manifest.version;
const managers = process.env.VOID_PACKED_PM ? [process.env.VOID_PACKED_PM] : ['npm', 'pnpm'];
assert(managers.every((manager) => ['npm', 'pnpm'].includes(manager)));
const frameworks = process.env.VOID_PACKED_FRAMEWORK
  ? [process.env.VOID_PACKED_FRAMEWORK]
  : full
    ? ['react', 'vue', 'svelte', 'solid']
    : ['react'];
assert(frameworks.every((framework) => ['react', 'vue', 'svelte', 'solid'].includes(framework)));
const pages = {
  react: `import { useState } from 'react';
import { Link } from '@void/react';
export default function Page({ message }: { message: string }) {
  const [count, setCount] = useState(0);
  return <><h1>{message}</h1><button onClick={() => setCount(count + 1)}>Count {count}</button><Link href="/next">Next page</Link></>;
}`,
  vue: `<script setup lang="ts">
import { ref } from 'vue';
import { Link } from '@void/vue';
defineProps<{ message: string }>();
const count = ref(0);
</script><template><h1>{{ message }}</h1><button @click="count++">Count {{ count }}</button><Link href="/next">Next page</Link></template>`,
  svelte: `<script lang="ts">
import { Link } from '@void/svelte';
let { message }: { message: string } = $props();
let count = $state(0);
</script><h1>{message}</h1><button onclick={() => count++}>Count {count}</button><Link href="/next">Next page</Link>`,
  solid: `import { createSignal } from 'solid-js';
import { Link } from '@void/solid';
export default function Page(props: { message: string }) {
  const [count, setCount] = createSignal(0);
  return <><h1>{props.message}</h1><button onClick={() => setCount(count() + 1)}>Count {count()}</button><Link href="/next">Next page</Link></>;
}`,
};

let browser;
const failures = [];
try {
  if (full) {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  }
  for (const manager of managers) {
    for (const framework of frameworks) {
      const label = `${manager}-${framework}`;
      try {
        const fixture = join(work, label);
        console.log(`Checking packed ${label}: create-void and interactive init`);
        await run(
          process.execPath,
          [
            join(root, '.github/scripts/packed-init.mjs'),
            fixture,
            framework,
            manager,
            version,
            toolchain,
          ],
          work,
        );
        const agentInstructions = readFileSync(join(fixture, 'AGENTS.md'), 'utf8');
        assert.equal(agentInstructions.match(/^- /gm)?.length, 2);
        assert(agentInstructions.includes('node_modules/void/docs/'));
        assert(existsSync(join(fixture, 'node_modules/void/docs/guide/quickstart.md')));
        assert(
          existsSync(join(fixture, '.git')),
          'Init should initialize the accepted Git repository',
        );
        assert.notEqual(
          spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: fixture }).status,
          0,
          'Init must not create an initial commit automatically',
        );
        assert.equal(
          execFileSync('git', ['ls-files'], { cwd: fixture, encoding: 'utf8' }),
          '',
          'Init must not stage files automatically',
        );
        assert.deepEqual(
          execFileSync(
            'git',
            [
              'check-ignore',
              'node_modules/dependency',
              '.env',
              '.env.local',
              '.env.production',
              '.env.example',
            ],
            {
              cwd: fixture,
              encoding: 'utf8',
            },
          )
            .trim()
            .split('\n'),
          ['node_modules/dependency', '.env', '.env.local', '.env.production'],
          'Init must ignore local environment files while allowing the example',
        );
        writeFileSync(
          join(fixture, '.npmrc'),
          `registry=${registry.origin}\nengine-strict=true\n${manager === 'pnpm' ? 'strict-peer-dependencies=true\n' : ''}audit=false\nfund=false\n`,
        );
        const cli = join(fixture, 'node_modules/void/dist/cli/cli.mjs');
        await run(process.execPath, [cli, '--help'], fixture);
        if (full && framework === 'react') {
          await run(
            manager,
            manager === 'npm'
              ? ['install', '--save-dev', `@void/md@${version}`]
              : ['add', '-D', `@void/md@${version}`],
            fixture,
          );
          writeFileSync(
            join(fixture, 'pages/markdown.md'),
            '# Packed Markdown\n\nThe installed Markdown package renders this page.\n',
          );
          const viteConfig = join(fixture, 'vite.config.ts');
          writeFileSync(
            viteConfig,
            `import { voidMarkdown } from '@void/md/plugin';\n` +
              readFileSync(viteConfig, 'utf8').replace(
                /plugins:\s*\[/,
                'plugins: [voidMarkdown(),',
              ),
          );
        }
        const manifest = JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8'));
        if (useVitePlus) {
          assert.equal(
            manifest.devDependencies['vite-plus'],
            `^${vitePlusVersion}`,
            'Vite+ init must match the tested workspace toolchain',
          );
          assert.equal(
            manifest.devDependencies.vite,
            `npm:@voidzero-dev/vite-plus-core@^${vitePlusVersion}`,
            'Vite+ init must use the matching core alias',
          );
          const installedVitePlus = JSON.parse(
            readFileSync(join(fixture, 'node_modules/vite-plus/package.json'), 'utf8'),
          );
          assert.equal(installedVitePlus.name, 'vite-plus');
          assert.equal(
            installedVitePlus.version.split('.')[0],
            vitePlusVersion.split('.')[0],
            'The consumer must use a compatible Vite+ release',
          );
        } else {
          assert(
            !manifest.devDependencies?.['vite-plus'],
            'Plain Vite init must not install Vite+',
          );
          const installedVite = JSON.parse(
            readFileSync(join(fixture, 'node_modules/vite/package.json'), 'utf8'),
          );
          assert.equal(installedVite.name, 'vite');
          assert(installedVite.version.startsWith('8.'), 'The consumer must use public Vite 8');
        }
        assert.equal(
          JSON.parse(readFileSync(join(fixture, 'node_modules/void/package.json'), 'utf8')).version,
          version,
        );
        await run(process.execPath, [cli, 'prepare'], fixture);
        await run(manager, manager === 'npm' ? ['ci'] : ['install', '--frozen-lockfile'], fixture);
        const extension = framework === 'vue' ? 'vue' : framework === 'svelte' ? 'svelte' : 'tsx';
        writeFileSync(join(fixture, `pages/index.${extension}`), pages[framework]);
        writeFileSync(join(fixture, `pages/next.${extension}`), pages[framework]);
        writeFileSync(
          join(fixture, 'pages/index.server.ts'),
          `import { defineHandler } from 'void';\nexport const loader = defineHandler(() => ({ message: 'Packed ${label}' }));\n`,
        );
        writeFileSync(
          join(fixture, 'pages/next.server.ts'),
          `import { defineHandler } from 'void';\nexport const loader = defineHandler(() => ({ message: 'Next ${label}' }));\n`,
        );
        mkdirSync(join(fixture, 'routes/api'), { recursive: true });
        writeFileSync(
          join(fixture, 'routes/api/packed.ts'),
          `import { defineHandler } from 'void';\nimport { kv } from 'void/kv';\nexport const GET = defineHandler(async () => { await kv.put('packed', 'ok'); return { value: await kv.get('packed') }; });\n`,
        );
        // void/email pulls a CommonJS dependency into the Worker; only an installed package shows whether dev serves it.
        writeFileSync(
          join(fixture, 'routes/api/packed-email.ts'),
          `import { defineHandler } from 'void';\nimport { sendEmail } from 'void/email';\nexport const GET = defineHandler(async () => { return sendEmail({ from: 'packed@example.com', to: 'inbox@example.com', subject: 'Packed', text: 'ok' }); });\n`,
        );
        mkdirSync(join(fixture, 'public'), { recursive: true });
        writeFileSync(join(fixture, 'public/packed.txt'), label);
        const vite = join(
          fixture,
          useVitePlus ? 'node_modules/vite-plus/bin/vp' : 'node_modules/vite/bin/vite.js',
        );
        await run(process.execPath, [vite, 'build'], fixture);
        await run(
          process.execPath,
          [join(fixture, 'node_modules/typescript/bin/tsc'), '--noEmit'],
          fixture,
        );
        // The installed package must find and verify every bundled runtime artifact.
        await run(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import { findPackageJSON } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const manifestPath = findPackageJSON('@void/platform', import.meta.resolve('void'));
const entry = JSON.parse(readFileSync(manifestPath, 'utf8')).exports['./installer'].import;
const { resolvePlatformRuntime } = await import(new URL(entry, pathToFileURL(manifestPath)));
const runtime = resolvePlatformRuntime();
if (runtime.manifest.platformVersion !== ${JSON.stringify(version)}) throw new Error('Runtime version mismatch');`,
          ],
          fixture,
        );
        for (const mode of full ? ['dev', 'preview'] : ['dev']) {
          const task = launch(
            process.execPath,
            [vite, mode, '--host', '127.0.0.1', '--port', '0', '--strictPort'],
            fixture,
          );
          try {
            const deadline = Date.now() + 90_000;
            let base;
            let response;
            while (Date.now() < deadline) {
              if (task.child.exitCode !== null) {
                throw new Error(task.failure());
              }
              // Let Vite bind port 0 and report the actual port. Reserving then
              // releasing an ephemeral port lets workerd's RPC listener claim
              // it during config loading; probing it sends HTTP to that RPC.
              base ??= packedServerUrl(task.output());
              if (base) {
                try {
                  response = await fetch(base, { signal: AbortSignal.timeout(2000) });
                  if (response.ok) {
                    break;
                  }
                } catch {
                  /* server is starting */
                }
              }
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
            assert(response?.ok, task.failure());
            assert((await response.text()).includes(`Packed ${label}`));
            assert.equal(await (await fetch(`${base}/packed.txt`)).text(), label);
            const apiResponse = await fetch(`${base}/api/packed`);
            const apiBody = await apiResponse.text();
            assert.equal(apiResponse.status, 200, `${apiBody}\n${task.failure()}`);
            assert.deepEqual(JSON.parse(apiBody), { value: 'ok' });
            const emailResponse = await fetch(`${base}/api/packed-email`);
            const emailBody = await emailResponse.text();
            assert.equal(emailResponse.status, 200, `${emailBody}\n${task.failure()}`);
            // Preview runs the built Worker: no dev inbox and no send binding.
            const email = JSON.parse(emailBody);
            if (mode === 'dev') {
              assert.equal(email.ok, true, emailBody);
            } else {
              assert.equal(email.error?.code, 'BINDING_MISSING', emailBody);
            }
            if (full && framework === 'react') {
              const markdown = await fetch(`${base}/markdown`);
              assert.equal(markdown.status, 200, task.failure());
              assert((await markdown.text()).includes('Packed Markdown'));
            }
            if (!browser) {
              continue;
            }
            const page = await browser.newPage();
            const diagnostics = collectBrowserDiagnostics(page);
            try {
              await page.goto(base);
              // SSR makes the button visible before the client has attached
              // its event handlers. Verify hydration before testing clicks.
              await page.locator('#app[data-hydrated="true"]').waitFor();
              await page.getByRole('button', { name: 'Count 0', exact: true }).click();
              await page.getByRole('button', { name: 'Count 1', exact: true }).waitFor();
              await page.evaluate(() => {
                window.__packedNavigation = 'preserved';
              });
              await page.getByRole('link', { name: 'Next page', exact: true }).click();
              await page.getByRole('heading', { name: `Next ${label}`, exact: true }).waitFor();
              assert.equal(
                await page.evaluate(() => window.__packedNavigation),
                'preserved',
                'Link navigation must preserve the document',
              );
            } catch (error) {
              throw new Error(
                `Packed ${label} ${mode} browser verification failed:\n${String(error.stack ?? error)}\n${diagnostics()}`,
                { cause: error },
              );
            } finally {
              await page.close();
            }
          } finally {
            await task.stop();
          }
        }
        if (framework === 'react') {
          // The Node target bundles the installed void into its build, so a ValidationError from
          // void/handler is the class that page actions check, as in dev.
          await run(
            manager,
            manager === 'npm' ? ['install', '@hono/node-server'] : ['add', '@hono/node-server'],
            fixture,
          );
          writeFileSync(
            join(fixture, 'void.config.ts'),
            "import { defineConfig } from 'void/config';\nexport default defineConfig({ target: 'node' });\n",
          );
          // KV and email are Cloudflare bindings.
          rmSync(join(fixture, 'routes'), { recursive: true });
          writeFileSync(
            join(fixture, 'pages/form.tsx'),
            'export default function Form() {\n  return <h1>Form</h1>;\n}\n',
          );
          writeFileSync(
            join(fixture, 'pages/form.server.ts'),
            "import { defineHandler, ValidationError } from 'void/handler';\nexport const action = defineHandler(() => {\n  throw new ValidationError({ email: 'Email already taken' });\n});\n",
          );
          await run(process.execPath, [vite, 'build'], fixture);
          const task = launch(
            process.execPath,
            [vite, 'preview', '--host', '127.0.0.1', '--port', '0', '--strictPort'],
            fixture,
          );
          try {
            const deadline = Date.now() + 60_000;
            let base;
            while (!base && Date.now() < deadline) {
              if (task.child.exitCode !== null) {
                throw new Error(task.failure());
              }
              base = packedServerUrl(task.output());
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
            assert(base, task.failure());
            const response = await fetch(`${base}/form`, {
              method: 'POST',
              headers: { accept: 'text/html' },
              body: new URLSearchParams({ email: 'taken@example.com' }),
            });
            const body = await response.text();
            assert.equal(response.status, 200, `${body}\n${task.failure()}`);
            assert(body.includes('Email already taken'), body);
          } finally {
            await task.stop();
          }
        }
        console.log(
          `Passed packed ${label} (${suite}): init, frozen install, ${useVitePlus ? 'Vite+' : 'public Vite'} build/typecheck, assets, KV, email, runtime integrity${full ? ', dev/preview, hydration/navigation' : ', dev HTTP'}${framework === 'react' ? ', Node target' : ''}`,
        );
      } catch (error) {
        failures.push({ fixture: label, error: String(error.stack ?? error) });
        console.error(`Failed packed ${label}: ${String(error.stack ?? error)}`);
      }
    }
  }
} finally {
  await browser?.close();
  await registry.close();
}
if (failures.length) {
  const path = join(work, 'failures.json');
  writeFileSync(path, JSON.stringify(failures, null, 2), { mode: 0o600 });
  throw new Error(
    `${failures.length} packed consumer fixture(s) failed. Full diagnostics: ${path}`,
  );
}
console.log(`Packed consumer acceptance passed. Logs and fixtures: ${work}`);
