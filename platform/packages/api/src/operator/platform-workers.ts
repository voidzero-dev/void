export type PlatformWorkerName =
  | 'proxy'
  | 'email-gateway'
  | 'tail'
  | 'api'
  | 'dashboard'
  | 'dispatch';

type PlatformWorkerDef = Readonly<{
  name: PlatformWorkerName;
  prodScript: string;
  stagingScript: string;
  dependsOn: ReadonlyArray<PlatformWorkerName>;
  deployOrder: number;
}>;

export type PlatformWorker = PlatformWorkerDef & {
  dependedBy: ReadonlyArray<PlatformWorkerName>;
};

// `deployOrder` follows the platform deploy script; rollback-all runs it in
// reverse. The API's confirmation page posts back through the email gateway,
// so the gateway ships before the API and rolls back after it. The dispatcher's
// private preview entrypoint must also exist before the API binds to it.
const WORKER_DEFS: ReadonlyArray<PlatformWorkerDef> = [
  {
    name: 'proxy',
    prodScript: 'void-proxy',
    stagingScript: 'void-proxy-staging',
    dependsOn: [],
    deployOrder: 1,
  },
  {
    name: 'email-gateway',
    prodScript: 'void-email-gateway',
    stagingScript: 'void-email-gateway-staging',
    dependsOn: [],
    deployOrder: 2,
  },
  {
    name: 'tail',
    prodScript: 'void-tail',
    stagingScript: 'void-tail-staging',
    dependsOn: [],
    deployOrder: 3,
  },
  {
    name: 'api',
    prodScript: 'void-api',
    stagingScript: 'void-api-staging',
    dependsOn: ['proxy', 'email-gateway', 'dispatch'],
    deployOrder: 5,
  },
  {
    name: 'dashboard',
    prodScript: 'void-dashboard',
    stagingScript: 'void-dashboard-staging',
    dependsOn: ['api'],
    deployOrder: 6,
  },
  {
    name: 'dispatch',
    prodScript: 'void-dispatch',
    stagingScript: 'void-dispatch-staging',
    dependsOn: ['proxy', 'tail'],
    deployOrder: 4,
  },
];

// Derive dependedBy from dependsOn (single source of truth for the dependency graph)
export const PLATFORM_WORKERS: ReadonlyArray<PlatformWorker> = WORKER_DEFS.map((def) => ({
  ...def,
  dependedBy: WORKER_DEFS.flatMap((other) =>
    other.dependsOn.includes(def.name) ? [other.name] : [],
  ),
}));

export type PlatformEnv = 'production' | 'staging';

export function getScriptName(worker: PlatformWorker, env: PlatformEnv): string {
  return env === 'staging' ? worker.stagingScript : worker.prodScript;
}

export function getWorkerByName(name: string): PlatformWorker | undefined {
  return PLATFORM_WORKERS.find((w) => w.name === name);
}
