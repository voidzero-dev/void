import { and, asc, eq, sql } from 'drizzle-orm';
import { generateId } from '../id.ts';
import { projectSecrets, projectDatabaseCredentials } from '../schema.ts';
import type { ProjectDatabaseCredentials, ProjectSecret } from '../types.ts';
import type { Db } from './client.ts';

// --- Project secrets ---

export async function listProjectSecretNames(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<{ name: string }>> {
  return db
    .select({ name: projectSecrets.name })
    .from(projectSecrets)
    .where(eq(projectSecrets.project_id, projectId))
    .orderBy(asc(projectSecrets.name));
}

export async function getProjectSecrets(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<ProjectSecret>> {
  return db
    .select()
    .from(projectSecrets)
    .where(eq(projectSecrets.project_id, projectId))
    .orderBy(asc(projectSecrets.name));
}

export async function upsertProjectSecret(
  db: Db,
  projectId: string,
  name: string,
  ciphertext: string,
  iv: string,
  keyVersion: string,
  managedReason: string | null = null,
): Promise<ProjectSecret> {
  const [row] = await db
    .insert(projectSecrets)
    .values({
      id: generateId('psc'),
      project_id: projectId,
      name,
      ciphertext,
      iv,
      key_version: keyVersion,
      managed_reason: managedReason,
    })
    .onConflictDoUpdate({
      target: [projectSecrets.project_id, projectSecrets.name],
      set: {
        ciphertext,
        iv,
        key_version: keyVersion,
        managed_reason: managedReason,
        updated_at: sql`now()`,
      },
    })
    .returning();
  return row;
}

export async function deleteProjectSecret(db: Db, projectId: string, name: string): Promise<void> {
  await db
    .delete(projectSecrets)
    .where(and(eq(projectSecrets.project_id, projectId), eq(projectSecrets.name, name)));
}

// --- Database credentials ---

export async function upsertProjectDatabaseUrl(
  db: Db,
  projectId: string,
  ciphertext: string,
  iv: string,
  keyVersion: string,
): Promise<ProjectDatabaseCredentials> {
  const [row] = await db
    .insert(projectDatabaseCredentials)
    .values({ project_id: projectId, ciphertext, iv, key_version: keyVersion })
    .onConflictDoUpdate({
      target: projectDatabaseCredentials.project_id,
      set: {
        ciphertext,
        iv,
        key_version: keyVersion,
        updated_at: sql`now()`,
      },
    })
    .returning();
  return row;
}

export async function getProjectDatabaseUrl(
  db: Db,
  projectId: string,
): Promise<ProjectDatabaseCredentials | null> {
  const [row] = await db
    .select()
    .from(projectDatabaseCredentials)
    .where(eq(projectDatabaseCredentials.project_id, projectId))
    .limit(1);
  return row ?? null;
}
