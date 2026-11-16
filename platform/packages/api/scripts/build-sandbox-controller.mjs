import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

/** Bundle independently so the API can upload identical trusted code for every app. */
export function buildSandboxController(outputDirectory = join(packageRoot, 'dist')) {
  const temporary = mkdtempSync(join(tmpdir(), 'void-sandbox-controller-'));
  try {
    const config = join(temporary, 'wrangler.json');
    writeFileSync(
      config,
      JSON.stringify({
        name: 'void-sandbox-controller-build',
        main: join(packageRoot, 'src/sandbox-controller-runtime.ts'),
        compatibility_date: '2026-02-24',
        compatibility_flags: ['nodejs_compat'],
        alias: {
          'void/_sandbox-container': join(
            packageRoot,
            '../../../packages/void/src/runtime/sandbox/container.ts',
          ),
        },
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(import.meta.resolve('wrangler')),
        'deploy',
        '--dry-run',
        '--config',
        config,
        '--outdir',
        join(temporary, 'bundle'),
        '--minify',
      ],
      { cwd: packageRoot, encoding: 'utf8' },
    );
    if (result.status !== 0) {
      throw new Error(`Sandbox controller build failed:\n${result.stdout}\n${result.stderr}`);
    }
    const source = readFileSync(join(temporary, 'bundle', 'sandbox-controller-runtime.js'), 'utf8');
    const modulePath = join(outputDirectory, 'sandbox-controller-source.ts');
    mkdirSync(dirname(modulePath), { recursive: true });
    writeFileSync(modulePath, `export default ${JSON.stringify(source)};\n`);
    return { source, modulePath };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildSandboxController();
}
