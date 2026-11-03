type Env = Readonly<{
  ANALYTICS: AnalyticsEngineDataset;
  PLATFORM_DISPATCH_WORKER_NAME?: string;
  // Set by `--runtime-logs minimal`: keep URLs and message text out of rows.
  PLATFORM_RUNTIME_LOGS?: 'minimal';
}>;

function isFetchEvent(event: TraceItem['event']): event is TraceItemFetchEventInfo {
  return event !== null && 'request' in event;
}

/**
 * Parse versioned or legacy worker script names.
 * Versioned: "user-{slug}-dpl_{id}" → projectKey "user-{slug}", deployId "dpl_{id}"
 * Legacy: "user-{slug}" → projectKey "user-{slug}", deployId ""
 * Platform dispatch: "void-dispatch" / "void-dispatch-staging" →
 *   projectKey "__platform-dispatch" / "__platform-dispatch-staging"
 *   (reserved prefix so admin tooling can surface relay errors without
 *   colliding with any user-* key).
 */
export function parseScriptName(
  scriptName: string,
  platformDispatchWorkerName?: string,
  scriptTags?: ReadonlyArray<string>,
): { projectKey: string; deployId: string } | null {
  if (scriptName.startsWith('void-do-')) {
    const project = scriptTags?.find((tag) => /^void-project:user-[a-z0-9-]+$/.test(tag));
    const deployment = scriptTags?.find((tag) => /^void-deployment:dpl_[a-zA-Z0-9_]+$/.test(tag));
    return project && deployment
      ? {
          projectKey: project.slice('void-project:'.length),
          deployId: deployment.slice('void-deployment:'.length),
        }
      : null;
  }
  const dplIndex = scriptName.lastIndexOf('-dpl_');
  if (dplIndex > 4) {
    return {
      projectKey: scriptName.slice(0, dplIndex),
      deployId: scriptName.slice(dplIndex + 1),
    };
  }
  if (scriptName.startsWith('user-')) {
    return { projectKey: scriptName, deployId: '' };
  }
  if (platformDispatchWorkerName && scriptName === platformDispatchWorkerName) {
    return { projectKey: '__platform-dispatch', deployId: '' };
  }
  if (scriptName === 'void-dispatch' || scriptName === 'void-dispatch-staging') {
    return { projectKey: `__platform-${scriptName.slice('void-'.length)}`, deployId: '' };
  }
  return null;
}

/**
 * Build the `void_logs` row for one trace event.
 *
 * Minimal mode drops the request URL and all message text. It keeps each log
 * level and exception name, so `--level` filters still match, and adds the
 * Ray ID so readers do not merge two requests that now look the same.
 */
export function buildLogDataPoint(
  event: TraceItem,
  parsed: { projectKey: string; deployId: string },
  runtimeLogs?: 'minimal',
): AnalyticsEngineDataPoint {
  const fetchEvent = isFetchEvent(event.event) ? event.event : null;
  const minimal = runtimeLogs === 'minimal';
  return {
    indexes: [parsed.projectKey],
    blobs: [
      event.outcome,
      JSON.stringify(minimal ? minimalLogs(event.logs) : event.logs),
      JSON.stringify(minimal ? minimalExceptions(event.exceptions) : event.exceptions),
      minimal ? '' : (fetchEvent?.request.url ?? ''),
      fetchEvent?.request.method ?? '',
      String(fetchEvent?.response?.status ?? ''),
      parsed.deployId,
      ...(minimal ? [fetchEvent?.request.headers['cf-ray'] ?? ''] : []),
    ],
    doubles: [event.eventTimestamp ?? Date.now(), fetchEvent?.response?.status ?? 0],
  };
}

function minimalLogs(logs: ReadonlyArray<TraceLog> | undefined) {
  return (logs ?? []).map((log) => ({ level: log.level, timestamp: log.timestamp, message: [] }));
}

function minimalExceptions(exceptions: ReadonlyArray<TraceException> | undefined) {
  return (exceptions ?? []).map((exception) => ({
    name: exception.name,
    timestamp: exception.timestamp,
    message: '',
  }));
}

export default {
  async tail(events: ReadonlyArray<TraceItem>, env: Env) {
    for (const event of events) {
      const scriptName = event.scriptName;
      if (!scriptName) {
        continue;
      }

      const parsed = parseScriptName(
        scriptName,
        env.PLATFORM_DISPATCH_WORKER_NAME,
        event.scriptTags,
      );
      if (!parsed) {
        continue;
      }

      env.ANALYTICS.writeDataPoint(buildLogDataPoint(event, parsed, env.PLATFORM_RUNTIME_LOGS));
    }
  },
} satisfies ExportedHandler<Env>;
