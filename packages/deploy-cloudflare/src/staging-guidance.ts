import { isRecord } from '@void/deploy-core';
import { readConfigEntryString } from './config.ts';

export function cloudflareStagingPairGuidance(
  deployment: Record<string, unknown> | null | undefined,
  { accountId, workerName }: { accountId?: string; workerName: string },
): { diagnostic: string } | undefined {
  const versions = deployment?.versions;
  const entries: Array<unknown> = Array.isArray(versions) && versions.length === 2 ? versions : [];
  const liveEntry = entries.find((entry) => isRecord(entry) && entry.percentage === 100);
  const candidateEntry = entries.find((entry) => isRecord(entry) && entry.percentage === 0);
  const id = readConfigEntryString(deployment, 'id');
  const live = readConfigEntryString(liveEntry, 'version_id')?.trim();
  const candidate = readConfigEntryString(candidateEntry, 'version_id')?.trim();
  if (accountId && id?.trim() && live && candidate && live !== candidate) {
    return {
      diagnostic: `Cloudflare Worker "${workerName}" in account ${accountId} has ${live} at 100% and ${candidate} at 0%. A failed deploy can leave this pair.
Pause other deploys and let any in progress finish. Open this Worker's Deployments tab in the Cloudflare dashboard.
If Active Deployment still shows this exact pair and the 0% version is unused, including by version overrides, roll back to the live version. Retry once it's the only version listed. If Void still reports the pair, wait and retry.
https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/#rolling-back-from-a-split-deployment`,
    };
  }
}
