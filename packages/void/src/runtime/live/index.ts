import { getUser, type AuthUser } from './auth.ts';
import { getRawRuntimeEnv } from './env-raw.ts';
import type { CloudContext, CloudEnv } from './handler.ts';
import {
  connectionInstanceName,
  internalUrl,
  topicDigest,
  topicInstanceName,
} from './live-names.ts';

type MaybePromise<T> = T | Promise<T>;

export type LiveControlRequest = {
  connectionId: string;
  operations: Array<LiveControlOperation>;
};

type ParsedControlOperation =
  | {
      ok: true;
      index: number;
      operation: LiveControlOperation;
    }
  | {
      ok: false;
      index: number;
      result: LiveControlOperationResult;
    };

type ParsedLiveControlRequest = {
  connectionId: string;
  operations: Array<ParsedControlOperation>;
};

export type LiveControlOperation =
  | {
      kind: 'subscribe';
      id: string;
      topic: string;
      lastEventId?: string;
    }
  | {
      kind: 'unsubscribe';
      id: string;
    };

export type LiveControlErrorCode =
  | 'BAD_REQUEST'
  | 'CONNECTION_CLOSED'
  | 'CONNECTION_NOT_FOUND'
  | 'FORBIDDEN'
  | 'INVALID_SUBSCRIPTION_ID'
  | 'INVALID_TOPIC'
  | 'OWNER_MISMATCH'
  | 'SUBSCRIPTION_LIMIT'
  | 'TOPIC_FULL'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL_ERROR';

export type LiveControlError = {
  code: LiveControlErrorCode;
  message: string;
};

export type LiveControlOperationResult =
  | {
      ok: true;
      kind: 'subscribe' | 'unsubscribe';
      id: string;
      topic?: string;
    }
  | {
      ok: false;
      kind: 'subscribe' | 'unsubscribe';
      id: string;
      error: LiveControlError;
    };

export type LiveControlResponse =
  | {
      accepted: true;
      connectionId: string;
      results: Array<LiveControlOperationResult>;
    }
  | {
      accepted: false;
      error: LiveControlError;
    };

export type LiveClientEvent<Data = unknown> = {
  subscriptionId: string;
  topic: string;
  type?: string;
  eventId?: string;
  data: Data;
};

export type LivePublishOptions = {
  type?: string;
  eventId?: string;
};

export type LiveConnectOptions = {
  owner?: string | null;
  user?: unknown;
};

export type LiveControlOptions = LiveConnectOptions;

export type LiveHookContext = {
  request: Request;
  env: CloudEnv['Bindings'];
  user: AuthUser | unknown | null;
  owner: string | null;
};

export type LiveConnectHookContext = LiveHookContext & {
  connection: { id: string };
};

export type LiveSubscribeHookContext = LiveHookContext & {
  connection: { id: string };
  subscription: { id: string };
  topic: string;
  lastEventId?: string;
};

export type LiveStreamOptions = {
  id: string;
  allowAnonymousControl?: boolean;
  identifyConnection?: (ctx: LiveHookContext) => MaybePromise<string | null | undefined>;
  onConnect?: (ctx: LiveConnectHookContext) => MaybePromise<Response | void>;
  /** Decides who can read each topic. Without it, any connection that passes the owner check can subscribe to any topic. Return a Response to reject. */
  onSubscribe?: (ctx: LiveSubscribeHookContext) => MaybePromise<Response | void>;
  limits?: Partial<LiveLimits>;
};

export type LiveLimits = {
  maxSubscriptionsPerConnection: number;
  maxSubscriptionsPerTopic: number;
  maxOperationsPerControlRequest: number;
  maxQueuedEventsPerConnection: number;
  maxEncodedEventSize: number;
  deliveryAttemptTimeoutMs: number;
};

export type LiveStream = {
  connect(ctx: CloudContext, options?: LiveConnectOptions): Promise<Response>;
  control(ctx: CloudContext, options?: LiveControlOptions): Promise<Response>;
  publish(topic: string, data: unknown, options?: LivePublishOptions): Promise<void>;
  withEnv(env: unknown): Pick<LiveStream, 'publish'>;
};

let liveBindingName = 'VOID_LIVE';
// Only the worker entry compiled by the Vite dev server turns this on. Builds
// never call the setter, so production clients get a fixed internal error.
let liveDev = false;
const registeredStreamIds = new Set<string>();
const DEFAULT_LIMITS: LiveLimits = {
  maxSubscriptionsPerConnection: 256,
  maxSubscriptionsPerTopic: 256,
  maxOperationsPerControlRequest: 100,
  maxQueuedEventsPerConnection: 100,
  maxEncodedEventSize: 64 * 1024,
  deliveryAttemptTimeoutMs: 1_500,
};
const MAX_SUBSCRIPTIONS_PER_TOPIC = 256;

