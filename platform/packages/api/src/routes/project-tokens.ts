import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { PROJECT_CREDENTIAL_MAX_DAYS, signProjectCredentialToken } from '../auth/deploy-token.ts';
import { getProject } from '../db.ts';
import type { DbOrTx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { PROJECT_PERMISSION_MESSAGES } from '../project-access.ts';
import { projectDeployCredentials, projects } from '../schema.ts';
import type { Project } from '../types.ts';

const app = new Hono<ApiEnv>();

function parseExpiryDays(value: unknown): number {
  const days = value === undefined ? 30 : value;
  if (!Number.isInteger(days) || Number(days) < 1 || Number(days) > PROJECT_CREDENTIAL_MAX_DAYS) {
    throw new Error(`expiresInDays must be an integer from 1 to ${PROJECT_CREDENTIAL_MAX_DAYS}`);
  }
  return Number(days);
}

function parseName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : 'CI deploy';
  // eslint-disable-next-line no-control-regex -- Names are shown in terminals and must exclude control characters.
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('name must contain 1 to 80 printable characters');
  }
  return name;
}

async function ownedProject(context: Context<ApiEnv>): Promise<Project | 'forbidden' | null> {
  const projectId = context.req.param('projectId');
  if (!projectId) {
    return null;
  }
  const project = await getProject(context.get('db'), projectId);
  if (!project) {
    return null;
  }
  if (project.user_id !== context.get('user').id) {
    return 'forbidden';
  }
  return project;
}

async function lockOwnedProject(
  db: DbOrTx,
  projectId: string,
  userId: string,
): Promise<Project | 'forbidden' | null> {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .for('update')
    .limit(1);
  if (!project) {
    return null;
  }
  if (project.user_id !== userId) {
    return 'forbidden';
  }
  return project;
}

function projectNotFound(context: Context<ApiEnv>) {
  return context.json(
    { error: 'project not found', message: PROJECT_PERMISSION_MESSAGES['not-found'] },
    404,
  );
}

function tokensForbidden(context: Context<ApiEnv>) {
  return context.json({ error: 'forbidden', message: PROJECT_PERMISSION_MESSAGES.tokens }, 403);
}

function projectDeleting(context: Context<ApiEnv>) {
  return context.json(
    {
      error: 'project is being deleted',
      message:
        'This project is being deleted. Wait for deletion to finish and select another project.',
    },
    409,
  );
}

function credentialNotFound(context: Context<ApiEnv>) {
  return context.json(
    {
      error: 'active credential not found',
      message:
        'This active deploy token could not be found. Refresh the token list; it may have been revoked or renewed.',
    },
    404,
  );
}

function publicCredential(row: typeof projectDeployCredentials.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
  };
}

app.get('/:projectId/tokens', async (context) => {
  const project = await ownedProject(context);
  if (project === 'forbidden') {
    return tokensForbidden(context);
  }
  if (!project) {
    return projectNotFound(context);
  }
  const rows = await context
    .get('db')
    .select()
    .from(projectDeployCredentials)
    .where(eq(projectDeployCredentials.project_id, project.id))
    .orderBy(desc(projectDeployCredentials.created_at))
    .limit(100);
  return context.json(rows.map(publicCredential));
});

