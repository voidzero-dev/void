import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import {
  parsePlatformAccessProtection,
  parsePlatformAdmissionPolicy,
  parsePlatformLoginConfiguration,
  validatePlatformAdmissionPolicy,
} from '@void/platform';
import type { PlatformAuthenticationRecovery, PlatformLoginConfiguration } from '@void/platform';
import { Buffer } from './node-buffer.ts';
import type { QueryConnection } from './platform-zero-trust-uninstall.ts';

type Credential = { ciphertext: string; iv: string; keyVersion: string };
export type Connection = {
  id: string;
  kind: string;
  revision: number;
  generation: number;
  configuration: PlatformLoginConfiguration;
  secret: Credential;
};
type RecoveryInput = {
  administratorUserId: string;
  expectedIdentity?: { issuer: string; subject: string };
  configuration?: PlatformLoginConfiguration;
};

export function parseAuthenticationRecoveryInput(
  value: unknown,
  connectionId: string,
): RecoveryInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('platform: Recovery requires a JSON object.');
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !['administratorUserId', 'expectedIdentity', 'configuration'].includes(key),
    ) ||
    typeof input.administratorUserId !== 'string' ||
    !input.administratorUserId.trim()
  ) {
    throw new Error(
      'platform: Recovery requires an existing administratorUserId and accepts no plaintext secrets.',
    );
  }
  let expectedIdentity: RecoveryInput['expectedIdentity'];
  if (input.expectedIdentity !== undefined) {
    const identity = input.expectedIdentity as Record<string, unknown> | null;
    if (
      !identity ||
      typeof identity !== 'object' ||
      typeof identity.issuer !== 'string' ||
      !identity.issuer ||
      typeof identity.subject !== 'string' ||
      !identity.subject ||
      Object.keys(identity).some((key) => key !== 'issuer' && key !== 'subject')
    ) {
      throw new Error('platform: expectedIdentity requires the exact issuer and subject.');
    }
    expectedIdentity = { issuer: identity.issuer, subject: identity.subject };
  }
  const configuration =
    input.configuration === undefined
      ? undefined
      : parsePlatformLoginConfiguration(input.configuration);
  if (configuration && configuration.id !== connectionId) {
    throw new Error('platform: Recovery configuration must match the selected connection.');
  }
  return { administratorUserId: input.administratorUserId, expectedIdentity, configuration };
}

