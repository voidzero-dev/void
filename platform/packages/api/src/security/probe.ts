/**
 * The entitlement probe (spec §5.2): checks 1–6. `void platform security probe` runs
 * it, and so does a policy change that leaves `disabled` (M6) and the daily hourly-cron
 * job while the policy is on (M9). Checks 1–4 must pass to leave `disabled`; check 5
 * decides per third-party host whether its models can be picked; check 6 only warns.
 *
 *   1 capability
 *   4 Workers AI 1-token call
 *   5 per third-party host: one call ─► copy + prepare its engine image   (all in parallel;
 *     only when the call passed and not every model of the host is blocked; M13b)
 *   2 provision + container self-test ─► 3 egress lock
 *   5 image: the same self-test in each deployed engine image        (in parallel with 2)
 *   6 email binding
 *
 * The model calls and the image work end by `SECURITY_IMAGE_BUDGET_MS` after the start.
 * The controller keeps every engine image it already runs at the current release pin, so a
 * failed call or copy only decides whether the host can be picked, never what is deployed.
 * A third-party host can be picked only when its call and its engine image both pass.
 * With a saved provider key (M33) the host's call goes out on that key, the way its scans
 * do; the report keeps the key ids it ran with, so a key changed meanwhile is not covered.
 */
import {
  getSecurityModel,
  isSecurityModelPriced,
  SECURITY_MODEL_IDS,
} from '@void/platform/security-models';
import type { SecurityModelId, SecurityThirdPartyHost } from '@void/platform/security-models';
import type { SecurityEntitlement, SecurityPolicy } from '@void/platform/security-policy';
import { getPlatformCapabilities } from '../capabilities.ts';
import type { Db, DbOrTx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { generateId } from '../id.ts';
import { CF_API_BASE } from '../provisioning/cloudflare-api.ts';
import {
  ensureSecurityScannerImage,
  scannerImageRef,
} from '../provisioning/security-scanner-images.ts';
import type { ScannerImageResult } from '../provisioning/security-scanner-images.ts';
import {
  assertSecurityScannerContainers,
  provisionSecurityScanner,
  SecurityScannerError,
  securityScannerNames,
  securityScannerTarget,
} from '../provisioning/security-scanner.ts';
import type {
  SecurityScannerImages,
  SecurityScannerNames,
} from '../provisioning/security-scanner.ts';
import type { ScannerEngine, SelfTestResult } from '../security-scanner-controller-runtime.ts';
import {
  readStoredSecurityPolicy,
  recordSecurityEntitlement,
  securityFallbackModel,
} from './policy.ts';
import {
  loadSecurityProviderKeySlots,
  securityProviderKeySlotIds,
  testSecurityProviderKey,
} from './provider-keys.ts';
import type { SecurityProviderKeyIds, SecurityProviderKeySlots } from './provider-keys.ts';
import { securityImageEngineForHost, securityScannerImagePins } from './scanner-images.ts';
import type { SecurityImageEngine } from './scanner-images.ts';

export type SecurityProbeCheckName =
  | 'capability'
  | 'container'
  | 'egress'
  | 'workers_ai'
  | 'credits'
  | 'image'
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
  /** The saved provider key per host the probe ran with (`null`: Unified Billing). */
  keyIds: SecurityProviderKeyIds;
}>;

export type SecurityProbeProvisioned = Readonly<{
  names: SecurityScannerNames;
  /** The engine images the controller runs after provisioning. */
  deployed: SecurityScannerImages;
}>;

