import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path/posix';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const usage = `Usage: node benchmark/scripts/access-token.ts <https-origin>

Print an employee Access JWT to stdout. Uses CF_ACCESS_TOKEN when supplied;
otherwise opens browser login through cf with temporary credential storage.
Login instructions go to stderr; temporary credentials are deleted before returning.`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);

  try {
    const { values, positionals } = parseArgs({
      strict: true,
      allowPositionals: true,
      options: { help: { type: 'boolean', short: 'h' } },
    });
    if (values.help) {
      console.log(usage);
    } else if (positionals.length !== 1) {
      throw new Error(usage);
    } else {
      console.log(await getAccessToken(positionals[0]));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function getAccessToken(origin: string) {
  const url = new URL(origin);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Access authentication requires an HTTPS origin without credentials or a path.',
    );
  }

  function validate(token: string) {
    if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
      throw new Error('Expected a single Access JWT from CF_ACCESS_TOKEN or cf access token.');
    }
    return token;
  }

  if (process.env.CF_ACCESS_TOKEN) {
    return validate(process.env.CF_ACCESS_TOKEN);
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'void-benchmark-access-'));
  let child: ChildProcess | undefined;
  let interrupted = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  function stop(signal: NodeJS.Signals) {
    if (!child?.pid) {
      return;
    }
    try {
      // cf delegates to cloudflared; terminate the whole group before deleting credentials.
      if (process.platform === 'win32') {
        child.kill(signal);
      } else {
        process.kill(-child.pid, signal);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error;
      }
    }
  }
  const onSignal = () => {
    interrupted = true;
    stop('SIGTERM');
    killTimer ??= setTimeout(() => stop('SIGKILL'), 2000);
    killTimer.unref();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  async function command(action: 'login' | 'token') {
    if (interrupted) {
      throw new Error('Access login interrupted.');
    }
    let stdout = '';
    let failure: Error | undefined;
    const code = await new Promise<number | null>((resolve) => {
      child = spawn('cf', ['access', action, url.origin], {
        env: {
          ...process.env,
          NO_COLOR: '1',
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: path.join(home, '.config'),
          XDG_CACHE_HOME: path.join(home, '.cache'),
          XDG_DATA_HOME: path.join(home, '.local/share'),
        },
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Login stdout may contain a JWT, so only forward browser instructions from stderr.
      child.stdout!.on('data', (chunk) => {
        if (action === 'token') {
          stdout += chunk.toString();
        }
      });
      child.stderr!.on('data', (chunk) => {
        if (action === 'login') {
          process.stderr.write(chunk);
        }
      });
      child.on('error', (error) => (failure = error));
      child.on('close', (code) => {
        child = undefined;
        resolve(code);
      });
    });
    if (interrupted) {
      throw new Error('Access login interrupted.');
    }
    if (failure) {
      throw new Error(
        'Could not start cf; install it and ensure it is on PATH, or set CF_ACCESS_TOKEN.',
      );
    }
    if (code !== 0) {
      throw new Error(`Employee Access ${action} failed; retry or supply CF_ACCESS_TOKEN.`);
    }
    return stdout;
  }

  try {
    fs.chmodSync(home, 0o700);
    process.stderr.write(
      'Opening employee Access login; complete authentication in your browser.\n',
    );
    await command('login');
    return validate((await command('token')).trim());
  } finally {
    clearTimeout(killTimer);
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } finally {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
  }
}
