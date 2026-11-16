import {
  connectionInstanceName,
  internalUrl,
  topicDigest,
  topicInstanceName,
} from './live-names.ts';
import {
  __getLiveBindingName,
  type LiveClientEvent,
  type LiveControlErrorCode,
  type LiveControlOperation,
  type LiveControlOperationResult,
  type LiveControlResponse,
  type LiveLimits,
} from './live.ts';
import { eventStream, type SseStream } from './sse.ts';

type LiveDurableObjectEnv = Record<string, unknown>;

type ConnectRequest = {
  streamId: string;
  connectionId: string;
  owner: string | null;
  limits: LiveLimits;
};

type ControlRequest = ConnectRequest & {
  operations: Array<LiveControlOperation>;
};

type PublishRequest = {
  streamId: string;
  topic: string;
  topicKey: string;
  data: unknown;
  type?: string;
  eventId?: string;
  limits: LiveLimits;
};

type DeliveryRequest = {
  streamId: string;
  topic: string;
  data: unknown;
  type?: string;
  eventId?: string;
  subscriptions: Array<SubscriberRow>;
};

type DeliveryResponse = {
  delivered: number;
  stale: Array<number>;
};

type StaleCheckRequest = {
  subscriptions: Array<SubscriberRow>;
};

type StaleCheckResponse = {
  stale: Array<number>;
};

type SubscriberRow = {
  streamId: string;
  topic: string;
  topicKey: string;
  connectionId: string;
  subscriptionId: string;
  generation: number;
  revision: number;
  lastSeenAt: number;
};

type ActiveSubscription = {
  id: string;
  topic: string;
  topicKey: string;
  generation: number;
  revision: number;
  active: boolean;
};

type ActiveConnection = {
  stream: SseStream;
  abort: AbortController;
  owner: string | null;
  generation: number;
  subscriptions: Map<string, ActiveSubscription>;
  writeChain: Promise<void>;
  queued: number;
  limits: LiveLimits;
};

export type LiveDurableObjectInstance = {
  fetch(request: Request): Promise<Response>;
  alarm?(): Promise<void>;
};

export type LiveDurableObjectClass = {
  new (state: DurableObjectState, env: LiveDurableObjectEnv): LiveDurableObjectInstance;
};

const GENERATION_KEY = 'connection:generation';
const TOPIC_PRUNE_ALARM_DELAY_MS = 60_000;
const LIVE_FANOUT_CONCURRENCY = 6;
const textEncoder = new TextEncoder();