app.post('/:projectId/tokens', async (context) => {
  const projectId = context.req.param('projectId');
  const body = await context.req
    .json<{ name?: unknown; expiresInDays?: unknown }>()
    .catch(() => ({}) as { name?: unknown; expiresInDays?: unknown });
  let name: string;
  let days: number;
  try {
    name = parseName(body.name);
    days = parseExpiryDays(body.expiresInDays);
  } catch (error) {
    return context.json({ error: error instanceof Error ? error.message : 'invalid request' }, 400);
  }
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const user = context.get('user');
  const token = await signProjectCredentialToken(
    { credentialId: id, projectId, userId: user.id, login: user.login, expiresAt },
    context.env.JWT_SECRET,
  );
  const row = await context.get('db').transaction(async (tx) => {
    const project = await lockOwnedProject(tx, projectId, user.id);
    if (typeof project === 'string' || !project) {
      return project;
    }
    if (project.status === 'deleting') {
      return 'project-deleting' as const;
    }
    const [created] = await tx
      .insert(projectDeployCredentials)
      .values({
        id,
        project_id: project.id,
        issued_by: user.id,
        name,
        expires_at: expiresAt.toISOString(),
      })
      .returning();
    return created!;
  });
  if (row === 'forbidden') {
    return tokensForbidden(context);
  }
  if (row === 'project-deleting') {
    return projectDeleting(context);
  }
  if (!row) {
    return projectNotFound(context);
  }
  return context.json({ ...publicCredential(row), token }, 201);
});

app.post('/:projectId/tokens/:credentialId/renew', async (context) => {
  const projectId = context.req.param('projectId');
  const body = await context.req
    .json<{ expiresInDays?: unknown }>()
    .catch(() => ({}) as { expiresInDays?: unknown });
  let days: number;
  try {
    days = parseExpiryDays(body.expiresInDays);
  } catch (error) {
    return context.json({ error: error instanceof Error ? error.message : 'invalid request' }, 400);
  }
  const user = context.get('user');
  const replacementId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const token = await signProjectCredentialToken(
    {
      credentialId: replacementId,
      projectId,
      userId: user.id,
      login: user.login,
      expiresAt,
    },
    context.env.JWT_SECRET,
  );
  const result = await context.get('db').transaction(async (transaction) => {
    const project = await lockOwnedProject(transaction, projectId, user.id);
    if (project === 'forbidden') {
      return project;
    }
    if (!project) {
      return 'project-not-found' as const;
    }
    if (project.status === 'deleting') {
      return 'project-deleting' as const;
    }
    const [current] = await transaction
      .select()
      .from(projectDeployCredentials)
      .where(
        and(
          eq(projectDeployCredentials.id, context.req.param('credentialId')),
          eq(projectDeployCredentials.project_id, project.id),
          isNull(projectDeployCredentials.revoked_at),
        ),
      )
      .for('update');
    if (!current) {
      return null;
    }
    await transaction
      .update(projectDeployCredentials)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(projectDeployCredentials.id, current.id));
    const [replacement] = await transaction
      .insert(projectDeployCredentials)
      .values({
        id: replacementId,
        project_id: project.id,
        issued_by: user.id,
        name: current.name,
        expires_at: expiresAt.toISOString(),
      })
      .returning();
    return replacement!;
  });
  if (result === 'project-not-found') {
    return projectNotFound(context);
  }
  if (result === 'forbidden') {
    return tokensForbidden(context);
  }
  if (result === 'project-deleting') {
    return projectDeleting(context);
  }
  if (!result) {
    return credentialNotFound(context);
  }
  return context.json({ ...publicCredential(result), token });
});

app.delete('/:projectId/tokens/:credentialId', async (context) => {
  const projectId = context.req.param('projectId');
  const user = context.get('user');
  const row = await context.get('db').transaction(async (tx) => {
    const project = await lockOwnedProject(tx, projectId, user.id);
    if (typeof project === 'string') {
      return project;
    }
    if (!project) {
      return 'project-not-found' as const;
    }
    const [revoked] = await tx
      .update(projectDeployCredentials)
      .set({ revoked_at: new Date().toISOString() })
      .where(
        and(
          eq(projectDeployCredentials.id, context.req.param('credentialId')),
          eq(projectDeployCredentials.project_id, project.id),
          isNull(projectDeployCredentials.revoked_at),
        ),
      )
      .returning();
    return revoked ?? null;
  });
  if (row === 'project-not-found') {
    return projectNotFound(context);
  }
  if (row === 'forbidden') {
    return tokensForbidden(context);
  }
  if (!row) {
    return credentialNotFound(context);
  }
  return context.json({ ok: true, id: row.id });
});

export default app;
