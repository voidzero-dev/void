import type { BaseSequencer, TestSpecification, Vitest } from 'vite-plus/test/node';
import { integrationTimings } from './integration-timings.ts';
import { balanceTests, compareKeys, shuffleTests, testFileKey } from './test-sharding.ts';

/** Balance shards and schedule each phase by cost across project boundaries. */
export class SuiteSequencer {
  private readonly ctx: Vitest;
  private baseSequencer: BaseSequencer | undefined;

  constructor(ctx: Vitest) {
    this.ctx = ctx;
  }

  private async base(): Promise<BaseSequencer> {
    // The config is also loaded by ordinary build commands. Only the test
    // runner needs to pay the startup cost of importing Vitest's Node API.
    this.baseSequencer ??= new (await import('vite-plus/test/node')).BaseSequencer(this.ctx);
    return this.baseSequencer;
  }
  private key(test: TestSpecification): string {
    return testFileKey(test.moduleId, this.ctx.config.root);
  }

  private duration(test: TestSpecification): number {
    return integrationTimings[this.key(test)] ?? 5000;
  }

  async shard(tests: Array<TestSpecification>): Promise<Array<TestSpecification>> {
    const shard = this.ctx.config.shard;
    if (!shard || tests.some((test) => test.project.name !== 'parallel-integration')) {
      return (await this.base()).shard(tests);
    }
    return balanceTests(
      tests,
      shard.count,
      (test) => this.key(test),
      (test) => this.duration(test),
    )[shard.index - 1];
  }

  async sort(tests: Array<TestSpecification>): Promise<Array<TestSpecification>> {
    const sequence = this.ctx.config.sequence;
    if (sequence.shuffle) {
      const stable = [...tests].sort((a, b) =>
        compareKeys(`${a.project.name}:${this.key(a)}`, `${b.project.name}:${this.key(b)}`),
      );
      return shuffleTests(stable, sequence.seed);
    }
    const sorted = await (await this.base()).sort(tests);
    const results = new Map(
      sorted.map((test) => [test, this.ctx.cache.getTestSpecificationResult(test)]),
    );
    const cost = (test: TestSpecification) =>
      results.get(test)?.duration ??
      (test.project.name === 'parallel-integration' ? this.duration(test) : 5000);
    // BaseSequencer puts project names ahead of duration. That leaves expensive
    // unit files queued behind integration builds even when they share a phase.
    // Preserve phase barriers and failure priority, then fill the shared workers
    // longest-first. Base ordering breaks ties (including cold file-size order).
    return sorted.sort(
      (a, b) =>
        a.project.config.sequence.groupOrder - b.project.config.sequence.groupOrder ||
        Number(results.get(b)?.failed ?? false) - Number(results.get(a)?.failed ?? false) ||
        cost(b) - cost(a),
    );
  }
}