/** The parts of the probe that leave the API Worker; tests replace them. */
export type SecurityProbeDeps = Readonly<{
  /** Copies (when missing) and prepares one engine image, ending by `deadline`. */
  image(engine: SecurityImageEngine, deadline: number): Promise<ScannerImageResult>;
  /** Provisions the scanner with the images made ready now; deployed ones at the pin stay. */
  provision(ready: SecurityScannerImages): Promise<SecurityProbeProvisioned>;
  selfTest(
    names: SecurityScannerNames,
    probeId: string,
    engine: ScannerEngine,
  ): Promise<SelfTestResult>;
  workersAi(model: SecurityModelId): Promise<void>;
  /** The HTTP status of the host's 1-token call (on its saved key when there is one). */
  thirdParty(host: SecurityThirdPartyHost, model: SecurityModelId): Promise<number>;
  /** The saved provider keys, read once before the checks. */
  keys: SecurityProviderKeySlots;
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
  ownKeyRefused: (host: SecurityThirdPartyHost, status: number) =>
    `The ${host} provider refused your saved key (HTTP ${status}). Save a working key: void platform security models --provider ${host} --key-stdin`,
  ownKeyFailed: (host: SecurityThirdPartyHost, detail: string) =>
    `The ${host}/* call on your saved key failed (${detail}). Check the key and its quota at the provider, then run void platform security probe again.`,
  ownKeyUnreadable: (host: SecurityThirdPartyHost) =>
    `The saved ${host} key cannot be read with the platform encryption keys. Save it again: void platform security models --provider ${host} --key-stdin`,
  email: 'Email is off. Owners will see findings only in the CLI and project page.',
  skipped: 'Not checked: security audits are not installed.',
  imageNoCredits: (host: SecurityThirdPartyHost) =>
    `Not checked: the ${host}/* call did not pass, so its scanner image is not copied.`,
  imageBlocked: (host: SecurityThirdPartyHost) =>
    `Not checked: every ${host}/* model is blocked, so its scanner image is not copied. Unblock a model, then run void platform security probe.`,
  imageSkipped: 'Not checked: the scanner controller could not be provisioned.',
  imageUnpublished: (host: SecurityThirdPartyHost) =>
    `This platform release has no scanner image for ${host}/* models. They stay off until a platform release ships one.`,
  imagePending: (host: SecurityThirdPartyHost) =>
    `The ${host}/* scanner image is still being copied into this account. Run void platform security probe again in a few minutes.`,
  imageCredentials: (host: SecurityThirdPartyHost) =>
    `The runtime token cannot copy the ${host}/* scanner image into the account registry. It needs Account → Containers → Edit.`,
  imageCopy: (host: SecurityThirdPartyHost) =>
    `Could not copy the ${host}/* scanner image into this account. Run void platform security probe again.`,
  imageSelfTest: (host: SecurityThirdPartyHost, probeId: string) =>
    `The ${host}/* scanner image failed its self-test (probe ${probeId}), so these models stay off. Run void platform security probe again; if it keeps failing, report probe ${probeId} with void platform logs.`,
} as const;

/**
 * How long, from the probe start, the model calls and the engine image copy may take; the
 * copy resumes next time. With provisioning and the self-test (at most 240 s) the probe
 * stays under the CLI's 5-minute request timeout.
 */
export const SECURITY_IMAGE_BUDGET_MS = 45_000;

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

/**
 * The real calls: Cloudflare API, the dispatch gate, Workers AI and AI Gateway REST, or
 * the provider-native route on a saved key (`keys`, read by `loadSecurityProviderKeySlots`).
 */
