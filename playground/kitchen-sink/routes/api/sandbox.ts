import { defineHandler } from 'void';
import { UsageLimit } from 'void/limits';
import { getSandbox, type SandboxClient } from 'void/sandbox';
import { sampleRequests } from '../../lib/sandbox-demo.ts';

const MAX_CODE_LENGTH = 8000;
const WORKDIR = '/workspace/void-kitchen-sink-code-lab';

const RUNNER = `import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const codeUrl = pathToFileURL("./user-code.mjs").href + "?t=" + Date.now();
const mod = await import(codeUrl);

if (typeof mod.default !== "function") {
  throw new Error("Expected user-code.mjs to export a default function.");
}

const input = JSON.parse(await readFile("./input.json", "utf8"));
const startedAt = Date.now();
const value = await mod.default(input.requests);
const output = {
  value,
  elapsedMs: Date.now() - startedAt,
};

await writeFile("./output.json", JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
`;

export const POST = defineHandler(async (c) => {
  const body = await c.req.json<{ code?: unknown }>().catch(() => null);
  const code = typeof body?.code === 'string' ? body.code : '';

  if (!code.trim()) {
    return c.json({ ok: false, error: 'Code is required.' }, 400);
  }

  if (code.length > MAX_CODE_LENGTH) {
    return c.json(
      {
        ok: false,
        error: `Code must be ${MAX_CODE_LENGTH.toLocaleString()} characters or less.`,
      },
      400,
    );
  }

  let sandbox: SandboxClient | undefined;
  try {
    // Programs from concurrent callers must never share files or processes.
    sandbox = await getSandbox(`kitchen-sink-${crypto.randomUUID()}`, {
      inactivityTimeoutMs: 30_000,
    });

    await sandbox.files.mkdir(WORKDIR, { recursive: true });
    await sandbox.files.writeFile(
      `${WORKDIR}/input.json`,
      JSON.stringify({ requests: sampleRequests }, null, 2),
    );
    await sandbox.files.writeFile(`${WORKDIR}/user-code.mjs`, code);
    await sandbox.files.writeFile(`${WORKDIR}/run.mjs`, RUNNER);

    const started = performance.now();
    const result = await sandbox.run(['node', 'run.mjs'], {
      cwd: WORKDIR,
      signal: AbortSignal.timeout(5000),
      env: {
        NODE_OPTIONS: '--disable-proto=throw',
      },
    });
    let output: unknown = null;
    if (result.exitCode === 0) {
      const file = await sandbox.files.readFile(`${WORKDIR}/output.json`);
      output = await file.json();
    }

    return c.json({
      ok: result.exitCode === 0,
      output,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
      exitCode: result.exitCode,
      duration: performance.now() - started,
    });
  } catch (err) {
    if (err instanceof UsageLimit) {
      return err.response({
        message:
          err.reason === 'concurrency'
            ? 'All runners are busy. Your code has been kept; try again shortly.'
            : 'The execution allowance is exhausted. Your code has been kept.',
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: message }, 500);
  } finally {
    if (sandbox) {
      try {
        await sandbox.destroy();
      } catch (error) {
        // Preserve the execution result. The bounded idle timeout still stops
        // the container if a transient provider error prevents explicit cleanup.
        console.error('[sandbox] cleanup failed', error);
      }
    }
  }
});
