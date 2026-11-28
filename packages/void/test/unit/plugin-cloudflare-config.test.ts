import { afterEach, expect, it, vi } from 'vite-plus/test';
import { addLocalQueueProducers } from '../../src/plugin-cloudflare-config.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('warns once for an inferred binding shared by queue files', () => {
  vi.stubEnv('CLOUDFLARE_VITE_BUILD', undefined);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const worker = { env: {} };
  const queues = [
    { filePath: 'a-b.ts', name: 'a-b', bindingName: 'QUEUE_A_B' },
    { filePath: 'a_b.ts', name: 'a_b', bindingName: 'QUEUE_A_B' },
    { filePath: 'inbox.ts', name: 'inbox', bindingName: 'QUEUE_INBOX' },
  ];

  expect(addLocalQueueProducers(worker, () => ({ queues, reserved: [] }))).toEqual(['QUEUE_INBOX']);
  expect(worker.env).toEqual({ QUEUE_INBOX: { type: 'queue', name: 'inbox' } });
  expect(log).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining(
      'Queue files a-b.ts, a_b.ts share binding QUEUE_A_B. Void skips inference for this binding. Rename the conflicting files so each queue has a distinct binding.',
    ),
  );
});
