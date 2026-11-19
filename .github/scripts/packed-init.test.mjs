import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path/posix';
import { test } from 'node:test';
import { runPty } from './packed-init.mjs';

void test('drives a real PTY and preserves quoted arguments', async () => {
  const cwd = mkdtempSync(join(tmpdir(), "void-pty-'quoted'-"));
  let output = '';
  const literal = "a 'quoted' $(printf should-not-run) value";
  try {
    await runPty(
      [
        process.execPath,
        '-e',
        `
      if (!process.stdin.isTTY) process.exit(9);
      console.log(process.argv[1]);
      process.stdin.setRawMode(true);
      process.stdout.write('Choose a value:');
      process.stdin.once('data', (data) => {
        console.log('answer=' + data.toString().trim());
        process.exit(data.toString().startsWith('ok') ? 0 : 8);
      });
    `,
        literal,
      ],
      {
        cwd,
        env: process.env,
        prompts: [{ text: 'Choose a value:', response: 'ok\r' }],
        onOutput: (data) => {
          output += data;
        },
      },
    );
    assert(output.includes(literal));
    assert(output.includes('answer=ok'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

void test('propagates child failure and detects missing prompts', async () => {
  const options = { cwd: tmpdir(), env: process.env, prompts: [], onOutput() {} };
  await assert.rejects(
    runPty([process.execPath, '-e', 'process.exit(7)'], options),
    /exited with 7/,
  );
  await assert.rejects(
    runPty([process.execPath, '-e', 'process.exit(0)'], {
      ...options,
      prompts: [{ text: 'Required prompt', response: '\r' }],
    }),
    /skipped Required prompt/,
  );
});

void test('terminates a stalled initializer', { timeout: 8000 }, async () => {
  await assert.rejects(
    runPty([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
      cwd: tmpdir(),
      env: process.env,
      prompts: [],
      timeoutMs: 300,
      onOutput() {},
    }),
    /initializer stalled/,
  );
});