function credentialKey(keysJson: string, version: string): Buffer {
  const keys = JSON.parse(keysJson) as Record<string, string>;
  const raw = typeof keys[version] === 'string' ? Buffer.from(keys[version], 'base64') : null;
  if (!raw || raw.length !== 32) {
    throw new Error('platform: Restore the original platform encryption keyring before recovery.');
  }
  return Buffer.from(
    hkdfSync('sha256', raw, 'void-platform-auth-v1', 'login-client-credentials', 32),
  );
}
export function recoverAuthenticationCredential(
  keysJson: string,
  installationId: string,
  connectionId: string,
  revision: number,
  saved: Credential,
): string {
  try {
    const encrypted = Buffer.from(saved.ciphertext, 'base64');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      credentialKey(keysJson, saved.keyVersion),
      Buffer.from(saved.iv, 'base64'),
    );
    decipher.setAAD(
      Buffer.from(JSON.stringify([installationId, JSON.stringify([connectionId, revision])])),
    );
    decipher.setAuthTag(encrypted.subarray(-16));
    return Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    throw new Error(
      'platform: The original platform encryption keyring is required for authentication recovery.',
    );
  }
}
export function encryptCredential(
  keysJson: string,
  version: string,
  installationId: string,
  connectionId: string,
  revision: number,
  secret: string,
): Credential {
  const iv = Buffer.from(randomBytes(12));
  const cipher = createCipheriv('aes-256-gcm', credentialKey(keysJson, version), iv);
  cipher.setAAD(
    Buffer.from(JSON.stringify([installationId, JSON.stringify([connectionId, revision])])),
  );
  const ciphertext = Buffer.concat([
    cipher.update(secret, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    keyVersion: version,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}
export async function transaction<T>(db: QueryConnection, action: () => Promise<T>): Promise<T> {
  await db.query('BEGIN');
  try {
    const result = await action();
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
export async function requireAdministrator(db: QueryConnection, id: string): Promise<void> {
  const row = (
    await db.query(
      "SELECT id FROM users WHERE id = $1 AND role = 'admin' AND (suspended_reason IS NULL OR suspended_reason IN ('requests_exceeded', 'sandbox_runtime_exceeded')) FOR UPDATE",
      [id],
    )
  ).rows[0];
  if (!row) {
    throw new Error('platform: Recovery can only restore an existing active administrator.');
  }
}
export async function readConnection(
  db: QueryConnection,
  id: string,
): Promise<Connection | undefined> {
  return (
    await db.query<Connection>(
      'SELECT c.id, c.kind, c.revision, c.generation, r.configuration, r.secret FROM platform_login_connections c JOIN platform_login_revisions r ON r.connection_id = c.id AND r.revision = c.revision WHERE c.id = $1',
      [id],
    )
  ).rows[0];
}

async function validateRecoveryAdmission(
  db: QueryConnection,
  connectionId: string,
  revision: number,
): Promise<void> {
  const settings = (
    await db.query<{ admission: unknown; protection: unknown }>(
      'SELECT admission, protection FROM platform_auth_settings WHERE singleton = true FOR UPDATE',
    )
  ).rows[0];
  if (!settings) {
    throw new Error('platform: Authentication settings are unavailable for recovery.');
  }
  const prospective = await db.query<{ configuration: PlatformLoginConfiguration }>(
    'SELECT r.configuration FROM platform_login_connections c JOIN platform_login_revisions r ON r.connection_id = c.id AND r.revision = CASE WHEN c.id = $1 THEN $2 ELSE c.active_revision END WHERE c.enabled = true OR c.id = $1',
    [connectionId, revision],
  );
  validatePlatformAdmissionPolicy(
    parsePlatformAdmissionPolicy(settings.admission),
    prospective.rows.map((row) => parsePlatformLoginConfiguration(row.configuration)),
    parsePlatformAccessProtection(settings.protection),
  );
}

export async function commitAuthenticationRecovery(
  db: QueryConnection,
  input: {
    recovery: PlatformAuthenticationRecovery;
    identity: { issuer: string; subject: string };
  },
): Promise<void> {
  const { recovery, identity } = input;
  await transaction(db, async () => {
    await db.query('LOCK TABLE platform_auth_settings IN SHARE ROW EXCLUSIVE MODE');
    await requireAdministrator(db, recovery.administratorUserId);
    const connection = await readConnection(db, recovery.connectionId);
    if (
      !connection ||
      connection.revision !== recovery.revision ||
      connection.generation !== recovery.generation ||
      Date.parse(recovery.expiresAt) <= Date.now()
    ) {
      throw new Error('platform: Recovery expired or configuration changed. Start again.');
    }
    await validateRecoveryAdmission(db, recovery.connectionId, recovery.revision);
    const proof = (
      await db.query(
        'DELETE FROM platform_login_tests WHERE id = $1 AND user_id = $2 AND connection_id = $3 AND revision = $4 AND issuer = $5 AND subject = $6 AND expires_at > now() RETURNING id',
        [
          recovery.testId,
          recovery.administratorUserId,
          recovery.connectionId,
          recovery.revision,
          identity.issuer,
          identity.subject,
        ],
      )
    ).rows[0];
    if (!proof) {
      throw new Error(
        'platform: Recovery requires a fresh successful login test of this exact identity.',
      );
    }
    const owner = (
      await db.query(
        'SELECT user_id FROM platform_login_identities WHERE connection_id = $1 AND issuer = $2 AND subject = $3',
        [recovery.connectionId, identity.issuer, identity.subject],
      )
    ).rows[0];
    if (owner && owner.user_id !== recovery.administratorUserId) {
      throw new Error(
        'platform: This identity belongs to another account. Recovery cannot take it over.',
      );
    }
    if (connection.kind === 'github' || connection.kind === 'google') {
      const legacyOwner = (
        await db.query(
          'SELECT user_id FROM oauth_accounts WHERE provider = $1 AND provider_id = $2',
          [connection.kind, identity.subject],
        )
      ).rows[0];
      if (legacyOwner && legacyOwner.user_id !== recovery.administratorUserId) {
        throw new Error('platform: This identity belongs to another account.');
      }
      await db.query('DELETE FROM oauth_accounts WHERE provider = $1 AND user_id = $2', [
        connection.kind,
        recovery.administratorUserId,
      ]);
      await db.query(
        'INSERT INTO oauth_accounts (id, user_id, provider, provider_id) VALUES ($1,$2,$3,$4)',
        [randomUUID(), recovery.administratorUserId, connection.kind, identity.subject],
      );
    }
    await db.query(
      'DELETE FROM platform_login_identities WHERE connection_id = $1 AND user_id = $2',
      [recovery.connectionId, recovery.administratorUserId],
    );
    await db.query(
      'INSERT INTO platform_login_identities (id, user_id, connection_id, issuer, subject) VALUES ($1,$2,$3,$4,$5)',
      [
        randomUUID(),
        recovery.administratorUserId,
        recovery.connectionId,
        identity.issuer,
        identity.subject,
      ],
    );
    await db.query(
      'UPDATE platform_login_connections SET enabled = true, active_revision = $2, generation = generation + 1 WHERE id = $1',
      [recovery.connectionId, recovery.revision],
    );
    await db.query(
      'UPDATE platform_auth_settings SET revision = revision + 1, sessions_required = true WHERE singleton = true',
    );
    await db.query(
      'UPDATE platform_human_sessions SET revoked_at = now() WHERE (connection_id = $1 OR user_id = $2) AND revoked_at IS NULL',
      [recovery.connectionId, recovery.administratorUserId],
    );
    await db.query('DELETE FROM operator_sessions WHERE user_id = $1 OR human_session_id IS NULL', [
      recovery.administratorUserId,
    ]);
    await db.query('DELETE FROM platform_login_tests WHERE connection_id = $1', [
      recovery.connectionId,
    ]);
    await db.query(
      'INSERT INTO operator_events (id,user_id,login,action,target,status,http_status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [
        randomUUID(),
        recovery.administratorUserId,
        'Installation owner recovery',
        'auth.recovery.confirm',
        JSON.stringify({
          installationId: recovery.installationId,
          connectionId: recovery.connectionId,
          revision: recovery.revision,
          identity,
        }),
        'success',
        200,
      ],
    );
  });
}