export function securityProbeDeps(
  env: ApiEnv['Bindings'],
  keys: SecurityProviderKeySlots,
): SecurityProbeDeps {
  const target = securityScannerTarget(env);
  // No image is copied into an account that cannot run containers (checked once).
  let containers: Promise<void> | undefined;
  return {
    async image(engine, deadline) {
      containers ??= assertSecurityScannerContainers(target);
      await containers;
      const names = await securityScannerNames(target.installationKey);
      const pin = securityScannerImagePins().find((candidate) => candidate.engine === engine)!;
      return ensureSecurityScannerImage(target, pin, names.engines[engine].repository, {
        deadline,
      });
    },
    async provision(ready) {
      const names = await securityScannerNames(target.installationKey);
      // The refs of this release's pins: an engine already running one of them stays.
      const keep: Partial<Record<SecurityImageEngine, string>> = {};
      for (const pin of securityScannerImagePins()) {
        if (pin.digest !== null) {
          keep[pin.engine] = scannerImageRef(
            target.accountId,
            names.engines[pin.engine].repository,
            pin.digest,
          );
        }
      }
      const result = await provisionSecurityScanner(target, ready, { keep });
      return { names, deployed: result.images };
    },
    async selfTest(names, probeId, engine) {
      const response = await env.DISPATCH.get(names.gate).fetch(
        'https://security-scanner.internal/v1/self-test',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ probeId, engine }),
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
    keys,
    async thirdParty(host, model) {
      const slot = keys[host];
      if (slot && 'unreadable' in slot) {
        throw new Error('the saved key cannot be read');
      }
      if (slot) {
        return testSecurityProviderKey(env.AI, gatewayId(env), slot, model);
      }
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
const CONTAINER_LABEL = 'Container + token permissions';

const creditsLabel = (host: SecurityThirdPartyHost) => `Credits     ${host}/*`;
const ownKeyLabel = (host: SecurityThirdPartyHost) => `Own key     ${host}/*`;
const imageLabel = (host: SecurityThirdPartyHost) => `Image       ${host}/*`;

type Timed<T> = Readonly<{ value?: T; error?: unknown; ms: number }>;

/** Every model of this host is blocked, so none of its scans can run. */
function hostBlocked(policy: SecurityPolicy, host: SecurityThirdPartyHost): boolean {
  return SECURITY_MODEL_IDS.filter((id) => getSecurityModel(id).host === host).every((id) =>
    policy.blockedModels.includes(id),
  );
}

/** The check 5 line for one host's engine image. */
function imageCheck(input: {
  host: SecurityThirdPartyHost;
  probeId: string;
  creditsOk: boolean;
  blocked: boolean;
  provisioned: boolean;
  /** The controller runs this engine's image (copied now or by an earlier probe). */
  deployed: boolean;
  image: Timed<ScannerImageResult> | undefined;
  selfTest: Timed<SelfTestResult> | undefined;
}): SecurityProbeCheck {
  const { host, probeId } = input;
  const base = { check: 5 as const, name: 'image' as const, label: imageLabel(host), host };
  if (!input.creditsOk) {
    return { ...base, status: 'skipped', message: SECURITY_PROBE_COPY.imageNoCredits(host) };
  }
  if (input.blocked) {
    return { ...base, status: 'skipped', message: SECURITY_PROBE_COPY.imageBlocked(host) };
  }
  if (!input.provisioned || input.image === undefined) {
    return { ...base, status: 'skipped', message: SECURITY_PROBE_COPY.imageSkipped };
  }
  const image: ScannerImageResult = input.image.value ?? {
    ok: false,
    step: 'copy',
    detail: errorText(input.image.error ?? 'no answer'),
  };
  // A deployed image is judged by its self-test, even when this run's copy step failed.
  if (!input.deployed && !image.ok) {
    const message =
      image.step === 'unpublished'
        ? SECURITY_PROBE_COPY.imageUnpublished(host)
        : image.step === 'pending'
          ? SECURITY_PROBE_COPY.imagePending(host)
          : image.step === 'credentials'
            ? SECURITY_PROBE_COPY.imageCredentials(host)
            : SECURITY_PROBE_COPY.imageCopy(host);
    return { ...base, status: 'fail', message, detail: image.detail };
  }
  if (!input.deployed) {
    return { ...base, status: 'skipped', message: SECURITY_PROBE_COPY.imageSkipped };
  }
  const result: SelfTestResult = input.selfTest?.value ?? {
    started: false,
    coldStartMs: null,
    report: null,
    error: errorText(input.selfTest?.error ?? 'no answer'),
  };
  const verdict = judgeSelfTest(result, probeId);
  if (verdict.container.ok && verdict.egress.ok) {
    return { ...base, status: 'ok', ms: input.selfTest?.ms };
  }
  const detail = verdict.container.ok ? verdict.egress.detail : verdict.container.detail;
  console.error('[security-probe] engine image self-test failed', {
    probeId,
    host,
    detail,
    report: result.report,
  });
  return {
    ...base,
    status: 'fail',
    message: SECURITY_PROBE_COPY.imageSelfTest(host, probeId),
    detail,
    ms: input.selfTest?.ms,
  };
}

/** Runs checks 1–6. Never throws for a failing check; it reports it. */
export async function runSecurityProbe(
  env: ApiEnv['Bindings'],
  db: DbOrTx,
  policy: SecurityPolicy,
  given?: SecurityProbeDeps,
  now: () => number = Date.now,
): Promise<SecurityProbeReport> {
  const deps = given ?? securityProbeDeps(env, await loadSecurityProviderKeySlots(env, db));
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
        label: CONTAINER_LABEL,
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
      ...HOSTS.flatMap((host): Array<SecurityProbeCheck> => [
        {
          check: 5,
          name: 'credits',
          label: creditsLabel(host),
          host,
          status: 'skipped',
          message: SECURITY_PROBE_COPY.skipped,
        },
        {
          check: 5,
          name: 'image',
          label: imageLabel(host),
          host,
          status: 'skipped',
          message: SECURITY_PROBE_COPY.skipped,
        },
      ]),
    );
  } else {
    checks.push({ check: 1, name: 'capability', label: 'Capability securityAudits', status: 'ok' });
    // An engine image is copied right after its host's call passes, unless every model of
    // the host is blocked. All of it ends by the deadline; a copy cut off goes on next time.
    const deadline = Date.now() + SECURITY_IMAGE_BUDGET_MS;
    const [ai, ...hosts] = await Promise.all([
      timed(() => deps.workersAi(aiModel)),
      ...HOSTS.map(async (host) => {
        const model = securityProbeHostModel(host);
        const credits = await timed(() => deps.thirdParty(host, model));
        const ok =
          credits.error === undefined &&
          credits.value !== undefined &&
          credits.value >= 200 &&
          credits.value < 300;
        const blocked = hostBlocked(policy, host);
        const engine = securityImageEngineForHost(host);
        const image = ok && !blocked ? await timed(() => deps.image(engine, deadline)) : undefined;
        return { host, engine, credits, ok, blocked, image };
      }),
    ]);
    const creditsOk = hosts.map((entry) => entry.ok);
    const ready: Partial<Record<SecurityImageEngine, string>> = {};
    for (const entry of hosts) {
      if (entry.image?.value?.ok) {
        ready[entry.engine] = entry.image.value.ref;
      }
    }
    const provisioned = await timed(() => deps.provision(ready));
    const deployed = provisioned.value?.deployed ?? {};
    const names = provisioned.value?.names;
    // Engine B and each deployed engine image of a callable, unblocked host run the same
    // self-test, in parallel.
    const testedEngines = hosts
      .filter((entry) => entry.ok && !entry.blocked && deployed[entry.engine] !== undefined)
      .map((entry) => entry.engine);
    const [selfTest, ...engineTests] = names
      ? await Promise.all([
          timed(() => deps.selfTest(names, probeId, 'void_loop')),
          ...testedEngines.map((engine) => timed(() => deps.selfTest(names, probeId, engine))),
        ])
      : [undefined];
    const engineSelfTest = (engine: SecurityImageEngine) =>
      testedEngines.includes(engine) ? engineTests[testedEngines.indexOf(engine)] : undefined;

    if (provisioned.error !== undefined || !names) {
      checks.push(
        {
          check: 2,
          name: 'container',
          label: CONTAINER_LABEL,
          status: 'fail',
          message: securityProvisionMessage(provisioned.error),
          detail: errorText(provisioned.error),
          ms: provisioned.ms,
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
      const result: SelfTestResult =
        selfTest?.value ??
        ({
          started: false,
          coldStartMs: null,
          report: null,
          error: errorText(selfTest?.error ?? 'no answer'),
        } satisfies SelfTestResult);
      coldStartMs = result.coldStartMs;
      const verdict = judgeSelfTest(result, probeId);
      checks.push({
        check: 2,
        name: 'container',
        label: CONTAINER_LABEL,
        status: verdict.container.ok ? 'ok' : 'fail',
        ...(verdict.container.ok
          ? {}
          : { message: SECURITY_PROBE_COPY.container, detail: verdict.container.detail }),
        ms: selfTest?.ms,
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
            report: result.report,
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
      const entry = hosts[index]!;
      const result = entry.credits;
      const status = result.value;
      const ok = creditsOk[index]!;
      const permission = status === 401 || status === 403;
      const detail = result.error !== undefined ? errorText(result.error) : `HTTP ${status}`;
      const slot = deps.keys[host];
      checks.push({
        check: 5,
        name: 'credits',
        label: slot ? ownKeyLabel(host) : creditsLabel(host),
        host,
        model: securityProbeHostModel(host),
        status: ok ? 'ok' : 'fail',
        ms: result.ms,
        ...(ok
          ? {}
          : slot
            ? {
                // A saved key: its own copy, never the credits or token one.
                message:
                  'unreadable' in slot
                    ? SECURITY_PROBE_COPY.ownKeyUnreadable(host)
                    : permission
                      ? SECURITY_PROBE_COPY.ownKeyRefused(host, status ?? 0)
                      : SECURITY_PROBE_COPY.ownKeyFailed(host, detail),
                detail,
              }
            : {
                message: permission
                  ? SECURITY_PROBE_COPY.creditsPermission(host)
                  : SECURITY_PROBE_COPY.credits(host),
                detail,
                ...(permission ? {} : { link: SECURITY_CREDITS_LINK }),
              }),
      });
      checks.push(
        imageCheck({
          host,
          probeId,
          creditsOk: ok,
          blocked: entry.blocked,
          provisioned: names !== undefined && provisioned.error === undefined,
          deployed: deployed[entry.engine] !== undefined,
          image: entry.image,
          selfTest: engineSelfTest(entry.engine),
        }),
      );
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
  // A host can be picked when its model call passed and its engine image runs.
  const hostOk = (host: SecurityThirdPartyHost) =>
    ['credits', 'image'].every((name) =>
      checks.some((check) => check.host === host && check.name === name && check.status === 'ok'),
    );
  const checkedAt = new Date(now()).toISOString();
  const entitlement: SecurityEntitlement = {
    checkedAt,
    ok: missing.length === 0,
    missing,
    hosts: { openai: hostOk('openai'), anthropic: hostOk('anthropic') },
  };
  return {
    probeId,
    checkedAt,
    ok: entitlement.ok,
    checks,
    entitlement,
    coldStartMs,
    keyIds: securityProviderKeySlotIds(deps.keys),
  };
}

/** `POST /operator/v1/security/probe`: run and store. */
export async function probeAndRecord(
  env: ApiEnv['Bindings'],
  db: Db,
  deps?: SecurityProbeDeps,
): Promise<SecurityProbeReport & Readonly<{ saved: boolean; revision: number | null }>> {
  const stored = await readStoredSecurityPolicy(db);
  const report = await runSecurityProbe(env, db, stored.policy, deps);
  if (!getPlatformCapabilities(env).securityAudits) {
    // Capability off: nothing ran, nothing is stored.
    return { ...report, saved: false, revision: null };
  }
  const saved = await recordSecurityEntitlement(db, report.entitlement, report.keyIds);
  return { ...report, ...saved };
}
