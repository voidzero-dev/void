import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { platformAuthenticationRecoveryMessage } from '@void/platform';
import { openBrowser } from './auth.ts';
import { confirm, isCancel } from './interactive-prompts.ts';
import { resolveOperatorOrigin } from './operator-auth.ts';
import { printSuccess, formatUrl } from './output.ts';
import {
  commitAuthenticationRecovery,
  encryptCredential,
  parseAuthenticationRecoveryInput,
  readConnection,
  recoverAuthenticationCredential,
  requireAdministrator,
  transaction,
} from './platform-auth-recovery-core.ts';
import type { Connection } from './platform-auth-recovery-core.ts';
import {
  platformOperatorCredentialLabel,
  resolvePlatformCloudflareCredential,
} from './platform-auth.ts';
import { PlatformCloudflareClient } from './platform-cloudflare.ts';
import type { PlatformConfigArgs } from './platform-config-args.ts';
import {
  acquirePlatformDatabaseLifecycleLockConnection,
  platformDatabaseClientUrl,
} from './platform-installer.ts';
import { resolvePlatformInstallDatabaseUrl } from './platform-lifecycle.ts';
import {
  selectAuthoritativePlatformManifest,
  verifyPlatformInstallationOwnership,
} from './platform-management.ts';
import {
  acquirePlatformLifecycleLock,
  readInstallationRecoverySecrets,
  resolveInstallationManifest,
} from './platform-registry.ts';

