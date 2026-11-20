/**
 * Shared bits of the local security spikes (S7, S9, S11; design doc 0095 "Phase 0 spikes").
 *
 * The spikes run the real API Worker code (`platform/packages/api/src/security/*`, the
 * scanner controller) in plain Node. Two things Node cannot load on its own:
 *   - TypeScript parameter properties in some API files (strip-only mode refuses them),
 *     so the script runs again with `--experimental-transform-types`;
 *   - Worker-only imports: `cloudflare:workers` (stand-in base classes, the same ones the
 *     unit tests mock) and the build-time `void:*` sources (a one-line comment).
 * Nothing here changes product code; the stand-ins only exist inside the spike process.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = fileURLToPath(new URL('../../', import.meta.url));

const WORKERS_STUB = [
  'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
  'export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
  'export const env = {};',
].join('\n');

const HOOKS = `import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') {
      return { url: 'data:text/javascript,' + ${JSON.stringify(encodeURIComponent(WORKERS_STUB))}, shortCircuit: true };
    }
    if (specifier.startsWith('void:')) {
      return { url: 'data:text/javascript,export%20default%20%22%2F%2F%20spike%20stub%22', shortCircuit: true };
    }
    // Database packages the API test helpers use, resolved from the API package.
    if (specifier.startsWith('drizzle-orm') || specifier.startsWith('@electric-sql/pglite')) {
      return next(specifier, { ...context, parentURL: ${JSON.stringify(new URL('../packages/api/package.json', import.meta.url).href)} });
    }
    return next(specifier, context);
  },
});`;

const MARKER = 'VOID_SECURITY_SPIKE_LOADER';

/**
 * Runs this script again with the loader when it is not there yet, and exits with the
 * child's code. Call it before any dynamic `import()` of API code.
 */
export function relaunchWithLocalLoader(scriptUrl: string): void {
  if (process.env[MARKER] === '1') {
    return;
  }
  // The hooks go in a file: a long `data:` URL on the command line was killed (SIGKILL) here.
  const dir = mkdtempSync(join(tmpdir(), 'void-spike-loader-'));
  const hooks = join(dir, 'hooks.mjs');
  writeFileSync(hooks, HOOKS);
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-transform-types',
      '--no-warnings',
      `--import=${pathToFileURL(hooks).href}`,
      fileURLToPath(scriptUrl),
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: { ...process.env, [MARKER]: '1' } },
  );
  rmSync(dir, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}

export type SpikeCheck = { name: string; ok: boolean; detail?: unknown };

/** Prints the one JSON report and the PASS/FAIL line; sets the exit code. */
export function finishSpike(
  spike: string,
  report: Record<string, unknown>,
  checks: ReadonlyArray<SpikeCheck>,
): void {
  const failed = checks.filter((check) => !check.ok);
  const out = {
    spike,
    ranAt: new Date().toISOString(),
    pass: failed.length === 0,
    checks: { total: checks.length, failed: failed.length },
    ...report,
    failedChecks: failed,
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.stdout.write(
    `${failed.length === 0 ? 'PASS' : 'FAIL'} ${spike}: ${checks.length - failed.length}/${checks.length} checks hold\n`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}