export function createLiveDurableObject(): LiveDurableObjectClass {
  class VoidLiveStreamDurableObject implements LiveDurableObjectInstance {
    private connection: ActiveConnection | null = null;
    private publishChain: Promise<void> = Promise.resolve();

    constructor(
      public readonly state: DurableObjectState,
      public readonly env: LiveDurableObjectEnv,
    ) {}

    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }
      if (pathname === '/connect') {
        return this.connect((await request.json()) as ConnectRequest);
      }
      if (pathname === '/control') {
        return this.control((await request.json()) as ControlRequest);
      }
      if (pathname === '/deliver') {
        return this.deliver((await request.json()) as DeliveryRequest);
      }
      if (pathname === '/check') {
        return this.check((await request.json()) as StaleCheckRequest);
      }
      if (pathname === '/register') {
        return this.register((await request.json()) as SubscriberRow & { limits: LiveLimits });
      }
      if (pathname === '/unregister') {
        return this.unregister((await request.json()) as Partial<SubscriberRow>);
      }
      if (pathname === '/publish') {
        return this.enqueuePublish(request);
      }
      return new Response('Not Found', { status: 404 });
    }

    async alarm(): Promise<void> {
      await this.pruneAllSubscribers();
    }

    private enqueuePublish(request: Request): Promise<Response> {
      const run = this.publishChain
        .catch(() => {})
        .then(async () => {
          return this.publish((await request.json()) as PublishRequest);
        });
      this.publishChain = run.then(
        () => {},
        () => {},
      );
      return run;
    }

    private async connect(message: ConnectRequest): Promise<Response> {
      const previous = this.connection;
      if (previous) {
        const active = [...previous.subscriptions.values()].filter((sub) => sub.active);
        for (const subscription of previous.subscriptions.values()) {
          subscription.active = false;
        }
        previous.abort.abort();
        await Promise.all(
          active.map((sub) => this.unregisterTopic(message.streamId, message.connectionId, sub)),
        );
      }

      const generation = ((await this.state.storage.get<number>(GENERATION_KEY)) ?? 0) + 1;
      await this.state.storage.put(GENERATION_KEY, generation);
      const abort = new AbortController();

      return eventStream(
        async (stream) => {
          const subscriptions =
            previous?.owner === message.owner ? previous.subscriptions : new Map();
          for (const subscription of subscriptions.values()) {
            subscription.active = false;
          }
          this.connection = {
            stream,
            abort,
            owner: message.owner,
            generation,
            subscriptions,
            writeChain: Promise.resolve(),
            queued: 0,
            limits: message.limits,
          };
          try {
            await stream.comment('connected');
            await stream.closed;
          } finally {
            const active = [...subscriptions.values()].filter(
              (sub) => sub.active && sub.generation === generation,
            );
            for (const sub of active) {
              sub.active = false;
            }
            if (this.connection?.generation === generation) {
              this.connection = null;
            }
            await Promise.all(
              active.map((sub) =>
                this.unregisterTopic(message.streamId, message.connectionId, sub),
              ),
            );
          }
        },
        { signal: abort.signal, keepAlive: { intervalMs: 15_000, comment: 'keep-alive' } },
      );
    }

    private async control(message: ControlRequest): Promise<Response> {
      const connection = this.connection;
      if (!connection) {
        return controlBatchError('CONNECTION_NOT_FOUND', 'live: connection is not open.', 404);
      }
      if (connection.owner !== message.owner) {
        return controlBatchError('OWNER_MISMATCH', 'live: connection owner mismatch.', 403);
      }

      const results: Array<LiveControlOperationResult> = [];
      for (const operation of message.operations) {
        if (operation.kind === 'unsubscribe') {
          const existing = connection.subscriptions.get(operation.id);
          if (existing) {
            existing.active = false;
            await this.unregisterTopic(message.streamId, message.connectionId, existing);
            connection.subscriptions.delete(operation.id);
          }
          results.push({ ok: true, kind: 'unsubscribe', id: operation.id });
          continue;
        }

        if (
          !connection.subscriptions.has(operation.id) &&
          activeSubscriptionCount(connection) >= message.limits.maxSubscriptionsPerConnection
        ) {
          results.push({
            ok: false,
            kind: 'subscribe',
            id: operation.id,
            error: { code: 'SUBSCRIPTION_LIMIT', message: 'live: subscription limit reached.' },
          });
          continue;
        }

        const topicKey = await topicDigest(message.streamId, operation.topic);
        const existing = connection.subscriptions.get(operation.id);
        const revision = (existing?.revision ?? 0) + 1;
        const row: SubscriberRow = {
          streamId: message.streamId,
          topic: operation.topic,
          topicKey,
          connectionId: message.connectionId,
          subscriptionId: operation.id,
          generation: connection.generation,
          revision,
          lastSeenAt: Date.now(),
        };
        const response = await this.topicStub(message.streamId, topicKey).fetch(
          internalUrl('/register'),
          {
            method: 'POST',
            body: JSON.stringify({ ...row, limits: message.limits }),
          },
        );
        if (!response.ok) {
          results.push({
            ok: false,
            kind: 'subscribe',
            id: operation.id,
            error:
              response.status === 409
                ? { code: 'TOPIC_FULL', message: 'live: topic subscription limit reached.' }
                : { code: 'INTERNAL_ERROR', message: await response.text() },
          });
          continue;
        }

        if (existing) {
          existing.active = false;
          await this.unregisterTopic(message.streamId, message.connectionId, existing).catch(
            () => {},
          );
        }
        connection.subscriptions.set(operation.id, {
          id: operation.id,
          topic: operation.topic,
          topicKey,
          generation: connection.generation,
          revision,
          active: true,
        });
        results.push({ ok: true, kind: 'subscribe', id: operation.id, topic: operation.topic });
      }

      return Response.json({
        accepted: true,
        connectionId: message.connectionId,
        results,
      } satisfies LiveControlResponse);
    }

    private async deliver(message: DeliveryRequest): Promise<Response> {
      const connection = this.connection;
      if (!connection) {
        return new Response('connection missing', { status: 410 });
      }

      let delivered = 0;
      const stale: Array<number> = [];
      for (const [index, row] of message.subscriptions.entries()) {
        if (isStaleSubscriber(row, connection)) {
          stale.push(index);
          continue;
        }
        if (connection.queued >= connection.limits.maxQueuedEventsPerConnection) {
          connection.abort.abort();
          if (this.connection === connection) {
            this.connection = null;
          }
          return new Response('connection queue full', { status: 410 });
        }
        const event = liveEvent(row.subscriptionId, message);
        if (encodedLiveEventSize(event) > connection.limits.maxEncodedEventSize) {
          return payloadTooLargeResponse(connection.limits.maxEncodedEventSize);
        }
        connection.queued++;
        const activeConnection = connection;
        connection.writeChain = connection.writeChain
          .catch(() => {})
          .then(() => connection.stream.send({ event: 'message', data: event }))
          .catch(() => {
            if (this.connection === activeConnection) {
              this.connection = null;
            }
            connection.abort.abort();
          })
          .finally(() => {
            connection.queued--;
          });
        delivered++;
      }
      return Response.json({ delivered, stale } satisfies DeliveryResponse);
    }

    private check(message: StaleCheckRequest): Response {
      const connection = this.connection;
      if (!connection) {
        return new Response('connection missing', { status: 410 });
      }

      const stale: Array<number> = [];
      for (const [index, row] of message.subscriptions.entries()) {
        if (isStaleSubscriber(row, connection)) {
          stale.push(index);
        }
      }
      return Response.json({ stale } satisfies StaleCheckResponse);
    }

    private async register(row: SubscriberRow & { limits: LiveLimits }): Promise<Response> {
      const prefix = subscriberPrefix(row.streamId, row.topicKey);
      const current = await this.state.storage.list<SubscriberRow>({ prefix });
      const deletedKeys = new Set<string>();
      for (const [key, value] of current) {
        if (value.connectionId === row.connectionId && value.generation < row.generation) {
          deletedKeys.add(key);
          continue;
        }
        if (
          value.connectionId === row.connectionId &&
          value.subscriptionId === row.subscriptionId
        ) {
          deletedKeys.add(key);
        }
      }

      let activeRows = [...current].filter(([key]) => !deletedKeys.has(key));
      if (activeRows.length >= row.limits.maxSubscriptionsPerTopic) {
        for (const key of await this.findStaleSubscriberKeys(activeRows, row.limits)) {
          deletedKeys.add(key);
        }
        activeRows = activeRows.filter(([key]) => !deletedKeys.has(key));
      }

      if (activeRows.length >= row.limits.maxSubscriptionsPerTopic) {
        return new Response('topic full', { status: 409 });
      }
      if (deletedKeys.size > 0) {
        await this.state.storage.delete([...deletedKeys]);
      }
      await this.state.storage.put(subscriberKey(row), withoutLimits(row));
      await this.schedulePruneAlarm();
      return Response.json({ ok: true });
    }

    private async unregister(row: Partial<SubscriberRow>): Promise<Response> {
      if (!row.streamId || !row.topicKey) {
        return Response.json({ ok: true });
      }
      const key =
        row.connectionId && row.subscriptionId && row.generation != null && row.revision != null
          ? subscriberKey(row as SubscriberRow)
          : undefined;
      if (key) {
        await this.state.storage.delete(key);
      }
      return Response.json({ ok: true });
    }

    private async publish(message: PublishRequest): Promise<Response> {
      const rows = await this.state.storage.list<SubscriberRow>({
        prefix: subscriberPrefix(message.streamId, message.topicKey),
      });
      const grouped = groupByConnection(rows);
      for (const { row } of [...grouped.values()].flat()) {
        const event = liveEvent(row.subscriptionId, message);
        if (encodedLiveEventSize(event) > message.limits.maxEncodedEventSize) {
          return payloadTooLargeResponse(message.limits.maxEncodedEventSize);
        }
      }
      const groups = [...grouped];
      for (let offset = 0; offset < groups.length; offset += LIVE_FANOUT_CONCURRENCY) {
        const batch = groups.slice(offset, offset + LIVE_FANOUT_CONCURRENCY);
        const responses = await Promise.allSettled(
          batch.map(([connectionId, items]) =>
            fetchWithTimeout(
              this.connectionStub(message.streamId, connectionId),
              internalUrl('/deliver'),
              {
                method: 'POST',
                body: JSON.stringify({
                  streamId: message.streamId,
                  topic: message.topic,
                  data: message.data,
                  type: message.type,
                  eventId: message.eventId,
                  subscriptions: items.map((item) => item.row),
                } satisfies DeliveryRequest),
              },
              message.limits.deliveryAttemptTimeoutMs,
            ),
          ),
        );
        for (const [index, outcome] of responses.entries()) {
          if (outcome.status === 'rejected') {
            throw outcome.reason;
          }
          const response = outcome.value;
          const items = batch[index]![1];
          // A missed delivery does not prove the still-open SSE connection is gone.
          if (!response) {
            continue;
          }
          if (response.status === 410 || response.status === 404) {
            await this.state.storage.delete(items.map((item) => item.key));
            continue;
          }
          if (response.status === 413) {
            return response;
          }
          if (response.ok) {
            const result = (await response.json().catch(() => null)) as DeliveryResponse | null;
            const staleKeys = result?.stale
              .map((staleIndex) => items[staleIndex]?.key)
              .filter((key): key is string => typeof key === 'string');
            if (staleKeys?.length) {
              await this.state.storage.delete(staleKeys);
            }
          }
        }
      }
      return Response.json({ ok: true });
    }

    private async pruneAllSubscribers(): Promise<void> {
      const rows = await this.state.storage.list<SubscriberRow>({ prefix: 'sub:' });
      const staleKeys = await this.findStaleSubscriberKeys([...rows], {
        deliveryAttemptTimeoutMs: 1_500,
      });
      if (staleKeys.length > 0) {
        await this.state.storage.delete(staleKeys);
      }
      if (rows.size > staleKeys.length) {
        await this.schedulePruneAlarm();
      }
    }

    private async findStaleSubscriberKeys(
      entries: Array<[string, SubscriberRow]>,
      limits: Pick<LiveLimits, 'deliveryAttemptTimeoutMs'>,
    ): Promise<Array<string>> {
      const grouped = groupByConnection(entries);

      const staleKeys: Array<string> = [];
      const groups = [...grouped];
      for (let offset = 0; offset < groups.length; offset += LIVE_FANOUT_CONCURRENCY) {
        const batch = groups.slice(offset, offset + LIVE_FANOUT_CONCURRENCY);
        const responses = await Promise.allSettled(
          batch.map(([connectionId, items]) =>
            fetchWithTimeout(
              this.connectionStub(items[0]!.row.streamId, connectionId),
              internalUrl('/check'),
              {
                method: 'POST',
                body: JSON.stringify({
                  subscriptions: items.map((item) => item.row),
                } satisfies StaleCheckRequest),
              },
              limits.deliveryAttemptTimeoutMs,
            ),
          ),
        );
        for (const [index, outcome] of responses.entries()) {
          if (outcome.status === 'rejected') {
            throw outcome.reason;
          }
          const response = outcome.value;
          const items = batch[index]![1];
          if (!response) {
            continue;
          }
          if (response.status === 410 || response.status === 404) {
            staleKeys.push(...items.map((item) => item.key));
            continue;
          }
          if (response.ok) {
            const result = (await response.json().catch(() => null)) as StaleCheckResponse | null;
            for (const staleIndex of result?.stale ?? []) {
              const key = items[staleIndex]?.key;
              if (key) {
                staleKeys.push(key);
              }
            }
          }
        }
      }
      return staleKeys;
    }

    private async schedulePruneAlarm(): Promise<void> {
      await this.state.storage.setAlarm?.(Date.now() + TOPIC_PRUNE_ALARM_DELAY_MS);
    }

    private topicStub(streamId: string, topicKey: string): DurableObjectStub {
      const binding = this.env[__getLiveBindingName()] as DurableObjectNamespace;
      return binding.get(binding.idFromName(topicInstanceName(streamId, topicKey)));
    }

    private connectionStub(streamId: string, connectionId: string): DurableObjectStub {
      const binding = this.env[__getLiveBindingName()] as DurableObjectNamespace;
      return binding.get(binding.idFromName(connectionInstanceName(streamId, connectionId)));
    }

    private unregisterTopic(
      streamId: string,
      connectionId: string,
      subscription: ActiveSubscription,
    ) {
      return this.topicStub(streamId, subscription.topicKey).fetch(internalUrl('/unregister'), {
        method: 'POST',
        body: JSON.stringify({
          streamId,
          topic: subscription.topic,
          topicKey: subscription.topicKey,
          connectionId,
          subscriptionId: subscription.id,
          revision: subscription.revision,
          generation: subscription.generation,
        }),
      });
    }
  }

  return VoidLiveStreamDurableObject;
}

