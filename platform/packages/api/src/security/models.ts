/**
 * Which model a scan runs on (spec §8.2, §8.3), worked out when the scan starts.
 *
 *   project model (or the installation default)
 *     ├─ unknown, blocked or unpriced ─► the installation default (edge #23)
 *     └─ third-party and any of: host failed probe check 5, no current installation
 *        notice, no current project notice ─► first non-blocked priced `@cf` model
 *        (edges #44, #84: code never leaves Cloudflare before the notice)
 *
 * A `trigger=fallback` scan (M26) always runs on the `@cf` default
 * (`securityCfDefaultModel`): the policy default when it is `@cf`, else the first
 * non-blocked priced `@cf` model. It never reaches a third-party model.
 *
 * The model proxy checks the same rules again on every call (`judgeSecurityModelCall`).
 */
import {
  getSecurityModel,
  isSecurityModelId,
  isSecurityModelPriced,
  SECURITY_PROVIDER_NOTICE_VERSION,
  securityModelThirdPartyHost,
  type SecurityEngine,
  type SecurityModelId,
  type SecurityPickProblem,
} from '@void/platform/security-models';
import type { SecurityPolicy } from '@void/platform/security-policy';
import { securityFallbackModel } from './policy.ts';
import type { SecurityScanTrigger } from './schema.ts';

export type SecurityScanModel = Readonly<{
  /** What the project asked for: its own model, else the installation default. */
  requested: string;
  used: SecurityModelId;
  engine: SecurityEngine;
}>;

export type SecurityProjectModelSettings = Readonly<{
  /** `project_security_settings.model`; `null` = the installation default. */
  model: string | null;
  /** `project_security_settings.provider_notice_version`. */
  noticeVersion: number | null;
  /** The scan's trigger; `fallback` runs on the `@cf` default. */
  trigger?: SecurityScanTrigger;
}>;

function usable(policy: SecurityPolicy, id: SecurityModelId): boolean {
  return !policy.blockedModels.includes(id) && isSecurityModelPriced(id);
}

function thirdPartyAllowed(
  policy: SecurityPolicy,
  project: SecurityProjectModelSettings,
  id: SecurityModelId,
): boolean {
  const host = securityModelThirdPartyHost(id);
  if (!host) {
    return true;
  }
  return (
    policy.entitlement?.hosts[host] === true &&
    policy.thirdPartyNotice?.version === SECURITY_PROVIDER_NOTICE_VERSION &&
    project.noticeVersion === SECURITY_PROVIDER_NOTICE_VERSION
  );
}

/** The `@cf` model a fallback scan runs on, or `null` when every `@cf` model is blocked. */
export function securityCfDefaultModel(policy: SecurityPolicy): SecurityModelId | null {
  const id = policy.defaultModel;
  if (securityModelThirdPartyHost(id) === null && usable(policy, id)) {
    return id;
  }
  return securityFallbackModel(policy.blockedModels);
}

/** `null` when no model may run (every `@cf` model blocked and no third-party allowed). */
export function resolveSecurityScanModel(
  policy: SecurityPolicy,
  project: SecurityProjectModelSettings,
): SecurityScanModel | null {
  if (project.trigger === 'fallback') {
    const used = securityCfDefaultModel(policy);
    return used === null ? null : { requested: used, used, engine: getSecurityModel(used).engine };
  }
  const requested = project.model ?? policy.defaultModel;
  let used: SecurityModelId | null =
    isSecurityModelId(requested) && usable(policy, requested) ? requested : policy.defaultModel;
  if (!usable(policy, used) || !thirdPartyAllowed(policy, project, used)) {
    used = securityFallbackModel(policy.blockedModels);
  }
  if (used === null) {
    return null;
  }
  return { requested, used, engine: getSecurityModel(used).engine };
}

/**
 * Why a scan does not run on the project's own pick (spec §8.2 page notice, edge #23):
 * `blocked` by the platform admin, `unknown` (not in the model list, for example retired),
 * `notice` (a third-party pick waits for this project to accept the current provider
 * notice) or `unavailable` (no price yet, its host is not ready, or no platform notice).
 * `null` when the project follows the default or its pick runs.
 */
export function securityPickProblem(
  policy: SecurityPolicy,
  project: SecurityProjectModelSettings,
  used: SecurityModelId | null,
): SecurityPickProblem | null {
  const pick = project.model;
  if (pick === null || pick === used) {
    return null;
  }
  if (!isSecurityModelId(pick)) {
    return 'unknown';
  }
  if (policy.blockedModels.includes(pick)) {
    return 'blocked';
  }
  const host = securityModelThirdPartyHost(pick);
  if (
    isSecurityModelPriced(pick) &&
    host !== null &&
    policy.entitlement?.hosts[host] === true &&
    policy.thirdPartyNotice?.version === SECURITY_PROVIDER_NOTICE_VERSION &&
    project.noticeVersion !== SECURITY_PROVIDER_NOTICE_VERSION
  ) {
    return 'notice';
  }
  return 'unavailable';
}
