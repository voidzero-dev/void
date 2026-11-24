import { defineQueue } from 'void';
import { queueCases, queueResultKey, validQueueRun } from '../lib/queue-acceptance.ts';
import type { AcceptanceMessage } from '../lib/queue-acceptance.ts';

// A single-message batch makes thrown retries independent of the other cases.
export const maxBatchSize = 1;
export const maxBatchTimeout = 1;
export const maxRetries = 1;
export const retryDelay = 1;

export default defineQueue<AcceptanceMessage>(async (batch, env) => {
  for (const message of batch.messages) {
    const { run, scenario } = message.body;
    if (!validQueueRun(run) || !queueCases.includes(scenario)) {
      message.ack();
      continue;
    }
    await env.DB.prepare('INSERT INTO queue_results (key, value) VALUES (?, ?)')
      .bind(
        queueResultKey(run),
        JSON.stringify({
          scenario,
          id: message.id,
          attempts: message.attempts,
          timestamp: message.timestamp instanceof Date ? message.timestamp.toISOString() : null,
        }),
      )
      .run();
    if (message.attempts > 1) {
      message.ack();
      continue;
    }
    switch (scenario) {
      case 'ack':
        message.ack();
        break;
      case 'retry-once':
        message.retry({ delaySeconds: 1 });
        break;
      case 'throw-once':
        throw new Error('Void queue acceptance deliberate first-attempt failure');
      case 'ack-then-retry':
        message.ack();
        message.retry({ delaySeconds: 1 });
        break;
      case 'retry-then-ack':
        message.retry({ delaySeconds: 1 });
        message.ack();
        break;
      case 'batch-ack-then-retry':
        batch.ackAll();
        batch.retryAll({ delaySeconds: 1 });
        break;
      case 'batch-retry-then-ack':
        batch.retryAll({ delaySeconds: 1 });
        batch.ackAll();
        break;
    }
  }
});
