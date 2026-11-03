import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  chooseCloudflareQueueName,
  cloudflareQueueName,
  otherQueueConsumers,
  readDeployBuildQueueNames,
  scopedCloudflareQueueName,
} from '../../src/queues/cloudflare-names.ts';
import { generateQueueResolverSource } from '../../src/queues/dispatch.ts';

/** Run the emitted resolver source and return its lookup function. */
function resolver(
  queueNames: Array<string>,
  cloudflareNames?: Array<string>,
): (queueName: unknown) => number {
  return new Function(
    `${generateQueueResolverSource(queueNames, cloudflareNames)}\nreturn __resolveQueueIndex;`,
  )() as (queueName: unknown) => number;
}

describe('Cloudflare queue names', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('names a queue after its Worker without changing either part', () => {
    expect(scopedCloudflareQueueName('app-staging', 'jobs')).toBe('app-staging-jobs');
    expect(scopedCloudflareQueueName('app', 'Order-Emails')).toBe('app-Order-Emails');
  });

  it.each([
    ['a new account', null, null, 'app-jobs', false],
    ['a scoped queue this Worker consumes', { consumers: ['app'] }, undefined, 'app-jobs', false],
    ['a plain queue this Worker consumes', null, { consumers: ['app'] }, 'jobs', true],
    ['a plain queue another Worker consumes', null, { consumers: ['other'] }, 'app-jobs', false],
    ['a plain queue with no consumer', null, { consumers: [] }, 'app-jobs', false],
    ['an unread plain queue', { consumers: [] }, undefined, 'app-jobs', false],
  ])('picks the name for %s', (_case, scoped, plain, name, kept) => {
    expect(
      chooseCloudflareQueueName({
        workerName: 'app',
        queueName: 'jobs',
        scopedName: 'app-jobs',
        scoped,
        plain,
      }),
    ).toEqual({ name, kept });
  });

  it('prefers the scoped queue when this Worker consumes both', () => {
    expect(
      chooseCloudflareQueueName({
        workerName: 'app',
        queueName: 'jobs',
        scopedName: 'app-jobs',
        scoped: { consumers: ['app'] },
        plain: { consumers: ['app'] },
      }),
    ).toEqual({ name: 'app-jobs', kept: false });
  });

  it('lists the consumers that are not this Worker', () => {
    expect(otherQueueConsumers(null, 'app')).toEqual([]);
    expect(otherQueueConsumers({ consumers: ['app'] }, 'app')).toEqual([]);
    expect(otherQueueConsumers({ consumers: ['other', null] }, 'app')).toEqual(['other', null]);
  });

  it('reads the queue name map only inside a deploy build', () => {
    vi.stubEnv('VOID_CLOUDFLARE_QUEUE_NAMES', '{"jobs":"app-jobs"}');
    vi.stubEnv('VOID_CLOUDFLARE_DEPLOY_BUILD', '');
    expect(readDeployBuildQueueNames()).toBeUndefined();
    vi.stubEnv('VOID_CLOUDFLARE_DEPLOY_BUILD', '1');
    expect(readDeployBuildQueueNames()).toEqual({ jobs: 'app-jobs' });
  });

  it.each(['not json', '[]', 'null', '{"jobs":1}', '{"jobs":""}'])(
    'rejects the queue name map %s',
    (raw) => {
      vi.stubEnv('VOID_CLOUDFLARE_DEPLOY_BUILD', '1');
      vi.stubEnv('VOID_CLOUDFLARE_QUEUE_NAMES', raw);
      expect(() => readDeployBuildQueueNames()).toThrow(
        'queue: VOID_CLOUDFLARE_QUEUE_NAMES is not a valid queue name map.',
      );
    },
  );

  it('falls back to the plain name outside a deploy', () => {
    expect(cloudflareQueueName('jobs', undefined)).toBe('jobs');
    expect(cloudflareQueueName('jobs', { jobs: 'app-jobs' })).toBe('app-jobs');
    expect(cloudflareQueueName('constructor', {})).toBe('constructor');
  });
});

describe('queue resolver with Cloudflare names', () => {
  it('matches each Cloudflare name exactly where a suffix would pick the wrong queue', () => {
    // Worker `app-staging` with queues `jobs` and `staging-jobs`.
    const names = ['jobs', 'staging-jobs'];
    const scoped = ['app-staging-jobs', 'app-staging-staging-jobs'];
    expect(resolver(names)('app-staging-jobs')).toBe(1);
    const exact = resolver(names, scoped);
    expect(exact('app-staging-jobs')).toBe(0);
    expect(exact('app-staging-staging-jobs')).toBe(1);
  });

  it('prefers a Cloudflare name over an equal plain name', () => {
    // Worker `x` with queues `jobs` and `x-jobs`: `x-jobs` is the Cloudflare name of `jobs`.
    const exact = resolver(['jobs', 'x-jobs'], ['x-jobs', 'x-x-jobs']);
    expect(exact('x-jobs')).toBe(0);
    expect(exact('x-x-jobs')).toBe(1);
  });

  it('still matches plain names, which the trigger endpoint sends', () => {
    const exact = resolver(['jobs', 'emails'], ['jobs', 'app-emails']);
    expect(exact('jobs')).toBe(0);
    expect(exact('emails')).toBe(1);
    expect(exact('app-emails')).toBe(1);
  });

  it('fails closed on any other name', () => {
    const exact = resolver(['jobs'], ['app-jobs']);
    for (const name of ['other-app-jobs', 'app-jobs-2', 'toString', '__proto__', '', 1]) {
      expect(exact(name)).toBe(-1);
    }
  });
});
