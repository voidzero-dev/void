import { eq, sql } from 'drizzle-orm';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { emailPayloadDigest } from '../../../proxy/src/email-admission.ts';
import { deleteEmailDestination } from '../../src/db.ts';
import {
  emailActionRecipients,
  emailMonthlyUsage,
  emailReceipts,
  emailUnresolvedAttempts,
} from '../../src/email/admission-schema.ts';
import {
  admitEmailAction,
  claimRelayedEmailReceipt,
  completeRelayedEmailReceipt,
  recordEmailReceipt,
  drainProjectEmailAdmissions,
  EmailAdmissionError,
  getProjectEmailLogs,
  getProjectEmailUsage,
  lockEmailPolicy,
  pruneEmailActionHistory,
  resolveEmailUnresolvedAttempt,
  setProjectEmailLimits,
  setProjectEmailSuspended,
  transitionEmailRecipients,
} from '../../src/email/admission.ts';
import {
  emailCredentials,
  emailDomainRoutes,
  emailZoneConnections,
} from '../../src/email/connection-schema.ts';
import { setEmailRecipientPolicy } from '../../src/email/settings.ts';
import { emailDestinations, projects, users } from '../../src/schema.ts';
import {
  captureQueries,
  clearTables,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
});

async function fixture() {
  const user = await createTestUser(env.db);
  const project = await createTestProject(env.db, user.id, 'acme');
  await env.db
    .insert(emailZoneConnections)
    .values({
      id: 'receipt-connection',
      installation_id: 'installation',
      account_id: 'account',
      zone_id: 'shared-zone',
      zone_name: 'mail.example.com',
      managed_by: 'admin',
      ingress_worker_name: 'receipt-gateway',
      secret_ciphertext: 'ciphertext',
      secret_iv: 'iv',
      secret_key_version: 'key',
      inbound_status: 'ready',
    })
    .onConflictDoNothing();
  await env.db
    .insert(emailDomainRoutes)
    .values({
      id: 'receipt-route',
      domain: 'mail.example.com',
      connection_id: 'receipt-connection',
      project_id: null,
      addressing: 'shared',
      managed_by: 'admin',
      inbound_status: 'ready',
    })
    .onConflictDoNothing();
  await env.db
    .insert(emailDomainRoutes)
    .values({
      id: 'shared-alias-route',
      domain: 'shared-alias.example.com',
      connection_id: 'receipt-connection',
      project_id: null,
      addressing: 'shared',
      managed_by: 'admin',
      inbound_status: 'ready',
    })
    .onConflictDoNothing();
  await env.db.insert(emailDestinations).values({
    id: `dest_${project.id}`,
    project_id: project.id,
    address: 'one@example.com',
    status: 'verified',
  });
  await env.db.insert(emailDestinations).values({
    id: `dest2_${project.id}`,
    project_id: project.id,
    address: 'two@example.com',
    status: 'verified',
  });
  return { ...project, userId: user.id };
}

async function waitForPostgresLockWaiter(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await env.db.execute(sql`
      SELECT count(*)::int AS waiters
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
    `);
    if (Number((result.rows[0] as { waiters?: number } | undefined)?.waiters ?? 0) >= 1) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for the attempt-start owner lock');
}

function input(projectId: string, key: string, recipients = ['one@example.com']) {
  return {
    projectId,
    kind: 'direct' as const,
    key,
    digest: 'a'.repeat(64),
    from: 'acme+news@mail.example.com',
    recipients,
    transport: 'binding' as const,
    sharedSenderDomain: 'mail.example.com',
  };
}

function receiptRoute(projectSlug = 'acme') {
  return {
    routeId: 'receipt-route',
    routeGeneration: 1,
    connectionId: 'receipt-connection',
    addressing: 'shared' as const,
    domain: 'mail.example.com',
    projectSlug,
  };
}