export async function runPlatformAuthRecovery(args: PlatformConfigArgs): Promise<void> {
  if (!args.file) {
    throw new Error(
      'platform: Recovery requires --file with administratorUserId and optional expectedIdentity/configuration.',
    );
  }
  const input = parseAuthenticationRecoveryInput(
    JSON.parse(await readFile(args.file, 'utf8')),
    args.target,
  );
  if (!args.plan && (!process.stdin.isTTY || args.yes) && (!args.yes || !input.expectedIdentity)) {
    throw new Error(
      'platform: Unattended recovery requires --yes and the exact expectedIdentity issuer and subject in --file.',
    );
  }
  let manifest = resolveInstallationManifest(args.installation ?? '');
  if (args.connection && resolveOperatorOrigin(args.connection) !== manifest.endpoints.apiUrl) {
    throw new Error('platform: The selected connection does not match the recovery installation.');
  }
  const secrets = readInstallationRecoverySecrets(manifest);
  if (
    !secrets?.jwtSecret ||
    !secrets.projectSecretKeysJson ||
    !secrets.projectSecretActiveKeyVersion
  ) {
    throw new Error(
      'platform: Restore the original encrypted installation recovery secrets before recovering a login.',
    );
  }
  const databaseUrl = resolvePlatformInstallDatabaseUrl(secrets, manifest);
  const credential = await resolvePlatformCloudflareCredential();
  const releaseLocal = acquirePlatformLifecycleLock(
    manifest.account.id,
    manifest.deployment.installationSlug,
  );
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: platformDatabaseClientUrl(databaseUrl), max: 1 });
  try {
    const db = await pool.connect();
    try {
      const releaseDatabase = await acquirePlatformDatabaseLifecycleLockConnection(
        db,
        manifest.id,
        manifest.ownershipNonce,
      );
      try {
        manifest = selectAuthoritativePlatformManifest(
          manifest,
          releaseDatabase.authoritativeManifest,
        );
        await verifyPlatformInstallationOwnership(
          new PlatformCloudflareClient(credential.token, {
            credential: platformOperatorCredentialLabel(credential),
          }),
          manifest,
          { databaseUrl },
        );
        if (!manifest.endpoints.apiUrl) {
          throw new Error('platform: Recover or repair the installed API endpoint first.');
        }
        const existing = await readConnection(db, args.target);
        const keyProbe =
          existing ??
          (
            await db.query<Connection>(
              'SELECT c.id,c.kind,r.revision,c.generation,r.configuration,r.secret FROM platform_login_connections c JOIN platform_login_revisions r ON c.id = r.connection_id LIMIT 1',
            )
          ).rows[0];
        if (!keyProbe) {
          throw new Error(
            'platform: Finish first-administrator setup before using provider recovery.',
          );
        }
        recoverAuthenticationCredential(
          secrets.projectSecretKeysJson,
          manifest.id,
          keyProbe.id,
          keyProbe.revision,
          keyProbe.secret,
        );
        const configuration = input.configuration ?? existing?.configuration;
        if (!configuration) {
          throw new Error('platform: A replacement connection requires configuration in --file.');
        }
        if (
          existing &&
          (configuration.kind !== existing.kind ||
            configuration.clientId !== existing.configuration.clientId ||
            configuration.issuer !== existing.configuration.issuer)
        ) {
          throw new Error('platform: A different identity namespace requires a new connection ID.');
        }
        const suppliedSecret = args.clientSecretEnv ? process.env[args.clientSecretEnv] : undefined;
        if ((args.clientSecretEnv && !suppliedSecret) || (!existing && !suppliedSecret)) {
          throw new Error(
            'platform: Supply the replacement client secret using --client-secret-env.',
          );
        }
        if (suppliedSecret && suppliedSecret.length > 8192) {
          throw new Error('platform: The client secret is too long.');
        }
        await requireAdministrator(db, input.administratorUserId);
        const preview = {
          installationId: manifest.id,
          administratorUserId: input.administratorUserId,
          connectionId: args.target,
          configuration,
          expectedIdentity: input.expectedIdentity,
          effect:
            'Test this login, explicitly confirm the identity, and restore the existing administrator. Revoke affected human sessions.',
        };
        console.log(JSON.stringify(preview, null, 2));
        if (args.plan) {
          return;
        }
        const proof = randomBytes(32).toString('hex');
        const testId = `test.${randomUUID()}`;
        const expiresAt = new Date(Date.now() + 600_000).toISOString();
        const recovery = await transaction(db, async () => {
          await db.query('LOCK TABLE platform_auth_settings IN SHARE ROW EXCLUSIVE MODE');
          await requireAdministrator(db, input.administratorUserId);
          const latest = await readConnection(db, args.target);
          if (JSON.stringify(latest) !== JSON.stringify(existing)) {
            throw new Error('platform: Login configuration changed. Start recovery again.');
          }
          let revision = existing?.revision ?? 1;
          if (suppliedSecret || input.configuration) {
            revision = existing ? existing.revision + 1 : 1;
            const secret =
              suppliedSecret ??
              (existing
                ? recoverAuthenticationCredential(
                    secrets.projectSecretKeysJson,
                    manifest.id,
                    existing.id,
                    existing.revision,
                    existing.secret,
                  )
                : undefined);
            if (secret === undefined) {
              throw new Error('platform: The login connection requires a client secret.');
            }
            const encrypted = encryptCredential(
              secrets.projectSecretKeysJson,
              secrets.projectSecretActiveKeyVersion,
              manifest.id,
              args.target,
              revision,
              secret,
            );
            if (!existing) {
              await db.query('INSERT INTO platform_login_connections (id,kind) VALUES ($1,$2)', [
                args.target,
                configuration.kind,
              ]);
            }
            await db.query(
              'INSERT INTO platform_login_revisions (connection_id,revision,configuration,secret) VALUES ($1,$2,$3::jsonb,$4::jsonb)',
              [args.target, revision, JSON.stringify(configuration), JSON.stringify(encrypted)],
            );
            await db.query('UPDATE platform_login_connections SET revision = $2 WHERE id = $1', [
              args.target,
              revision,
            ]);
            await db.query(
              'UPDATE platform_auth_settings SET revision = revision + 1 WHERE singleton = true',
            );
          }
          const unsigned = {
            installationId: manifest.id,
            administratorUserId: input.administratorUserId,
            connectionId: args.target,
            revision,
            generation: existing?.generation ?? 1,
            testId,
            expiresAt,
          };
          const recovery = {
            ...unsigned,
            signature: createHmac('sha256', secrets.jwtSecret)
              .update(platformAuthenticationRecoveryMessage(unsigned))
              .digest('base64url'),
          };
          await db.query(
            "INSERT INTO platform_auth_attempts (id,connection_id,revision,generation,purpose,browser_hash,context,expires_at) VALUES ($1,$2,$3,$4,'test',$5,$6::jsonb,$7)",
            [
              testId,
              args.target,
              revision,
              recovery.generation,
              createHash('sha256').update(proof).digest('hex'),
              JSON.stringify({
                phase: 'launch',
                actor: { userId: input.administratorUserId, sessionId: '', audience: 'api' },
                recovery,
              }),
              expiresAt,
            ],
          );
          await db.query(
            'INSERT INTO operator_events (id,user_id,login,action,target,status,http_status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [
              randomUUID(),
              input.administratorUserId,
              'Installation owner recovery',
              'auth.recovery.start',
              JSON.stringify({ connectionId: args.target, revision, testId }),
              'success',
              200,
            ],
          );
          return recovery;
        });
        const url = new URL('/auth/test', manifest.endpoints.apiUrl);
        url.searchParams.set('id', testId);
        url.searchParams.set('proof', proof);
        console.log(`Complete the recovery login in your browser: ${formatUrl(url.href)}`);
        if (process.stdin.isTTY) {
          openBrowser(url.href);
        }
        let tested: { issuer: string; subject: string; login: string } | undefined;
        while (Date.now() < Date.parse(expiresAt)) {
          tested = (
            await db.query<{ issuer: string; subject: string; login: string }>(
              'SELECT issuer,subject,login FROM platform_login_tests WHERE id = $1 AND user_id = $2 AND expires_at > now()',
              [testId, input.administratorUserId],
            )
          ).rows[0];
          if (tested) {
            break;
          }
          await delay(1000);
        }
        if (!tested) {
          throw new Error('platform: The recovery login expired. Run recovery again.');
        }
        console.log(
          JSON.stringify(
            { administratorUserId: input.administratorUserId, authenticatedIdentity: tested },
            null,
            2,
          ),
        );
        if (
          input.expectedIdentity &&
          (input.expectedIdentity.issuer !== tested.issuer ||
            input.expectedIdentity.subject !== tested.subject)
        ) {
          throw new Error(
            'platform: The authenticated identity does not match expectedIdentity. No administrator link was changed.',
          );
        }
        if (!args.yes) {
          const accepted = await confirm({
            message: `Bind issuer ${JSON.stringify(tested.issuer)}, subject ${JSON.stringify(tested.subject)} to existing administrator ${JSON.stringify(input.administratorUserId)}?`,
            initialValue: false,
          });
          if (isCancel(accepted) || !accepted) {
            throw new Error('platform: Recovery cancelled.');
          }
        }
        await commitAuthenticationRecovery(db, { recovery, identity: tested });
        printSuccess('Administrator login recovered. Sign in again with this login method.');
      } finally {
        await releaseDatabase();
      }
    } finally {
      db.release();
    }
  } finally {
    await pool.end();
    releaseLocal();
  }
}
