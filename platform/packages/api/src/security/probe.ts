/**
 * The entitlement probe (spec §5.2): checks 1–6. `void platform security probe` runs
 * it, and so does a policy change that leaves `disabled` (M6) and the daily hourly-cron
 * job while the policy is on (M9). Checks 1–4 must pass to leave `disabled`; check 5
 * decides per third-party host whether its models can be picked; check 6 only warns.
 *
 *   1 capability ─► 2 provision + container self-test ─► 3 egress lock (same self-test)
 *   4 Workers AI 1-token call · 5 one call per third-party host · 6 email binding
 */
import {
  getSecurityModel,
  isSecurityModelPriced,
  SECURITY_MODEL_IDS,
  type SecurityModelId,
  type SecurityThirdPartyHost,
} from '@void/platform/security-models';
import type { SecurityEntitlement, SecurityPolicy } from '@void/platform/security-policy';
import { getPlatformCapabilities } from '../capabilities.ts';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { generateId } from '../id.ts';
import { CF_API_BASE } from '../provisioning/cloudflare-api.ts';
import {
  provisionSecurityScanner,
  SecurityScannerError,
  securityScannerTarget,
  type SecurityScannerNames,
} from '../provisioning/security-scanner.ts';
import type { SelfTestResult } from '../security-scanner-controller-runtime.ts';
import {
  readStoredSecurityPolicy,
  recordSecurityEntitlement,
  securityFallbackModel,
} from './policy.ts';

export type SecurityProbeCheckName =
  | 'capability'
  | 'container'
  | 'egress'
  | 'workers_ai'
  | 'credits'
  | 'email';

/** The checks that must pass to leave `disabled`. */
export const SECURITY_PROBE_REQUIRED: ReadonlyArray<SecurityProbeCheckName> = [
  'capability',
  'container',
  'egress',
  'workers_ai',
];

export type SecurityProbeCheck = Readonly<{
  check: 1 | 2 | 3 | 4 | 5 | 6;
  name: SecurityProbeCheckName;
  label: string;
  status: 'ok' | 'fail' | 'off' | 'skipped';
  /** User copy for a failed, skipped or off check. */
  message?: string;
  /** Extra facts for logs and support; never a secret. */
  detail?: string;
  ms?: number;
  model?: SecurityModelId;
  host?: SecurityThirdPartyHost;
  link?: string;
}>;

export type SecurityProbeReport = Readonly<{
  probeId: string;
  checkedAt: string;
  /** Checks 1–4 passed. */
  ok: boolean;
  checks: ReadonlyArray<SecurityProbeCheck>;
  entitlement: SecurityEntitlement;
  coldStartMs: number | null;
}>;

/** The parts of the probe that leave the API Worker; tests replace them. */
export type SecurityProbeDeps = Readonly<{
  provision(): Promise<SecurityScannerNames>;
  selfTest(names: SecurityScannerNames, probeId: string): Promise<SelfTestResult>;
  workersAi(model: SecurityModelId): Promise<void>;
  thirdParty(host: SecurityThirdPartyHost, model: SecurityModelId): Promise<number>;
}>;

export const SECURITY_PROBE_COPY = {
  capability: 'Security audits are not installed. Run: void platform upgrade --security-audits',
  container:
    'Scans run in a Cloudflare Container. They need Workers Paid, and the runtime token needs Account → Containers → Edit and Account → Cloudchamber → Edit.',
  egress: (probeId: string) =>
    `Scanner network lock failed (probe ${probeId}). The scanner could reach the internet, so scans stay off to keep code private. Run void platform security probe again; if it keeps failing, report probe ${probeId} with void platform logs.`,
  egressSkipped: 'Not checked: the scanner container did not start.',
  workersAi: (model: SecurityModelId) =>
    `Could not run ${model}. It needs Workers Paid or prepaid AI credits.`,
  credits: (host: SecurityThirdPartyHost) =>
    `No AI Gateway credits for ${host}/*. Load Unified Billing credits to let projects pick these models.`,
  creditsPermission: (host: SecurityThirdPartyHost) =>
    `The runtime API token cannot call AI Gateway for ${host}/*. Add Account → Workers AI → Read to the token, then run the probe again.`,
  email: 'Email is off. Owners will see findings only in the CLI and project page.',
  skipped: 'Not checked: security audits are not installed.',
} as const;

export const SECURITY_CREDITS_LINK = 'https://dash.cloudflare.com/?to=/:account/ai/ai-gateway';
const AI_TIMEOUT_MS = 30_000;
/**
 * How long the API waits for the controller's self-test. The controller's own limits
 * (ready 90 s + setup 30 s + run 90 s) end first, so a slow start reports its own error.
 */
