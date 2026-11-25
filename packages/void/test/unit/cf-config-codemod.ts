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
const { resolveAndParseConfig } = await import(process.argv[2]);
const results = [];
for (const { configPath, mode } of JSON.parse(readFileSync(process.argv[3], 'utf8'))) {
  try {
    const migration = await migrateWranglerToCf(configPath, {
      bundler: 'vite', force: true, installDependencies: false,
    });
    const directory = dirname(configPath);
    const generated = readFileSync(join(directory, 'cloudflare.config.ts'), 'utf8');
    const executable = generated.replace(/^throw new Error\("Migration incomplete\.[^\n]*\);\s*$/m, '');
    const executablePath = join(directory, 'cloudflare.config.mjs');
    writeFileSync(executablePath, executable);
    const input = (await import(pathToFileURL(executablePath).href)).default;
    const parsed = await resolveAndParseConfig(input, { isPreview: false, mode });
    results.push({
      config: parsed.success ? parsed.data : null,
      followUps: migration.followUps,
    });
  } catch (error) {
    results.push({ error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  }
}
process.stdout.write(JSON.stringify(results));
`;

export type CodemodTranslation = {
  config: unknown;
  followUps: Array<{ blocking: boolean; code: string; message: string; sourcePath?: string }>;
};

/**
 * Translates Wrangler-format settings with the installed `@cloudflare/codemods`: for each input
 * it migrates a `wrangler.json` in its own scratch project, runs the `cloudflare.config.ts` it
 * writes and parses the result with `@cloudflare/config`. Void's own translation must give the
 * same configuration. `config` is null when cf rejects the generated configuration.
 *
 * One process translates every input: starting the codemod costs far more than a translation.
 * An input the codemod cannot translate gives an `Error` in its place.
 */
export async function translateWithCodemod(
  inputs: ReadonlyArray<{ raw: Record<string, unknown>; mode: string }>,
): Promise<Array<CodemodTranslation | Error>> {
  const cfPackage = fileURLToPath(import.meta.resolve('cf/package.json'));
  const root = mkdtempSync(join(tmpdir(), 'void-cf-codemod-'));
  try {
    const projects = inputs.map(({ raw, mode }, index) => {
      const directory = join(root, String(index));
      mkdirSync(join(directory, 'node_modules'), { recursive: true });
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
      return { configPath, mode };
    });
    const projectsPath = join(root, 'projects.json');
    writeFileSync(projectsPath, JSON.stringify(projects));
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        script,
        import.meta.resolve('@cloudflare/codemods'),
        import.meta.resolve('@cloudflare/config'),
        projectsPath,
      ],
      { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
    );
    return (JSON.parse(stdout) as Array<CodemodTranslation | { error: string }>).map((result) =>
      'error' in result ? new Error(result.error) : result,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
