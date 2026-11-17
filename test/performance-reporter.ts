import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, platform, release, totalmem } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import type { Reporter, TestModule, Vitest } from 'vite-plus/test/node';

/** Opt-in measurements; this reporter never participates in test selection or result reuse. */
export default class PerformanceReporter implements Reporter {
  private root = process.cwd();
  private output = '';
  private started = 0;
  private vitest: Vitest | undefined;

  onInit(vitest: Vitest): void {
    this.vitest = vitest;
    this.root = vitest.config.root;
    const configured = vitest.config.outputFile;
    this.output = resolve(
      this.root,
      (typeof configured === 'string' ? configured : configured?.performance) ??
        'node_modules/.cache/void-tests/performance.json',
    );
    this.started = performance.now();
  }

  onTestRunEnd(
    modules: ReadonlyArray<TestModule>,
    errors: ReadonlyArray<unknown>,
    reason: string,
  ): void {
    const files = modules.map((module) => {
      const diagnostic = module.diagnostic();
      return {
        project: module.project.name,
        file: relative(this.root, module.moduleId).replaceAll('\\', '/'),
        durationMs: diagnostic.duration,
        collectMs: diagnostic.collectDuration,
        setupMs: diagnostic.setupDuration,
        prepareMs: diagnostic.prepareDuration,
        environmentMs: diagnostic.environmentSetupDuration,
        worker: diagnostic.concurrencyId,
        tests: [...module.children.allTests()].map((test) => ({
          name: test.fullName,
          state: test.result().state,
          durationMs: test.diagnostic()?.duration ?? 0,
        })),
      };
    });
    mkdirSync(dirname(this.output), { recursive: true });
    writeFileSync(
      this.output,
      `${JSON.stringify(
        {
          version: 1,
          recordedAt: new Date().toISOString(),
          durationMs: performance.now() - this.started,
          publicBuildMilliseconds: this.vitest?.getProvidedContext().publicBuildMilliseconds,
          reason,
          unhandledErrors: errors.length,
          machine: {
            node: process.version,
            platform: platform(),
            release: release(),
            arch: process.arch,
            cpu: cpus()[0]?.model,
            parallelism: availableParallelism(),
            memoryBytes: totalmem(),
          },
          files,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`Test performance report: ${this.output}`);
  }
}