describe('authoritative email admission', () => {
  it.each(['native', 'relayed'] as const)(
    'requires an authoritative route fence for a fresh %s receipt',
    async (transport) => {
      const project = await fixture();
      const receive =
        transport === 'native'
          ? recordEmailReceipt(env.db, {
              receiptId: 'missing-route-fence',
              projectId: project.id,
              status: 'received',
            })
          : claimRelayedEmailReceipt(env.db, {
              receiptId: '0'.repeat(64),
              projectId: project.id,
              payloadDigest: '1'.repeat(64),
            });
      await expect(receive).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(await env.db.select().from(emailReceipts)).toHaveLength(0);
    },
  );

  it.each(['native', 'relayed'] as const)(
    'rejects a fresh %s receipt after its resolved route is disabled',
    async (transport) => {
      const project = await fixture();
      await env.db
        .update(emailDomainRoutes)
        .set({ desired_state: 'disabled' })
        .where(eq(emailDomainRoutes.id, 'receipt-route'));

      const receive =
        transport === 'native'
          ? recordEmailReceipt(env.db, {
              receiptId: 'route-disabled',
              projectId: project.id,
              status: 'received',
              route: receiptRoute(),
            })
          : claimRelayedEmailReceipt(env.db, {
              receiptId: 'a'.repeat(64),
              projectId: project.id,
              payloadDigest: 'b'.repeat(64),
              route: receiptRoute(),
            });
      await expect(receive).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(await env.db.select().from(emailReceipts)).toHaveLength(0);
      expect((await getProjectEmailUsage(env.db, project.id)).received).toBe(0);
    },
  );

  it.each([
    [
      'route generation changes',
      async () => {
        await env.db
          .update(emailDomainRoutes)
          .set({ desired_generation: 2 })
          .where(eq(emailDomainRoutes.id, 'receipt-route'));
      },
    ],
    [
      'route readiness changes',
      async () => {
        await env.db
          .update(emailDomainRoutes)
          .set({ inbound_status: 'drifted' })
          .where(eq(emailDomainRoutes.id, 'receipt-route'));
      },
    ],
    [
      'connection readiness changes',
      async () => {
        await env.db
          .update(emailZoneConnections)
          .set({ inbound_status: 'drifted' })
          .where(eq(emailZoneConnections.id, 'receipt-connection'));
      },
    ],
    [
      'the shared project slug changes',
      async () => {
        await env.db.update(projects).set({ slug: 'renamed' });
      },
    ],
  ] as const)('rejects a fresh relayed receipt when %s', async (_label, mutate) => {
    const project = await fixture();
    await mutate();
    await expect(
      claimRelayedEmailReceipt(env.db, {
        receiptId: 'c'.repeat(64),
        projectId: project.id,
        payloadDigest: 'd'.repeat(64),
        route: receiptRoute(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('rejects a stale custom-route assignment for another project', async () => {
    const project = await fixture();
    const otherUser = await createTestUser(env.db);
    const other = await createTestProject(env.db, otherUser.id, 'other');
    await env.db.insert(emailDomainRoutes).values({
      id: 'custom-receipt-route',
      domain: 'custom.example.com',
      connection_id: 'receipt-connection',
      project_id: project.id,
      addressing: 'custom',
      managed_by: 'admin',
      inbound_status: 'ready',
      desired_generation: 3,
    });
    await env.db
      .update(emailDomainRoutes)
      .set({ project_id: other.id, desired_generation: 4 })
      .where(eq(emailDomainRoutes.id, 'custom-receipt-route'));

    await expect(
      recordEmailReceipt(env.db, {
        receiptId: 'stale-custom-route',
        projectId: project.id,
        status: 'received',
        route: {
          routeId: 'custom-receipt-route',
          routeGeneration: 3,
          connectionId: 'receipt-connection',
          addressing: 'custom',
          domain: 'custom.example.com',
          projectSlug: project.slug,
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('allows an existing native receipt to finish after its route is disabled', async () => {
    const project = await fixture();
    await recordEmailReceipt(env.db, {
      receiptId: 'existing-native-route',
      projectId: project.id,
      status: 'received',
      route: receiptRoute(),
    });
    await env.db
      .update(emailDomainRoutes)
      .set({ desired_state: 'disabled', inbound_status: 'disabled' })
      .where(eq(emailDomainRoutes.id, 'receipt-route'));

    await expect(
      recordEmailReceipt(env.db, {
        receiptId: 'existing-native-route',
        projectId: project.id,
        status: 'handler_completed',
      }),
    ).resolves.toBeUndefined();
    expect((await getProjectEmailUsage(env.db, project.id)).received).toBe(1);
  });

  it.runIf(Boolean(process.env.VOID_TEST_DATABASE_URL)).each(['native', 'relayed'] as const)(
    'serializes a fresh %s receipt with a concurrent route disable',
    async (transport) => {
      const project = await fixture();
      let routeDisabled!: () => void;
      const disabled = new Promise<void>((resolve) => {
        routeDisabled = resolve;
      });
      let releaseDisable!: () => void;
      const disableMayCommit = new Promise<void>((resolve) => {
        releaseDisable = resolve;
      });
      const disabling = env.db.transaction(async (tx) => {
        await lockEmailPolicy(tx);
        await tx
          .update(emailDomainRoutes)
          .set({ desired_state: 'disabled', inbound_status: 'disabled' })
          .where(eq(emailDomainRoutes.id, 'receipt-route'));
        routeDisabled();
        await disableMayCommit;
      });
      await disabled;
      const receive =
        transport === 'native'
          ? recordEmailReceipt(env.db, {
              receiptId: 'route-disable-race',
              projectId: project.id,
              status: 'received',
              route: receiptRoute(),
            })
          : claimRelayedEmailReceipt(env.db, {
              receiptId: 'e'.repeat(64),
              projectId: project.id,
              payloadDigest: 'f'.repeat(64),
              route: receiptRoute(),
            });
      // It can fail before the assertion below listens; that is not an unhandled rejection.
      receive.catch(() => {});
      try {
        await waitForPostgresLockWaiter();
        releaseDisable();
        await disabling;
        await expect(receive).rejects.toMatchObject({ code: 'INVALID_STATE' });
        expect(await env.db.select().from(emailReceipts)).toHaveLength(0);
      } finally {
        releaseDisable();
        await Promise.allSettled([disabling, receive]);
      }
    },
    15_000,
  );

  it('rejects a custom sender after its stored Cloudflare token expiry', async () => {
    const project = await fixture();
    await env.db.insert(emailCredentials).values({
      id: 'expired-cred',
      installation_id: 'installation',
      managed_by: 'owner',
      manager_user_id: project.userId,
      kind: 'api_token',
      account_id: 'account',
      zone_id: 'zone',
      ciphertext: 'ciphertext',
      iv: 'iv',
      key_version: 'key',
      expires_on: new Date(Date.now() - 60_000).toISOString(),
    });
    await env.db.insert(emailZoneConnections).values({
      id: 'expired-connection',
      installation_id: 'installation',
      account_id: 'account',
      zone_id: 'zone',
      zone_name: 'example.com',
      managed_by: 'owner',
      manager_user_id: project.userId,
      credential_id: 'expired-cred',
      ingress_worker_name: 'gateway',
      secret_ciphertext: 'ciphertext',
      secret_iv: 'iv',
      secret_key_version: 'key',
      management_status: 'healthy',
    });
    await env.db.insert(emailDomainRoutes).values({
      id: 'expired-route',
      domain: 'custom.example.com',
      connection_id: 'expired-connection',
      project_id: project.id,
      addressing: 'custom',
      managed_by: 'owner',
      assigned_by_user_id: project.userId,
      inbound_status: 'ready',
      outbound_status: 'ready',
    });

    const action = await admitEmailAction(env.db, {
      ...input(project.id, 'expired-sender'),
      from: 'support@custom.example.com',
      transport: 'send_raw',
    });
    expect(action.recipients).toMatchObject([{ state: 'rejected', errorCode: 'INVALID_FROM' }]);
    expect((await getProjectEmailUsage(env.db, project.id)).attempts).toBe(0);
  });

  it('does not start a reserved custom send after the stored token expires', async () => {
    const project = await fixture();
    await env.db.insert(emailCredentials).values({
      id: 'expiring-cred',
      installation_id: 'installation',
      managed_by: 'owner',
      manager_user_id: project.userId,
      kind: 'api_token',
      account_id: 'account',
      zone_id: 'zone',
      ciphertext: 'ciphertext',
      iv: 'iv',
      key_version: 'key',
      expires_on: new Date(Date.now() + 60_000).toISOString(),
    });
    await env.db.insert(emailZoneConnections).values({
      id: 'expiring-connection',
      installation_id: 'installation',
      account_id: 'account',
      zone_id: 'zone',
      zone_name: 'example.com',
      managed_by: 'owner',
      manager_user_id: project.userId,
      credential_id: 'expiring-cred',
      ingress_worker_name: 'gateway',
      secret_ciphertext: 'ciphertext',
      secret_iv: 'iv',
      secret_key_version: 'key',
      management_status: 'healthy',
    });
    await env.db.insert(emailDomainRoutes).values({
      id: 'expiring-route',
      domain: 'expiring.example.com',
      connection_id: 'expiring-connection',
      project_id: project.id,
      addressing: 'custom',
      managed_by: 'owner',
      assigned_by_user_id: project.userId,
      inbound_status: 'ready',
      outbound_status: 'ready',
    });
    const action = await admitEmailAction(env.db, {
      ...input(project.id, 'expiring-sender'),
      from: 'support@expiring.example.com',
      transport: 'send_raw',
    });
    expect(action.recipients[0]?.state).toBe('reserved');
    await env.db
      .update(emailCredentials)
      .set({ expires_on: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(emailCredentials.id, 'expiring-cred'));

    await expect(
      transitionEmailRecipients(env.db, action.operationId, ['one@example.com'], 'attempt_started'),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(
      (
        await admitEmailAction(env.db, {
          ...input(project.id, 'expiring-sender'),
          from: 'support@expiring.example.com',
          transport: 'send_raw',
        })
      ).recipients[0]?.state,
    ).toBe('reserved');
    expect(await env.db.select().from(emailUnresolvedAttempts)).toHaveLength(0);
    await transitionEmailRecipients(env.db, action.operationId, ['one@example.com'], 'cancelled');
    expect((await getProjectEmailUsage(env.db, project.id)).attempts).toBe(0);
  });

  it('admits shared-sender replies through the binding while enforcing recipient consent', async () => {
    const project = await fixture();
    const receiptId = 'f'.repeat(64);
    await recordEmailReceipt(env.db, {
      receiptId,
      projectId: project.id,
      status: 'handler_completed',
      route: receiptRoute(),
    });
    const result = await admitEmailAction(env.db, {
      ...input(project.id, 'shared-binding-reply', ['one@example.com', 'unverified@example.net']),
      kind: 'reply',
      receiptId,
    });
    expect(result.recipients).toHaveLength(2);
    expect(result.recipients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recipient: 'one@example.com', state: 'reserved' }),
        expect.objectContaining({
          recipient: 'unverified@example.net',
          state: 'rejected',
          errorCode: 'UNVERIFIED_DESTINATION',
        }),
      ]),
    );
    expect((await getProjectEmailUsage(env.db, project.id)).attempts).toBe(1);
  });

  it('requires verified recipients for shared native forwarding even under an open policy', async () => {
    const project = await fixture();
    await setEmailRecipientPolicy(env.db, env.ROUTING, { mode: 'any', domains: [] });
    const receiptId = 'e'.repeat(64);
    await recordEmailReceipt(env.db, {
      receiptId,
      projectId: project.id,
      status: 'handler_completed',
      route: receiptRoute(),
    });
    const result = await admitEmailAction(env.db, {
      ...input(project.id, 'shared-forward', ['one@example.com', 'unverified@example.net']),
      kind: 'forward',
      transport: 'native_forward',
      receiptId,
    });
    expect(result.recipients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recipient: 'one@example.com', state: 'reserved' }),
        expect.objectContaining({
          recipient: 'unverified@example.net',
          state: 'rejected',
          errorCode: 'UNVERIFIED_DESTINATION',
        }),
      ]),
    );
    expect((await getProjectEmailUsage(env.db, project.id)).attempts).toBe(1);
  });

  it('admits a multi-tag shared forward only for the project named by the first segment', async () => {
    const project = await fixture();
    const receiptId = 'multi-tag-forward';
    await recordEmailReceipt(env.db, {
      receiptId,
      projectId: project.id,
      status: 'handler_completed',
      route: receiptRoute(),
    });

    const admitted = await admitEmailAction(env.db, {
      ...input(project.id, 'owned-multi-tag-forward'),
      kind: 'forward',
      from: 'acme+support+forward.run@mail.example.com',
      transport: 'native_forward',
      receiptId,
    });
    expect(admitted.recipients).toMatchObject([{ state: 'reserved', errorCode: null }]);

    const crossProject = await admitEmailAction(env.db, {
      ...input(project.id, 'cross-project-multi-tag-forward'),
      kind: 'forward',
      from: 'other+support+forward.run@mail.example.com',
      transport: 'native_forward',
      receiptId,
    });
    expect(crossProject.recipients).toMatchObject([
      { state: 'rejected', errorCode: 'INVALID_FROM' },
    ]);
    expect((await getProjectEmailUsage(env.db, project.id)).attempts).toBe(1);
  });

  it('records unsupported relayed forwarding without charging and retains native verified forwarding', async () => {
    const project = await fixture();
    await env.db.insert(emailCredentials).values({
      id: 'cred',
      installation_id: 'installation',
      managed_by: 'admin',
      kind: 'platform',
      account_id: 'account',
      zone_id: 'zone',
    });
    await env.db.insert(emailZoneConnections).values({
      id: 'connection',
      installation_id: 'installation',
      account_id: 'account',
      zone_id: 'zone',
      zone_name: 'example.com',
      managed_by: 'admin',
      credential_id: 'cred',
      ingress_worker_name: 'gateway',
      secret_ciphertext: 'ciphertext',
      secret_iv: 'iv',
      secret_key_version: 'key',
      management_status: 'healthy',
    });
    await env.db.insert(emailDomainRoutes).values({
      id: 'route',
      domain: 'example.com',
      connection_id: 'connection',
      project_id: project.id,
      addressing: 'custom',
      managed_by: 'admin',
      inbound_status: 'ready',
      outbound_status: 'ready',
    });
    const receiptId = 'f'.repeat(64);
    await recordEmailReceipt(env.db, {
      receiptId,
      projectId: project.id,
      status: 'handler_completed',
      route: receiptRoute(),
    });
    const forward = {
      ...input(project.id, 'relay-forward'),
      kind: 'forward' as const,
      from: 'support@example.com',
      receiptId,
    };
    const unsupported = await admitEmailAction(env.db, { ...forward, transport: 'send_raw' });
    expect(unsupported.recipients).toMatchObject([
      { state: 'rejected', errorCode: 'UNSUPPORTED_ACTION' },
    ]);
    expect((await getProjectEmailUsage(env.db, project.id)).attempts).toBe(0);
    const native = await admitEmailAction(env.db, {
      ...forward,
      key: 'native-forward',
      transport: 'native_forward',
      recipients: ['one@example.com', 'unverified@example.net'],
    });
    expect(native.recipients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recipient: 'one@example.com', state: 'reserved' }),
        expect.objectContaining({
          recipient: 'unverified@example.net',
          state: 'rejected',
          errorCode: 'UNVERIFIED_DESTINATION',
        }),
      ]),
    );
  });

  it('keeps invalid handler actions visible when completing and replaying a receipt', async () => {
    const project = await fixture();
    const identity = {
      receiptId: 'c'.repeat(64),
      payloadDigest: 'd'.repeat(64),
      projectId: project.id,
      route: receiptRoute(),
    };
    await claimRelayedEmailReceipt(env.db, identity);
    await recordEmailReceipt(env.db, { ...identity, status: 'actions_rejected' });
    await completeRelayedEmailReceipt(env.db, { ...identity, reject: false });
    expect(await claimRelayedEmailReceipt(env.db, identity)).toEqual({
      state: 'completed',
      reject: false,
    });
    expect((await getProjectEmailLogs(env.db, project.id)).logs).toEqual([
      expect.objectContaining({
        receiptId: identity.receiptId,
        status: 'actions_rejected',
        errorCode: 'INVALID_ACTIONS',
      }),
    ]);
  });

  it('claims a relay invocation once and replays its completed outcome without rerunning it', async () => {
    const project = await fixture();
    const identity = {
      receiptId: 'a'.repeat(64),
      projectId: project.id,
      payloadDigest: 'b'.repeat(64),
      route: receiptRoute(),
    };
    const claims = await Promise.all(
      Array.from({ length: 3 }, () => claimRelayedEmailReceipt(env.db, identity)),
    );
    expect(claims.filter((claim) => claim.state === 'claimed')).toHaveLength(1);
    expect(claims.filter((claim) => claim.state === 'in_progress')).toHaveLength(2);
    expect((await getProjectEmailUsage(env.db, project.id)).received).toBe(1);
    await env.db
      .update(emailDomainRoutes)
      .set({ desired_state: 'disabled', inbound_status: 'disabled' })
      .where(eq(emailDomainRoutes.id, 'receipt-route'));
    await expect(
      completeRelayedEmailReceipt(env.db, { ...identity, reject: false }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await recordEmailReceipt(env.db, {
      receiptId: identity.receiptId,
      projectId: project.id,
      status: 'handler_completed',
    });
    await completeRelayedEmailReceipt(env.db, { ...identity, reject: false });
    const replayIdentity = {
      receiptId: identity.receiptId,
      projectId: identity.projectId,
      payloadDigest: identity.payloadDigest,
    };
    expect(await claimRelayedEmailReceipt(env.db, replayIdentity)).toEqual({
      state: 'completed',
      reject: false,
    });
    expect((await getProjectEmailUsage(env.db, project.id)).received).toBe(1);
    await expect(
      claimRelayedEmailReceipt(env.db, {
        ...replayIdentity,
        payloadDigest: 'c'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      completeRelayedEmailReceipt(env.db, { ...identity, reject: true }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('fences new starts during deletion, cancels only reserved work, and retains the audit after deletion', async () => {
    const project = await fixture();
    const reserved = await admitEmailAction(env.db, input(project.id, 'reserved'));
    const started = await admitEmailAction(
      env.db,
      input(project.id, 'started', ['two@example.com']),
    );
    await transitionEmailRecipients(
      env.db,
      started.operationId,
      ['two@example.com'],
      'attempt_started',
    );
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
    await expect(
      transitionEmailRecipients(
        env.db,
        reserved.operationId,
        ['one@example.com'],
        'attempt_started',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await drainProjectEmailAdmissions(env.db, project.id)).toEqual({
      cancelled: 1,
      inFlight: 1,
    });
    expect((await getProjectEmailUsage(env.db, project.id)).attempts).toBe(1);
    await transitionEmailRecipients(
      env.db,
      started.operationId,
      ['two@example.com'],
      'outcome_unknown',
    );
    expect(await drainProjectEmailAdmissions(env.db, project.id)).toEqual({
      cancelled: 0,
      inFlight: 0,
    });
    await env.db.delete(projects).where(eq(projects.id, project.id));
    const logs = await getProjectEmailLogs(env.db, project.id);
    expect(logs.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operationId: reserved.operationId, status: 'cancelled' }),
        expect.objectContaining({ operationId: started.operationId, status: 'outcome_unknown' }),
      ]),
    );
    expect((await getProjectEmailUsage(env.db, project.id)).attempts).toBe(1);
  });

  it('expires completed unknown metadata but retains a PII-free active-attempt fence', async () => {
    const project = await fixture();
    const active = await admitEmailAction(env.db, input(project.id, 'active'));
    const uncertain = await admitEmailAction(
      env.db,
      input(project.id, 'uncertain', ['two@example.com']),
    );
    await transitionEmailRecipients(
      env.db,
      active.operationId,
      ['one@example.com'],
      'attempt_started',
    );
    await transitionEmailRecipients(
      env.db,
      uncertain.operationId,
      ['two@example.com'],
      'attempt_started',
    );
    await transitionEmailRecipients(
      env.db,
      uncertain.operationId,
      ['two@example.com'],
      'outcome_unknown',
    );
    await pruneEmailActionHistory(env.db, new Date(Date.now() + 60_000));
    expect((await getProjectEmailLogs(env.db, project.id)).logs).toHaveLength(0);
    const tombstones = await env.db.select().from(emailUnresolvedAttempts);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({
      project_id: project.id,
      sender_domain: 'mail.example.com',
    });
    expect(JSON.stringify(tombstones)).not.toContain('one@example.com');
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
    expect(await drainProjectEmailAdmissions(env.db, project.id)).toEqual({
      cancelled: 0,
      inFlight: 1,
    });
  });

  it('resolves a stopped old attempt without retrying or refunding it', async () => {
    const project = await fixture();
    const action = await admitEmailAction(env.db, input(project.id, 'crashed'));
    await transitionEmailRecipients(
      env.db,
      action.operationId,
      ['one@example.com'],
      'attempt_started',
    );
    const [fence] = await env.db.select().from(emailUnresolvedAttempts);
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    await env.db
      .update(emailUnresolvedAttempts)
      .set({ started_at: old })
      .where(eq(emailUnresolvedAttempts.id, fence!.id));
    await env.db
      .update(emailActionRecipients)
      .set({ attempt_started_at: old })
      .where(eq(emailActionRecipients.id, fence!.id));

    await expect(
      resolveEmailUnresolvedAttempt(env.db, { id: fence!.id, ended: false, reason: 'ended' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      resolveEmailUnresolvedAttempt(env.db, { id: fence!.id, ended: true, reason: '' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(
      await resolveEmailUnresolvedAttempt(env.db, {
        id: fence!.id,
        ended: true,
        reason: 'Worker execution ended; provider status cannot be verified',
      }),
    ).toMatchObject({ state: 'outcome_unknown', metadataExpired: false, charged: true });
    expect(await env.db.select().from(emailUnresolvedAttempts)).toHaveLength(0);
    expect((await getProjectEmailLogs(env.db, project.id)).logs).toEqual([
      expect.objectContaining({ operationId: action.operationId, status: 'outcome_unknown' }),
    ]);
    expect((await getProjectEmailUsage(env.db, project.id)).attempts).toBe(1);
    expect(
      (await admitEmailAction(env.db, input(project.id, 'crashed'))).recipients[0]?.state,
    ).toBe('outcome_unknown');
    await expect(
      transitionEmailRecipients(
        env.db,
        action.operationId,
        ['one@example.com'],
        'provider_accepted',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('requires an old fence even when the operator attests the execution ended', async () => {
    const project = await fixture();
    const action = await admitEmailAction(env.db, input(project.id, 'recent'));
    await transitionEmailRecipients(
      env.db,
      action.operationId,
      ['one@example.com'],
      'attempt_started',
    );
    const [fence] = await env.db.select().from(emailUnresolvedAttempts);
    await expect(
      resolveEmailUnresolvedAttempt(env.db, {
        id: fence!.id,
        ended: true,
        reason: 'Worker execution ended',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await env.db.select().from(emailUnresolvedAttempts)).toHaveLength(1);
    expect((await getProjectEmailLogs(env.db, project.id)).logs[0]?.status).toBe('attempt_started');
  });

  it('releases a PII-free fence after the recipient ledger has expired', async () => {
    const project = await fixture();
    const action = await admitEmailAction(env.db, input(project.id, 'expired'));
    await transitionEmailRecipients(
      env.db,
      action.operationId,
      ['one@example.com'],
      'attempt_started',
    );
    const [fence] = await env.db.select().from(emailUnresolvedAttempts);
    await env.db
      .update(emailUnresolvedAttempts)
      .set({ started_at: new Date(Date.now() - 31 * 86_400_000).toISOString() })
      .where(eq(emailUnresolvedAttempts.id, fence!.id));
    await pruneEmailActionHistory(env.db, new Date(Date.now() + 60_000));
    expect((await getProjectEmailLogs(env.db, project.id)).logs).toHaveLength(0);
    expect(
      await resolveEmailUnresolvedAttempt(env.db, {
        id: fence!.id,
        ended: true,
        reason: 'Worker execution ended; delivery record expired',
      }),
    ).toMatchObject({ metadataExpired: true, charged: true });
    expect(await env.db.select().from(emailUnresolvedAttempts)).toHaveLength(0);
    expect((await getProjectEmailUsage(env.db, project.id)).attempts).toBe(1);
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
    expect(await drainProjectEmailAdmissions(env.db, project.id)).toEqual({
      cancelled: 0,
      inFlight: 0,
    });
  });

  it('replays one operation without a second quota debit and conflicts on changed payload', async () => {
    const project = await fixture();
    const first = await admitEmailAction(env.db, input(project.id, 'same'));
    expect(first.replay).toBe(false);
    expect(first.recipients[0]?.state).toBe('reserved');
    const again = await admitEmailAction(env.db, input(project.id, 'same'));
    expect(again.operationId).toBe(first.operationId);
    expect(again.replay).toBe(true);
    expect((await getProjectEmailUsage(env.db, project.id)).attempts).toBe(1);
    await expect(
      admitEmailAction(env.db, { ...input(project.id, 'same'), digest: 'b'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<EmailAdmissionError>);
  });

  it('replays a multipart send whose SDK boundary was rebuilt without a second quota debit', async () => {
    const project = await fixture();
    const original = input(project.id, 'rebuilt-multipart');
    const mime = (boundary: string) =>
      new TextEncoder().encode(
        [
          'From: acme+news@mail.example.com',
          'To: one@example.com',
          'MIME-Version: 1.0',
          'Content-Type: multipart/alternative;',
          ` boundary="${boundary}"`,
          '',
          `--${boundary}`,
          'Content-Type: text/plain; charset=UTF-8',
          '',
          'Plain text',
          `--${boundary}`,
          'Content-Type: text/html; charset=UTF-8',
          '',
          '<p>HTML</p>',
          `--${boundary}--`,
          '',
        ].join('\r\n'),
      );
    const digest = (raw: Uint8Array) =>
      emailPayloadDigest('direct', original.from, original.recipients, raw);
    const first = await admitEmailAction(env.db, {
      ...original,
      digest: await digest(mime('=_void_alternative_1573725Jyj8yLCojOVRltQ')),
    });
    expect(
      await admitEmailAction(env.db, {
        ...original,
        digest: await digest(mime('=_void_alternative_rebuilt')),
      }),
    ).toMatchObject({ operationId: first.operationId, replay: true });
    expect((await getProjectEmailUsage(env.db, project.id)).attempts).toBe(1);
  });

  it('admits a partial batch under atomic recipient quotas and keeps charges after uncertain outcomes', async () => {
    const project = await fixture();
    await setProjectEmailLimits(env.db, project.id, { burst: 1, monthly: 1 });
    const result = await admitEmailAction(
      env.db,
      input(project.id, 'batch', ['one@example.com', 'two@example.com', 'one@example.com']),
    );
    expect(result.recipients).toHaveLength(2);
    expect(Object.fromEntries(result.recipients.map((r) => [r.recipient, r.state]))).toEqual({
      'one@example.com': 'reserved',
      'two@example.com': 'rejected',
    });
    await transitionEmailRecipients(
      env.db,
      result.operationId,
      ['one@example.com'],
      'attempt_started',
    );
    await transitionEmailRecipients(
      env.db,
      result.operationId,
      ['one@example.com'],
      'outcome_unknown',
      { errorCode: 'OUTCOME_UNKNOWN' },
    );
    expect((await getProjectEmailUsage(env.db, project.id)).attempts).toBe(1);
    const replay = await admitEmailAction(
      env.db,
      input(project.id, 'batch', ['one@example.com', 'two@example.com']),
    );
    expect(replay.recipients.find((r) => r.recipient === 'one@example.com')?.state).toBe(
      'outcome_unknown',
    );
    await expect(
      transitionEmailRecipients(env.db, result.operationId, ['one@example.com'], 'attempt_started'),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('keeps admission database round trips constant at the maximum recipient batch', async () => {
    const project = await fixture();
    await setEmailRecipientPolicy(env.db, env.ROUTING, { mode: 'any', domains: [] });
    await setProjectEmailLimits(env.db, project.id, { burst: 1_000, monthly: 1_000 });

    const single = await captureQueries(env.db, () =>
      admitEmailAction(env.db, input(project.id, 'single-query-count', ['single@external.test'])),
    );
    const recipients = Array.from(
      { length: 50 },
      (_, index) => `recipient@external-${String(index).padStart(2, '0')}.test`,
    );
    const maximum = await captureQueries(env.db, () =>
      admitEmailAction(env.db, input(project.id, 'maximum-query-count', recipients)),
    );

    expect(single.result.recipients).toHaveLength(1);
    expect(maximum.result.recipients).toHaveLength(50);
    expect(single.queries.length).toBeGreaterThan(0);
    expect(maximum.queries).toHaveLength(single.queries.length);
  });

  it('preserves input priority when a maximum batch crosses the quota', async () => {
    const project = await fixture();
    await setEmailRecipientPolicy(env.db, env.ROUTING, { mode: 'any', domains: [] });
    await setProjectEmailLimits(env.db, project.id, { burst: 25, monthly: 25 });
    const recipients = Array.from(
      { length: 50 },
      (_, index) => `priority-${String(index).padStart(2, '0')}@external.test`,
    );

    const result = await admitEmailAction(env.db, input(project.id, 'maximum-quota', recipients));
    const byRecipient = new Map(
      result.recipients.map((recipient) => [recipient.recipient, recipient]),
    );
    for (const [index, recipient] of recipients.entries()) {
      expect(byRecipient.get(recipient)).toMatchObject(
        index < 25
          ? { state: 'reserved', errorCode: null }
          : { state: 'rejected', errorCode: 'QUOTA_EXCEEDED' },
      );
    }
  });

  it('keeps shared platform domains consent-gated in a mixed batch', async () => {
    const project = await fixture();
    await setEmailRecipientPolicy(env.db, env.ROUTING, { mode: 'any', domains: [] });

    const result = await admitEmailAction(
      env.db,
      input(project.id, 'shared-domain-protection', [
        'external@external.test',
        'other-project@shared-alias.example.com',
      ]),
    );
    expect(result.recipients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recipient: 'external@external.test', state: 'reserved' }),
        expect.objectContaining({
          recipient: 'other-project@shared-alias.example.com',
          state: 'rejected',
          errorCode: 'UNVERIFIED_DESTINATION',
        }),
      ]),
    );
  });

  it('rejects new attempts after suspension and keeps a rejection in the ledger', async () => {
    const project = await fixture();
    await setProjectEmailSuspended(env.db, project.id, true);
    const result = await admitEmailAction(env.db, input(project.id, 'blocked'));
    expect(result.recipients[0]).toMatchObject({ state: 'rejected', errorCode: 'SUSPENDED' });
    expect((await getProjectEmailUsage(env.db, project.id)).attempts).toBe(0);
  });

  it.each([
    ['native', 'project'],
    ['native', 'owner'],
    ['relayed', 'project'],
    ['relayed', 'owner'],
  ] as const)(
    'blocks new %s receipts after %s suspension but finishes an existing receipt',
    async (transport, scope) => {
      const project = await fixture();
      const receive = (receiptId: string) =>
        transport === 'native'
          ? recordEmailReceipt(env.db, {
              receiptId,
              projectId: project.id,
              status: 'received',
              route: receiptRoute(),
            })
          : claimRelayedEmailReceipt(env.db, {
              receiptId,
              projectId: project.id,
              payloadDigest: 'd'.repeat(64),
              route: receiptRoute(),
            });
      const receiptId = 'a'.repeat(64);
      await receive(receiptId);
      if (scope === 'owner') {
        await env.db
          .update(users)
          .set({ suspended_reason: 'admin_suspended' })
          .where(eq(users.id, project.userId));
      } else {
        await setProjectEmailSuspended(env.db, project.id, true);
      }
      await expect(receive('b'.repeat(64))).rejects.toMatchObject({ code: 'INVALID_STATE' });
      await recordEmailReceipt(env.db, {
        receiptId,
        projectId: project.id,
        status: 'handler_completed',
      });
      if (transport === 'relayed') {
        await completeRelayedEmailReceipt(env.db, {
          receiptId,
          projectId: project.id,
          payloadDigest: 'd'.repeat(64),
          reject: false,
        });
        await expect(receive(receiptId)).resolves.toEqual({ state: 'completed', reject: false });
      }
      expect(await env.db.select().from(emailReceipts)).toHaveLength(1);
      expect((await getProjectEmailUsage(env.db, project.id)).received).toBe(1);
    },
  );

  it('does not start an admitted reservation after its owner is suspended', async () => {
    const project = await fixture();
    const action = await admitEmailAction(env.db, input(project.id, 'owner-suspended'));
    await env.db
      .update(users)
      .set({ suspended_reason: 'admin_suspended' })
      .where(eq(users.id, project.userId));

    await expect(
      transitionEmailRecipients(env.db, action.operationId, ['one@example.com'], 'attempt_started'),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(
      (await admitEmailAction(env.db, input(project.id, 'owner-suspended'))).recipients[0]?.state,
    ).toBe('reserved');
  });

  it
    .runIf(Boolean(process.env.VOID_TEST_DATABASE_URL))
    .each(['outbound', 'native', 'relayed'] as const)(
    'serializes %s admission with a concurrent owner suspension',
    async (transport) => {
      const project = await fixture();
      const action =
        transport === 'outbound'
          ? await admitEmailAction(env.db, input(project.id, 'owner-suspension-race'))
          : null;
      let markSuspended!: () => void;
      const suspended = new Promise<void>((resolve) => {
        markSuspended = resolve;
      });
      let releaseSuspension!: () => void;
      const suspensionMayCommit = new Promise<void>((resolve) => {
        releaseSuspension = resolve;
      });
      const suspension = env.db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({ suspended_reason: 'admin_suspended' })
          .where(eq(users.id, project.userId));
        markSuspended();
        await suspensionMayCommit;
      });
      await suspended;

      const start = action
        ? transitionEmailRecipients(
            env.db,
            action.operationId,
            ['one@example.com'],
            'attempt_started',
          )
        : transport === 'native'
          ? recordEmailReceipt(env.db, {
              receiptId: 'c'.repeat(64),
              projectId: project.id,
              status: 'received',
              route: receiptRoute(),
            })
          : claimRelayedEmailReceipt(env.db, {
              receiptId: 'c'.repeat(64),
              projectId: project.id,
              payloadDigest: 'd'.repeat(64),
              route: receiptRoute(),
            });
      // It can fail before the assertion below listens; that is not an unhandled rejection.
      start.catch(() => {});
      try {
        await waitForPostgresLockWaiter();
        releaseSuspension();
        await suspension;
        await expect(start).rejects.toMatchObject({ code: 'INVALID_STATE' });
        if (action) {
          expect(
            (await admitEmailAction(env.db, input(project.id, 'owner-suspension-race')))
              .recipients[0]?.state,
          ).toBe('reserved');
        } else {
          expect(await env.db.select().from(emailReceipts)).toHaveLength(0);
          expect((await getProjectEmailUsage(env.db, project.id)).received).toBe(0);
        }
      } finally {
        releaseSuspension();
        await Promise.allSettled([suspension, start]);
      }
    },
    15_000,
  );

  it('applies a tightened policy and revoked consent on the next operation', async () => {
    const project = await fixture();
    const kv = { put: async () => {}, get: async () => null } as unknown as KVNamespace;
    await setEmailRecipientPolicy(env.db, kv, { mode: 'any', domains: [] });
    const open = await admitEmailAction(env.db, input(project.id, 'open', ['new@example.net']));
    expect(open.recipients[0]?.state).toBe('reserved');
    await setEmailRecipientPolicy(env.db, kv, { mode: 'verified', domains: [] });
    await deleteEmailDestination(env.db, `dest_${project.id}`);
    const closed = await admitEmailAction(
      env.db,
      input(project.id, 'closed', ['one@example.com', 'new@example.net']),
    );
    expect(closed.recipients.map((r) => r.state)).toEqual(['rejected', 'rejected']);
    expect(closed.recipients.every((r) => r.errorCode === 'UNVERIFIED_DESTINATION')).toBe(true);
  });

  it('holds current-month quota after metadata pruning while removing expired buckets', async () => {
    const project = await fixture();
    await setProjectEmailLimits(env.db, project.id, { monthly: 1, burst: 10 });
    const first = await admitEmailAction(env.db, input(project.id, 'first'));
    await transitionEmailRecipients(
      env.db,
      first.operationId,
      ['one@example.com'],
      'attempt_started',
    );
    await transitionEmailRecipients(
      env.db,
      first.operationId,
      ['one@example.com'],
      'provider_accepted',
    );
    await recordEmailReceipt(env.db, {
      receiptId: 'retained-current-month-count',
      projectId: project.id,
      status: 'handler_completed',
      route: receiptRoute(),
    });
    await env.db.insert(emailMonthlyUsage).values([
      { project_id: project.id, month: '2000-01', recipient_attempts: 1 },
      { project_id: 'deleted-project', month: '2000-01', recipient_attempts: 2 },
    ]);
    await pruneEmailActionHistory(env.db, new Date(Date.now() + 60_000));
    expect(await env.db.select().from(emailMonthlyUsage)).toEqual([
      {
        project_id: project.id,
        month: new Date().toISOString().slice(0, 7),
        recipient_attempts: 1,
        inbound_receipts: 1,
      },
    ]);
    expect((await getProjectEmailLogs(env.db, project.id)).logs).toHaveLength(0);
    expect(await getProjectEmailUsage(env.db, project.id)).toMatchObject({
      attempts: 1,
      received: 1,
    });
    const second = await admitEmailAction(env.db, input(project.id, 'second'));
    expect(second.recipients[0]).toMatchObject({ state: 'rejected', errorCode: 'QUOTA_EXCEEDED' });
    expect(first.operationId).not.toBe(second.operationId);
  });

  it('refunds only cancelled reservations and never restarts an uncertain attempt', async () => {
    const project = await fixture();
    const first = await admitEmailAction(env.db, input(project.id, 'cancel'));
    await transitionEmailRecipients(env.db, first.operationId, ['one@example.com'], 'cancelled');
    expect((await getProjectEmailUsage(env.db, project.id)).attempts).toBe(0);
    await expect(
      transitionEmailRecipients(env.db, first.operationId, ['one@example.com'], 'attempt_started'),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const second = await admitEmailAction(env.db, input(project.id, 'uncertain'));
    await transitionEmailRecipients(
      env.db,
      second.operationId,
      ['one@example.com'],
      'attempt_started',
    );
    await transitionEmailRecipients(
      env.db,
      second.operationId,
      ['one@example.com'],
      'outcome_unknown',
    );
    expect(
      (await admitEmailAction(env.db, input(project.id, 'uncertain'))).recipients[0]?.state,
    ).toBe('outcome_unknown');
    await expect(
      transitionEmailRecipients(env.db, second.operationId, ['one@example.com'], 'cancelled'),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect((await getProjectEmailUsage(env.db, project.id)).attempts).toBe(1);
  });

  it.runIf(Boolean(process.env.VOID_TEST_DATABASE_URL))(
    'refunds the UTC quota month under a non-UTC PostgreSQL session',
    async () => {
      const project = await fixture();
      const action = await admitEmailAction(env.db, input(project.id, 'utc-month-refund'));
      await env.db.update(emailActionRecipients).set({ reserved_at: '2026-10-01T00:01:00.000Z' });
      await env.db.update(emailMonthlyUsage).set({ month: '2026-10' });
      await env.db.execute(sql`set time zone 'Pacific/Honolulu'`);
      try {
        const [stored] = await env.db.select().from(emailActionRecipients);
        expect(stored!.reserved_at!.slice(0, 7)).toBe('2026-09');
        await transitionEmailRecipients(
          env.db,
          action.operationId,
          ['one@example.com'],
          'cancelled',
        );
      } finally {
        await env.db.execute(sql`set time zone 'UTC'`);
      }
      expect(await env.db.select().from(emailMonthlyUsage)).toEqual([
        expect.objectContaining({ month: '2026-10', recipient_attempts: 0 }),
      ]);
    },
  );

  it('reclaims abandoned reservations without reopening started or uncertain sends', async () => {
    const project = await fixture();
    const abandoned = await admitEmailAction(env.db, input(project.id, 'abandoned'));
    const started = await admitEmailAction(env.db, input(project.id, 'started'));
    const uncertain = await admitEmailAction(env.db, input(project.id, 'unknown'));
    for (const action of [started, uncertain]) {
      await transitionEmailRecipients(
        env.db,
        action.operationId,
        ['one@example.com'],
        'attempt_started',
      );
    }
    await transitionEmailRecipients(
      env.db,
      uncertain.operationId,
      ['one@example.com'],
      'outcome_unknown',
    );
    await env.db.update(emailActionRecipients).set({
      reserved_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    });
    const recent = await admitEmailAction(env.db, input(project.id, 'recent'));

    await pruneEmailActionHistory(env.db);
    await pruneEmailActionHistory(env.db);
    for (const [key, operationId, state] of [
      ['abandoned', abandoned.operationId, 'cancelled'],
      ['started', started.operationId, 'attempt_started'],
      ['unknown', uncertain.operationId, 'outcome_unknown'],
      ['recent', recent.operationId, 'reserved'],
    ]) {
      const replay = await admitEmailAction(env.db, input(project.id, key!));
      expect(replay.operationId).toBe(operationId);
      expect(replay.recipients[0]?.state).toBe(state);
    }
    expect((await getProjectEmailUsage(env.db, project.id)).attempts).toBe(3);
    await expect(
      transitionEmailRecipients(
        env.db,
        abandoned.operationId,
        ['one@example.com'],
        'attempt_started',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await env.db.select().from(emailUnresolvedAttempts)).toHaveLength(1);
  });

  it('does not refund a previous-month reservation against this month', async () => {
    const project = await fixture();
    const abandoned = await admitEmailAction(env.db, input(project.id, 'last-month'));
    const previousMonth = new Date();
    previousMonth.setUTCDate(0);
    await env.db.update(emailActionRecipients).set({ reserved_at: previousMonth.toISOString() });
    await env.db.update(emailMonthlyUsage).set({ month: previousMonth.toISOString().slice(0, 7) });
    await admitEmailAction(env.db, input(project.id, 'this-month'));
    await pruneEmailActionHistory(env.db);
    expect(
      (await admitEmailAction(env.db, input(project.id, 'last-month'))).recipients[0]?.state,
    ).toBe('cancelled');
    expect((await getProjectEmailUsage(env.db, project.id)).attempts).toBe(1);
    await expect(
      transitionEmailRecipients(
        env.db,
        abandoned.operationId,
        ['one@example.com'],
        'attempt_started',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('enforces direct caller bounds at the authoritative API', async () => {
    const project = await fixture();
    await expect(
      admitEmailAction(env.db, input(project.id, 'x'.repeat(129))),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      admitEmailAction(
        env.db,
        input(
          project.id,
          'many',
          Array.from({ length: 51 }, (_, n) => `user${n}@example.com`),
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
