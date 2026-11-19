import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path/posix';
import { test } from 'node:test';
import { packedServerUrl } from './packed-server.mjs';

void test('waits for the bound Local URL, including colored output', () => {
  assert.equal(packedServerUrl('RPC listening on http://127.0.0.1:36939/'), undefined);
  assert.equal(packedServerUrl('Local: http://127.0.0.1:0/'), undefined);
  assert.equal(
    packedServerUrl('\u001b[32m➜\u001b[39m Local: \u001b[36mhttp://127.0.0.1:5173/\u001b[39m'),
    'http://127.0.0.1:5173',
  );
});

for (const mode of ['dev', 'preview']) {
  void test(`discovers Vite's actual ${mode} port without probing a competing listener`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-packed-server-'));
    const competing = createServer();
    let probes = 0;
    competing.on('connection', (socket) => {
      probes++;
      socket.destroy();
    });
    competing.listen(0, '127.0.0.1');
    await once(competing, 'listening');
    const occupiedPort = competing.address().port;
    mkdirSync(join(directory, 'dist'));
    for (const output of [directory, join(directory, 'dist')]) {
      writeFileSync(join(output, 'index.html'), '<h1>Packed server</h1>');
      const assets = mode === 'dev' ? join(output, 'public') : output;
      mkdirSync(assets, { recursive: true });
      writeFileSync(join(assets, 'packed.txt'), 'Packed asset');
    }
    const script = `
      const { createServer, preview } = await import(${JSON.stringify(import.meta.resolve('vite'))});
      const options = { host: '127.0.0.1', port: 0, strictPort: true };
      const server = ${
        mode === 'dev'
          ? 'await createServer({ server: options }); await server.listen();'
          : 'await preview({ preview: options });'
      }
      server.printUrls();
      process.once('SIGTERM', async () => { await server.close(); process.exit(0); });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    let output = '';
    const ready = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(new Error(`Vite exited before binding:\n${output}`)));
      for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', (chunk) => {
          output += String(chunk);
          const url = packedServerUrl(output);
          if (url) {
            resolve(url);
          }
        });
      }
    });
    try {
      const base = await ready;
      assert.notEqual(Number(new URL(base).port), 0);
      assert.notEqual(Number(new URL(base).port), occupiedPort);
      const response = await fetch(base);
      assert.equal(response.status, 200);
      assert((await response.text()).includes('Packed server'));
      assert.equal(await (await fetch(`${base}/packed.txt`)).text(), 'Packed asset');
      assert.equal(probes, 0);
    } finally {
      child.kill('SIGTERM');
      await closed;
      await new Promise((resolve) => competing.close(resolve));
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