export function __setLiveBindingName(name: string): void {
  liveBindingName = assertBindingName(name);
}

export function __getLiveBindingName(): string {
  return liveBindingName;
}

export function __setLiveDev(dev: boolean): void {
  liveDev = dev === true;
}

export function defineLiveStream(options: LiveStreamOptions): LiveStream {
  const streamId = assertStreamId(options.id);
  const limits = resolveLiveLimits(options.limits);
  if (registeredStreamIds.has(streamId)) {
    throw new Error(`live: duplicate stream id "${streamId}".`);
  }
  registeredStreamIds.add(streamId);

  async function resolveOwner(
    ctx: CloudContext,
    request: Request,
    connectOptions: LiveConnectOptions | undefined,
  ): Promise<{ owner: string | null; user: unknown | null }> {
    const hasExplicitUser = connectOptions && 'user' in connectOptions;
    const resolvedUser = hasExplicitUser ? connectOptions.user : (getContextUser(ctx) ?? getUser());
    const hookContext: LiveHookContext = {
      request,
      env: ctx.env,
      user: resolvedUser ?? null,
      owner: connectOptions?.owner ?? null,
    };
    const identified =
      connectOptions && 'owner' in connectOptions
        ? connectOptions.owner
        : await options.identifyConnection?.(hookContext);
    const owner = identified ?? defaultOwner(resolvedUser);
    if (owner == null && !options.allowAnonymousControl) {
      throw liveResponseError('FORBIDDEN', 'live: anonymous control is not enabled.', 403);
    }
    assertOwner(owner);
    return { owner, user: resolvedUser ?? null };
  }

  async function publishWithEnv(
    env: unknown,
    topic: string,
    data: unknown,
    publishOptions: LivePublishOptions = {},
  ): Promise<void> {
    const binding = getLiveBinding(env);
    assertTopic(topic);
    assertOptionalString('type', publishOptions.type);
    assertOptionalString('eventId', publishOptions.eventId);
    assertJsonSerializable(data);
    const topicKey = await topicDigest(streamId, topic);
    const id = binding.idFromName(topicInstanceName(streamId, topicKey));
    const response = await binding.get(id).fetch(internalUrl('/publish'), {
      method: 'POST',
      body: JSON.stringify({
        streamId,
        topic,
        topicKey,
        data,
        type: publishOptions.type,
        eventId: publishOptions.eventId,
        limits,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      const parsed = parseLiveControlResponse(body);
      if (parsed && !parsed.accepted) {
        throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
      }
      throw new Error(body || response.statusText);
    }
  }

  return {
    async connect(ctx, connectOptions) {
      try {
        const request = ctx.req.raw;
        const connectionId = getConnectionId(request);
        const { owner, user } = await resolveOwner(ctx, request, connectOptions);
        const decision = await options.onConnect?.({
          request,
          env: ctx.env,
          user,
          owner,
          connection: { id: connectionId },
        });
        if (decision instanceof Response) {
          return decision;
        }
        const binding = getLiveBinding(ctx.env);
        const id = binding.idFromName(connectionInstanceName(streamId, connectionId));
        return binding.get(id).fetch(internalUrl('/connect'), {
          method: 'POST',
          body: JSON.stringify({ streamId, connectionId, owner, limits }),
        });
      } catch (error) {
        return errorToResponse(error);
      }
    },

    async control(ctx, controlOptions) {
      try {
        const request = ctx.req.raw;
        const body = await readControlRequest(request, limits);
        const { owner, user } = await resolveOwner(ctx, request, controlOptions);
        const authorized: Array<{ operation: LiveControlOperation; index: number }> = [];
        const results: Array<LiveControlOperationResult | undefined> = [];
        for (const entry of body.operations) {
          if (!entry.ok) {
            results[entry.index] = entry.result;
            continue;
          }
          const { operation, index } = entry;
          if (operation.kind === 'unsubscribe') {
            authorized.push({ operation, index });
            continue;
          }
          const decision = await options.onSubscribe?.({
            request,
            env: ctx.env,
            user,
            owner,
            connection: { id: body.connectionId },
            subscription: { id: operation.id },
            topic: operation.topic,
            lastEventId: operation.lastEventId,
          });
          if (decision instanceof Response) {
            results[index] = {
              ok: false,
              kind: 'subscribe',
              id: operation.id,
              error: await responseToControlError(decision),
            };
            continue;
          }
          authorized.push({ operation, index });
        }
        if (authorized.length > 0) {
          const binding = getLiveBinding(ctx.env);
          const id = binding.idFromName(connectionInstanceName(streamId, body.connectionId));
          const response = await binding.get(id).fetch(internalUrl('/control'), {
            method: 'POST',
            body: JSON.stringify({
              streamId,
              connectionId: body.connectionId,
              owner,
              operations: authorized.map((entry) => entry.operation),
              limits,
            }),
          });
          const controlResponse = (await response.json()) as LiveControlResponse;
          if (!controlResponse.accepted) {
            return Response.json(controlResponse, { status: response.status });
          }
          for (const [resultIndex, result] of controlResponse.results.entries()) {
            const operation = authorized[resultIndex];
            if (operation) {
              results[operation.index] = result;
            }
          }
        }
        for (const entry of body.operations) {
          if (!entry.ok) {
            continue;
          }
          const { operation, index } = entry;
          results[index] ??= {
            ok: false,
            kind: operation.kind,
            id: operation.id,
            error: { code: 'INTERNAL_ERROR', message: 'live: missing control result.' },
          };
        }
        return Response.json({
          accepted: true,
          connectionId: body.connectionId,
          results: results as Array<LiveControlOperationResult>,
        } satisfies LiveControlResponse);
      } catch (error) {
        return errorToResponse(error);
      }
    },

    publish(topic, data, publishOptions) {
      let env: unknown;
      try {
        env = getRawRuntimeEnv();
      } catch {
        throw new Error(
          'live: publish() was called outside a Void server runtime context. Pass an explicit env with stream.withEnv(env).publish(...).',
        );
      }
      return publishWithEnv(env, topic, data, publishOptions);
    },

    withEnv(env) {
      return {
        publish(topic, data, publishOptions) {
          return publishWithEnv(env, topic, data, publishOptions);
        },
      };
    },
  };
}

function defaultOwner(user: unknown): string | null {
  if (user && typeof user === 'object' && 'id' in user && typeof user.id === 'string') {
    return `user:${user.id}`;
  }
  return null;
}

function getContextUser(ctx: CloudContext): unknown | null {
  try {
    return ctx.get('user');
  } catch {
    return null;
  }
}

function parseLiveControlResponse(body: string): LiveControlResponse | null {
  try {
    const parsed = JSON.parse(body) as LiveControlResponse;
    return typeof parsed === 'object' && parsed !== null && 'accepted' in parsed ? parsed : null;
  } catch {
    return null;
  }
}

async function readControlRequest(
  request: Request,
  limits: LiveLimits,
): Promise<ParsedLiveControlRequest> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw liveResponseError('BAD_REQUEST', 'live: control request body must be JSON.', 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw liveResponseError('BAD_REQUEST', 'live: control request body must be an object.', 400);
  }
  const record = body as Record<string, unknown>;
  const connectionId = assertConnectionId(record.connectionId);
  if (!Array.isArray(record.operations)) {
    throw liveResponseError('BAD_REQUEST', 'live: operations must be an array.', 400);
  }
  if (record.operations.length > limits.maxOperationsPerControlRequest) {
    throw liveResponseError(
      'BAD_REQUEST',
      'live: too many operations in one control request.',
      400,
    );
  }
  const operations = record.operations.map(parseOperation);
  return { connectionId, operations };
}

function parseOperation(value: unknown, index: number): ParsedControlOperation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw liveResponseError('BAD_REQUEST', 'live: operation must be an object.', 400);
  }
  const record = value as Record<string, unknown>;
  if (record.kind === 'subscribe') {
    const id = parseBoundedString(record.id, 1, 256);
    if (id == null) {
      return invalidOperation(index, 'subscribe', record.id, 'INVALID_SUBSCRIPTION_ID');
    }
    const topic = parseBoundedString(record.topic, 1, 512);
    if (topic == null) {
      return invalidOperation(index, 'subscribe', id, 'INVALID_TOPIC');
    }
    let lastEventId: string | undefined;
    if (record.lastEventId !== undefined) {
      lastEventId = parseBoundedString(record.lastEventId, 0, 512) ?? undefined;
      if (lastEventId === undefined) {
        return invalidOperation(index, 'subscribe', id, 'BAD_REQUEST');
      }
    }
    return {
      ok: true,
      index,
      operation: {
        kind: 'subscribe',
        id,
        topic,
        ...(lastEventId !== undefined && { lastEventId }),
      },
    };
  }
  if (record.kind === 'unsubscribe') {
    const id = parseBoundedString(record.id, 1, 256);
    if (id == null) {
      return invalidOperation(index, 'unsubscribe', record.id, 'INVALID_SUBSCRIPTION_ID');
    }
    return { ok: true, index, operation: { kind: 'unsubscribe', id } };
  }
  throw liveResponseError('BAD_REQUEST', 'live: operation kind is invalid.', 400);
}

