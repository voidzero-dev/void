import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const scannerRoot = join(packageRoot, '../security-scanner');

/**
 * One Node file with no dependencies (node built-ins stay imports). The controller
 * streams it into the managed scanner image at start (Engine B, design doc 0095 R1
 * option C); the Engine A/C images copy the same file in.
 */
export async function buildSecurityScannerRunner(outputDirectory) {
  await build({
    configFile: false,
    root: scannerRoot,
    publicDir: false,
    logLevel: 'warn',
    build: {
      ssr: join(scannerRoot, 'src/runner/main.ts'),
      outDir: outputDirectory,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      target: 'node22',
      rollupOptions: { output: { format: 'es', entryFileNames: 'runner.mjs' } },
    },
    ssr: { target: 'node', noExternal: true },
  });
  return readFileSync(join(outputDirectory, 'runner.mjs'), 'utf8');
}

/** Bundle the scanner controller Worker (runner inside) so the API uploads fixed code. */
export async function buildSecurityScannerController(outputDirectory = join(packageRoot, 'dist')) {
  const temporary = mkdtempSync(join(tmpdir(), 'void-security-scanner-controller-'));
  try {
    const runner = await buildSecurityScannerRunner(join(temporary, 'runner'));
    const runnerModule = join(temporary, 'runner-source.ts');
    writeFileSync(runnerModule, `export default ${JSON.stringify(runner)};\n`);
    const config = join(temporary, 'wrangler.json');
    writeFileSync(
      config,
      JSON.stringify({
        name: 'void-security-scanner-controller-build',
        main: join(packageRoot, 'src/security-scanner-controller-runtime.ts'),
        compatibility_date: '2026-09-01',
        alias: { 'void:security-scanner-runner-source': runnerModule },
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
      throw new Error(
        `Security scanner controller build failed:\n${result.stdout}\n${result.stderr}`,
      );
    }
    const bundled = readFileSync(
      join(temporary, 'bundle', 'security-scanner-controller-runtime.js'),
      'utf8',
    );
    // The upload carries no source map, so drop the trailing reference to one.
    const mapComment = bundled.lastIndexOf('\n//# sourceMappingURL=');
    const source = mapComment === -1 ? bundled : `${bundled.slice(0, mapComment)}\n`;
    const modulePath = join(outputDirectory, 'security-scanner-controller-source.ts');
    mkdirSync(dirname(modulePath), { recursive: true });
    writeFileSync(modulePath, `export default ${JSON.stringify(source)};\n`);
    return { source, modulePath };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildSecurityScannerController();
}