export const SECURITY_SELF_TEST_TIMEOUT_MS = 240_000;
const PROBE_PROMPT = 'Reply with ok.';
const DEFAULT_GATEWAY_ID = 'void';
/** Probe calls are not a project's usage; they carry this tag instead of a scan tag. */
const PROBE_METADATA = { securityScan: 'probe' };

/** The `@cf` model check 4 calls: the default when it is `@cf`, else the fallback. */
export function securityProbeWorkersAiModel(policy: SecurityPolicy): SecurityModelId {
  const model = getSecurityModel(policy.defaultModel);
  if (model.host === 'workers-ai' && !policy.blockedModels.includes(model.id)) {
    return model.id;
  }
  return securityFallbackModel(policy.blockedModels) ?? '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
}

/** One priced model per third-party host, called the way its engine calls it. */
export function securityProbeHostModel(host: SecurityThirdPartyHost): SecurityModelId {
  const id = SECURITY_MODEL_IDS.find(
    (candidate) => getSecurityModel(candidate).host === host && isSecurityModelPriced(candidate),
  );
  if (!id) {
    throw new Error(`No priced ${host} security model.`);
  }
  return id;
}

type Verdict = Readonly<{ ok: boolean; detail?: string }>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Checks 2 and 3 from the controller's self-test answer (pure). */
export function judgeSelfTest(
  result: SelfTestResult,
  probeId: string,
): Readonly<{ container: Verdict; egress: Verdict }> {
  const report = record(result.report);
  if (!result.started || !report || report.selfTest !== 1) {
    const detail = result.error ?? 'the scanner self-test did not run';
    return { container: { ok: false, detail }, egress: { ok: false, detail } };
  }
  if (typeof report.uid !== 'number' || report.uid === 0) {
    const detail = 'the scanner ran as root';
    return { container: { ok: false, detail }, egress: { ok: false, detail } };
  }
  const problems: Array<string> = [];
  const model = record(report.model);
  if (!model || model.ok !== true || model.probe !== probeId) {
    problems.push('the model route did not answer with this probe id');
  }
  const egress = record(report.egress);
  const targets = egress ? Object.entries(egress) : [];
  if (targets.length === 0) {
    problems.push('no egress target was checked');
  }
  for (const [name, value] of targets) {
    if (record(value)?.blocked !== true) {
      problems.push(`${name} was reachable`);
    }
  }
  const suspicious = Array.isArray(report.envSuspicious) ? report.envSuspicious : null;
  if (!suspicious || suspicious.length > 0) {
    problems.push(`credential-like env names: ${suspicious ? suspicious.join(', ') : 'unknown'}`);
  }
  return {
    container: { ok: true },
    egress: problems.length === 0 ? { ok: true } : { ok: false, detail: problems.join('; ') },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Check 2 copy for a failed provisioning step. Plan and token problems get the
 * Workers Paid / permissions copy; a name owned by another installation, an outdated
 * or missing controller and a changed gate say what they are, since more permissions
 * would not fix them.
 */
export function securityProvisionMessage(error: unknown): string {
  if (
    error instanceof SecurityScannerError &&
    (error.kind === 'ownership' ||
      error.kind === 'outdated' ||
      error.kind === 'missing' ||
      error.kind === 'gate')
  ) {
    return error.message;
  }
  return SECURITY_PROBE_COPY.container;
}

async function timed<T>(
  operation: () => Promise<T>,
): Promise<{ value?: T; error?: unknown; ms: number }> {
  const started = Date.now();
  try {
    return { value: await operation(), ms: Date.now() - started };
  } catch (error) {
    return { error, ms: Date.now() - started };
  }
}

function gatewayId(env: ApiEnv['Bindings']): string {
  return env.AI_GATEWAY_ID ?? DEFAULT_GATEWAY_ID;
}

/** The real calls: Cloudflare API, the dispatch gate, Workers AI and AI Gateway REST. */
export function securityProbeDeps(env: ApiEnv['Bindings']): SecurityProbeDeps {
  return {
    async provision() {
      return (await provisionSecurityScanner(securityScannerTarget(env))).names;
    },
    async selfTest(names, probeId) {
      const response = await env.DISPATCH.get(names.gate).fetch(
        'https://security-scanner.internal/v1/self-test',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ probeId }),
          signal: AbortSignal.timeout(SECURITY_SELF_TEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        throw new Error(`the scanner controller answered HTTP ${response.status}`);
      }
      return (await response.json()) as SelfTestResult;
    },
    async workersAi(model) {
      if (!env.AI) {
        throw new Error('the API Worker has no AI binding');
      }
      await env.AI.run(
        model as keyof AiModels,
        { messages: [{ role: 'user', content: PROBE_PROMPT }], max_tokens: 1 } as never,
        {
          gateway: {
            id: gatewayId(env),
            skipCache: true,
            collectLog: true,
            metadata: PROBE_METADATA,
          },
          extraHeaders: { 'cf-aig-collect-log-payload': 'false', 'cf-aig-skip-cache': 'true' },
          signal: AbortSignal.timeout(AI_TIMEOUT_MS),
        },
      );
    },
    async thirdParty(host, model) {
      // The routes and bodies the engines use: Messages for anthropic/* (Engine A),
      // Responses with the cyber access program for openai/* (Engine C).
      const [path, body] =
        host === 'anthropic'
          ? [
              'messages',
              { model, max_tokens: 1, messages: [{ role: 'user', content: PROBE_PROMPT }] },
            ]
          : [
              'responses',
              {
                model,
                input: PROBE_PROMPT,
                max_output_tokens: 16,
                access_programs: { cyber: 'standard' },
              },
            ];
      const response = await fetch(`${CF_API_BASE}/${env.CF_ACCOUNT_ID}/ai/v1/${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.CF_API_TOKEN}`,
          'content-type': 'application/json',
          'cf-aig-gateway-id': gatewayId(env),
          'cf-aig-collect-log-payload': 'false',
          'cf-aig-skip-cache': 'true',
          'cf-aig-metadata': JSON.stringify(PROBE_METADATA),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      });
      await response.body?.cancel();
      return response.status;
    },
  };
}

