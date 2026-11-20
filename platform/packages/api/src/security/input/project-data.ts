/**
 * Project data every scan input reads (design doc 0095, M10): the stored secret values
 * (for redaction) and the past findings and their events (for memory). Shared by the
 * deployment input (`prepare.ts`) and the local check input (`local.ts`, M32).
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../../db.ts';
import { getProjectSecrets } from '../../db/secrets.ts';
import type { ApiEnv } from '../../env.ts';
import { decryptProjectSecret } from '../../project-secrets.ts';
import { securityFindingEvents, securityFindings } from '../schema.ts';
import type { SecurityMemoryEvent, SecurityMemoryFinding } from './memory.ts';
import type { SecuritySecret } from './redact.ts';

export async function loadSecuritySecrets(
  env: Pick<ApiEnv['Bindings'], 'PROJECT_SECRET_KEYS_JSON' | 'PROJECT_SECRET_ACTIVE_KEY_VERSION'>,
  db: Db,
  projectId: string,
): Promise<Array<SecuritySecret>> {
  const rows = await getProjectSecrets(db, projectId);
  const out: Array<SecuritySecret> = [];
  for (const row of rows) {
    // A secret that cannot be read cannot be redacted: the input is not built.
    out.push({ name: row.name, value: await decryptProjectSecret(env, projectId, row) });
  }
  return out;
}

export async function loadSecurityMemory(
  db: Db,
  projectId: string,
): Promise<{ findings: Array<SecurityMemoryFinding>; events: Array<SecurityMemoryEvent> }> {
  const findings = await db
    .select()
    .from(securityFindings)
    .where(eq(securityFindings.project_id, projectId));
  const events = await db
    .select({
      findingId: securityFindingEvents.finding_id,
      action: securityFindingEvents.action,
      actorKind: securityFindingEvents.actor_kind,
      actorRole: securityFindingEvents.actor_role,
      resolution: securityFindingEvents.resolution,
      comment: securityFindingEvents.comment,
      scanId: securityFindingEvents.scan_id,
      createdAt: securityFindingEvents.created_at,
    })
    .from(securityFindingEvents)
    .where(eq(securityFindingEvents.project_id, projectId));
  return {
    findings: findings.map((row) => ({
      id: row.id,
      number: row.number,
      fingerprintKey: row.fingerprint_key,
      modelFingerprint: row.model_fingerprint,
      verdict: row.verdict,
      severity: row.severity_override ?? row.severity,
      title: row.title,
      category: row.category,
      cwe: row.cwe,
      file: row.file,
      lineStart: row.line_start,
      lineEnd: row.line_end,
      sinkPath: row.sink_path,
      detail: row.detail,
      source: row.source,
      state: row.state,
      resolution: row.resolution,
      resolvedAt: row.resolved_at,
      resolvedSinkHash: row.resolved_sink_hash,
      notSeenInLatest: row.not_seen_in_latest,
      reopenCount: row.reopen_count,
      createdAt: row.created_at,
    })),
    events,
  };
}
