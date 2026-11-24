import { describe, expect, it } from 'vite-plus/test';
import { R2_CONCURRENCY } from '../../src/concurrency.ts';
import { prepareDeploymentInput } from '../../src/deployment-execution.ts';

type Put = { key: string; release: (error?: Error) => void };

/** Holds every put open until the test releases it. */
class GatedR2 {
  readonly objects = new Map<string, string>();
  readonly pending: Array<Put> = [];
  readonly started: Array<string> = [];
  readonly values = new Map<string, Blob | string>();
  inFlight = 0;
  maxInFlight = 0;
  deletedWhileInFlight = false;

  async put(key: string, value: Blob | string): Promise<object> {
    this.started.push(key);
    this.values.set(key, value);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise<void>((resolve, reject) => {
        this.pending.push({ key, release: (error) => (error ? reject(error) : resolve()) });
      });
    } finally {
      this.inFlight--;
    }
    this.objects.set(key, typeof value === 'string' ? value : await value.text());
    return {};
  }

  async list({ prefix }: { prefix: string }) {
    return {
      objects: [...this.objects.keys()].flatMap((key) =>
        key.startsWith(prefix)
          ? [
              {
                key,
              },
            ]
          : [],
      ),
      truncated: false,
    };
  }

  async delete(keys: string | Array<string>) {
    if (this.inFlight > 0) {
      this.deletedWhileInFlight = true;
    }
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key);
    }
  }

  /** Release the oldest pending put once one is waiting. */
  async releaseNext(error?: Error): Promise<string> {
    while (this.pending.length === 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    const put = this.pending.shift()!;
    put.release(error);
    return put.key;
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; !condition(); attempt++) {
    if (attempt > 1000) {
      throw new Error('condition was not reached');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function files(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    name: `module-${index}.js`,
    content: new Blob([`export default ${index};`], { type: 'application/javascript+module' }),
  }));
}

describe('prepareDeploymentInput', () => {
  it.each([
    ['static', 'static', 0],
    ['spa', 'spa', 0],
    ['void', 'static', 0],
    ['framework', 'static', 0],
    ['void', 'worker', 1],
    ['framework', 'worker', 1],
  ] as const)(
    'attributes %s input using its single existing receipt write',
    async (appType, kind, moduleCount) => {
      const r2 = new GatedR2();
      const staging = prepareDeploymentInput(
        r2 as unknown as R2Bucket,
        'prj_test',
        { manifest: { type: appType } },
        files(moduleCount),
        { appType, credentialId: 'credential', oauthApproval: 'approval' },
      );
      for (let index = 0; index <= moduleCount; index++) {
        await r2.releaseNext();
      }
      const { input, prefix } = await staging;
      expect(r2.started).toEqual([
        ...Array.from({ length: moduleCount }, (_, index) => `${prefix}${index}`),
        `${prefix}receipt-void-platform-${kind}`,
      ]);
      expect(input).toMatchObject({
        body: { manifest: { type: appType } },
        credentialId: 'credential',
        oauthApproval: 'approval',
      });
      expect(input.modules).toHaveLength(moduleCount);
      expect(JSON.parse(r2.objects.get(r2.started.at(-1)!)!)).toEqual({
        createdAt: expect.any(Number),
      });
    },
  );

  it('stages modules with bounded concurrency, in input order, and writes the receipt last', async () => {
    const r2 = new GatedR2();
    const count = R2_CONCURRENCY * 3 + 1;
    const modules = files(count);
    const staging = prepareDeploymentInput(
      r2 as unknown as R2Bucket,
      'prj_test',
      { manifest: { type: 'void' }, workerFiles: { ignored: true } },
      modules,
      { appType: 'void' },
    );
    // Keep the pool full, and release puts out of start order: newest first.
    for (let released = 0; released < count; released++) {
      await waitFor(() => r2.pending.length === Math.min(R2_CONCURRENCY, count - released));
      expect(r2.started.some((key) => key.includes('/receipt'))).toBe(false);
      r2.pending.pop()!.release();
    }
    expect(await r2.releaseNext()).toMatch(/receipt-void-platform-worker$/);
    const { input, prefix, digest } = await staging;

    expect(r2.maxInFlight).toBe(R2_CONCURRENCY);
    expect(r2.started).toHaveLength(count + 1);
    expect(r2.started.at(-1)).toBe(`${prefix}receipt-void-platform-worker`);
    expect(input.body).not.toHaveProperty('workerFiles');
    expect(input.modules.map(({ name, key }) => ({ name, key }))).toEqual(
      Array.from({ length: count }, (_, index) => ({
        name: `module-${index}.js`,
        key: `${prefix}${index}`,
      })),
    );
    expect(r2.objects.get(`${prefix}${count - 1}`)).toBe(`export default ${count - 1};`);
    // Each put sends the decoded Blob itself rather than a buffered copy.
    modules.forEach(({ content }, index) =>
      expect(r2.values.get(`${prefix}${index}`)).toBe(content),
    );
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    // The identity digest depends only on the content, not on completion order.
    const sequential = new GatedR2();
    const again = prepareDeploymentInput(
      sequential as unknown as R2Bucket,
      'prj_test',
      { manifest: { type: 'void' } },
      files(count),
      { appType: 'void' },
    );
    for (let released = 0; released <= count; released++) {
      await sequential.releaseNext();
    }
    expect((await again).digest).toBe(digest);
  });

  it('rejects on the first failed put, starts no further puts, and cleans up after in-flight puts settle', async () => {
    const r2 = new GatedR2();
    const count = R2_CONCURRENCY * 4;
    const staging = prepareDeploymentInput(
      r2 as unknown as R2Bucket,
      'prj_test',
      { manifest: { type: 'void' } },
      files(count),
      { appType: 'void' },
    );
    const outcome = staging.then(
      () => null,
      (error: unknown) => error,
    );
    await waitFor(() => r2.pending.length === R2_CONCURRENCY);
    await r2.releaseNext();
    await waitFor(() => r2.pending.length === R2_CONCURRENCY);
    await r2.releaseNext(new Error('R2 put failed'));
    const startedAtFailure = r2.started.length;
    expect(startedAtFailure).toBe(R2_CONCURRENCY + 1);
    // Settle the puts that were already running when the failure happened.
    while (r2.pending.length > 0) {
      r2.pending.shift()!.release();
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }

    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('R2 put failed');
    expect(r2.started).toHaveLength(startedAtFailure);
    expect(r2.started.length).toBeLessThan(count);
    expect(r2.started.some((key) => key.includes('/receipt'))).toBe(false);
    expect(r2.deletedWhileInFlight).toBe(false);
    expect(r2.objects.size).toBe(0);
  });

  it('cleans up staged modules when the receipt write fails', async () => {
    const r2 = new GatedR2();
    const staging = prepareDeploymentInput(
      r2 as unknown as R2Bucket,
      'prj_test',
      { manifest: { type: 'void' } },
      files(1),
      { appType: 'void' },
    );
    const outcome = staging.catch((error: unknown) => error);
    await r2.releaseNext();
    expect(await r2.releaseNext(new Error('Receipt write failed'))).toMatch(
      /receipt-void-platform-worker$/,
    );
    expect(await outcome).toEqual(new Error('Receipt write failed'));
    expect(r2.deletedWhileInFlight).toBe(false);
    expect(r2.objects.size).toBe(0);
  });
});
