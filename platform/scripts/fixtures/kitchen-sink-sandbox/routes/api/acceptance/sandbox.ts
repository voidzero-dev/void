import { defineHandler } from 'void';
import { env } from 'void/env';
import { getSandbox, SandboxLimitError } from 'void/sandbox';
import type { SandboxClient } from 'void/sandbox';
import { internetAccessProbe } from '../../../lib/internet-probe.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export const POST = defineHandler(async (c) => {
  const secret = env.SECRET_KEY;
  if (typeof secret !== 'string' || !secret || c.req.header('x-void-e2e-token') !== secret) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const started = Date.now();
  const id = `acceptance-${crypto.randomUUID()}`;
  const root = '/workspace/void-acceptance';
  const clients: Array<SandboxClient> = [];
  const checks: Array<string> = [];
  try {
    const sandbox = await getSandbox(id, {
      inactivityTimeoutMs: 30_000,
      enableInternet: false,
      labels: { purpose: 'void-acceptance' },
    });
    clients.push(sandbox);
    assert(!(await sandbox.running()), 'Resolving a fresh Sandbox must not start it');
    checks.push('lazy start');

    await sandbox.files.mkdir(root, { recursive: true });
    await sandbox.files.writeFile(`${root}/text.txt`, 'text content');
    await sandbox.files.writeFile(`${root}/bytes.bin`, new Uint8Array([0, 1, 127, 255]));
    await sandbox.files.writeFile(`${root}/blob.txt`, new Blob(['blob content']));
    await sandbox.files.writeFile(`${root}/stream.txt`, new Blob(['stream content']).stream());
    await sandbox.files.writeFile('relative.txt', 'relative content', { cwd: root });
    assert(await sandbox.running(), 'File operations must start the container');
    assert(
      (await (await sandbox.files.readFile(`${root}/text.txt`)).text()) === 'text content',
      'Text round trip failed',
    );
    const bytes = new Uint8Array(
      await (await sandbox.files.readFile(`${root}/bytes.bin`)).arrayBuffer(),
    );
    assert(bytes.join(',') === '0,1,127,255', 'Binary round trip failed');
    assert(
      (await (await sandbox.files.readFile(`${root}/blob.txt`)).text()) === 'blob content',
      'Blob round trip failed',
    );
    assert(
      (await (await sandbox.files.readFile(`${root}/stream.txt`)).text()) === 'stream content',
      'Stream round trip failed',
    );
    assert(
      (await (await sandbox.files.readFile('relative.txt', { cwd: root })).text()) ===
        'relative content',
      'Relative path round trip failed',
    );
    checks.push('text, binary, Blob, stream, relative files');

    const stat = await sandbox.files.stat(`${root}/text.txt`);
    assert(
      stat.type === 'file' && stat.size === 12n && stat.modifiedAt instanceof Date,
      'File stat metadata failed',
    );
    await sandbox.files.rename(`${root}/text.txt`, `${root}/renamed.txt`);
    const entries = await sandbox.files.readDirectory(root);
    assert(
      entries.some(({ name }) => name === 'renamed.txt') &&
        !entries.some(({ name }) => name === 'text.txt'),
      'Directory listing or rename failed',
    );
    await sandbox.files.remove(`${root}/renamed.txt`);
    assert(
      !(await sandbox.files.readDirectory(root)).some(({ name }) => name === 'renamed.txt'),
      'File removal failed',
    );
    checks.push('mkdir, stat, rename, list, remove');

    const command = await sandbox.exec(
      [
        'node',
        '-e',
        'console.log(process.cwd()); console.log(process.env.VOID_ACCEPTANCE); console.error("stderr marker");',
      ],
      {
        cwd: root,
        env: { VOID_ACCEPTANCE: id },
        signal: AbortSignal.timeout(10_000),
      },
    );
    const output = await command.output();
    const stdout = new TextDecoder().decode(output.stdout);
    assert(
      output.exitCode === 0 && stdout.includes(root) && stdout.includes(id),
      'Execution cwd, env, or stdout failed',
    );
    assert(
      new TextDecoder().decode(output.stderr).includes('stderr marker'),
      'Execution stderr failed',
    );
    checks.push('exec, cwd, env, stdout, stderr, exitCode');

    const pipe = await sandbox.exec(['cat'], {
      stdin: 'pipe',
      signal: AbortSignal.timeout(10_000),
    });
    assert(pipe.stdin, 'Piped stdin is missing');
    const writer = pipe.stdin.getWriter();
    const collected = pipe.output();
    await writer.write(new TextEncoder().encode('stdin marker'));
    await writer.close();
    const pipedOutput = await collected;
    assert(
      pipedOutput.exitCode === 0 && new TextDecoder().decode(pipedOutput.stdout) === 'stdin marker',
      'Piped stdin failed',
    );
    checks.push('stdin pipe');

    const long = await sandbox.exec(['node', '-e', 'setTimeout(() => {}, 60000)'], {
      pty: { cols: 80, rows: 24 },
    });
    assert(long.isPty, 'PTY was not created');
    await long.resize(100, 30);
    await long.kill(9);
    assert((await long.exitCode) !== 0, 'Killed process returned success');
    checks.push('PTY, resize, kill');

    const abort = new AbortController();
    const cancellable = await sandbox.exec(['node', '-e', 'setTimeout(() => {}, 60000)'], {
      signal: abort.signal,
    });
    abort.abort();
    assert((await cancellable.exitCode) !== 0, 'Aborted process returned success');
    checks.push('AbortSignal cancellation');

    const server = await sandbox.exec(
      [
        'node',
        '-e',
        'require("node:http").createServer((req,res) => { res.setHeader("content-type", "text/plain"); res.end(req.url); }).listen(8080, "0.0.0.0", () => console.log("ready"));',
      ],
      { signal: AbortSignal.timeout(15_000) },
    );
    assert(server.stdout, 'Server stdout is missing');
    const ready = server.stdout.getReader();
    await ready.read();
    ready.releaseLock();
    const response = await sandbox.fetch(8080, new Request('http://sandbox/acceptance?test=1'));
    assert(
      response.status === 200 && (await response.text()) === '/acceptance?test=1',
      'Sandbox port fetch failed',
    );
    await server.kill(9);
    await server.exitCode;
    checks.push('HTTP port fetch');

    const blocked = await sandbox.exec(internetAccessProbe, {
      signal: AbortSignal.timeout(10_000),
    });
    const blockedOutput = await blocked.output();
    assert(
      blockedOutput.exitCode === 0,
      `Disabled Internet probe failed (exit ${blockedOutput.exitCode})`,
    );
    checks.push('Internet disabled');

    const isolated = await getSandbox(`${id}-other`, {
      inactivityTimeoutMs: 30_000,
      enableInternet: true,
    });
    clients.push(isolated);
    const isolation = await isolated.exec(['sh', '-c', `test ! -e ${root}/bytes.bin`]);
    assert(
      (await isolation.output()).exitCode === 0,
      'A second Sandbox can see the first Sandbox files',
    );
    checks.push('separate ID isolation');
    const internet = await isolated.exec(internetAccessProbe, {
      signal: AbortSignal.timeout(15_000),
    });
    const internetOutput = await internet.output();
    assert(
      internetOutput.exitCode === 1,
      `Enabled Internet probe did not receive an HTTP response (exit ${internetOutput.exitCode})`,
    );
    checks.push('Internet enabled');
    await isolated.destroy();

    await sandbox.destroy();
    assert(!(await sandbox.running()), 'Destroy did not stop the container');
    const restarted = await sandbox.exec(['sh', '-c', `test ! -e ${root}/bytes.bin`]);
    assert(
      (await restarted.output()).exitCode === 0,
      'Container files survived a destroy and restart',
    );
    checks.push('destroy, restart, ephemeral files');
    return c.json({ ok: true, checks, durationMs: Date.now() - started });
  } catch (error) {
    return c.json(
      { ok: false, checks, error: error instanceof Error ? error.message : String(error) },
      error instanceof SandboxLimitError ? 429 : 500,
    );
  } finally {
    await Promise.all(
      clients.map((client) =>
        client
          .destroy()
          .catch((error) => console.error('[sandbox acceptance] cleanup failed', error)),
      ),
    );
  }
});
