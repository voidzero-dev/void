import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'pathslash';
import { writeFileAtomic } from '../shared/atomic-write.ts';

export const CANDIDATE_FILE = '.void/cloudflare-candidate.json';
const INVALID_CANDIDATE_MESSAGE =
  'The saved Cloudflare candidate receipt is invalid. Restore or remove .void/cloudflare-candidate.json before retrying.';

export type CloudflareCandidateReceipt = {
  accountId: string;
  workerName: string;
  parentVersionId: string;
  versionIds: Array<string>;
};

/** A saved upload chain: a non-empty list of distinct, non-empty version IDs. */
export function isVersionIdChain(value: unknown): value is Array<string> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((id: unknown) => typeof id === 'string' && id.length > 0) &&
    new Set(value).size === value.length
  );
}

/** A failed normal deploy keeps its locally verified upload chain across retries. */
export function readCloudflareCandidate(root: string): CloudflareCandidateReceipt | null {
  const path = join(root, CANDIDATE_FILE);
  if (!existsSync(path)) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(INVALID_CANDIDATE_MESSAGE);
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('accountId' in value) ||
    typeof value.accountId !== 'string' ||
    !value.accountId ||
    !('workerName' in value) ||
    typeof value.workerName !== 'string' ||
    !value.workerName ||
    !('parentVersionId' in value) ||
    typeof value.parentVersionId !== 'string' ||
    !value.parentVersionId ||
    !('versionIds' in value) ||
    !isVersionIdChain(value.versionIds)
  ) {
    throw new Error(INVALID_CANDIDATE_MESSAGE);
  }
  return value as CloudflareCandidateReceipt;
}

export function assertCloudflareCandidateUnchanged(
  root: string,
  expected: CloudflareCandidateReceipt | null,
): void {
  if (JSON.stringify(readCloudflareCandidate(root)) !== JSON.stringify(expected)) {
    throw new Error(
      'The Cloudflare candidate receipt changed while project code was running. Retry from a trusted checkout.',
    );
  }
}

export function recordCloudflareCandidateUpload(
  root: string,
  expected: CloudflareCandidateReceipt | null,
  accountId: string,
  workerName: string,
  parentVersionId: string,
  versionId: string,
): void {
  assertCloudflareCandidateUnchanged(root, expected);
  if (
    expected &&
    (expected.accountId !== accountId ||
      expected.workerName !== workerName ||
      (expected.parentVersionId !== parentVersionId &&
        expected.versionIds.at(-1) !== parentVersionId))
  ) {
    throw new Error(
      'The saved Cloudflare candidate belongs to a different Worker or live version. Inspect the deployment before retrying.',
    );
  }
  // The activation runner supplies its verified live parent. If the last saved
  // candidate already became that parent, begin a new chain instead of retaining
  // the interrupted deployment's old parent and inactive-version authorization.
  const versionIds = [
    ...(expected?.parentVersionId === parentVersionId ? expected.versionIds : []),
    versionId,
  ];
  mkdirSync(join(root, '.void'), { recursive: true });
  writeFileAtomic(
    join(root, CANDIDATE_FILE),
    `${JSON.stringify({ accountId, workerName, parentVersionId, versionIds })}\n`,
    0o600,
  );
}

export function clearCloudflareCandidate(root: string): void {
  const path = join(root, CANDIDATE_FILE);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}