function controlBatchError(code: LiveControlErrorCode, message: string, status: number): Response {
  return Response.json({ accepted: false, error: { code, message } }, { status });
}

function activeSubscriptionCount(connection: ActiveConnection): number {
  let count = 0;
  for (const subscription of connection.subscriptions.values()) {
    if (subscription.active) {
      count++;
    }
  }
  return count;
}

function isStaleSubscriber(row: SubscriberRow, connection: ActiveConnection): boolean {
  if (row.generation !== connection.generation) {
    return true;
  }
  const subscription = connection.subscriptions.get(row.subscriptionId);
  return !subscription || !subscription.active || subscription.revision !== row.revision;
}

function liveEvent(
  subscriptionId: string,
  message: Pick<PublishRequest, 'topic' | 'data' | 'type' | 'eventId'>,
): LiveClientEvent {
  return {
    subscriptionId,
    topic: message.topic,
    ...(message.type !== undefined && { type: message.type }),
    ...(message.eventId !== undefined && { eventId: message.eventId }),
    data: message.data,
  };
}

function groupByConnection(
  entries: Iterable<[string, SubscriberRow]>,
): Map<string, Array<{ key: string; row: SubscriberRow }>> {
  const grouped = new Map<string, Array<{ key: string; row: SubscriberRow }>>();
  for (const [key, row] of entries) {
    const list = grouped.get(row.connectionId) ?? [];
    list.push({ key, row });
    grouped.set(row.connectionId, list);
  }
  return grouped;
}

function encodedLiveEventSize(event: LiveClientEvent): number {
  return textEncoder.encode(JSON.stringify(event)).byteLength;
}

function payloadTooLargeResponse(maxEncodedEventSize: number): Response {
  return Response.json(
    {
      accepted: false,
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `live: encoded event exceeds ${maxEncodedEventSize} bytes.`,
      },
    } satisfies LiveControlResponse,
    { status: 413 },
  );
}

async function fetchWithTimeout(
  stub: DurableObjectStub,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response | null> {
  const fetchPromise = stub.fetch(input, init);
  fetchPromise.catch(() => {});
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeout = setTimeout(() => resolve(null), Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([fetchPromise, timeoutPromise]);
  } catch {
    return null;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function withoutLimits(row: SubscriberRow & { limits?: LiveLimits }): SubscriberRow {
  const { limits: _limits, ...rest } = row;
  return rest;
}

function subscriberPrefix(streamId: string, topicKey: string): string {
  return `sub:${streamId}:${topicKey}:`;
}

function subscriberKey(row: SubscriberRow): string {
  return `${subscriberPrefix(row.streamId, row.topicKey)}${row.connectionId}:${row.subscriptionId}:${row.generation}:${row.revision}`;
}
