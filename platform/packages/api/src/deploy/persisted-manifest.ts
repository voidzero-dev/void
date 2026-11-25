import { isRecord } from '@void/deploy-core';
import type {
  DeployManifest,
  LiveManifestMeta,
  QueueMeta,
  WebSocketManifestMeta,
  WebSocketMigrationMeta,
  WebSocketRouteMeta,
} from '@void/deploy-core';

export type PreviousDeployManifest = Pick<DeployManifest, 'queues' | 'websocket' | 'live'>;

function isStringArray(value: unknown): value is Array<string> {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isQueue(value: unknown): value is QueueMeta {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.bindingName === 'string' &&
    ['maxBatchSize', 'maxBatchTimeout', 'maxConcurrency', 'maxRetries', 'retryDelay'].every(
      (key) => value[key] === undefined || typeof value[key] === 'number',
    )
  );
}

function isWebSocketRoute(value: unknown): value is WebSocketRouteMeta {
  return (
    isRecord(value) &&
    typeof value.pattern === 'string' &&
    typeof value.filePath === 'string' &&
    typeof value.className === 'string' &&
    (value.bindingName === undefined || typeof value.bindingName === 'string') &&
    (value.mode === 'room' || value.mode === 'socket') &&
    typeof value.hasAuthGate === 'boolean'
  );
}

function isClassMigration(value: unknown): value is WebSocketMigrationMeta {
  return (
    isRecord(value) &&
    typeof value.tag === 'string' &&
    (value.newClasses === undefined || isStringArray(value.newClasses)) &&
    (value.newSqliteClasses === undefined || isStringArray(value.newSqliteClasses)) &&
    (value.deletedClasses === undefined || isStringArray(value.deletedClasses))
  );
}

function isWebSocket(value: unknown): value is WebSocketManifestMeta {
  return (
    isRecord(value) &&
    Array.isArray(value.routes) &&
    value.routes.every(isWebSocketRoute) &&
    isStringArray(value.classes) &&
    (value.migrations === undefined ||
      (Array.isArray(value.migrations) && value.migrations.every(isClassMigration)))
  );
}

function isLive(value: unknown): value is LiveManifestMeta {
  return (
    isRecord(value) &&
    typeof value.bindingName === 'string' &&
    typeof value.className === 'string' &&
    value.storage === 'sqlite' &&
    isStringArray(value.classes) &&
    (value.migrations === undefined ||
      (Array.isArray(value.migrations) && value.migrations.every(isClassMigration)))
  );
}

/** Read only the history needed by a redeploy, including rows written by older clients. */
export function readPreviousDeployManifest(
  raw: string | null | undefined,
): PreviousDeployManifest | null {
  if (!raw) {
    return null;
  }
  const value: unknown = JSON.parse(raw);
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error('Invalid persisted deployment manifest');
  }
  const { queues, websocket, live } = value;
  if (
    (queues !== undefined && (!Array.isArray(queues) || !queues.every(isQueue))) ||
    (websocket !== undefined && !isWebSocket(websocket)) ||
    (live !== undefined && !isLive(live))
  ) {
    throw new Error('Invalid persisted deployment history');
  }
  return { queues, websocket, live };
}
