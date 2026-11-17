import spawn from 'cross-spawn';
import type { TestProject } from 'vite-plus/test/node';

declare module 'vite-plus/test' {
  export interface ProvidedContext {
    publicBuildMilliseconds: number;
  }
}

export async function preparePublicPackages(root: string): Promise<number> {
  const started = performance.now();
  await new Promise<void>((resolve, reject) => {
    const child = spawn('vp', ['run', 'build'], {
      cwd: root,
      // Clear Vitest's mode so build tools use their production defaults and the same cache
      // fingerprint as a normal `vp run build` outside the test runner.
      env: { ...process.env, NODE_ENV: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-200_000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Public package preparation failed (${code}).\n${output}`));
      }
    });
  });
  return performance.now() - started;
}

/** Restore/build public exports before any integration worker imports them. */
export default async function setup(project: TestProject): Promise<void> {
  const vitest = project.vitest;
  if (vitest.getProvidedContext().publicBuildMilliseconds !== undefined) {
    return;
  }
  const build = async () => {
    vitest.provide('publicBuildMilliseconds', await preparePublicPackages(vitest.config.root));
  };
  await build();
  vitest.onTestsRerun(build);
}
