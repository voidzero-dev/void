import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { readBuildOutput } from '@cloudflare/build-output-utils';
import { Miniflare } from 'miniflare';

const benchmark = new URL('../../', import.meta.url);
const cf = fileURLToPath(new URL('./bin/cf', import.meta.resolve('cf/package.json')));

function command(root: string, args: Array<string>) {
  const result = spawnSync(process.execPath, [cf, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NODE_ENV: 'production', VOID_INSPECTOR_PORT: 'false' },
  });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout}\n${result.stderr}`;
}

async function png(
  response: Awaited<ReturnType<Miniflare['dispatchFetch']>>,
  width: number,
  height: number,
) {
  assert.equal(response.status, 200, response.ok ? '' : await response.text());
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(buffer);
  assert.equal(view.getUint32(16), width);
  assert.equal(view.getUint32(20), height);
  return bytes;
}

for (const name of ['baseline-workers', 'baseline-void', 'image-response-bare', 'image-response']) {
  void test(`${name}: production Worker and prebuilt cf upload`, { timeout: 120_000 }, async () => {
    const root = fileURLToPath(new URL(`${name}/`, benchmark));
    command(root, ['build']);
    const output = await readBuildOutput(root);
    assert.deepEqual(Object.keys(output.workers), ['default']);
    assert.deepEqual(output.containers, []);
    const { config, bundleDir, assetsDir } = output.workers.default;
    assert.equal(config.name, `void-perf-${name}`);
    assert.equal(config.compatibilityDate, '2026-11-10');
    assert.deepEqual(config.compatibilityFlags, ['nodejs_als']);
    assert.deepEqual(config.observability, {
      enabled: true,
      logs: { enabled: true, invocationLogs: true, headSamplingRate: 1 },
      traces: { enabled: true, headSamplingRate: 1 },
    });
    assert.equal(config.placement?.mode, 'off');
    assert.equal(config.workersDev, true);
    assert.equal(config.previewUrls, false);
    assert.ok(bundleDir);
    assert.ok(config.manifest);
    const wasm = Object.values(config.manifest.modules).filter((module) => module.type === 'wasm');
    assert.equal(wasm.length, name.startsWith('image-response') ? 1 : 0);
    assert.deepEqual(Object.keys(config.env ?? {}), name === 'baseline-workers' ? [] : ['ASSETS']);

    assert.match(command(root, ['deploy', '--prebuilt', '--dry-run']), /--dry-run: exiting now/);

    const runtime = new Miniflare({
      workers: [
        {
          config: {
            name: config.name,
            compatibilityDate: config.compatibilityDate,
            compatibilityFlags: config.compatibilityFlags,
            manifest: {
              mainModule: config.manifest.mainModule,
              modulesRoot: bundleDir,
              modules: Object.fromEntries(
                Object.entries(config.manifest.modules).map(([path, module]) => {
                  const bytes = readFileSync(`${bundleDir}/${path}`);
                  return [
                    path,
                    {
                      type: module.type,
                      contents:
                        module.type === 'wasm' ? new Uint8Array(bytes) : bytes.toString('utf8'),
                    },
                  ];
                }),
              ),
            },
            ...(assetsDir
              ? {
                  env: { ASSETS: { type: 'assets' } },
                  assets: { ...config.assets, directory: assetsDir, hasUserWorker: true },
                }
              : {}),
          },
        },
      ],
    });
    try {
      async function emptyRoot() {
        // The root ignores image parameters and stays comparable across all fixtures.
        for (const path of ['/', '/?width=0&iterations=-1']) {
          const response = await runtime.dispatchFetch(`http://localhost${path}`);
          assert.equal(response.status, 200);
          assert.equal(response.headers.get('content-type'), null);
          assert.equal(await response.text(), '');
        }
      }

      await emptyRoot();

      if (name === 'image-response') {
        // Exercise the empty path before any render warms the image runtime.
        for (const query of [
          'iterations=0',
          'iterations=0&width=4096&height=4096&text=%F0%9F%8C%8D&fallbackFonts=false',
        ]) {
          const empty = await runtime.dispatchFetch(`http://localhost/run?${query}`);
          assert.equal(empty.status, 200);
          assert.equal(empty.headers.get('content-type'), null);
          assert.equal(empty.headers.get('cache-control'), 'no-store');
          assert.equal(await empty.text(), '');
        }
      }

      if (name === 'image-response-bare') {
        await png(await runtime.dispatchFetch('http://localhost/run'), 64, 64);
      } else if (name === 'image-response') {
        const inter = await png(await runtime.dispatchFetch('http://localhost/run'), 1200, 630);
        const geist = await png(
          await runtime.dispatchFetch('http://localhost/run?defaultFont=Geist&fallbackFonts=false'),
          1200,
          630,
        );
        assert.notDeepEqual(inter, geist);
        const single = await png(
          await runtime.dispatchFetch('http://localhost/run?width=128&height=64'),
          128,
          64,
        );
        const repeated = await png(
          await runtime.dispatchFetch('http://localhost/run?width=128&height=64&iterations=3'),
          128,
          64,
        );
        assert.deepEqual(repeated, single);
        await png(
          await runtime.dispatchFetch(
            'http://localhost/run?width=128&height=64&fallbackFonts=false&text=' +
              encodeURIComponent('<img src="https://127.0.0.1:1/unwanted.png">'),
          ),
          128,
          64,
        );
        for (const query of [
          'emoji=invalid',
          'defaultFont=invalid',
          'iterations=-1',
          'iterations=0&width=0',
          'width=4097',
        ]) {
          const invalid = await runtime.dispatchFetch(`http://localhost/run?${query}`);
          assert.equal(invalid.status, 400);
          assert.equal(invalid.headers.get('cache-control'), 'no-store');
          await invalid.text();
        }
      }

      // Rendering must not change the empty-response route.
      await emptyRoot();
    } finally {
      await runtime.dispose();
    }
  });
}
