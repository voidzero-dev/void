import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vite-plus/test';
import { scanQueuesSync } from '../../src/queues/scan.ts';

describe('scanQueuesSync', () => {
  let root: string;
  let queuesDir: string;

  beforeEach(() => {
    root = join(tmpdir(), `queue-scan-test-${Date.now()}`);
    queuesDir = join(root, 'queues');
    mkdirSync(queuesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('extracts all consumer options together', () => {
    writeFileSync(
      join(root, 'queues', 'full.ts'),
      `import { defineQueue } from "void";
export const maxBatchSize = 50;
export const maxBatchTimeout = 10;
export const maxRetries = 3;
export const retryDelay = 60;
export default defineQueue(async (batch, env) => {});`,
    );

    const queues = scanQueuesSync(queuesDir);
    expect(queues).toHaveLength(1);
    expect(queues[0].maxBatchSize).toBe(50);
    expect(queues[0].maxBatchTimeout).toBe(10);
    expect(queues[0].maxRetries).toBe(3);
    expect(queues[0].retryDelay).toBe(60);
  });

  it('ignores options mentioned only in comments and strings', () => {
    writeFileSync(
      join(root, 'queues', 'basic.ts'),
      `// export const maxBatchSize = 99;
const example = 'export const retryDelay = 50';
export const maxRetries = 3 as const;
export default async () => {};`,
    );
    expect(scanQueuesSync(queuesDir)).toMatchObject([
      { maxBatchSize: undefined, maxRetries: 3, retryDelay: undefined },
    ]);
  });

  it('rejects a nonliteral consumer option instead of reading a numeric prefix', () => {
    writeFileSync(
      join(root, 'queues', 'basic.ts'),
      'export const maxBatchSize = 2 + 3; export default async () => {};',
    );
    expect(() => scanQueuesSync(queuesDir)).toThrow('maxBatchSize');
  });

  it.each([
    ['a re-export', "export { maxRetries } from './_shared';"],
    ['an imported binding', "import { maxRetries } from './_shared';\nexport { maxRetries };"],
    ['a renamed local', 'const retries = 3;\nexport { retries as maxRetries };'],
    ['let', 'export let maxRetries = 3;'],
    ['destructuring', 'export const { maxRetries } = { maxRetries: 3 };'],
  ])(
    'rejects an option exported through %s instead of deploying the default',
    (_form, declaration) => {
      writeFileSync(join(queuesDir, 'jobs.ts'), `${declaration}\nexport default async () => {};`);
      expect(() => scanQueuesSync(queuesDir)).toThrow(
        "queue: maxRetries in 'jobs.ts' must be declared in the queue file as `export const maxRetries = <integer>`. Re-exported options and other export forms are not read.",
      );
    },
  );

  it('ignores type-only exports of option names', () => {
    writeFileSync(
      join(queuesDir, 'typed.ts'),
      "export type { maxRetries } from './_types';\nexport const retryDelay = 5;\nexport default async () => {};",
    );
    expect(scanQueuesSync(queuesDir)).toMatchObject([{ maxRetries: undefined, retryDelay: 5 }]);
  });

  it('warns once that options are not read through export *', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      writeFileSync(
        join(queuesDir, 'star.ts'),
        "export * from './_options';\nexport const maxRetries = 5;\nexport default async () => {};",
      );
      expect(scanQueuesSync(queuesDir)).toMatchObject([{ maxRetries: 5, retryDelay: undefined }]);
      scanQueuesSync(queuesDir);
      expect(log).toHaveBeenCalledOnce();
      expect(log.mock.calls[0][0]).toContain(
        "queue: 'star.ts' uses `export * from`. Void does not read consumer options through it",
      );
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    ['block-comment', "export /* shared */ * from './_options';"],
    ['line-comment', "export // shared\n* from './_options';"],
    ['line-breaks', "export\n*\nfrom './_options';"],
  ])(
    'warns about export * spelled with %s when the file names no option',
    (spelling, statement) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        writeFileSync(
          join(queuesDir, `${spelling}.ts`),
          `${statement}\nexport default async () => {};`,
        );
        scanQueuesSync(queuesDir);
        expect(log).toHaveBeenCalledOnce();
        expect(log.mock.calls[0][0]).toContain(`queue: '${spelling}.ts' uses \`export * from\`.`);
      } finally {
        log.mockRestore();
      }
    },
  );

  it('does not warn about export * when the queue file declares every option', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      writeFileSync(
        join(queuesDir, 'complete.ts'),
        `export * from './_helpers';
export const maxBatchSize = 1;
export const maxBatchTimeout = 2;
export const maxRetries = 3;
export const retryDelay = 4;
export default async () => {};`,
      );
      expect(scanQueuesSync(queuesDir)).toMatchObject([{ maxBatchSize: 1, retryDelay: 4 }]);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('normalizes nested paths while preserving binding derivation', () => {
    mkdirSync(join(root, 'queues', 'order'), { recursive: true });
    writeFileSync(
      join(root, 'queues', 'order', 'notifications.ts'),
      `export default async () => {};`,
    );

    expect(scanQueuesSync(queuesDir)).toEqual([
      {
        filePath: 'order/notifications.ts',
        name: 'order-notifications',
        bindingName: 'QUEUE_ORDER_NOTIFICATIONS',
      },
    ]);
  });

  it('reports normalized name collisions in deterministic path order', () => {
    mkdirSync(join(root, 'queues', 'order'), { recursive: true });
    writeFileSync(join(root, 'queues', 'order-notifications.ts'), 'export default {};');
    writeFileSync(join(root, 'queues', 'order', 'notifications.ts'), 'export default {};');

    expect(() => scanQueuesSync(queuesDir)).toThrow(
      [
        'queue: Multiple queue files resolve to the same queue name:',
        '  "order-notifications": "order-notifications.ts", "order/notifications.ts"',
        'Rename the conflicting files so each queue has a unique name.',
      ].join('\n'),
    );
  });
});
