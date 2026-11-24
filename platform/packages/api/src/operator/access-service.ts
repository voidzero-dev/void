import { parsePlatformSignupAllowlistEntry } from '@void/platform';
import { eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import {
  lockAuthSettings,
  readAuthSettings,
  readLoginConnection,
  readLoginRevision,
} from '../auth/configuration.ts';
import {
  countInvitations,
  createInvitation,
  getAllInvitations,
  getAllowlistEntryStatuses,
  getInvitation,
  getPendingInvitationByEmail,
  getUserByEmail,
  revokeInvitation,
  setInvitationEmailDeliveryStatus,
} from '../db.ts';
import type { Db } from '../db.ts';
import { sendInvitationEmail } from '../email.ts';
import type { ApiEnv } from '../env.ts';
import { platformAuthSettings, platformLoginConnections } from '../schema.ts';
import { getAllowlist, putAllowlist } from '../signup-allowlist.ts';
import type { AllowlistEntry } from '../signup-allowlist.ts';
import type { Invitation } from '../types.ts';
import { OperatorError, preview } from './common.ts';

export function parseAccessList(input: string): Array<string> {
  return [
    ...new Set(
      input
        .split(/[\s,]+/)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function parseOperatorAllowlistEntry(input: unknown): AllowlistEntry {
  try {
    return parsePlatformSignupAllowlistEntry(input);
  } catch (error) {
    throw new OperatorError(
      400,
      error instanceof Error ? error.message : 'Invalid signup allowlist entry.',
      'invalid_argument',
    );
  }
}

function canonicalEntry(entry: AllowlistEntry): AllowlistEntry {
  if (entry.type === 'identity') {
    return { ...entry, note: entry.note?.trim() || undefined };
  }
  return { ...entry, pattern: entry.pattern.toLowerCase(), note: entry.note?.trim() || undefined };
}

function sameEntry(left: AllowlistEntry, right: AllowlistEntry): boolean {
  if (left.type !== right.type) {
    return false;
  }
  if (left.type === 'identity' && right.type === 'identity') {
    return left.connectionId === right.connectionId && left.subject === right.subject;
  }
  return (
    left.type !== 'identity' &&
    right.type !== 'identity' &&
    left.pattern.toLowerCase() === right.pattern.toLowerCase()
  );
}

function entryTarget(entry: AllowlistEntry): Record<string, string> {
  return entry.type === 'identity'
    ? { type: entry.type, connectionId: entry.connectionId, subject: entry.subject }
    : { type: entry.type, pattern: entry.pattern };
}

export async function getOperatorSignup(context: Context<ApiEnv>) {
  const [raw, entries, settings, connectionRows] = await Promise.all([
    context.env.ROUTING.get('signup:enabled'),
    getAllowlist(context.env.ROUTING),
    readAuthSettings(context.get('db')),
    context.get('db').select().from(platformLoginConnections).orderBy(platformLoginConnections.id),
  ]);
  const restricted = settings
    ? settings.admission.mode !== 'public'
    : raw === 'true' || (raw !== 'false' && !!context.env.PLATFORM_INSTALLATION_ID);
  return {
    enabled: restricted,
    restricted,
    signupsOpen: !restricted,
    ...(settings ? { admission: settings.admission } : {}),
    entries: await getAllowlistEntryStatuses(context.get('db'), entries),
    connections: await Promise.all(
      connectionRows.map(async (connection) => {
        const revision = await readLoginRevision(
          context.get('db'),
          connection.id,
          connection.revision,
        );
        return {
          id: connection.id,
          kind: connection.kind,
          label: revision?.configuration.label ?? connection.id,
        };
      }),
    ),
  };
}

export async function setOperatorSignup(
  context: Context<ApiEnv>,
  enabled: boolean,
  dryRun = false,
) {
  const previous = (await getOperatorSignup(context)).enabled;
  const action = enabled ? 'signup.restrict' : 'signup.open';
  const target = { restrictionsEnabled: enabled };
  if (dryRun) {
    return preview(action, target, {
      previousRestrictionsEnabled: previous,
      effect: enabled ? 'Only allowlisted users may sign up.' : 'All users may sign up.',
    });
  }
  await context.get('db').transaction(async (transaction) => {
    const settings = await lockAuthSettings(transaction);
    await context.env.ROUTING.put('signup:enabled', String(enabled));
    if (settings) {
      await transaction
        .update(platformAuthSettings)
        .set({
          admission: { mode: enabled ? 'restricted' : 'public' },
          revision: sql`${platformAuthSettings.revision} + 1`,
        })
        .where(eq(platformAuthSettings.singleton, true));
    }
  });
  return { action, target, enabled, restricted: enabled, signupsOpen: !enabled };
}

export async function allowOperatorSignup(
  context: Context<ApiEnv>,
  input: ReadonlyArray<unknown>,
  dryRun = false,
) {
  if (input.length === 0 || input.length > 100) {
    throw new OperatorError(400, 'Supply between 1 and 100 signup allowlist entries.');
  }
  const normalized = input.map(parseOperatorAllowlistEntry).map(canonicalEntry);
  const unique = normalized.filter(
    (entry, index) => normalized.findIndex((candidate) => sameEntry(candidate, entry)) === index,
  );
  for (const connectionId of new Set(
    unique.flatMap((entry) => (entry.type === 'identity' ? [entry.connectionId] : [])),
  )) {
    if (!(await readLoginConnection(context.get('db'), connectionId))) {
      throw new OperatorError(
        400,
        `Login connection '${connectionId}' is not configured.`,
        'invalid_argument',
      );
    }
  }
  const entries = await getAllowlist(context.env.ROUTING);
  const additions = unique.filter(
    (candidate) => !entries.some((entry) => sameEntry(entry, candidate)),
  );
  const target =
    unique.length === 1 && unique[0]?.type === 'identity'
      ? entryTarget(unique[0])
      : unique.every((entry) => entry.type === unique[0]?.type && entry.type !== 'identity')
        ? {
            type: unique[0]!.type,
            patterns: unique.map((entry) => (entry.type === 'identity' ? '' : entry.pattern)),
          }
        : { entries: unique.map(entryTarget) };
  if (dryRun) {
    return preview('signup.allow', target, { additions });
  }
  if (additions.length) {
    await putAllowlist(context.env.ROUTING, [...entries, ...additions]);
  }
  return {
    action: 'signup.allow',
    target,
    added: additions,
    unchanged: unique.length - additions.length,
  };
}

export async function removeOperatorSignup(
  context: Context<ApiEnv>,
  input: unknown,
  dryRun = false,
  action: 'remove' | 'disallow' = 'remove',
) {
  const candidate = canonicalEntry(parseOperatorAllowlistEntry(input));
  if (
    candidate.type === 'identity' &&
    !(await readLoginConnection(context.get('db'), candidate.connectionId))
  ) {
    throw new OperatorError(
      400,
      `Login connection '${candidate.connectionId}' is not configured.`,
      'invalid_argument',
    );
  }
  const entries = await getAllowlist(context.env.ROUTING);
  const removed = entries.filter((entry) => sameEntry(entry, candidate));
  if (!removed.length) {
    throw new OperatorError(404, 'Signup allowlist entry not found.');
  }
  if (
    candidate.type === 'email' &&
    !candidate.pattern.includes('*') &&
    (await getPendingInvitationByEmail(context.get('db'), candidate.pattern))
  ) {
    throw new OperatorError(
      409,
      'This email has a pending invitation. Revoke the invitation to remove its signup access.',
      'invitation_pending',
    );
  }
  const target = entryTarget(candidate);
  if (dryRun) {
    return preview(`signup.${action}`, target, { removed });
  }
  await putAllowlist(
    context.env.ROUTING,
    entries.filter((entry) => !sameEntry(entry, candidate)),
  );
  return { action: `signup.${action}`, target, removed };
}

export async function listOperatorInvitations(
  db: Db,
  page: { page: number; limit: number; offset: number },
) {
  const [invitations, total] = await Promise.all([
    getAllInvitations(db, page.limit, page.offset),
    countInvitations(db),
  ]);
  return {
    invitations,
    page: page.page,
    limit: page.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / page.limit)),
  };
}

export async function sendOperatorInvitations(
  context: Context<ApiEnv>,
  input: ReadonlyArray<string>,
  dryRun = false,
) {
  if (
    !input.length ||
    input.length > 100 ||
    input.some((email) => email.length > 320 || !/^[^\s@,]+@[^\s@,]+$/.test(email.trim()))
  ) {
    throw new OperatorError(
      400,
      'Invalid email address list; supply between 1 and 100 email addresses.',
    );
  }
  const emails = [...new Set(input.map((email) => email.trim().toLowerCase()))];
  const db = context.get('db');
  const [existingUsers, existingInvitations, entries] = await Promise.all([
    Promise.all(emails.map((email) => getUserByEmail(db, email))),
    Promise.all(emails.map((email) => getPendingInvitationByEmail(db, email))),
    getAllowlist(context.env.ROUTING),
  ]);
  if (existingUsers.some(Boolean)) {
    throw new OperatorError(400, 'A user with one of these emails already exists.');
  }
  if (existingInvitations.some(Boolean)) {
    throw new OperatorError(400, 'A pending invitation already exists for one of these emails.');
  }
  const allowlistedEmails = new Set(
    entries.flatMap((entry) => (entry.type === 'email' ? [entry.pattern.toLowerCase()] : [])),
  );
  if (emails.some((email) => allowlistedEmails.has(email))) {
    throw new OperatorError(400, 'One of these emails is already on the signup allowlist.');
  }
  const target = { emails };
  if (dryRun) {
    return preview('invitation.send', target, {
      emailDelivery: context.env.EMAIL ? 'enabled' : 'unavailable',
      addsSignupAccess: true,
    });
  }

  // Capture each committed result. A DB or KV failure must never hide which
  // invitations exist already, and an ambiguous failure must not be retried.
  const created: Array<Invitation> = [];
  try {
    for (const email of emails) {
      created.push(await createInvitation(db, email, context.get('user').id));
    }
    await putAllowlist(context.env.ROUTING, [
      ...entries,
      ...emails.map((email): AllowlistEntry => ({
        type: 'email',
        pattern: email,
        note: `Invited by ${context.get('user').login}`,
      })),
    ]);
  } catch (error) {
    console.error('[admin] invitation creation failed', { emails, error });
    throw new OperatorError(
      500,
      'Invitation creation incomplete. Inspect invitations and the signup allowlist before retrying.',
      'partial_failure',
      {
        partial: true,
        target,
        invitations: created,
        emailDelivery: 'not_attempted',
        allowlistConfirmed: false,
      },
    );
  }
  const emailDelivery: Array<{ email: string; status: 'sent' | 'failed' | 'unavailable' }> = [];
  for (const [index, email] of emails.entries()) {
    let status: 'sent' | 'failed' | 'unavailable';
    if (!context.env.EMAIL) {
      status = 'unavailable';
    } else {
      try {
        await sendInvitationEmail(context.env, email);
        status = 'sent';
      } catch (error) {
        console.error('[admin] invitation email failed', { email, error });
        status = 'failed';
      }
    }
    try {
      created[index] = await setInvitationEmailDeliveryStatus(db, created[index]!.id, status);
    } catch (error) {
      console.error('[admin] invitation email status could not be saved', { email, status, error });
      throw new OperatorError(
        500,
        'Invitation email status could not be saved. Inspect invitations before retrying.',
        'partial_failure',
        {
          partial: true,
          target,
          invitations: created,
          emailDelivery,
          uncertainEmail: { email, attemptedStatus: status },
          allowlistConfirmed: true,
        },
      );
    }
    emailDelivery.push({ email, status });
  }
  return {
    action: 'invitation.send',
    target,
    invitations: created,
    emailDelivery,
    warnings: emailDelivery.flatMap((entry) =>
      entry.status !== 'sent'
        ? [`Email ${entry.status}: ${entry.email}. Signup access was granted.`]
        : [],
    ),
  };
}

export async function revokeOperatorInvitation(
  context: Context<ApiEnv>,
  id: string,
  dryRun = false,
) {
  const db = context.get('db');
  const invitation = await getInvitation(db, id);
  if (!invitation) {
    throw new OperatorError(404, 'Invitation not found.');
  }
  if (invitation.status !== 'pending') {
    throw new OperatorError(409, 'Invitation is not pending.');
  }
  const entries = await getAllowlist(context.env.ROUTING);
  const filtered = entries.filter(
    (entry) =>
      !(entry.type === 'email' && entry.pattern.toLowerCase() === invitation.email.toLowerCase()),
  );
  const target = { id, email: invitation.email };
  if (dryRun) {
    return preview('invitation.revoke', target, {
      removesSignupEntries: entries.length - filtered.length,
    });
  }
  // Remove access before updating the invitation row, keeping a failed revoke
  // retryable without leaving a stale exact-email allowlist grant.
  let allowlistUpdated = false;
  try {
    if (filtered.length !== entries.length) {
      await putAllowlist(context.env.ROUTING, filtered);
    }
    allowlistUpdated = true;
    if (!(await revokeInvitation(db, id, context.get('user').id))) {
      throw new OperatorError(
        409,
        'Invitation changed while revoking; inspect its current status.',
        'conflict',
        { partial: true, target, allowlistUpdated },
      );
    }
  } catch (error) {
    if (error instanceof OperatorError) {
      throw error;
    }
    console.error('[admin] invitation revocation failed', { id, error });
    throw new OperatorError(
      500,
      'Invitation revocation incomplete. Inspect its status and the signup allowlist before retrying.',
      'partial_failure',
      { partial: true, target, allowlistUpdated },
    );
  }
  return { action: 'invitation.revoke', target, revoked: true };
}
