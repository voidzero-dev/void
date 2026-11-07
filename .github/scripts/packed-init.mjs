import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path/posix';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Drive a real terminal using the OS PTY utility, without a native npm dependency. */
export function runPty(
  argv,
  { cwd, env, prompts, timeoutMs = 240_000, onOutput = (data) => process.stdout.write(data) },
) {
  assert(
    ['darwin', 'linux'].includes(process.platform),
    'Packed initialization requires macOS or Linux',
  );
  const command = `stty cols 180 rows 40; exec ${argv.map(quote).join(' ')}`;
  const args =
    process.platform === 'darwin'
      ? ['-q', '/dev/null', 'sh', '-c', command]
      : ['-q', '-e', '-f', '-c', command, '/dev/null'];

  return new Promise((resolveRun, reject) => {
    // BSD script needs a real pipe instead of Node's macOS socket pair. Only
    // bridge stdin there: on Linux the extra cat retains the output descriptors
    // after script exits, so Node never receives the child's close event.
    const child = spawn(
      process.platform === 'darwin' ? 'bash' : 'script',
      process.platform === 'darwin'
        ? ['-c', 'exec "$@" < <(cat 2>/dev/null)', 'packed-init', 'script', ...args]
        : args,
      {
        cwd,
        env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const seen = new Set();
    let buffer = '';
    let failure;
    let force;
    let finished = false;
    const stop = (message) => {
      failure ??= new Error(message);
      if (finished || force) {
        return;
      }
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already exited */
      }
      force = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already exited */
        }
      }, 5000);
    };
    const interrupt = () => stop('Packed initializer interrupted');
    const timeout = setTimeout(
      () => stop('The initializer stalled or introduced an unhandled prompt'),
      timeoutMs,
    );
    process.on('SIGTERM', interrupt);
    process.on('SIGINT', interrupt);

    const finish = (error) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      clearTimeout(force);
      process.off('SIGTERM', interrupt);
      process.off('SIGINT', interrupt);
      child.stdin.destroy();
      if (error) {
        reject(error);
      } else {
        resolveRun();
      }
    };
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (data) => {
        onOutput(data);
        buffer = (buffer + data.toString()).slice(-131072);
        const plain = stripVTControlCharacters(buffer);
        for (const prompt of prompts) {
          if (!seen.has(prompt.text) && plain.includes(prompt.text)) {
            seen.add(prompt.text);
            child.stdin.write(prompt.response);
          }
        }
      });
    }
    child.stdin.on('error', () => stop('The initializer closed its terminal input'));
    child.once('error', finish);
    child.once('close', (code, signal) => {
      const missing = prompts.find((prompt) => prompt.required !== false && !seen.has(prompt.text));
      finish(
        failure ??
          (code !== 0
            ? new Error(`Initializer exited with ${code ?? signal}`)
            : missing
              ? new Error(`The initializer skipped ${missing.text}`)
              : undefined),
      );
    });
  });
}

export async function initializePackedProject(
  directory,
  framework,
  manager,
  version,
  toolchain = 'vite',
) {
  const frameworks = ['react', 'vue', 'svelte', 'solid', 'hono'];
  assert(frameworks.includes(framework), 'Unknown Pages framework');
  assert(['npm', 'pnpm'].includes(manager), 'Unknown package manager');
  assert(['vite', 'vite-plus'].includes(toolchain), 'Unknown toolchain');
  assert(
    /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(version),
    'Invalid package version',
  );
  const env = { ...process.env, TERM: 'xterm-256color' };
  delete env.CI;
  const root = resolve(directory);
  const argv =
    manager === 'npm'
      ? [
          'npm',
          'exec',
          '--yes',
          `--package=create-void@${version}`,
          '--',
          'create-void',
          basename(root),
        ]
      : ['pnpm', 'dlx', `create-void@${version}`, basename(root)];
  await runPty(argv, {
    cwd: dirname(root),
    env,
    prompts: [
      { text: 'Initialize a git repository?', response: '\r' },
      {
        text: 'Choose a Pages scaffold toolchain:',
        response: toolchain === 'vite-plus' ? '\r' : '\x1b[B\r',
      },
      {
        text: 'Choose a Pages framework to scaffold:',
        response: '\x1b[B'.repeat(frameworks.indexOf(framework)) + '\r',
      },
      { text: 'Choose a Pages starter:', response: '\r' },
      {
        text: 'Could not detect your coding agent. Which one are you using?',
        response: '\x1b[B'.repeat(4) + '\r',
        required: false,
      },
      { text: 'Where should this project deploy?', response: '\x1b[B\x1b[B\r' },
    ],
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  initializePackedProject(...process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