const INVALID_OPERATION_MESSAGES = {
  BAD_REQUEST: 'live: invalid control operation.',
  INVALID_SUBSCRIPTION_ID: 'live: invalid subscription id.',
  INVALID_TOPIC: 'live: invalid topic.',
} as const;

function invalidOperation(
  index: number,
  kind: 'subscribe' | 'unsubscribe',
  id: unknown,
  code: keyof typeof INVALID_OPERATION_MESSAGES,
): ParsedControlOperation {
  return {
    ok: false,
    index,
    result: {
      ok: false,
      kind,
      id: typeof id === 'string' ? id : '',
      error: { code, message: INVALID_OPERATION_MESSAGES[code] },
    },
  };
}

function getLiveBinding(env: unknown): DurableObjectNamespace {
  if (typeof env !== 'object' || env === null) {
    throw new Error('live: Cloudflare env is unavailable.');
  }
  const binding = (env as Record<string, unknown>)[liveBindingName] as
    | DurableObjectNamespace
    | undefined;
  if (!binding) {
    throw new Error(`live: Missing Durable Object binding "${liveBindingName}".`);
  }
  return binding;
}

function getConnectionId(request: Request): string {
  return assertConnectionId(new URL(request.url).searchParams.get('connectionId'));
}

function assertStreamId(value: unknown): string {
  return assertBoundedString('stream id', value, 1, 128);
}

