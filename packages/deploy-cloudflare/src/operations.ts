/** Typed provider operations shared by app deployment and platform installation. */
type ConfigTarget = { configPath?: string };
type WorkerTarget = ConfigTarget & { workerName?: string };

export type CloudflareOperation =
  | ({ type: 'auth.whoami' | 'auth.login' | 'auth.logout' | 'auth.token' } & ConfigTarget)
  | ({ type: 'd1.list' | 'kv.namespace.list' | 'containers.list' } & ConfigTarget)
  | ({ type: 'd1.info'; name: string } & ConfigTarget)
  | { type: 'd1.create'; name: string; binding: string; configPath: string }
  | { type: 'd1.execute'; database: string; sql: string; configPath: string }
  | { type: 'd1.migrations.list' | 'd1.migrations.apply'; database: string; configPath: string }
  | { type: 'd1.time-travel.bookmark'; database: string; configPath: string }
  | {
      type: 'd1.time-travel.restore';
      database: string;
      target: { bookmark: string } | { timestamp: string };
      configPath: string;
    }
  | { type: 'kv.namespace.create'; name: string; binding: string; configPath: string }
  | ({ type: 'r2.bucket.info'; name: string } & ConfigTarget)
  | { type: 'r2.bucket.create'; name: string; binding: string; configPath: string }
  | { type: 'hyperdrive.create'; name: string; binding: string; configPath: string }
  | ({ type: 'queues.info' | 'queues.create'; name: string } & ConfigTarget)
  | ({ type: 'queues.consumer.remove'; queueName: string; workerName: string } & ConfigTarget)
  | ({
      type:
        | 'email.routing.settings'
        | 'email.routing.enable'
        | 'email.routing.rules.list'
        | 'email.sending.settings'
        | 'email.sending.enable';
      domain: string;
    } & ConfigTarget)
  | ({ type: 'secret.list' | 'secret.bulk' } & WorkerTarget)
  | ({ type: 'secret.put' | 'secret.delete'; name: string } & WorkerTarget)
  | ({ type: 'deployments.status' | 'deployments.list' | 'versions.list' } & WorkerTarget)
  | ({ type: 'versions.view'; versionId: string; includeSource?: boolean } & WorkerTarget)
  | ({
      type: 'versions.deploy';
      versions: Array<{ versionId: string; percentage: number }>;
      message?: string;
      bypassDeploymentChecks?: boolean;
    } & WorkerTarget)
  | ({
      type: 'versions.upload' | 'worker.deploy';
      message?: string;
      secretsFilePath?: string;
      assetsDirectory?: string;
      previewAlias?: string;
      noBundle?: boolean;
      /**
       * Attach the Cloudflare CLI to this terminal so that it can ask the
       * operator. The result then has only the exit status.
       */
      interactive?: boolean;
    } & WorkerTarget)
  | ({ type: 'triggers.deploy'; assets?: boolean } & WorkerTarget)
  | ({ type: 'triggers.clear-crons' | 'triggers.clear-domains' } & WorkerTarget)
  | ({ type: 'tail'; search?: string; versionId?: string; status?: 'error' } & WorkerTarget);

export type CloudflareUploadResult = {
  versionId: string;
  previewUrl?: string;
  workersDevUrl?: string;
};

export type CloudflareProviderError = {
  code?: number;
  message: string;
};
