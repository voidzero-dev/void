import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { log } from '@voidzero-dev/vite-plus-prompts';
import { formatCloudflareUserMessage } from './cloudflare-user-output.ts';
import { Buffer } from './node-buffer.ts';

const CHILD_COMMAND = '__void-db-execute-json__';
const RESULT_FD = 3;

/** Keep config output on stderr, including writes to fd 1 and output from its children. */
export async function runDbExecuteProcess(
  root: string,
  args: ReadonlyArray<string>,
): Promise<void> {
  const child = spawn(
    process.execPath,
    [...process.execArgv, import.meta.filename, CHILD_COMMAND, process.argv[1], ...args],
    {
      cwd: root,
      stdio: ['inherit', 2, 'inherit', 'pipe'],
    },
  );
  const chunks: Array<Buffer> = [];
  child.stdio[RESULT_FD]?.on('data', (chunk: Buffer) => chunks.push(chunk));

  // Also forward signals sent to the parent PID alone, as process supervisors do.
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) => {
        resolve(signal ? 128 + constants.signals[signal] : (status ?? 1));
      });
    });
    if (code !== 0) {
      process.exitCode = code;
    } else if (chunks.length > 0) {
      process.stdout.write(Buffer.concat(chunks));
    }
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

if (process.argv[2] === CHILD_COMMAND) {
  try {
    // Keep the CLI arguments visible to project config evaluated by this process.
    process.argv.splice(1, 2);
    const { parseDbArgs } = await import('./db-args.ts');
    const args = parseDbArgs(process.argv.slice(3));
    const { runDbCommand } = await import('./db.ts');
    await runDbCommand(process.cwd(), args, (text) => writeFileSync(RESULT_FD, text));
  } catch (error) {
    log.error(formatCloudflareUserMessage(error instanceof Error ? error.message : String(error)), {
      output: process.stderr,
    });
    process.exitCode = 1;
  }
}