function assertBindingName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`live: invalid Durable Object binding name "${value}".`);
  }
  return value;
}

function assertConnectionId(value: unknown): string {
  return assertBoundedString('connectionId', value, 16, 256);
}

function assertTopic(value: unknown): string {
  return assertBoundedString('topic', value, 1, 512);
}

function assertOwner(value: string | null): void {
  if (value !== null) {
    assertBoundedString('owner', value, 1, 512);
  }
}

function assertOptionalString(name: string, value: unknown): void {
  if (value !== undefined) {
    assertBoundedString(name, value, 1, 512);
  }
}

function resolveLiveLimits(input: Partial<LiveLimits> | undefined): LiveLimits {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(limits) as Array<keyof LiveLimits>) {
    const value = input?.[key];
    if (value === undefined) {
      continue;
    }
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      throw new Error(`live: limits.${key} must be a positive finite integer.`);
    }
    limits[key] = value;
  }
  if (limits.maxSubscriptionsPerTopic > MAX_SUBSCRIPTIONS_PER_TOPIC) {
    throw new Error(
      `live: limits.maxSubscriptionsPerTopic must be at most ${MAX_SUBSCRIPTIONS_PER_TOPIC}.`,
    );
  }
  return limits;
}

function assertBoundedString(name: string, value: unknown, min: number, max: number): string {
  const parsed = parseBoundedString(value, min, max);
  if (parsed == null) {
    throw liveResponseError('BAD_REQUEST', `live: invalid ${name}.`, 400);
  }
  return parsed;
}

function parseBoundedString(value: unknown, min: number, max: number): string | null {
  if (
    typeof value !== 'string' ||
    value.length < min ||
    value.length > max ||
    /[\r\n]/.test(value) ||
    value.includes('\u0000')
  ) {
    return null;
  }
  return value;
}

function assertJsonSerializable(value: unknown): void {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') {
      throw new Error('unsupported value');
    }
  } catch (error) {
    throw new Error(
      `live: payload must be JSON-serializable. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

class LiveResponseError extends Error {
  constructor(
    readonly code: LiveControlErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function liveResponseError(code: LiveControlErrorCode, message: string, status: number): never {
  throw new LiveResponseError(code, message, status);
}

function errorToResponse(error: unknown): Response {
  if (error instanceof LiveResponseError) {
    return Response.json(
      {
        accepted: false,
        error: { code: error.code, message: error.message },
      } satisfies LiveControlResponse,
      { status: error.status },
    );
  }
  // Hooks, bindings and the Durable Object can fail with internal details; log them
  // on the server and send clients a fixed message. Dev keeps the real message.
  console.error(error);
  const message = liveDev
    ? error instanceof Error
      ? error.message
      : String(error)
    : 'live: internal error.';
  return Response.json(
    {
      accepted: false,
      error: { code: 'INTERNAL_ERROR', message },
    } satisfies LiveControlResponse,
    { status: 500 },
  );
}

async function responseToControlError(response: Response): Promise<LiveControlError> {
  const body = await response.text().catch(() => '');
  const message = body || response.statusText;
  if (response.status === 403 || response.status === 401) {
    return { code: 'FORBIDDEN', message: message || 'Forbidden' };
  }
  return { code: 'BAD_REQUEST', message: message || 'Subscription rejected' };
}