const HOSTS: ReadonlyArray<SecurityThirdPartyHost> = ['openai', 'anthropic'];

/** Runs checks 1–6. Never throws for a failing check; it reports it. */
export async function runSecurityProbe(
  env: ApiEnv['Bindings'],
  policy: SecurityPolicy,
  deps: SecurityProbeDeps = securityProbeDeps(env),
  now: () => number = Date.now,
): Promise<SecurityProbeReport> {
  const probeId = generateId('pr');
  const capability = getPlatformCapabilities(env).securityAudits;
  const aiModel = securityProbeWorkersAiModel(policy);
  const checks: Array<SecurityProbeCheck> = [];
  let coldStartMs: number | null = null;
  if (!capability) {
    // Nothing else runs: no provisioning call, no model call.
    checks.push({
      check: 1,
      name: 'capability',
      label: 'Capability securityAudits',
      status: 'fail',
      message: SECURITY_PROBE_COPY.capability,
    });
    checks.push(
      {
        check: 2,
        name: 'container',
        label: 'Container + token permissions',
        status: 'skipped',
        message: SECURITY_PROBE_COPY.skipped,
      },
      {
        check: 3,
        name: 'egress',
        label: 'Egress lock',
        status: 'skipped',
        message: SECURITY_PROBE_COPY.skipped,
      },
      {
        check: 4,
        name: 'workers_ai',
        label: `Workers AI  ${aiModel}`,
        model: aiModel,
        status: 'skipped',
        message: SECURITY_PROBE_COPY.skipped,
      },
      ...HOSTS.map((host): SecurityProbeCheck => ({
        check: 5,
        name: 'credits',
        label: `Credits     ${host}/*`,
        host,
        status: 'skipped',
        message: SECURITY_PROBE_COPY.skipped,
      })),
    );
  } else {
    checks.push({ check: 1, name: 'capability', label: 'Capability securityAudits', status: 'ok' });
    const scanner = (async () => {
      const provisioned = await timed(() => deps.provision());
      if (provisioned.error !== undefined || !provisioned.value) {
        return { provisioned, selfTest: undefined };
      }
      const names = provisioned.value;
      return { provisioned, selfTest: await timed(() => deps.selfTest(names, probeId)) };
    })();
    const [scan, ai, ...hosts] = await Promise.all([
      scanner,
      timed(() => deps.workersAi(aiModel)),
      ...HOSTS.map((host) => {
        const model = securityProbeHostModel(host);
        return timed(() => deps.thirdParty(host, model));
      }),
    ]);
    const containerLabel = 'Container + token permissions';
    if (scan.provisioned.error !== undefined) {
      checks.push(
        {
          check: 2,
          name: 'container',
          label: containerLabel,
          status: 'fail',
          message: securityProvisionMessage(scan.provisioned.error),
          detail: errorText(scan.provisioned.error),
          ms: scan.provisioned.ms,
        },
        {
          check: 3,
          name: 'egress',
          label: 'Egress lock',
          status: 'skipped',
          message: SECURITY_PROBE_COPY.egressSkipped,
        },
      );
    } else {
      const selfTest: SelfTestResult =
        scan.selfTest?.value ??
        ({
          started: false,
          coldStartMs: null,
          report: null,
          error: errorText(scan.selfTest?.error ?? 'no answer'),
        } satisfies SelfTestResult);
      coldStartMs = selfTest.coldStartMs;
      const verdict = judgeSelfTest(selfTest, probeId);
      checks.push({
        check: 2,
        name: 'container',
        label: containerLabel,
        status: verdict.container.ok ? 'ok' : 'fail',
        ...(verdict.container.ok
          ? {}
          : { message: SECURITY_PROBE_COPY.container, detail: verdict.container.detail }),
        ms: scan.selfTest?.ms,
      });
      if (!verdict.container.ok) {
        checks.push({
          check: 3,
          name: 'egress',
          label: 'Egress lock',
          status: 'skipped',
          message: SECURITY_PROBE_COPY.egressSkipped,
        });
      } else {
        if (!verdict.egress.ok) {
          // The probe id in the copy finds this line in `void platform logs`.
          console.error('[security-probe] egress lock failed', {
            probeId,
            detail: verdict.egress.detail,
            report: selfTest.report,
          });
        }
        checks.push({
          check: 3,
          name: 'egress',
          label: 'Egress lock',
          status: verdict.egress.ok ? 'ok' : 'fail',
          ...(verdict.egress.ok
            ? {}
            : { message: SECURITY_PROBE_COPY.egress(probeId), detail: verdict.egress.detail }),
        });
      }
    }
    checks.push({
      check: 4,
      name: 'workers_ai',
      label: `Workers AI  ${aiModel}`,
      model: aiModel,
      status: ai.error === undefined ? 'ok' : 'fail',
      ms: ai.ms,
      ...(ai.error === undefined
        ? {}
        : { message: SECURITY_PROBE_COPY.workersAi(aiModel), detail: errorText(ai.error) }),
    });
    HOSTS.forEach((host, index) => {
      const result = hosts[index]!;
      const status = result.value;
      const ok =
        result.error === undefined && status !== undefined && status >= 200 && status < 300;
      const permission = status === 401 || status === 403;
      checks.push({
        check: 5,
        name: 'credits',
        label: `Credits     ${host}/*`,
        host,
        model: securityProbeHostModel(host),
        status: ok ? 'ok' : 'fail',
        ms: result.ms,
        ...(ok
          ? {}
          : {
              message: permission
                ? SECURITY_PROBE_COPY.creditsPermission(host)
                : SECURITY_PROBE_COPY.credits(host),
              detail: result.error !== undefined ? errorText(result.error) : `HTTP ${status}`,
              ...(permission ? {} : { link: SECURITY_CREDITS_LINK }),
            }),
      });
    });
  }
  checks.push({
    check: 6,
    name: 'email',
    label: 'Email',
    status: env.EMAIL ? 'ok' : 'off',
    ...(env.EMAIL ? {} : { message: SECURITY_PROBE_COPY.email }),
  });
  const missing = SECURITY_PROBE_REQUIRED.filter((name) =>
    checks.some((check) => check.name === name && check.status !== 'ok'),
  );
  const hostOk = (host: SecurityThirdPartyHost) =>
    checks.some((check) => check.host === host && check.status === 'ok');
  const checkedAt = new Date(now()).toISOString();
  const entitlement: SecurityEntitlement = {
    checkedAt,
    ok: missing.length === 0,
    missing,
    hosts: { openai: hostOk('openai'), anthropic: hostOk('anthropic') },
  };
  return { probeId, checkedAt, ok: entitlement.ok, checks, entitlement, coldStartMs };
}

/** `POST /operator/v1/security/probe`: run and store. */
export async function probeAndRecord(
  env: ApiEnv['Bindings'],
  db: Db,
  deps?: SecurityProbeDeps,
): Promise<SecurityProbeReport & Readonly<{ saved: boolean; revision: number | null }>> {
  const stored = await readStoredSecurityPolicy(db);
  const report = await runSecurityProbe(env, stored.policy, deps);
  if (!getPlatformCapabilities(env).securityAudits) {
    // Capability off: nothing ran, nothing is stored.
    return { ...report, saved: false, revision: null };
  }
  const saved = await recordSecurityEntitlement(db, report.entitlement);
  return { ...report, ...saved };
}
