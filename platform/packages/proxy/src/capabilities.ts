export function proxyCapabilityEnabled(value: string | undefined, capability: string): boolean {
  if (!value) {
    return true;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) && parsed[capability] === true;
  } catch {
    return false;
  }
}
import { isRecord } from '@void/deploy-core';
