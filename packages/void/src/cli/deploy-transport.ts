import { readWranglerTopLevelString } from '@void/deploy-cloudflare';
import { join } from 'pathslash';
import { scanWranglerDotenvKeys } from '../shared/dotenv.ts';
import { CLOUDFLARE_DEPLOY_BUILD_ENV } from '../shared/env.ts';
import { WRANGLER_AUTH_CREDENTIAL_ENV_VARS } from '../shared/untrusted-env.ts';
import { CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV } from '../shared/version-metadata.ts';
import {
  assertNoTransportRedirectInProjectDotenv,
  deleteEnvVarCaseAware,
  provisionEnv,
  resolvePinnedApiBaseUrl,
} from './provision.ts';

/**
 * Marks a build child as driven by a MANAGED `void deploy`.
 *
 * The platform resolves the asset routing policy out-of-band (`resolveAssetConfig`
 * → `manifest.assetConfig`) and applies it to the uploaded script, so settings the
 * Vite plugin cannot safely write into the built wrangler config — `routing.notFound`
 * for a Class A framework, which needs an `assets` policy Void does not own there —
 * are still honored on this path. `void:framework-build-wrapper` warns about exactly
 * those when this flag is ABSENT, i.e. on a self-hosted `vite build && wrangler deploy`.
 *
 * Passed through the CHILD env only (never `process.env`), the same way
 * `VOID_DEPLOY_PROJECT_ID` is, so it cannot leak into an unrelated child process or a
 * later `void dev` in the same shell.
 *
 * Deliberately NOT set by `runCloudflareDeploy` (`--platform cloudflare`): that flow
 * deploys the built output to the user's own account and IS the self-host path the
 * warning is about.
 */
export const MANAGED_DEPLOY_BUILD_ENV = { VOID_DEPLOY_BUILD: '1' } as const;

/** Remove managed-only build markers from an explicit native Cloudflare child. */
export function scrubManagedDeployBuildMarkers(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  deleteEnvVarCaseAware(env, 'VOID_DEPLOY_PROJECT_ID');
  deleteEnvVarCaseAware(env, CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV);
  for (const name of Object.keys(MANAGED_DEPLOY_BUILD_ENV)) {
    deleteEnvVarCaseAware(env, name);
  }
  return env;
}

/**
 * Deploy-time env selectors that pin the WRONG worker/config out from under the
 * top-level config this flow provisions + preflights. Scrubbed from every child env
 * and fenced in the project dotenv (see below), on top of the provisioner's transport
 * scrub/fence which owns the endpoint-redirect + `CLOUDFLARE_ENV` vars:
 *   - `WRANGLER_CI_OVERRIDE_NAME` — the Cloudflare tooling (wrangler and the `cf` CLI)
 *     applies it AFTER config load (`getCIOverrideName()`), REPLACING the upload name, so a
 *     bare deploy uploads a worker whose name the generated-config check never validated.
 *   - `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH` — the CF Vite plugin points the build at an
 *     ALTERNATE wrangler config, flattening a different binding set into
 *     `dist/ssr/wrangler.json`.
 */
const DEPLOY_CONFIG_OVERRIDE_ENV_VARS = [
  'WRANGLER_CI_OVERRIDE_NAME',
  'CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH',
] as const;

/**
 * The dotenv files wrangler loads into `process.env` (`override: true`) when no
 * `--env` is named (`getDefaultEnvFiles("")`). Void runs its deploy steps through the
 * `cf` CLI, not wrangler, but this set is kept for a user who runs `wrangler deploy` on
 * the same config. It also covers the `.env` / `.env.local` files `cf` reads. A repo
 * dotenv here would bring back `WRANGLER_CI_OVERRIDE_NAME` after the child-env scrub
 * removed it.
 */
const DEPLOY_WRANGLER_DOTENV_FILES = ['.env', '.env.local', '.env.', '.env..local'];

/**
 * The dotenv files Vite's `loadEnv(mode, …)` reads for a production `vite build`
 * (`.env`, `.env.local`, `.env.production`, `.env.production.local`), where the CF Vite
 * plugin picks up `CLOUDFLARE_ENV` / `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH` — a set
 * that differs from the wrangler dotenv files above, so it is fenced separately for the build.
 */
const DEPLOY_VITE_DOTENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'];

/** The first non-blank ambient selector of a non-top-level worker/config, if any. */
export function findAmbientConfigOverride(): string | undefined {
  return ['CLOUDFLARE_ENV', 'CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH'].find((name) =>
    process.env[name]?.trim(),
  );
}

