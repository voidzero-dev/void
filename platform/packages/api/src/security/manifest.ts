import { isRecord } from '@void/deploy-core';
import type { DeployManifest } from '../types.ts';

/**
 * The stored manifest of a deployment, as security scans read it. The scan only
 * reads a few fields as hints and checks each where it is used; a row that is not
 * a JSON object reads as no manifest.
 */
export function readSecurityManifest(raw: string | null | undefined): DeployManifest | null {
  if (!raw) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return isRecord(value) ? (value as DeployManifest) : null;
}
