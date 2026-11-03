export type Env = Readonly<{
  PLATFORM_APPLICATION?: string;
  DISPATCH: DispatchNamespace;
  PREVIEW_API?: Fetcher;
  ISR_CACHE: KVNamespace;
  ROUTING: KVNamespace;
  STATIC_ASSETS: KVNamespace;
  STATIC_ASSETS_R2: R2Bucket;
  ANALYTICS: AnalyticsEngineDataset;
  // The `void_logs` dataset the tail worker owns. Dispatch writes to it only to
  // explain a 503 it generated itself — see `recordPlatformLog` in metering.ts.
  LOGS: AnalyticsEngineDataset;
  USAGE_QUEUE: Queue<unknown>;
  BASE_HOSTNAME?: string;
  DISPATCH_TIMEOUT_MS?: string;
  PLATFORM_HEALTH_PROBE_TOKEN?: string;
  PLATFORM_INSTALLATION_ID?: string;
  // Set by `--runtime-logs minimal`: keep URLs out of `void_logs` rows.
  PLATFORM_RUNTIME_LOGS?: 'minimal';
  PLATFORM_TRAFFIC_STATE?: string;
}>;