/**
 * FAIL CLOSED when the AMBIENT env selects a non-top-level worker/config for the
 * Cloudflare backend, which deploys the top-level environment of the canonical root
 * config ONLY. `CLOUDFLARE_ENV` picks a named env block (different account/name/bindings);
 * `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH` points the build at a different config. We refuse
 * rather than silently deploy a target the drift-check / provision never reasoned about.
 */
function assertNoAmbientConfigOverride(): void {
  const override = findAmbientConfigOverride();
  if (override === 'CLOUDFLARE_ENV') {
    throw new Error(
      'CLOUDFLARE_ENV is set. --platform cloudflare deploys the TOP-LEVEL environment of ' +
        'your root wrangler config only (a named environment can carry a different account, ' +
        'worker name, or binding set). Unset CLOUDFLARE_ENV and retry.',
    );
  }
  if (override) {
    throw new Error(
      'CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH is set. --platform cloudflare builds from the ' +
        'canonical root wrangler config only. Unset it and retry.',
    );
  }
}

/** Which of `names` the project dotenv `file` declares; win32 keys match case-insensitively. */
function findDotenvDeclaration(
  root: string,
  file: string,
  names: ReadonlyArray<string>,
  platform: NodeJS.Platform,
): string | undefined {
  const caseInsensitive = platform === 'win32';
  const rawKeys = scanWranglerDotenvKeys(join(root, file));
  const keys = caseInsensitive ? new Set([...rawKeys].map((key) => key.toLowerCase())) : rawKeys;
  return names.find((name) => keys.has(caseInsensitive ? name.toLowerCase() : name));
}

/** The first dotenv file wrangler reloads that declares `WRANGLER_CI_OVERRIDE_NAME`. */
export function findWranglerCiOverrideDotenvFile(
  root: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return DEPLOY_WRANGLER_DOTENV_FILES.find((file) =>
    findDotenvDeclaration(root, file, ['WRANGLER_CI_OVERRIDE_NAME'], platform),
  );
}

/**
 * FAIL CLOSED when the project's dotenv files declare a deploy-time config-override
 * selector. wrangler / Vite reload dotenv on every command, so a repo dotenv would
 * reintroduce a scrubbed var AFTER the child-env scrub — reselecting the upload worker
 * name (the wrangler dotenv files) or the build's wrangler config (Vite production files).
 * The provisioner's transport fence ({@link assertNoTransportRedirectInProjectDotenv})
 * owns `CLOUDFLARE_ENV` + the endpoint-redirect vars; this closes the deploy-specific
 * name/config-path selectors it does not cover, across BOTH consumers' file sets.
 * Exported for direct unit testing of the file-set + win32 case rule.
 */
export function assertNoConfigOverrideInProjectDotenv(
  root: string,
  platform: NodeJS.Platform = process.platform,
): void {
  // WRANGLER_CI_OVERRIDE_NAME reaches a deploy through the wrangler dotenv reload.
  const ciOverrideFile = findWranglerCiOverrideDotenvFile(root, platform);
  if (ciOverrideFile) {
    throw new Error(
      `the project file "${ciOverrideFile}" sets WRANGLER_CI_OVERRIDE_NAME, which wrangler reloads on ` +
        `every command and applies AFTER config load to REPLACE the deployed worker name — so ` +
        `\`wrangler deploy\` would upload a worker whose name was never validated. Remove it from ` +
        `"${ciOverrideFile}" (set it in your shell/CI only if you truly need a CI name override).`,
    );
  }
  // CLOUDFLARE_ENV / CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH reach the BUILD via Vite's
  // production `loadEnv`, whose file set differs from the wrangler dotenv files.
  for (const file of DEPLOY_VITE_DOTENV_FILES) {
    const offender = findDotenvDeclaration(
      root,
      file,
      ['CLOUDFLARE_ENV', 'CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH'],
      platform,
    );
    if (offender) {
      throw new Error(
        `the project file "${file}" sets ${offender}, which the Cloudflare Vite plugin reads at ` +
          `build time to select a named environment or an ALTERNATE wrangler config — flattening a ` +
          `different binding set into dist/ssr/wrangler.json than this deploy provisioned. Remove ` +
          `${offender} from "${file}".`,
      );
    }
  }
}

