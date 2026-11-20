import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const script = String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { migrateWranglerToCf } = await import(process.argv[1]);
const configPath = process.argv[2];
const migration = await migrateWranglerToCf(configPath, {
  bundler: 'vite', force: true, installDependencies: false,
});
const directory = dirname(configPath);
const generated = readFileSync(join(directory, 'cloudflare.config.ts'), 'utf8');
const executable = generated.replace(/^throw new Error\("Migration incomplete\.[^\n]*\);\s*$/m, '');
const executablePath = join(directory, 'cloudflare.config.mjs');
writeFileSync(executablePath, executable);
const input = (await import(pathToFileURL(executablePath).href)).default;
const { resolveAndParseConfig } = await import(process.argv[3]);
const parsed = await resolveAndParseConfig(input, { isPreview: false, mode: process.argv[4] });
process.stdout.write(JSON.stringify({
  config: parsed.success ? parsed.data : null,
  followUps: migration.followUps,
}));
`;

/**
 * Translates Wrangler-format settings with the installed `@cloudflare/codemods`: it migrates a
 * `wrangler.json` in a scratch project, runs the `cloudflare.config.ts` it writes and parses the
 * result with `@cloudflare/config`. Void's own translation must give the same configuration.
 * `config` is null when cf rejects the generated configuration.
 */
export async function translateWithCodemod(
  raw: Record<string, unknown>,
  mode: string,
): Promise<{
  config: unknown;
  followUps: Array<{ blocking: boolean; code: string; message: string; sourcePath?: string }>;
}> {
  const cfPackage = fileURLToPath(import.meta.resolve('cf/package.json'));
  const directory = mkdtempSync(join(tmpdir(), 'void-cf-codemod-'));
  try {
    mkdirSync(join(directory, 'node_modules'));
    symlinkSync(dirname(cfPackage), join(directory, 'node_modules', 'cf'), 'junction');
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'void-codemod-reference',
        private: true,
        type: 'module',
        dependencies: { cf: '1.0.0', '@cloudflare/vite-plugin': '1.0.0' },
      }),
    );
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(configPath, JSON.stringify(raw));
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        script,
        import.meta.resolve('@cloudflare/codemods'),
        configPath,
        import.meta.resolve('@cloudflare/config'),
        mode,
      ],
      { cwd: directory, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
    );
    return JSON.parse(stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
