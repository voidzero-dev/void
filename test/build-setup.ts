import spawn from 'cross-spawn';
import type { TestProject } from 'vite-plus/test/node';

declare module 'vite-plus/test' {
  export interface ProvidedContext {
    publicBuildMilliseconds: number;
  }
}

/** Restore/build public exports before any test worker imports them. */
export default async function setup(project: TestProject): Promise<void> {
  const vitest = project.vitest;
  if (vitest.getProvidedContext().publicBuildMilliseconds !== undefined) {
    return;
  }
  const build = async () => {
    const started = performance.now();
    await new Promise<void>((resolve, reject) => {
      const child = spawn('vp', ['run', 'build'], {
        cwd: vitest.config.root,
        env: { ...process.env, NODE_ENV: 'production' },
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
    vitest.provide('publicBuildMilliseconds', performance.now() - started);
  };
  await build();
  vitest.onTestsRerun(build);
}