/**
 * Resolve + validate the ONE pinned transport for the whole deploy, and FAIL CLOSED
 * on any ambient/dotenv redirect that would move the target out from under the pinned
 * top-level config. Reuses the provisioner's resolver + dotenv fence so provision AND
 * the deploy tail (build / whoami / migrate / deploy) share one source of truth.
 * Returns the single resolved API base URL to pin into every child env.
 */
export function resolveDeployTransport(root: string, rootConfig: Record<string, unknown>): string {
  assertNoAmbientConfigOverride();
  assertNoTransportRedirectInProjectDotenv(root);
  assertNoConfigOverrideInProjectDotenv(root);
  return resolvePinnedApiBaseUrl(
    process.env,
    readWranglerTopLevelString(rootConfig, 'compliance_region'),
  );
}

/**
 * Build a child env for an orchestrator-owned wrangler / build invocation. Reuses the
 * provisioner's {@link provisionEnv} (scrubs the CF Access pair + EVERY transport
 * selector incl. `CLOUDFLARE_ENV` + win32 case variants, pins ONE account + API base),
 * then scrubs the deploy-specific config-override selectors on top.
 *
 * {@link createDeployWranglerRunner} runs the deploy's Cloudflare operations with this
 * env, so it KEEPS the Cloudflare credentials; only children that run project code layer
 * {@link scrubWranglerAuthCredentials} on top.
 */
export function deployChildEnv(
  accountId: string | undefined,
  apiBaseUrl: string,
): NodeJS.ProcessEnv {
  const env = provisionEnv({ accountId, apiBaseUrl });
  for (const name of DEPLOY_CONFIG_OVERRIDE_ENV_VARS) {
    deleteEnvVarCaseAware(env, name);
  }
  // Pin Wrangler's default log level. Delete case-aware first so a mixed-case
  // ambient value cannot shadow the pin on win32.
  deleteEnvVarCaseAware(env, 'WRANGLER_LOG');
  env.WRANGLER_LOG = 'log';
  // Void owns the browser OAuth lifecycle. Never allow Wrangler to fall back to
  // its plaintext credential file while a Void command is using that session.
  env.CLOUDFLARE_AUTH_USE_KEYRING = 'true';
  return env;
}

/**
 * Delete every {@link WRANGLER_AUTH_CREDENTIAL_ENV_VARS} entry from `env` IN PLACE and
 * return it, for a Cloudflare-fork child that executes UNTRUSTED project code.
 */
export function scrubWranglerAuthCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const name of WRANGLER_AUTH_CREDENTIAL_ENV_VARS) {
    deleteEnvVarCaseAware(env, name);
  }
  // These are not Wrangler credentials, but native Cloudflare builds do not
  // need either one: DATABASE_URL is consumed only by the parent-side
  // provision/migration steps, and VOID_TOKEN belongs to the managed target.
  deleteEnvVarCaseAware(env, 'DATABASE_URL');
  deleteEnvVarCaseAware(env, 'VOID_TOKEN');
  return env;
}

/**
 * Build the child env for the isolated env-schema probe. Starts from
 * {@link deployChildEnv} (CF Access + every transport selector scrubbed, one account +
 * API base pinned), then (1) scrubs the FULL wrangler-auth credential set case-aware —
 * the probe needs no credentials — and (2) pins `NODE_ENV=production` so the child
 * evaluates env.ts under the SAME environment the build uses (`vite build` sets
 * `NODE_ENV=production`), keeping the required-key set the probe derives identical to
 * the built worker's. Used by BOTH the pre-build facts probe and the post-build
 * `validate-emitted` probe.
 */
export function buildSchemaProbeEnv(accountId: string, apiBaseUrl: string): NodeJS.ProcessEnv {
  const env = scrubManagedDeployBuildMarkers(
    scrubWranglerAuthCredentials(deployChildEnv(accountId, apiBaseUrl)),
  );
  // Match the Cloudflare deploy build's dotenv boundary. Besides keeping a
  // schema conditioned on this internal marker consistent with the build,
  // this prevents an ambient case variant from shadowing the pinned value on
  // Windows.
  deleteEnvVarCaseAware(env, CLOUDFLARE_DEPLOY_BUILD_ENV);
  env[CLOUDFLARE_DEPLOY_BUILD_ENV] = '1';
  // Scrub any ambient spelling first (case-aware on win32) so it cannot shadow the pin.
  deleteEnvVarCaseAware(env, 'NODE_ENV');
  env.NODE_ENV = 'production';
  return env;
}
