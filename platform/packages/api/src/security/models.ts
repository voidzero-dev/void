/**
 * Which model a scan runs on (spec §8.2, §8.3), worked out when the scan starts.
 *
 *   project model (or the installation default)
 *     ├─ unknown, blocked or unpriced ─► the installation default (edge #23)
 *     └─ third-party and any of: host failed probe check 5, no current installation
 *        notice, no current project notice ─► first non-blocked priced `@cf` model
 *        (edges #44, #84: code never leaves Cloudflare before the notice)
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
} from '@void/platform/security-models';
import type { SecurityPolicy } from '@void/platform/security-policy';
import { securityFallbackModel } from './policy.ts';

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

/** `null` when no model may run (every `@cf` model blocked and no third-party allowed). */
export function resolveSecurityScanModel(
  policy: SecurityPolicy,
  project: SecurityProjectModelSettings,
): SecurityScanModel | null {
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
