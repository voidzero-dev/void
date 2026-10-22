/**
 * Control-plane coverage for `void/email`.
 *
 * Routes under test (all mounted in `src/index.ts`):
 *   - `GET    /projects/:id/email/usage`
 *   - `GET    /projects/:id/email/logs`
 *   - `GET    /projects/:id/email/destinations`
 *   - `POST   /projects/:id/email/destinations`
 *   - `DELETE /projects/:id/email/destinations/:destId`
 *   - `GET    /email/destinations/confirm`  (public — shows the Confirm button)
 *   - `POST   /email/destinations/confirm`  (public — the token IS the auth)
 *
 * Two contracts run through the whole file and are worth stating once:
 *
 * 1. **The mail domain is configured, never baked in.** `EMAIL_SENDER_DOMAIN`
 *    is a per-environment var; `setupEnv()` deliberately leaves it UNSET so
 *    the fail-closed branch stays reachable. Anything that sends mail must
 *    opt in via `emailEnv()`, and the verification sender is
 *    `noreply@<EMAIL_SENDER_DOMAIN>` — asserted against the var, never
 *    against a literal.
 *
 * 2. **Per-project consent (Options C + B from the email design doc).** CF
 *    Email Routing verification is ACCOUNT-level. When CF already has an
 *    address verified we either inherit that consent (Option C — it is the
 *    project owner's own address, same human) or refuse to (Option B — some
 *    other project verified it, so we mail our own confirmation link and the
 *    row stays `pending` / `platform` until the recipient clicks).
 */

import { eq } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import { signConfirmToken } from '../../src/auth/confirm-token.ts';
import { revokeOwnerVerifiedDestinationsForUserChange } from '../../src/db.ts';
import * as dbModule from '../../src/db.ts';
import { emailMonthlyUsage } from '../../src/email/admission-schema.ts';
import { setProjectEmailLimits, setProjectEmailSuspended } from '../../src/email/admission.ts';
import { emailSharedRecipients } from '../../src/email/connection-schema.ts';
import {
  ensureSharedEmailConnection,
  resolveEmailDomain,
  runEmailOperation,
} from '../../src/email/connection-service.ts';
import type { ApiEnv } from '../../src/env.ts';
import app from '../../src/index.ts';
import { PROJECT_PERMISSION_MESSAGES } from '../../src/project-access.ts';
import {
  reconcileEmailDestinationCleanups,
  runEmailDestinationCleanup,
} from '../../src/provisioning/email-destination-cleanup.ts';
import {
  deployments,
  emailDestinationCleanups,
  emailDestinations,
  platformSettings,
  projectMembers,
  projects,
  users,
} from '../../src/schema.ts';
import { callsByTag, stubCustomerCf } from './email-domain-cf-stub.ts';
import {
  cfError,
  cfSuccess,
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  mockCfApi,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;

/**
 * The environment's platform mail zone. Staging's value on purpose: a test
 * that hard-coded production's would pass against a route that ignored the
 * var entirely.
 */
const MAIL_DOMAIN = 'mail.voidcloud.dev';
const EMAIL_GATEWAY_ORIGIN = 'https://void-email-gateway-staging.voidzer0.workers.dev';

type VerificationSend = {
  from: string;
  to: string;
  subject: string;
  text: string;
};

const verificationSends: Array<VerificationSend> = [];
let deliverVerification: () => void | Promise<void> = () => {};
const verificationEmailBinding = {
  send: vi.fn(async (message: VerificationSend) => {
    verificationSends.push(message);
    await deliverVerification();
  }),
};

/** Bindings with platform verification mail configured. */
function emailEnv(domain: string = MAIL_DOMAIN): TestEnv {
  return {
    ...env,
    EMAIL: verificationEmailBinding as unknown as SendEmail,
    EMAIL_GATEWAY_ORIGIN,
    EMAIL_SENDER_DOMAIN: domain,
  };
}

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  verificationSends.length = 0;
  verificationEmailBinding.send.mockClear();
  deliverVerification = () => {};
  await clearTables(env.db);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function listDestinations(projectId: string, jwt: string, bindings: TestEnv = env) {
  return app.fetch(
    new Request(`http://localhost/projects/${projectId}/email/destinations`, {
      headers: { Authorization: `Bearer ${jwt}` },
    }),
    bindings,
  );
}

async function addDestination(
  projectId: string,
  jwt: string,
  address: unknown,
  bindings: TestEnv = env,
): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost/projects/${projectId}/email/destinations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    }),
    bindings,
  );
}

async function removeDestination(
  projectId: string,
  destId: string,
  jwt: string,
  bindings: TestEnv = env,
): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost/projects/${projectId}/email/destinations/${destId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${jwt}` },
    }),
    bindings,
  );
}

function rowsFor(projectId: string) {
  return env.db.select().from(emailDestinations).where(eq(emailDestinations.project_id, projectId));
}

async function setUserEmail(userId: string, email: string): Promise<string> {
  await env.db.update(users).set({ email }).where(eq(users.id, userId));
  return email;
}

async function createProjectWithAdmin(label: string) {
  const owner = await createTestUser(env.db, `${label}-owner`);
  const admin = await createTestUser(env.db, `${label}-admin`);
  const project = await createTestProject(env.db, owner.id, `${label}-project`);
  await env.db.insert(projectMembers).values({
    project_id: project.id,
    user_id: admin.id,
    role: 'admin',
    added_by_user_id: owner.id,
  });
  return { owner, admin, project };
}

async function readVerifiedDestinations(projectId: string): Promise<Array<string>> {
  return (await rowsFor(projectId))
    .filter((row) => row.status === 'verified')
    .map((row) => row.address);
}

/** Two verified rows, the shape a live project has once both recipients confirmed. */
async function seedVerifiedPair(projectId: string): Promise<void> {
  await env.db.insert(emailDestinations).values([
    {
      id: 'edst_v1',
      project_id: projectId,
      address: 'keep@example.com',
      status: 'verified',
      cf_destination_id: 'cf-tag-keep',
      verified_at: '2026-04-29T00:00:00Z',
    },
    {
      id: 'edst_v2',
      project_id: projectId,
      address: 'gone@example.com',
      status: 'verified',
      cf_destination_id: 'cf-tag-gone',
      verified_at: '2026-04-29T00:00:00Z',
    },
  ]);
}

/** A CF list row for `address`, verified at `verified` (null = still pending). */
function cfRow(tag: string, email: string, verified: string | null) {
  return {
    tag,
    email,
    verified,
    created: '2026-04-25T00:00:00Z',
    modified: '2026-04-26T00:00:00Z',
  };
}

function cfCalls(
  fetchMock: ReturnType<typeof mockCfApi> | ReturnType<typeof vi.fn>,
  method: string,
  fragment: string,
): Array<Array<unknown>> {
  return (fetchMock.mock.calls as Array<Array<unknown>>).filter((call) => {
    const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
    const init = call[1] as RequestInit | undefined;
    return url.includes(fragment) && (init?.method ?? 'GET') === method;
  });
}

/** Configure the CF API mock and optional verification delivery behavior. */
function mockCfWithEmail(
  overrides: Parameters<typeof mockCfApi>[0] = {},
  deliver: () => void | Promise<void> = () => {},
): ReturnType<typeof vi.fn> {
  deliverVerification = deliver;
  return mockCfApi(overrides);
}

function recordedVerificationSends(): Array<VerificationSend> {
  return verificationSends;
}

/**
 * CF mock shaped for "the address is already on the account, verified by
 * someone". `addDestination` reports the conflict; recovery lists and finds it.
 */
function cfAlreadyVerified(tag: string, email: string) {
  return {
    addEmailDestination: () => cfError('address already exists'),
    listEmailDestinations: () => cfSuccess([cfRow(tag, email, '2026-04-26T00:00:00Z')]),
  };
}

// ---------------------------------------------------------------------------
// POST /projects/:id/email/destinations
// ---------------------------------------------------------------------------

describe('POST /projects/:id/email/destinations', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_x/email/destinations', { method: 'POST' }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown project', async () => {
    const user = await createTestUser(env.db);
    const res = await addDestination('proj_missing', user.jwt, 'a@b.com');
    expect(res.status).toBe(404);
  });

  it('returns 403 when the caller does not own the project', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const intruder = await createTestUser(env.db, 'intruder');
    const project = await createTestProject(env.db, owner.id);
    const fetchMock = mockCfApi();

    const res = await addDestination(project.id, intruder.jwt, 'a@b.com');

    expect(res.status).toBe(403);
    // The ownership check must run BEFORE anything reaches Cloudflare —
    // otherwise a stranger can register account-level addresses.
    expect(cfCalls(fetchMock, 'POST', '/email/routing/addresses')).toHaveLength(0);
    expect(await rowsFor(project.id)).toHaveLength(0);
  });

  it('rejects an add when the project admin is demoted during the provider call', async () => {
    const { owner, admin, project } = await createProjectWithAdmin('add-race');
    const fetchMock = mockCfApi({
      addEmailDestination: async () => {
        await dbModule.setProjectMemberRole(env.db, {
          projectId: project.id,
          subjectUserId: admin.id,
          role: 'collaborator',
          actorUserId: owner.id,
        });
        return cfSuccess(cfRow('cf-tag-add-race', 'race@example.com', null));
      },
    });

    const response = await addDestination(project.id, admin.jwt, 'race@example.com', emailEnv());

    expect(response.status).toBe(403);
    expect(await rowsFor(project.id)).toHaveLength(0);
    expect(recordedVerificationSends()).toHaveLength(0);
    expect(cfCalls(fetchMock, 'DELETE', '/email/routing/addresses/')).toHaveLength(1);
  });

  it('does not resend verification after the project admin is demoted', async () => {
    const { owner, admin, project } = await createProjectWithAdmin('resend-race');
    await env.db.insert(emailDestinations).values({
      id: 'edst_resend_race',
      project_id: project.id,
      address: 'race@example.com',
      status: 'pending',
      cf_destination_id: 'cf-tag-resend-race',
      verification_source: 'platform',
    });
    mockCfApi();
    const getDestination = dbModule.getEmailDestinationByAddress;
    vi.spyOn(dbModule, 'getEmailDestinationByAddress').mockImplementationOnce(async (...args) => {
      const destination = await getDestination(...args);
      await dbModule.setProjectMemberRole(env.db, {
        projectId: project.id,
        subjectUserId: admin.id,
        role: 'collaborator',
        actorUserId: owner.id,
      });
      return destination;
    });

    const response = await addDestination(project.id, admin.jwt, 'race@example.com', emailEnv());

    expect(response.status).toBe(403);
    expect(recordedVerificationSends()).toHaveLength(0);
    expect(await rowsFor(project.id)).toHaveLength(1);
  });

  it('returns 409 once the project is being torn down', async () => {
    // Teardown snapshots the CF destination tags it has to clean up ONCE. A
    // destination registered after that snapshot but before the cascade drops
    // our rows leaves an account-level CF handle nothing can find again.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));
    const fetchMock = mockCfApi();

    const res = await addDestination(project.id, user.jwt, 'late@example.com');

    expect(res.status).toBe(409);
    expect(cfCalls(fetchMock, 'POST', '/email/routing/addresses')).toHaveLength(0);
    expect(await rowsFor(project.id)).toHaveLength(0);
  });

  it('returns 400 for an invalid email', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    mockCfApi();
    const res = await addDestination(project.id, user.jwt, 'not-an-email');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid address' });
  });

  it('returns 400 for a malformed JSON body rather than a 500', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    mockCfApi();
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/email/destinations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: '{not json',
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects an over-long address before the rate limiter, CF, or the database see it', async () => {
    // The loose regex accepts any length, so only the cap keeps a 100 KB
    // address away from CF and the database. RFC 5321 bounds a deliverable
    // address at 256 octets; the cap is the proxy's 320.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const fetchMock = mockCfApi();
    const putSpy = vi.spyOn(env.ROUTING, 'put');

    const res = await addDestination(project.id, user.jwt, `${'a'.repeat(100 * 1024)}@example.com`);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid address' });
    expect(cfCalls(fetchMock, 'POST', '/email/routing/addresses')).toHaveLength(0);
    expect(await rowsFor(project.id)).toHaveLength(0);
    // A 400 must not charge the per-project add budget either way, but the
    // point of the cap is that the rejection happens ahead of the limiter.
    expect(
      putSpy.mock.calls.filter(([key]) => String(key).startsWith('email-add-rate:')),
    ).toHaveLength(0);

    // Exact boundary: 320 characters is still deliverable and goes through.
    const atCap = await addDestination(project.id, user.jwt, `${'a'.repeat(308)}@example.com`);
    expect(atCap.status).toBe(201);
    const overCap = await addDestination(project.id, user.jwt, `${'a'.repeat(309)}@example.com`);
    expect(overCap.status).toBe(400);
    expect(cfCalls(fetchMock, 'POST', '/email/routing/addresses')).toHaveLength(1);
  });

  it('bounds a crafted address before the regex can backtrack on it', async () => {
    // `isValidEmail` is quadratic on `a@` + `b.`x N + ` x`: every `.` is a
    // candidate for the literal `\.`, and the inner space defeats `$` on each
    // retry. At 160 KB that is seconds of CPU per request, all of it ahead
    // of the rate limiter. The regex alone rejects this input too, so the
    // status cannot tell the two orders apart — the elapsed time can.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    mockCfApi();

    const startedAt = Date.now();
    const res = await addDestination(project.id, user.jwt, `a@${'b.'.repeat(80_000)} x`);

    expect(res.status).toBe(400);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it('creates a pending row and calls CF on the first add', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const fetchMock = mockCfApi();

    const res = await addDestination(project.id, user.jwt, 'Owner@Example.com');

    expect(res.status).toBe(201);
    const body = (await res.json()) as { address: string; status: string };
    // Address is lowercased on insert.
    expect(body.address).toBe('owner@example.com');
    expect(body.status).toBe('pending');

    const rows = await rowsFor(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cf_destination_id).toBe('cf-tag-owner@example.com');
    expect(rows[0]?.verification_source).toBe('cf');
    expect(cfCalls(fetchMock, 'POST', '/email/routing/addresses')).toHaveLength(1);
  });

  it('returns the existing row without calling CF when the address is already in the DB', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    // Email binding and sender configured, so a platform send COULD
    // happen here — the assertion below is that it does not.
    const fetchMock = mockCfWithEmail();

    const first = await addDestination(project.id, user.jwt, 'a@b.com', emailEnv());
    expect(first.status).toBe(201);
    // CF created the address for this request and is mailing the link: the
    // "nothing sent" marker must NOT appear on a real create.
    expect((await first.json()) as { verificationSent?: boolean }).not.toHaveProperty(
      'verificationSent',
    );

    const second = await addDestination(project.id, user.jwt, 'a@b.com', emailEnv());
    expect(second.status).toBe(200);
    expect(((await second.json()) as { verificationSent?: boolean }).verificationSent).toBe(false);

    // CF is touched once — the duplicate is fully short-circuited, so the
    // recipient gets one verification email rather than one per click.
    expect(cfCalls(fetchMock, 'POST', '/email/routing/addresses')).toHaveLength(1);
    expect(await rowsFor(project.id)).toHaveLength(1);
    // A CF-pending row waits on CLOUDFLARE's link, which CF mails on create
    // only — there is nothing for the platform to resend.
    expect(recordedVerificationSends()).toHaveLength(0);
  });

  it('recovers via list when CF reports "already exists"', async () => {
    // The address does not match the owner's email (the fixture leaves it
    // null), so CF's verified flag cannot be inherited: Option B applies and
    // the row lands platform-pending.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    mockCfWithEmail(cfAlreadyVerified('recovered-tag', 'shared@example.com'));

    const res = await addDestination(project.id, user.jwt, 'shared@example.com', emailEnv());
    expect(res.status).toBe(201);

    const rows = await rowsFor(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cf_destination_id).toBe('recovered-tag');
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.verification_source).toBe('platform');
    expect(recordedVerificationSends()).toHaveLength(1);
  });

  it('returns 502 when CF fails for any reason other than "already exists"', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    mockCfApi({ addEmailDestination: () => cfError('Authentication error', 401) });

    const res = await addDestination(project.id, user.jwt, 'a@b.com');

    expect(res.status).toBe(502);
    // No row: a destination we could not register with CF would be a
    // permanently-pending entry the recipient can never confirm.
    expect(await rowsFor(project.id)).toHaveLength(0);
  });

  it('returns 502 when CF claims the address exists but the list does not contain it', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    mockCfApi({
      addEmailDestination: () => cfError('address already exists'),
      listEmailDestinations: () => cfSuccess([]),
    });

    const res = await addDestination(project.id, user.jwt, 'ghost@example.com');
    expect(res.status).toBe(502);
    expect(await rowsFor(project.id)).toHaveLength(0);
  });

  it('rate-limits to 5 adds per minute', async () => {
    // Keep all six requests in one minute bucket even when the test crosses
    // a wall-clock minute.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    try {
      mockCfApi();
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id);

      for (let i = 0; i < 5; i++) {
        const res = await addDestination(project.id, user.jwt, `r${i}@example.com`);
        expect(res.status).toBe(201);
      }

      const res = await addDestination(project.id, user.jwt, 'r5@example.com');
      expect(res.status).toBe(429);
      expect((await res.json()) as { error: string }).toEqual({
        error: expect.stringMatching(/per minute|limit/i),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rate-limits to 50 adds per day', async () => {
    // Pre-seed the day counter rather than firing 50 requests. The reader is
    // NaN-poison-resistant, so any non-negative integer string counts.
    mockCfApi();
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const now = new Date();
    const dayBucket = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
    await env.ROUTING.put(`email-add-rate:${project.id}:${dayBucket}`, '50');

    const res = await addDestination(project.id, user.jwt, 'over-the-cap@example.com');
    expect(res.status).toBe(429);
    expect((await res.json()) as { error: string }).toEqual({
      error: expect.stringMatching(/today|day/i),
    });
  });
});

// ---------------------------------------------------------------------------
// GET /projects/:id/email/destinations
// ---------------------------------------------------------------------------

describe('GET /projects/:id/email/destinations', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_x/email/destinations'),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown project', async () => {
    const user = await createTestUser(env.db);
    const res = await listDestinations('proj_missing', user.jwt);
    expect(res.status).toBe(404);
  });

  it("returns 403 and leaks nothing for another user's project", async () => {
    const owner = await createTestUser(env.db, 'owner');
    const intruder = await createTestUser(env.db, 'intruder');
    const project = await createTestProject(env.db, owner.id);
    await env.db.insert(emailDestinations).values({
      id: 'edst_secret',
      project_id: project.id,
      address: 'secret@example.com',
      status: 'verified',
      cf_destination_id: 'cf-tag-secret',
      verified_at: '2026-04-29T00:00:00Z',
    });
    mockCfApi();

    const res = await listDestinations(project.id, intruder.jwt);

    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('secret@example.com');
  });

  it('requires settings access to list destination addresses', async () => {
    const owner = await createTestUser(env.db, 'destination-roles-owner');
    const collaborator = await createTestUser(env.db, 'destination-roles-collaborator');
    const admin = await createTestUser(env.db, 'destination-roles-admin');
    const project = await createTestProject(env.db, owner.id, 'destination-roles-project');
    await env.db.insert(projectMembers).values([
      {
        project_id: project.id,
        user_id: collaborator.id,
        role: 'collaborator',
        added_by_user_id: owner.id,
      },
      {
        project_id: project.id,
        user_id: admin.id,
        role: 'admin',
        added_by_user_id: owner.id,
      },
    ]);
    await env.db.insert(emailDestinations).values({
      id: 'edst_role_private',
      project_id: project.id,
      address: 'private@example.com',
      status: 'verified',
      cf_destination_id: 'cf-tag-role-private',
      verified_at: '2026-04-29T00:00:00Z',
    });

    const denied = await listDestinations(project.id, collaborator.jwt);
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain('private@example.com');

    const allowed = await listDestinations(project.id, admin.jwt);
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain('private@example.com');
  });

  it('refreshes pending rows that CF now reports verified', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    mockCfApi();
    await addDestination(project.id, user.jwt, 'pending@example.com');

    mockCfApi({
      listEmailDestinations: () =>
        cfSuccess([
          cfRow('cf-tag-pending@example.com', 'pending@example.com', '2026-04-27T01:00:00Z'),
        ]),
    });

    const res = await listDestinations(project.id, user.jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ address: string; status: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.status).toBe('verified');

    const rows = await rowsFor(project.id);
    expect(rows[0]?.status).toBe('verified');
    expect(rows[0]?.verified_at).toBeTruthy();
  });

  it('still returns the cached view when the CF list call fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    mockCfApi();
    await addDestination(project.id, user.jwt, 'a@b.com');

    mockCfApi({ listEmailDestinations: () => cfError('CF down', 503) });

    const res = await listDestinations(project.id, user.jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ address: string; status: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.status).toBe('pending');
  });

  it('skips CF refresh for platform-pending rows', async () => {
    // CF says verified — a DIFFERENT project earned that. The per-project
    // consent gate is our own confirmation click, so the refresh must not
    // flip this row or the whole Option B path is bypassable.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await env.db.insert(emailDestinations).values({
      id: 'edst_platform_pending',
      project_id: project.id,
      address: 'shared@example.com',
      status: 'pending',
      cf_destination_id: 'cf-tag-shared',
      verified_at: null,
      verification_source: 'platform',
    });

    mockCfApi({
      listEmailDestinations: () =>
        cfSuccess([cfRow('cf-tag-shared', 'shared@example.com', '2026-04-29T00:00:00Z')]),
    });

    const res = await listDestinations(project.id, user.jwt);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ status: string; verification_source: string }>;
    expect(list[0]?.status).toBe('pending');
    expect(list[0]?.verification_source).toBe('platform');
    expect(await readVerifiedDestinations(project.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET refresh: the row's Cloudflare destination was deleted and recreated
// ---------------------------------------------------------------------------

describe('GET refresh against a recreated Cloudflare destination', () => {
  /**
   * The state this sequence ends in, built through the routes:
   *
   *   1. project A registers `alice` first on the account — a fresh CF
   *      create, so A waits on CLOUDFLARE's link (`pending` / `cf`, tag T1).
   *   2. T1 is deleted at Cloudflare (an operator in the dashboard, or the
   *      delete-vs-register window the DELETE route names). A's row keeps T1.
   *   3. project B registers `alice` — the address is off the account again,
   *      so CF creates T2 and mails alice a link that names no project.
   *   4. alice clicks it. CF now lists `alice` verified under T2.
   *
   * Returns both projects' rows plus the fetch mock, with CF's list already
   * reporting T2 verified.
   */
  async function recreatedDestination(options: {
    ownerA: { id: string; jwt: string };
    ownerB: { id: string; jwt: string };
    address: string;
  }) {
    const projectA = await createTestProject(env.db, options.ownerA.id, 'email-a');
    const projectB = await createTestProject(env.db, options.ownerB.id, 'email-b');
    const tagT1 = `cf-tag-${options.address}`;
    const tagT2 = 'cf-tag-recreated';
    // Cloudflare's view, driven by the steps above. Each create hands out
    // the next tag: step 1 gets T1, step 3 gets T2.
    let onAccount: ReturnType<typeof cfRow> | null = null;
    const unissued = [tagT1, tagT2];
    const fetchMock = mockCfWithEmail({
      addEmailDestination: (_url, init) => {
        if (onAccount) {
          return cfError('address already exists');
        }
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        onAccount = cfRow(unissued.shift()!, body.email, null);
        return cfSuccess(onAccount);
      },
      listEmailDestinations: () => cfSuccess(onAccount ? [onAccount] : []),
      deleteEmailDestination: (url) => {
        const tag = url.split('/').pop()?.split('?')[0] ?? '';
        if (onAccount?.tag !== tag) {
          return cfError('destination not found', 404);
        }
        onAccount = null;
        return cfSuccess({ tag });
      },
    });

    // 1. A registers first: fresh create, T1.
    const addedA = await addDestination(
      projectA.id,
      options.ownerA.jwt,
      options.address,
      emailEnv(),
    );
    expect(addedA.status).toBe(201);
    const rowA = (await addedA.json()) as {
      id: string;
      status: string;
      verification_source: string;
    };
    expect(rowA.status).toBe('pending');
    expect(rowA.verification_source).toBe('cf');
    expect((await rowsFor(projectA.id))[0]?.cf_destination_id).toBe(tagT1);

    // 2. T1 disappears at Cloudflare; A's row still points at it.
    onAccount = null;

    // 3. B registers: the address is off the account, so CF creates T2 and
    //    mails alice. B waits on that link.
    const addedB = await addDestination(
      projectB.id,
      options.ownerB.jwt,
      options.address,
      emailEnv(),
    );
    expect(addedB.status).toBe(201);
    const rowB = (await addedB.json()) as {
      id: string;
      status: string;
      verification_source: string;
    };
    expect(rowB.status).toBe('pending');
    expect(rowB.verification_source).toBe('cf');
    expect((await rowsFor(projectB.id))[0]?.cf_destination_id).toBe(tagT2);
    expect(recordedVerificationSends()).toHaveLength(0);

    // 4. alice clicks CF's link.
    onAccount = cfRow(tagT2, options.address, '2026-09-15T00:00:00Z');

    return { projectA, projectB, rowA, rowB, tagT1, tagT2, fetchMock };
  }

  it("does not promote another project's pending CF row off the recreated tag's click", async () => {
    // Under the normal order B would have hit Option B — alice was already
    // verified at CF, so B gets the platform's per-project link — and A's
    // own CF link is the only thing that verifies A. The recreated tag
    // inverts that: the click was for the destination B registered, and
    // matching by address alone hands that consent to A too.
    const owner = await createTestUser(env.db, 'owner');
    await setUserEmail(owner.id, 'owner@example.com');
    const { projectA, projectB, rowA, tagT1, tagT2 } = await recreatedDestination({
      ownerA: owner,
      ownerB: owner,
      address: 'alice@example.com',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // B registered T2: the click is B's.
    const listedB = await listDestinations(projectB.id, owner.jwt, emailEnv());
    expect(listedB.status).toBe(200);
    const bodyB = (await listedB.json()) as Array<{ status: string }>;
    expect(bodyB[0]?.status).toBe('verified');
    expect(await readVerifiedDestinations(projectB.id)).toEqual(['alice@example.com']);

    // A registered T1, which nobody clicked: it stays pending, off the
    // allowlist, and says why once.
    const listedA = await listDestinations(projectA.id, owner.jwt, emailEnv());
    expect(listedA.status).toBe(200);
    const bodyA = (await listedA.json()) as Array<{ status: string; verification_source: string }>;
    expect(bodyA).toHaveLength(1);
    expect(bodyA[0]?.status).toBe('pending');
    expect(bodyA[0]?.verification_source).toBe('cf');
    expect(await readVerifiedDestinations(projectA.id)).toEqual([]);
    const persisted = (await rowsFor(projectA.id))[0];
    expect(persisted?.status).toBe('pending');
    expect(persisted?.cf_destination_id).toBe(tagT1);
    expect(persisted?.verified_by_user_id).toBeNull();
    const mismatchLines = warnSpy.mock.calls.filter((call) =>
      String(call[0]).includes('[email] destination tag mismatch'),
    );
    expect(mismatchLines).toHaveLength(1);
    expect(String(mismatchLines[0]![0])).toContain(rowA.id);
    expect(String(mismatchLines[0]![0])).toContain(tagT1);
    expect(String(mismatchLines[0]![0])).toContain(tagT2);
  });

  it("adopts the recreated tag for the project owner's OWN address, with the inherited-consent audit", async () => {
    // Option C: the owner is the human who clicked, whichever registration
    // CF's mail answered. Same rule the auto-add applies when it inherits a
    // CF-verified owner address, audit columns included.
    const owner = await createTestUser(env.db, 'owner');
    await setUserEmail(owner.id, 'owner@example.com');
    const other = await createTestUser(env.db, 'other');
    await setUserEmail(other.id, 'other@example.com');
    const { projectA, tagT2 } = await recreatedDestination({
      ownerA: owner,
      ownerB: other,
      address: 'owner@example.com',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const listedA = await listDestinations(projectA.id, owner.jwt, emailEnv());
    expect(listedA.status).toBe(200);
    const bodyA = (await listedA.json()) as Array<{ status: string; verification_source: string }>;
    expect(bodyA[0]?.status).toBe('verified');
    expect(bodyA[0]?.verification_source).toBe('cf');
    expect(await readVerifiedDestinations(projectA.id)).toEqual(['owner@example.com']);
    const persisted = (await rowsFor(projectA.id))[0];
    expect(persisted?.status).toBe('verified');
    expect(persisted?.cf_destination_id).toBe(tagT2);
    // CF's click time, not now() — Postgres renders the string its own way.
    expect(persisted?.verified_at).toMatch(/^2026-09-15/);
    expect(persisted?.verified_by_user_id).toBe(owner.id);
    expect(persisted?.verified_by_email_snapshot).toBe('owner@example.com');
    expect(
      warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes('[email] destination tag mismatch'),
      ),
    ).toHaveLength(0);
  });

  it('disallow + allow on the stale row takes the platform link, because the address is now CF-verified', async () => {
    // The recipe the log line points at. DELETE finds T1 gone at CF (404,
    // caught) and drops the row; the re-add recovers T2, which is verified
    // by someone else's registration, so it is Option B — the per-project
    // link the normal order would have given A in the first place.
    const owner = await createTestUser(env.db, 'owner');
    await setUserEmail(owner.id, 'owner@example.com');
    const { projectA, rowA, tagT1, tagT2, fetchMock } = await recreatedDestination({
      ownerA: owner,
      ownerB: owner,
      address: 'alice@example.com',
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const removed = await removeDestination(projectA.id, rowA.id, owner.jwt, emailEnv());
    expect(removed.status).toBe(200);
    const deletes = cfCalls(fetchMock, 'DELETE', '/email/routing/addresses');
    expect(deletes).toHaveLength(1);
    expect(String(deletes[0]![0])).toContain(tagT1);
    expect(await rowsFor(projectA.id)).toHaveLength(0);

    const readded = await addDestination(projectA.id, owner.jwt, 'alice@example.com', emailEnv());
    expect(readded.status).toBe(201);
    const body = (await readded.json()) as {
      status: string;
      verification_source: string;
      platformVerificationPending?: boolean;
    };
    expect(body.status).toBe('pending');
    expect(body.verification_source).toBe('platform');
    expect(body.platformVerificationPending).toBe(true);
    const sends = recordedVerificationSends();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toBe('alice@example.com');
    expect((await rowsFor(projectA.id))[0]?.cf_destination_id).toBe(tagT2);

    // And the refresh keeps its hands off a platform-pending row.
    const listed = await listDestinations(projectA.id, owner.jwt, emailEnv());
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as Array<{ status: string }>)[0]?.status).toBe('pending');
    expect(await readVerifiedDestinations(projectA.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DELETE /projects/:id/email/destinations/:destId
// ---------------------------------------------------------------------------

describe('DELETE /projects/:id/email/destinations/:destId', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_x/email/destinations/edst_x', {
        method: 'DELETE',
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 and keeps the row for another user's project", async () => {
    const owner = await createTestUser(env.db, 'owner');
    const intruder = await createTestUser(env.db, 'intruder');
    const project = await createTestProject(env.db, owner.id);
    mockCfApi();
    const created = await addDestination(project.id, owner.jwt, 'a@b.com');
    const dest = (await created.json()) as { id: string };

    const res = await removeDestination(project.id, dest.id, intruder.jwt);

    expect(res.status).toBe(403);
    expect(await rowsFor(project.id)).toHaveLength(1);
  });

  it('keeps the destination when the project admin is demoted before the locked delete', async () => {
    const { owner, admin, project } = await createProjectWithAdmin('delete-race');
    await env.db.insert(emailDestinations).values({
      id: 'edst_delete_race',
      project_id: project.id,
      address: 'race@example.com',
      status: 'verified',
      cf_destination_id: 'cf-tag-delete-race',
      verification_source: 'platform',
    });
    const fetchMock = mockCfApi();
    const getDestinations = dbModule.getEmailDestinationsByProjectId;
    vi.spyOn(dbModule, 'getEmailDestinationsByProjectId').mockImplementationOnce(
      async (...args) => {
        const destinations = await getDestinations(...args);
        await dbModule.setProjectMemberRole(env.db, {
          projectId: project.id,
          subjectUserId: admin.id,
          role: 'collaborator',
          actorUserId: owner.id,
        });
        return destinations;
      },
    );

    const response = await removeDestination(project.id, 'edst_delete_race', admin.jwt, emailEnv());

    expect(response.status).toBe(403);
    expect(await rowsFor(project.id)).toHaveLength(1);
    expect(cfCalls(fetchMock, 'DELETE', '/email/routing/addresses/')).toHaveLength(0);
  });

  it('returns 409 once the project is being torn down', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    mockCfApi();
    const created = await addDestination(project.id, user.jwt, 'a@b.com');
    const dest = (await created.json()) as { id: string };
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));

    const res = await removeDestination(project.id, dest.id, user.jwt);

    expect(res.status).toBe(409);
    expect(await rowsFor(project.id)).toHaveLength(1);
  });

  it('returns 404 for an unknown destination', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    mockCfApi();
    const res = await removeDestination(project.id, 'missing-id', user.jwt);
    expect(res.status).toBe(404);
  });

  it('returns 404 when the destination belongs to another project', async () => {
    const user = await createTestUser(env.db);
    const projectA = await createTestProject(env.db, user.id, 'project-a');
    const projectB = await createTestProject(env.db, user.id, 'project-b');
    mockCfApi();

    const created = await addDestination(projectA.id, user.jwt, 'a@b.com');
    const dest = (await created.json()) as { id: string };

    // Same owner, wrong project in the path — must 404, not delete.
    const res = await removeDestination(projectB.id, dest.id, user.jwt);
    expect(res.status).toBe(404);

    const rows = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.id, dest.id));
    expect(rows).toHaveLength(1);
  });

  it('deletes from CF when no other project references the tag', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const fetchMock = mockCfApi();

    const created = await addDestination(project.id, user.jwt, 'a@b.com');
    const dest = (await created.json()) as { id: string };

    const res = await removeDestination(project.id, dest.id, user.jwt);
    expect(res.status).toBe(200);

    expect(cfCalls(fetchMock, 'DELETE', '/email/routing/addresses/')).toHaveLength(1);
    expect(await rowsFor(project.id)).toHaveLength(0);
  });

  it('skips the CF delete while another project still references the tag', async () => {
    // Destinations are ACCOUNT-level on Cloudflare. Deleting the CF address
    // because one project dropped it would silently break every sibling
    // project that still has it verified.
    const user = await createTestUser(env.db);
    const projectA = await createTestProject(env.db, user.id, 'project-a');
    const projectB = await createTestProject(env.db, user.id, 'project-b');
    const fetchMock = mockCfApi();

    for (const p of [projectA, projectB]) {
      const res = await addDestination(p.id, user.jwt, 'shared@example.com');
      expect(res.status).toBe(201);
    }

    const aRows = await rowsFor(projectA.id);
    expect(aRows[0]?.cf_destination_id).toBe('cf-tag-shared@example.com');

    const res = await removeDestination(projectA.id, aRows[0]!.id, user.jwt);
    expect(res.status).toBe(200);

    expect(cfCalls(fetchMock, 'DELETE', '/email/routing/addresses/')).toHaveLength(0);
    expect(await rowsFor(projectA.id)).toHaveLength(0);
    expect(await rowsFor(projectB.id)).toHaveLength(1);
  });

  it('revokes consent immediately and retries failed provider cleanup from a durable tag', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    mockCfApi();
    const created = await addDestination(project.id, user.jwt, 'a@b.com');
    const dest = (await created.json()) as { id: string };

    mockCfApi({ deleteEmailDestination: () => cfError('CF outage', 500) });

    const res = await removeDestination(project.id, dest.id, user.jwt);
    expect(res.status).toBe(200);

    const rows = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.id, dest.id));
    expect(rows).toHaveLength(0);
    expect(await env.db.select().from(emailDestinationCleanups)).toEqual([
      expect.objectContaining({
        cf_destination_id: 'cf-tag-a@b.com',
        status: 'pending',
        attempts: 1,
      }),
    ]);

    mockCfApi();
    await reconcileEmailDestinationCleanups(
      env.db,
      { accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN },
      10,
      new Date(Date.now() + 2 * 60 * 60_000),
    );
    expect(await env.db.select().from(emailDestinationCleanups)).toEqual([
      expect.objectContaining({
        cf_destination_id: 'cf-tag-a@b.com',
        status: 'completed',
        attempts: 2,
      }),
    ]);
  });

  it('refuses a stale provider tag after its cleanup completed', async () => {
    const user = await createTestUser(env.db);
    const first = await createTestProject(env.db, user.id, 'first-tag-owner');
    const second = await createTestProject(env.db, user.id, 'second-tag-owner');
    mockCfApi();
    const created = await addDestination(first.id, user.jwt, 'stale@example.com');
    const destination = (await created.json()) as { id: string };
    expect((await removeDestination(first.id, destination.id, user.jwt)).status).toBe(200);

    mockCfApi({
      addEmailDestination: () => cfError('address already exists'),
      listEmailDestinations: () =>
        cfSuccess([
          {
            tag: 'cf-tag-stale@example.com',
            email: 'stale@example.com',
            verified: '2026-09-01T00:00:00Z',
            created: '2026-09-01T00:00:00Z',
            modified: '2026-09-01T00:00:00Z',
          },
        ]),
    });
    const stale = await addDestination(second.id, user.jwt, 'stale@example.com', emailEnv());
    expect(stale.status).toBe(409);
    expect(await rowsFor(second.id)).toHaveLength(0);
  });

  it('fences a sibling add that recovers the tag while provider deletion is in flight', async () => {
    const user = await createTestUser(env.db);
    const deleting = await createTestProject(env.db, user.id, 'deleting-tag-owner');
    const sibling = await createTestProject(env.db, user.id, 'sibling-tag-owner');
    mockCfApi();
    const created = await addDestination(deleting.id, user.jwt, 'racing@example.com');
    const destination = (await created.json()) as { id: string };

    let siblingStatus: number | undefined;
    mockCfApi({
      addEmailDestination: () => cfError('address already exists'),
      listEmailDestinations: () =>
        cfSuccess([
          {
            tag: 'cf-tag-racing@example.com',
            email: 'racing@example.com',
            verified: '2026-09-01T00:00:00Z',
            created: '2026-09-01T00:00:00Z',
            modified: '2026-09-01T00:00:00Z',
          },
        ]),
      deleteEmailDestination: async () => {
        siblingStatus = (
          await addDestination(sibling.id, user.jwt, 'racing@example.com', emailEnv())
        ).status;
        return cfSuccess({ tag: 'cf-tag-racing@example.com' });
      },
    });

    expect((await removeDestination(deleting.id, destination.id, user.jwt)).status).toBe(200);
    expect(siblingStatus).toBe(409);
    expect(await rowsFor(sibling.id)).toHaveLength(0);
    expect(await env.db.select().from(emailDestinationCleanups)).toEqual([
      expect.objectContaining({
        cf_destination_id: 'cf-tag-racing@example.com',
        status: 'completed',
      }),
    ]);
  });

  it('does not let an expired cleanup attempt overwrite a newer completion', async () => {
    await env.db
      .insert(emailDestinationCleanups)
      .values({ cf_destination_id: 'cf-tag-expired-lease' });
    let rejectFirst: ((error: Error) => void) | undefined;
    let reachedFirst: (() => void) | undefined;
    const firstReached = new Promise<void>((resolve) => {
      reachedFirst = resolve;
    });
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      if (calls === 1) {
        reachedFirst?.();
        return new Promise<Response>((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      return cfSuccess({ tag: 'cf-tag-expired-lease' });
    });
    const startedAt = new Date();
    const first = runEmailDestinationCleanup(
      env.db,
      { accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN },
      'cf-tag-expired-lease',
      startedAt,
    );
    await firstReached;
    await runEmailDestinationCleanup(
      env.db,
      { accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN },
      'cf-tag-expired-lease',
      new Date(startedAt.getTime() + 6 * 60_000),
    );
    rejectFirst?.(new Error('late timeout'));
    await first;
    expect(await env.db.select().from(emailDestinationCleanups)).toEqual([
      expect.objectContaining({ status: 'completed', attempts: 2 }),
    ]);
  });
});

describe('per-project verification (Option C + Option B)', () => {
  it("Option C: the owner's own CF-verified address is inherited, with no platform email", async () => {
    const user = await createTestUser(env.db);
    await setUserEmail(user.id, 'owner@example.com');
    const project = await createTestProject(env.db, user.id);
    mockCfWithEmail(cfAlreadyVerified('cf-tag-owner', 'owner@example.com'));

    const res = await addDestination(project.id, user.jwt, 'owner@example.com', emailEnv());

    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string; verification_source: string };
    expect(body.status).toBe('verified');
    expect(body.verification_source).toBe('cf');

    expect(await readVerifiedDestinations(project.id)).toEqual(['owner@example.com']);
    // No platform-side confirmation mail — that is the Option B path only.
    expect(recordedVerificationSends()).toHaveLength(0);
  });

  it('Option C: records who consented and which address they used', async () => {
    // The audit columns are what makes an inherited consent revocable when
    // the granter's identity later changes.
    const user = await createTestUser(env.db);
    await setUserEmail(user.id, 'owner@example.com');
    const project = await createTestProject(env.db, user.id);
    mockCfApi(cfAlreadyVerified('cf-tag-owner', 'owner@example.com'));

    const res = await addDestination(project.id, user.jwt, 'owner@example.com', emailEnv());
    expect(res.status).toBe(201);

    const rows = await rowsFor(project.id);
    expect(rows[0]?.status).toBe('verified');
    expect(rows[0]?.verification_source).toBe('cf');
    expect(rows[0]?.verified_by_user_id).toBe(user.id);
    expect(rows[0]?.verified_by_email_snapshot).toBe('owner@example.com');
  });

  it('Option B: a non-owner CF-verified address stays pending, mails a link, and is NOT allow-listed', async () => {
    const user = await createTestUser(env.db);
    await setUserEmail(user.id, 'owner@example.com');
    const project = await createTestProject(env.db, user.id);
    mockCfWithEmail(cfAlreadyVerified('cf-tag-shared', 'shared@example.com'));

    const res = await addDestination(project.id, user.jwt, 'shared@example.com', emailEnv());
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      status: string;
      verification_source: string;
      platformVerificationPending?: boolean;
    };
    expect(body.status).toBe('pending');
    expect(body.verification_source).toBe('platform');
    expect(body.platformVerificationPending).toBe(true);

    // Still pending, so SQL admission must refuse sends to it.
    expect(await readVerifiedDestinations(project.id)).toEqual([]);

    const sends = recordedVerificationSends();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toBe('shared@example.com');
    // The sender is derived from the CONFIGURED domain, never a literal.
    expect(sends[0]!.from).toBe(`noreply@${MAIL_DOMAIN}`);
    expect(sends[0]!.text).toContain('/email/destinations/confirm?token=');
  });

  it('Option B: does NOT populate the audit columns (consent was per-recipient)', async () => {
    const user = await createTestUser(env.db);
    await setUserEmail(user.id, 'owner@example.com');
    const project = await createTestProject(env.db, user.id);
    mockCfWithEmail(cfAlreadyVerified('cf-tag-shared', 'shared@example.com'));

    const res = await addDestination(project.id, user.jwt, 'shared@example.com', emailEnv());
    expect(res.status).toBe(201);

    const rows = await rowsFor(project.id);
    expect(rows[0]?.verification_source).toBe('platform');
    // Nothing was inherited, so there is no identity to revoke later.
    expect(rows[0]?.verified_by_user_id).toBeNull();
    expect(rows[0]?.verified_by_email_snapshot).toBeNull();
  });

  it("Option B: an account-level row that is still PENDING must not inherit the other project's click", async () => {
    // The address is already on the CF account because ANOTHER project added
    // it, and that recipient has not clicked CF's link yet. CF refuses our
    // create, so CF mails nobody for THIS project — `verified: null` here
    // means "someone else's unclicked link", not "a link is on its way".
    // Without platform verification the row would wait on a link that does
    // not exist, and the GET refresh (which matches BY ADDRESS) would flip it
    // the moment the recipient consented to the OTHER project.
    const user = await createTestUser(env.db);
    await setUserEmail(user.id, 'owner@example.com');
    const project = await createTestProject(env.db, user.id);
    let cfVerifiedAt: string | null = null;
    mockCfWithEmail({
      addEmailDestination: () => cfError('address already exists'),
      listEmailDestinations: () =>
        cfSuccess([cfRow('cf-tag-shared', 'shared@example.com', cfVerifiedAt)]),
    });

    const res = await addDestination(project.id, user.jwt, 'shared@example.com', emailEnv());
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      status: string;
      verification_source: string;
      platformVerificationPending?: boolean;
    };
    expect(body.status).toBe('pending');
    expect(body.verification_source).toBe('platform');
    expect(body.platformVerificationPending).toBe(true);

    // Our own link is the only one the recipient can receive for this project.
    const sends = recordedVerificationSends();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toBe('shared@example.com');

    // The recipient now clicks the link CF sent for the OTHER project. That
    // consent is not ours to claim: the row stays pending and the proxy keeps
    // refusing sends.
    cfVerifiedAt = '2026-04-28T00:00:00Z';
    const listed = await listDestinations(project.id, user.jwt, emailEnv());
    expect(listed.status).toBe(200);
    const rows = (await listed.json()) as Array<{ status: string; verification_source: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.verification_source).toBe('platform');
    expect(await readVerifiedDestinations(project.id)).toEqual([]);
  });

  it("owner's own address already on the account and still PENDING: adopted, and reported as no send", async () => {
    // CF holds the owner's address from an earlier add (their first project's
    // auto-add, or a hand add) and the owner never clicked. CF refuses this
    // create, and it mails its link on create only — so this add sends
    // nothing, and the row waits on the link from the FIRST add. The 201 is
    // real (the project's row is new) but must not read as "a link went
    // out": `void email allow` prints "Verification email sent" from a bare
    // 201.
    const user = await createTestUser(env.db);
    await setUserEmail(user.id, 'owner@example.com');
    const project = await createTestProject(env.db, user.id);
    mockCfWithEmail({
      addEmailDestination: () => cfError('address already exists'),
      listEmailDestinations: () => cfSuccess([cfRow('cf-tag-owner', 'owner@example.com', null)]),
    });

    const res = await addDestination(project.id, user.jwt, 'owner@example.com', emailEnv());
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      status: string;
      verification_source: string;
      verificationSent?: boolean;
      platformVerificationPending?: boolean;
    };
    expect(body.status).toBe('pending');
    // Not Option B: the owner's own address needs no per-project consent,
    // and CF's click is the one that unlocks the send binding.
    expect(body.verification_source).toBe('cf');
    expect(body.platformVerificationPending).toBeUndefined();
    expect(body.verificationSent).toBe(false);

    // Nothing went out: CF refused, and the platform has no link of its own
    // to mail for a CF-pending owner row.
    expect(recordedVerificationSends()).toHaveLength(0);
    const rows = await rowsFor(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cf_destination_id).toBe('cf-tag-owner');
    expect(rows[0]?.verification_source).toBe('cf');
  });

  it('disallow + allow re-registers at CF only once no other project lists the address', async () => {
    // The CLI's "fresh link" recipe. A sibling project (the owner's first,
    // via auto-add) still references the tag, so DELETE keeps the CF address
    // and the re-add lands on the adopt path again — honestly marked. Once
    // the sibling's row is gone the DELETE reaches CF and the next add is a
    // real create, which is the only way Cloudflare mails a new link.
    const user = await createTestUser(env.db);
    await setUserEmail(user.id, 'owner@example.com');
    const first = await createTestProject(env.db, user.id, 'email-first');
    const second = await createTestProject(env.db, user.id, 'email-second');
    await env.db.insert(emailDestinations).values({
      id: 'edst_first_owner',
      project_id: first.id,
      address: 'owner@example.com',
      status: 'pending',
      cf_destination_id: 'cf-tag-owner',
      verification_source: 'cf',
    });
    let onAccount = true;
    const fetchMock = mockCfWithEmail({
      addEmailDestination: () =>
        onAccount
          ? cfError('address already exists')
          : cfSuccess(cfRow('cf-tag-owner-2', 'owner@example.com', null)),
      listEmailDestinations: () =>
        cfSuccess(onAccount ? [cfRow('cf-tag-owner', 'owner@example.com', null)] : []),
      deleteEmailDestination: () => {
        onAccount = false;
        return cfSuccess({ tag: 'cf-tag-owner' });
      },
    });

    const added = await addDestination(second.id, user.jwt, 'owner@example.com', emailEnv());
    expect(added.status).toBe(201);
    const addedBody = (await added.json()) as { id: string; verificationSent?: boolean };
    expect(addedBody.verificationSent).toBe(false);

    // Sibling still lists the address: the CF address survives the DELETE...
    expect((await removeDestination(second.id, addedBody.id, user.jwt, emailEnv())).status).toBe(
      200,
    );
    expect(cfCalls(fetchMock, 'DELETE', '/email/routing/addresses')).toHaveLength(0);
    // ...so the re-add adopts it again, and says so again.
    const readded = await addDestination(second.id, user.jwt, 'owner@example.com', emailEnv());
    expect(readded.status).toBe(201);
    const readdedBody = (await readded.json()) as { id: string; verificationSent?: boolean };
    expect(readdedBody.verificationSent).toBe(false);

    // Drop the sibling's row too, then the recipe works: DELETE reaches CF,
    // the next add is a fresh create, and the marker is gone.
    await env.db.delete(emailDestinations).where(eq(emailDestinations.id, 'edst_first_owner'));
    expect((await removeDestination(second.id, readdedBody.id, user.jwt, emailEnv())).status).toBe(
      200,
    );
    expect(cfCalls(fetchMock, 'DELETE', '/email/routing/addresses')).toHaveLength(1);
    const fresh = await addDestination(second.id, user.jwt, 'owner@example.com', emailEnv());
    expect(fresh.status).toBe(201);
    expect((await fresh.json()) as { verificationSent?: boolean }).not.toHaveProperty(
      'verificationSent',
    );
    expect((await rowsFor(second.id))[0]?.cf_destination_id).toBe('cf-tag-owner-2');
    expect(recordedVerificationSends()).toHaveLength(0);
  });

  it('Option B: parallel POSTs for the same address send exactly one platform email', async () => {
    const user = await createTestUser(env.db);
    await setUserEmail(user.id, 'owner@example.com');
    const project = await createTestProject(env.db, user.id);
    // Park both requests inside the CF call until both have arrived, so both
    // miss the existing-row lookup and both reach the INSERT — the race this
    // test is about. Left to itself the harness serializes them, and the
    // second one would take the repeat-POST resend path instead.
    let arrived = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cfMocks = cfAlreadyVerified('cf-tag-shared', 'shared@example.com');
    mockCfWithEmail({
      ...cfMocks,
      addEmailDestination: async () => {
        if (++arrived === 2) {
          release();
        }
        await bothArrived;
        return cfMocks.addEmailDestination();
      },
    });

    // The unique constraint on (project_id, address) lets exactly one INSERT
    // win; ON CONFLICT DO NOTHING + RETURNING is what tells the loser it did
    // not insert, and only the inserter mails the recipient.
    const [resA, resB] = await Promise.all([
      addDestination(project.id, user.jwt, 'shared@example.com', emailEnv()),
      addDestination(project.id, user.jwt, 'shared@example.com', emailEnv()),
    ]);
    expect([200, 201]).toContain(resA.status);
    expect([200, 201]).toContain(resB.status);

    const sends = recordedVerificationSends();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toBe('shared@example.com');
    expect(await rowsFor(project.id)).toHaveLength(1);
  });

  it('Option B: a repeat POST for a platform-pending row resends the link', async () => {
    // A platform-pending row waits on OUR link, and that link is best-effort
    // (a failed delivery is logged and swallowed) and expires in 24h. The
    // repeat POST is the only surface a project owner has to re-issue it.
    const user = await createTestUser(env.db);
    await setUserEmail(user.id, 'owner@example.com');
    const project = await createTestProject(env.db, user.id);
    let deliveryFails = true;
    const fetchMock = mockCfWithEmail(
      cfAlreadyVerified('cf-tag-shared', 'shared@example.com'),
      () => {
        if (deliveryFails) {
          throw new Error('provider unavailable');
        }
      },
    );

    // First add: the row lands, the delivery fails, and the failure is
    // swallowed — the recipient has nothing to click.
    const first = await addDestination(project.id, user.jwt, 'shared@example.com', emailEnv());
    expect(first.status).toBe(201);
    expect(recordedVerificationSends()).toHaveLength(1);

    // Repeat: no new CF registration, no new row — one more link.
    deliveryFails = false;
    const second = await addDestination(project.id, user.jwt, 'shared@example.com', emailEnv());
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      status: string;
      verification_source: string;
      platformVerificationPending?: boolean;
    };
    expect(body.status).toBe('pending');
    expect(body.verification_source).toBe('platform');
    expect(body.platformVerificationPending).toBe(true);

    const sends = recordedVerificationSends();
    expect(sends).toHaveLength(2);
    expect(sends[1]!.to).toBe('shared@example.com');
    expect(cfCalls(fetchMock, 'POST', '/email/routing/addresses')).toHaveLength(1);
    expect(await rowsFor(project.id)).toHaveLength(1);
  });

  it('does not swallow a missing EMAIL_SENDER_DOMAIN into a delivery-failure log', async () => {
    // Every reader fails closed on the unset var. `sendPlatformVerificationEmail`
    // resolves the sender OUTSIDE its try, so the misconfiguration surfaces
    // instead of looking like a transient delivery error. In this harness there
    // is no ExecutionContext, so the inline-await fallback carries the throw
    // into the response — in production it lands in `waitUntil`.
    const user = await createTestUser(env.db);
    await setUserEmail(user.id, 'owner@example.com');
    const project = await createTestProject(env.db, user.id);
    mockCfWithEmail(cfAlreadyVerified('cf-tag-shared', 'shared@example.com'));

    // `env` as-is — EMAIL_SENDER_DOMAIN unset.
    const res = await addDestination(project.id, user.jwt, 'shared@example.com', env);

    expect(res.status).toBe(500);
    // Nothing was mailed, and the row remains pending.
    expect(recordedVerificationSends()).toHaveLength(0);
    // But the row was already committed before the sender was resolved, so
    // the misconfigured environment leaves behind a platform-pending row
    // with no link in anyone's inbox. Once the var is set, a repeat POST is
    // the resend: it mails the link against the existing row.
    const stranded = await rowsFor(project.id);
    expect(stranded).toHaveLength(1);
    expect(stranded[0]?.status).toBe('pending');
    expect(stranded[0]?.verification_source).toBe('platform');

    const retry = await addDestination(project.id, user.jwt, 'shared@example.com', emailEnv());
    expect(retry.status).toBe(200);
    const sends = recordedVerificationSends();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toBe('shared@example.com');
    expect(await rowsFor(project.id)).toHaveLength(1);
  });

  it("defaults verification_source to 'cf' for rows that predate the column", async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await env.db.insert(emailDestinations).values({
      id: 'edst_legacy',
      project_id: project.id,
      address: 'legacy@example.com',
      status: 'verified',
      cf_destination_id: 'cf-tag-legacy',
      verified_at: '2026-04-01T00:00:00Z',
      // verification_source omitted on purpose — the column default applies.
    });
    const [row] = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.id, 'edst_legacy'));
    expect(row?.verification_source).toBe('cf');
  });
});

// ---------------------------------------------------------------------------
// Owner auto-add on project create
// ---------------------------------------------------------------------------

describe('POST /projects — owner destination auto-add', () => {
  async function createProject(jwt: string, slug: string, bindings: TestEnv): Promise<Response> {
    return app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      }),
      bindings,
    );
  }

  it("inherits CF's verification for the owner's own address", async () => {
    // A second-or-later project for the same owner: CF already has the
    // address, so the row starts verified with `verification_source='cf'`
    // and the audit columns naming whose consent was inherited.
    const user = await createTestUser(env.db);
    await setUserEmail(user.id, 'owner@example.com');
    mockCfApi(cfAlreadyVerified('cf-tag-owner', 'owner@example.com'));

    const res = await createProject(user.jwt, 'email-autoadd-inherited', emailEnv());
    expect(res.status).toBe(201);
    const project = (await res.json()) as { id: string };

    const rows = await rowsFor(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      address: 'owner@example.com',
      cf_destination_id: 'cf-tag-owner',
      status: 'verified',
      verification_source: 'cf',
      verified_by_user_id: user.id,
      verified_by_email_snapshot: 'owner@example.com',
    });
    expect(await readVerifiedDestinations(project.id)).toEqual(['owner@example.com']);
  });

  it('leaves a fresh CF registration pending, with nothing allow-listed and no consent attributed', async () => {
    const user = await createTestUser(env.db);
    await setUserEmail(user.id, 'Owner@Example.com');
    mockCfApi();

    const res = await createProject(user.jwt, 'email-autoadd-fresh', emailEnv());
    expect(res.status).toBe(201);
    const project = (await res.json()) as { id: string };

    const rows = await rowsFor(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // Lowercased regardless of how the OAuth provider cased it.
      address: 'owner@example.com',
      status: 'pending',
      verification_source: 'cf',
    });
    expect(rows[0]?.verified_by_user_id).toBeNull();
    expect(await readVerifiedDestinations(project.id)).toEqual([]);
  });

  it('registers nothing when the environment has no platform mail domain', async () => {
    const user = await createTestUser(env.db);
    await setUserEmail(user.id, 'owner@example.com');
    const fetchMock = mockCfApi();

    // `env` as-is — EMAIL_SENDER_DOMAIN unset. There is no sender to
    // allow-list a recipient for, so the auto-add stays inert.
    const res = await createProject(user.jwt, 'email-autoadd-nodomain', env);
    expect(res.status).toBe(201);
    const project = (await res.json()) as { id: string };

    expect(cfCalls(fetchMock, 'POST', '/email/routing/addresses')).toHaveLength(0);
    expect(await rowsFor(project.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Audit-driven revocation
// ---------------------------------------------------------------------------

describe('revokeOwnerVerifiedDestinationsForUserChange', () => {
  it('demotes only the rows that inherited THIS identity', async () => {
    const user = await createTestUser(env.db);
    const projectA = await createTestProject(env.db, user.id, 'rev-a');
    const projectB = await createTestProject(env.db, user.id, 'rev-b');

    await env.db.insert(emailDestinations).values([
      {
        id: 'edst_owner_a',
        project_id: projectA.id,
        address: 'owner@example.com',
        status: 'verified',
        cf_destination_id: 'cf-tag-owner',
        verified_at: '2026-04-25T00:00:00Z',
        verification_source: 'cf',
        verified_by_user_id: user.id,
        verified_by_email_snapshot: 'owner@example.com',
      },
      {
        id: 'edst_owner_b',
        project_id: projectB.id,
        address: 'owner@example.com',
        status: 'verified',
        cf_destination_id: 'cf-tag-owner',
        verified_at: '2026-04-25T00:00:00Z',
        verification_source: 'cf',
        verified_by_user_id: user.id,
        verified_by_email_snapshot: 'owner@example.com',
      },
      // Platform-source: consent was per-recipient, independent of the
      // owner's identity. Must stay verified.
      {
        id: 'edst_platform_a',
        project_id: projectA.id,
        address: 'shared@example.com',
        status: 'verified',
        cf_destination_id: 'cf-tag-shared',
        verified_at: '2026-04-25T00:00:00Z',
        verification_source: 'platform',
        verified_by_user_id: null,
        verified_by_email_snapshot: null,
      },
      // Same user, DIFFERENT snapshot — matching on user_id alone would
      // wrongly revoke this one.
      {
        id: 'edst_owner_other',
        project_id: projectA.id,
        address: 'old@example.com',
        status: 'verified',
        cf_destination_id: 'cf-tag-old',
        verified_at: '2026-04-25T00:00:00Z',
        verification_source: 'cf',
        verified_by_user_id: user.id,
        verified_by_email_snapshot: 'old@example.com',
      },
    ]);

    await revokeOwnerVerifiedDestinationsForUserChange(env.db, user.id, 'owner@example.com');

    const after = await env.db.select().from(emailDestinations);
    const byId = new Map(after.map((r) => [r.id, r]));

    expect(byId.get('edst_owner_a')?.status).toBe('pending');
    expect(byId.get('edst_owner_a')?.verified_at).toBeNull();
    expect(byId.get('edst_owner_a')?.verified_by_user_id).toBeNull();
    expect(byId.get('edst_owner_a')?.verified_by_email_snapshot).toBeNull();
    expect(byId.get('edst_owner_b')?.status).toBe('pending');

    expect(byId.get('edst_platform_a')?.status).toBe('verified');
    expect(byId.get('edst_platform_a')?.verification_source).toBe('platform');

    expect(byId.get('edst_owner_other')?.status).toBe('verified');
    expect(byId.get('edst_owner_other')?.verified_by_email_snapshot).toBe('old@example.com');
  });

  it('matches the email snapshot case-insensitively', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await env.db.insert(emailDestinations).values({
      id: 'edst_case',
      project_id: project.id,
      address: 'mixedcase@example.com',
      status: 'verified',
      cf_destination_id: 'cf-tag-mixed',
      verified_at: '2026-04-25T00:00:00Z',
      verification_source: 'cf',
      verified_by_user_id: user.id,
      verified_by_email_snapshot: 'MixedCase@Example.com',
    });

    await revokeOwnerVerifiedDestinationsForUserChange(env.db, user.id, 'mixedcase@example.com');

    const [row] = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.id, 'edst_case'));
    expect(row?.status).toBe('pending');
  });

  it('stays revoked across a destinations listing while CF still reports the address verified', async () => {
    // The revoke is a PLATFORM decision: nothing was deleted on CF's side, so
    // CF keeps reporting the address verified forever. The destinations GET
    // refreshes every row that is `pending` and NOT 'platform'-sourced against
    // exactly that list — so demoting `status` alone leaves the row sitting in
    // the refresh filter, and the owner's very next `void email destinations`
    // silently re-promotes it, undoing the revoke. Re-sourcing the row to
    // 'platform' is what makes the revoke stick.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rev-sticky');
    await env.db.insert(emailDestinations).values({
      id: 'edst_sticky',
      project_id: project.id,
      address: 'owner@example.com',
      status: 'verified',
      cf_destination_id: 'cf-tag-owner',
      verified_at: '2026-04-25T00:00:00Z',
      verification_source: 'cf',
      verified_by_user_id: user.id,
      verified_by_email_snapshot: 'owner@example.com',
    });
    await revokeOwnerVerifiedDestinationsForUserChange(env.db, user.id, 'owner@example.com');
    expect(await readVerifiedDestinations(project.id)).toEqual([]);

    // CF is unchanged — the address is still verified on the account.
    mockCfApi({
      listEmailDestinations: () =>
        cfSuccess([cfRow('cf-tag-owner', 'owner@example.com', '2026-04-26T00:00:00Z')]),
    });

    const res = await listDestinations(project.id, user.jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ status: string; verification_source: string }>;
    expect(body[0]?.status).toBe('pending');
    expect(body[0]?.verification_source).toBe('platform');

    const [row] = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.id, 'edst_sticky'));
    expect(row?.status).toBe('pending');
    expect(row?.verification_source).toBe('platform');
    expect(row?.verified_at).toBeNull();
    // The listing did not re-verify the address.
    expect(await readVerifiedDestinations(project.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// /email/destinations/confirm — public; the HMAC-signed token IS the auth.
// GET shows a Confirm button; the button's POST grants consent.
// ---------------------------------------------------------------------------

describe('/email/destinations/confirm', () => {
  async function seedPlatformPending(
    address: string,
    project: { id: string },
    id = `edst_${Math.random().toString(36).slice(2, 10)}`,
  ): Promise<string> {
    await env.db.insert(emailDestinations).values({
      id,
      project_id: project.id,
      address,
      status: 'pending',
      cf_destination_id: 'cf-tag-shared',
      verified_at: null,
      verification_source: 'platform',
    });
    return id;
  }

  function makeToken(
    pid: string,
    did: string,
    addr: string,
    overrides: { exp?: number; iat?: number } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return signConfirmToken(
      {
        v: 1,
        pid,
        did,
        addr,
        iat: overrides.iat ?? now,
        exp: overrides.exp ?? now + 24 * 60 * 60,
      },
      env.EMAIL_SIGNING_SECRET,
    );
  }

  async function confirm(token: string): Promise<Response> {
    return app.fetch(
      new Request(
        `http://localhost/email/destinations/confirm?token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
        },
      ),
      env,
    );
  }

  // Mail security scanners fetch every link in a message, so opening the
  // link must not grant consent on its own.
  it('opening the link shows a Confirm button and leaves the row pending', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const did = await seedPlatformPending('shared@example.com', project);
    const token = await makeToken(project.id, did, 'shared@example.com');

    const res = await app.fetch(
      new Request(`http://localhost/email/destinations/confirm?token=${encodeURIComponent(token)}`),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await res.text();
    expect(html).toContain('shared@example.com');
    expect(html).toContain('<form method="post"');
    expect(html).toContain(`action="?token=${token}"`);
    expect(html).not.toContain('Email confirmed');

    const [row] = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.id, did));
    expect(row?.status).toBe('pending');
    expect(row?.verified_at).toBeNull();
    expect(await readVerifiedDestinations(project.id)).toEqual([]);

    expect(await (await confirm(token)).text()).toContain("You've authorized");
    const again = await confirm(token);
    expect(again.status).toBe(200);
    expect(await again.text()).toContain('Already confirmed');
  });

  it('flips the row to verified and renders the success page', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const did = await seedPlatformPending('shared@example.com', project);
    const token = await makeToken(project.id, did, 'shared@example.com');

    const res = await confirm(token);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Email confirmed');
    expect(html).toContain('shared@example.com');

    const [row] = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.id, did));
    expect(row?.status).toBe('verified');
    expect(row?.verified_at).toBeTruthy();
    // Audit trail: the recipient clicked OUR link, not CF's.
    expect(row?.verification_source).toBe('platform');

    expect(await readVerifiedDestinations(project.id)).toEqual(['shared@example.com']);
  });

  it('sets no-store and no-referrer on the success page', async () => {
    // The single-use token is in the URL. A shared cache or a `Referer`
    // leak would let a later visitor consume it.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const did = await seedPlatformPending('shared@example.com', project);
    const res = await confirm(await makeToken(project.id, did, 'shared@example.com'));

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('does not report confirmation after consent is concurrently removed', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const did = await seedPlatformPending('shared@example.com', project);
    const updateStatus = dbModule.updateEmailDestinationStatus;
    vi.spyOn(dbModule, 'updateEmailDestinationStatus').mockImplementationOnce(async (...args) => {
      await dbModule.deleteEmailDestination(env.db, did);
      return updateStatus(...args);
    });
    const response = await confirm(await makeToken(project.id, did, 'shared@example.com'));
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('Destination not found');
    expect(await readVerifiedDestinations(project.id)).toEqual([]);
    expect(await env.db.select().from(emailDestinationCleanups)).toMatchObject([
      { cf_destination_id: 'cf-tag-shared', status: 'pending' },
    ]);
  });

  it('returns 400 for a missing token', async () => {
    const res = await app.fetch(new Request('http://localhost/email/destinations/confirm'), env);
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid signature', async () => {
    const res = await confirm('not-a-real-token');
    expect(res.status).toBe(400);
  });

  it('rejects a confirmation signed with the login key', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const did = await seedPlatformPending('shared@example.com', project);
    const now = Math.floor(Date.now() / 1000);
    const forged = await signConfirmToken(
      { v: 1, pid: project.id, did, addr: 'shared@example.com', iat: now, exp: now + 3600 },
      env.JWT_SECRET,
    );

    const res = await confirm(forged);
    expect(res.status).toBe(400);

    const [row] = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.id, did));
    expect(row?.status).toBe('pending');
  });

  it('returns 400 for an expired token and leaves the row pending', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const did = await seedPlatformPending('shared@example.com', project);
    const now = Math.floor(Date.now() / 1000);
    const expired = await makeToken(project.id, did, 'shared@example.com', {
      iat: now - 25 * 60 * 60,
      exp: now - 60 * 60,
    });

    const res = await confirm(expired);
    expect(res.status).toBe(400);

    const [row] = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.id, did));
    expect(row?.status).toBe('pending');
  });

  it('returns 404 for an unknown destination id', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const res = await confirm(
      await makeToken(project.id, 'edst_does_not_exist', 'shared@example.com'),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when the row was deleted after the link was mailed', async () => {
    // Re-adding the address mints a NEW edst_* id, so the old token stays
    // dead rather than confirming the replacement row.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const did = await seedPlatformPending('shared@example.com', project);
    const token = await makeToken(project.id, did, 'shared@example.com');

    await env.db.delete(emailDestinations).where(eq(emailDestinations.id, did));

    expect((await confirm(token)).status).toBe(404);
  });

  it('returns 404 when the token claims a different address than the row', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const did = await seedPlatformPending('shared@example.com', project);

    const res = await confirm(await makeToken(project.id, did, 'someone-else@example.com'));
    expect(res.status).toBe(404);

    const [row] = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.id, did));
    expect(row?.status).toBe('pending');
  });

  it('returns 404 when the token claims project A but the row lives in project B', async () => {
    // Replay across projects: an attacker holding a valid token for their
    // OWN project must not be able to confirm someone else's row.
    const user = await createTestUser(env.db);
    const projectA = await createTestProject(env.db, user.id, 'pid-a');
    const projectB = await createTestProject(env.db, user.id, 'pid-b');
    const didInB = await seedPlatformPending('shared@example.com', projectB);

    const res = await confirm(await makeToken(projectA.id, didInB, 'shared@example.com'));
    expect(res.status).toBe(404);

    const [row] = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.id, didInB));
    expect(row?.status).toBe('pending');
    expect(await readVerifiedDestinations(projectB.id)).toEqual([]);
  });

  it('is idempotent on an already-verified row', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await env.db.insert(emailDestinations).values({
      id: 'edst_already_verified',
      project_id: project.id,
      address: 'shared@example.com',
      status: 'verified',
      cf_destination_id: 'cf-tag-shared',
      verified_at: '2026-04-29T00:00:00Z',
      verification_source: 'platform',
    });

    const res = await confirm(
      await makeToken(project.id, 'edst_already_verified', 'shared@example.com'),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Already confirmed');
  });

  it('confirms end to end: the emailed link is the one that flips the row', async () => {
    // Full Option B loop — the token in the mail body is the same token the
    // public endpoint accepts. Anything that drifts between signer and
    // verifier (payload shape, encoding, secret) breaks here.
    const user = await createTestUser(env.db);
    await setUserEmail(user.id, 'owner@example.com');
    const project = await createTestProject(env.db, user.id);
    mockCfWithEmail(cfAlreadyVerified('cf-tag-shared', 'shared@example.com'));

    const added = await addDestination(project.id, user.jwt, 'shared@example.com', emailEnv());
    expect(added.status).toBe(201);

    const [send] = recordedVerificationSends();
    const link = /https:\/\/\S*\/email\/destinations\/confirm\?token=(\S+)/.exec(send!.text);
    expect(link, `no confirm link in the mail body:\n${send!.text}`).not.toBeNull();

    // Stop mocking fetch before the confirm request — nothing outbound is
    // expected on that path.
    vi.unstubAllGlobals();
    const res = await confirm(decodeURIComponent(link![1]!));
    expect(res.status).toBe(200);

    const rows = await rowsFor(project.id);
    expect(rows[0]?.status).toBe('verified');
    expect(rows[0]?.verification_source).toBe('platform');
    expect(await readVerifiedDestinations(project.id)).toEqual(['shared@example.com']);
  });
});

// ---------------------------------------------------------------------------
// GET /projects/:id/email/settings
// ---------------------------------------------------------------------------

describe('GET /projects/:id/email/settings', () => {
  async function settings(projectId: string, jwt: string): Promise<Response> {
    return app.fetch(
      new Request(`http://localhost/projects/${projectId}/email/settings`, {
        headers: { Authorization: `Bearer ${jwt}` },
      }),
      env,
    );
  }

  it('returns 401 without auth and 404 for an unknown project', async () => {
    const anon = await app.fetch(
      new Request('http://localhost/projects/proj_x/email/settings'),
      env,
    );
    expect(anon.status).toBe(401);
    const user = await createTestUser(env.db);
    expect((await settings('proj_missing', user.jwt)).status).toBe(404);
  });

  it("returns 403 for another user's project", async () => {
    const owner = await createTestUser(env.db, 'owner');
    const intruder = await createTestUser(env.db, 'intruder');
    const project = await createTestProject(env.db, owner.id);
    expect((await settings(project.id, intruder.jwt)).status).toBe(403);
  });

  it('reports the defaults with the project slug and repairs the policy mirror', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'settings-project');
    await env.ROUTING.delete('email-recipient-policy');

    const res = await settings(project.id, user.jwt);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      domains: { management: 'self-serve', projectSlug: 'settings-project' },
      emailAlias: null,
      sharedDomain: null,
      sharedInbound: null,
      recipientPolicy: { mode: 'verified', domains: [] },
    });
    expect(await env.ROUTING.get('email-recipient-policy')).toBe(
      JSON.stringify({ mode: 'verified', domains: [] }),
    );
  });

  it('reflects the stored settings', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await env.db.insert(platformSettings).values([
      { key: 'email.domains', value: 'admin' },
      { key: 'email.recipientPolicy', value: { mode: 'domains', domains: ['corp.example'] } },
    ]);

    const body = await (await settings(project.id, user.jwt)).json();
    expect(body).toMatchObject({
      domains: { management: 'admin' },
      recipientPolicy: { mode: 'domains', domains: ['corp.example'] },
    });
  });
});

// ---------------------------------------------------------------------------
// PUT /projects/:id/email/alias
// ---------------------------------------------------------------------------

describe('PUT /projects/:id/email/alias', () => {
  async function setAlias(
    projectId: string,
    jwt: string,
    body: unknown,
    bindings: TestEnv | ApiEnv['Bindings'] = emailEnv(),
  ): Promise<Response> {
    return app.fetch(
      new Request(`http://localhost/projects/${projectId}/email/alias`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      bindings,
    );
  }

  async function storedAlias(projectId: string): Promise<string | null> {
    const [row] = await env.db.select().from(projects).where(eq(projects.id, projectId));
    return row!.email_alias;
  }

  async function seedAlias(projectId: string, alias: string): Promise<void> {
    await env.db.update(projects).set({ email_alias: alias }).where(eq(projects.id, projectId));
  }

  it('sets the alias for the owner and shows it in the settings', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'alias-project');
    // No shared inbound route is connected, so nothing reaches Cloudflare.
    const fetchMock = mockCfApi();

    const res = await setAlias(project.id, user.jwt, { alias: 'support-desk' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      emailAlias: 'support-desk',
      address: `support-desk@${MAIL_DOMAIN}`,
      sharedInbound: null,
    });
    expect(await storedAlias(project.id)).toBe('support-desk');
    expect(fetchMock).not.toHaveBeenCalled();

    const settings = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/email/settings`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      emailEnv(),
    );
    expect(settings.status).toBe(200);
    expect(await settings.json()).toMatchObject({
      domains: { projectSlug: 'alias-project' },
      emailAlias: 'support-desk',
      sharedDomain: MAIL_DOMAIN,
      sharedInbound: null,
    });
  });

  it('refuses a non-owner admin with the owner-only message', async () => {
    const { admin, project } = await createProjectWithAdmin('alias');

    const res = await setAlias(project.id, admin.jwt, { alias: 'support-desk' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: PROJECT_PERMISSION_MESSAGES['email-alias'],
    });
    expect(await storedAlias(project.id)).toBeNull();
  });

  it('returns 409 when the platform has no shared mail domain', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    // `env` as-is: EMAIL_SENDER_DOMAIN unset.
    const res = await setAlias(project.id, user.jwt, { alias: 'support-desk' }, env);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'this platform has no shared mail domain' });
    expect(await storedAlias(project.id)).toBeNull();
  });

  it('requires an alias string', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    for (const body of [{}, { alias: '' }, { alias: 42 }]) {
      const res = await setAlias(project.id, user.jwt, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: 'alias is required' });
    }
    expect(await storedAlias(project.id)).toBeNull();
  });

  it('applies the slug shape, length and reserved-name rules', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const cases: Array<[string, string]> = [
      ['Support-Desk', 'alias must be lowercase alphanumeric with dashes'],
      ['support_desk', 'alias must be lowercase alphanumeric with dashes'],
      ['-support', 'alias must be lowercase alphanumeric with dashes'],
      [`len-${'a'.repeat(53)}`, 'alias must be at most 56 characters'],
      ['postmaster', 'this name is reserved'],
      ['preview-x', 'this name is reserved'],
    ];
    for (const [alias, error] of cases) {
      const res = await setAlias(project.id, user.jwt, { alias });
      expect(res.status, alias).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
    expect(await storedAlias(project.id)).toBeNull();
  });

  it('refuses to change an alias once set', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await seedAlias(project.id, 'first-alias');

    const res = await setAlias(project.id, user.jwt, { alias: 'second-alias' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'this project already has the email alias first-alias; it cannot be changed',
    });
    expect(await storedAlias(project.id)).toBe('first-alias');
  });

  it('refuses the project slug', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'alias-project');

    const res = await setAlias(project.id, user.jwt, { alias: 'alias-project' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'alias must differ from the project slug' });
    expect(await storedAlias(project.id)).toBeNull();
  });

  it('applies the short-name plan rule of project slugs', async () => {
    const free = await createTestUser(env.db, 'free-owner');
    const freeProject = await createTestProject(env.db, free.id);
    const refused = await setAlias(freeProject.id, free.jwt, { alias: 'desk' });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: 'the selected plan does not permit short names (5 characters or fewer)',
    });
    expect(await storedAlias(freeProject.id)).toBeNull();

    const paid = await createTestUser(env.db, 'paid-owner', 'github', undefined, 'solo');
    const paidProject = await createTestProject(env.db, paid.id);
    const allowed = await setAlias(paidProject.id, paid.jwt, { alias: 'desk' });
    expect(allowed.status).toBe(200);
    expect(await storedAlias(paidProject.id)).toBe('desk');
  });

  it('refuses a name another project uses as its slug or alias', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await createTestProject(env.db, user.id, 'taken-slug');
    const aliased = await createTestProject(env.db, user.id);
    await seedAlias(aliased.id, 'taken-alias');

    for (const alias of ['taken-slug', 'taken-alias']) {
      const res = await setAlias(project.id, user.jwt, { alias });
      expect(res.status, alias).toBe(409);
      expect(await res.json()).toEqual({ error: 'this name is already taken' });
    }
    expect(await storedAlias(project.id)).toBeNull();
  });

  describe('with the shared inbound route connected', () => {
    const SHARED_DOMAIN = 'mail.example.com';

    function sharedEnv(): ApiEnv['Bindings'] {
      return {
        ...env,
        HYPERDRIVE: {
          ...env.HYPERDRIVE,
          host: 'localhost',
          ip: '127.0.0.1',
          port: 5432,
          user: 'test',
          password: 'inert-test-password',
          database: 'test',
          connect() {
            throw new Error('Tests use the injected database');
          },
        },
        CRON_FIRES_QUEUE: {
          send: vi.fn(),
          sendBatch: vi.fn(),
          metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
        },
        PLATFORM_INSTALLATION_ID: 'installation-shared-test',
        EMAIL_GATEWAY_ORIGIN: 'https://email-gateway.example.test',
        EMAIL_SENDER_DOMAIN: SHARED_DOMAIN,
        EMAIL_SHARED_ACCOUNT_ID: env.CF_ACCOUNT_ID,
        EMAIL_SHARED_ZONE_ID: 'shared-zone',
        EMAIL_SHARED_INGRESS_NAME: 'native-gateway',
      } as ApiEnv['Bindings'];
    }

    async function connectShared(config: NonNullable<Parameters<typeof stubCustomerCf>[0]> = {}) {
      const provider = stubCustomerCf({
        zones: {
          'example.com': { id: 'shared-zone', name: 'example.com', accountId: env.CF_ACCOUNT_ID },
        },
        mx: { [SHARED_DOMAIN]: ['route1.mx.cloudflare.net'] },
        ...config,
      });
      const operation = await ensureSharedEmailConnection(env.db, sharedEnv());
      await runEmailOperation(env.db, sharedEnv(), operation!);
      expect((await resolveEmailDomain(env.db, SHARED_DOMAIN))?.route.inbound_status).toBe('ready');
      return provider;
    }

    /** A live deployment that declares inbound email handlers. */
    async function deployEmailHandlers(projectId: string): Promise<void> {
      const deployment = await createTestDeployment(env.db, projectId);
      await env.db
        .update(deployments)
        .set({ manifest: JSON.stringify({ version: 3, bindings: {}, emailProtocolVersion: 1 }) })
        .where(eq(deployments.id, deployment.id));
    }

    it('refuses an alias a Cloudflare rule already routes and saves nothing', async () => {
      const provider = await connectShared({
        routingRules: [
          {
            enabled: true,
            addresses: [`support-desk+vip@${SHARED_DOMAIN}`],
            workerName: 'other-worker',
          },
        ],
      });
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'alias-project');
      await deployEmailHandlers(project.id);

      const res = await setAlias(project.id, user.jwt, { alias: 'support-desk' }, sharedEnv());
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain(
        `already routes support-desk@${SHARED_DOMAIN}`,
      );
      expect(await storedAlias(project.id)).toBeNull();
      expect(await env.db.select().from(emailSharedRecipients)).toEqual([]);
      expect(callsByTag(provider.calls, 'literalRuleCreate')).toHaveLength(0);
    });

    it('adds an alias rule next to the slug rule when the project receives mail', async () => {
      const provider = await connectShared();
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'alias-project');
      await deployEmailHandlers(project.id);

      const res = await setAlias(project.id, user.jwt, { alias: 'support-desk' }, sharedEnv());
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        emailAlias: 'support-desk',
        address: `support-desk@${SHARED_DOMAIN}`,
        sharedInbound: { recipient: `support-desk@${SHARED_DOMAIN}`, status: 'ready' },
      });
      const rows = await env.db.select().from(emailSharedRecipients);
      expect(rows.map((row) => row.recipient).sort()).toEqual([
        `alias-project@${SHARED_DOMAIN}`,
        `support-desk@${SHARED_DOMAIN}`,
      ]);
      expect(rows.every((row) => row.status === 'ready')).toBe(true);
      expect(callsByTag(provider.calls, 'literalRuleCreate')).toHaveLength(2);
    });
  });
});

// ---------------------------------------------------------------------------
// GET /projects/:id/email/usage
// ---------------------------------------------------------------------------

describe('GET /projects/:id/email/usage', () => {
  async function usage(projectId: string, jwt: string): Promise<Response> {
    return app.fetch(
      new Request(`http://localhost/projects/${projectId}/email/usage`, {
        headers: { Authorization: `Bearer ${jwt}` },
      }),
      env,
    );
  }

  function monthBucket(): string {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  it('returns 401 without auth', async () => {
    const res = await app.fetch(new Request('http://localhost/projects/proj_x/email/usage'), env);
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown project', async () => {
    const user = await createTestUser(env.db);
    expect((await usage('proj_missing', user.jwt)).status).toBe(404);
  });

  it("returns 403 for another user's project", async () => {
    const owner = await createTestUser(env.db, 'owner');
    const intruder = await createTestUser(env.db, 'intruder');
    const project = await createTestProject(env.db, owner.id);
    expect((await usage(project.id, intruder.jwt)).status).toBe(403);
  });

  it('reports zeroes and the default limit for a project that has never sent', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const res = await usage(project.id, user.jwt);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      month: monthBucket(),
      attempts: 0,
      received: 0,
      limit: 200,
      remaining: 200,
      suspended: false,
    });
  });

  it('reads the PostgreSQL month counter, limit override, and suspend flag', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const month = monthBucket();
    await env.db
      .insert(emailMonthlyUsage)
      .values({ project_id: project.id, month, recipient_attempts: 7, inbound_receipts: 3 });
    await setProjectEmailLimits(env.db, project.id, { monthly: 50 });
    await setProjectEmailSuspended(env.db, project.id, true);

    const res = await usage(project.id, user.jwt);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      month,
      attempts: 7,
      received: 3,
      limit: 50,
      remaining: 43,
      suspended: true,
    });
  });

  it('treats a poisoned counter as zero and never reports a negative remaining', async () => {
    // `parseInt('NaN', 10)` is NaN — an unguarded reader would propagate it
    // straight into the response and into every `>=` comparison downstream.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const month = monthBucket();
    await env.ROUTING.put(`email-sent:${project.id}:${month}`, 'NaN');
    await env.ROUTING.put(`email-limit:${project.id}`, '-5');

    const res = await usage(project.id, user.jwt);
    const body = (await res.json()) as { attempts: number; limit: number; remaining: number };
    expect(body.attempts).toBe(0);
    // A non-positive override is ignored in favour of the default.
    expect(body.limit).toBe(200);
    expect(body.remaining).toBe(200);
  });

  it('clamps remaining at zero once PostgreSQL usage exceeds the limit', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await env.db
      .insert(emailMonthlyUsage)
      .values({ project_id: project.id, month: monthBucket(), recipient_attempts: 500 });

    const body = (await (await usage(project.id, user.jwt)).json()) as { remaining: number };
    expect(body.remaining).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /projects/:id/email/logs
// ---------------------------------------------------------------------------

describe('GET /projects/:id/email/logs', () => {
  async function logs(projectId: string, jwt: string): Promise<Response> {
    return app.fetch(
      new Request(`http://localhost/projects/${projectId}/email/logs`, {
        headers: { Authorization: `Bearer ${jwt}` },
      }),
      env,
    );
  }

  it('returns 401 without auth', async () => {
    const res = await app.fetch(new Request('http://localhost/projects/proj_x/email/logs'), env);
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown project', async () => {
    const user = await createTestUser(env.db);
    expect((await logs('proj_missing', user.jwt)).status).toBe(404);
  });

  it("returns 403 for another user's project", async () => {
    const owner = await createTestUser(env.db, 'owner');
    const intruder = await createTestUser(env.db, 'intruder');
    const project = await createTestProject(env.db, owner.id);
    expect((await logs(project.id, intruder.jwt)).status).toBe(403);
  });

  it('returns an empty durable ledger for a project with no email activity', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const res = await logs(project.id, user.jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: Array<unknown> };
    expect(body.logs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Platform capability gate
// ---------------------------------------------------------------------------

describe('email platform capability', () => {
  /** Email must remain independent of optional application custom domains. */
  function capabilityEnv(email: boolean, bindings: TestEnv = env): TestEnv {
    return {
      ...bindings,
      PLATFORM_CAPABILITIES: JSON.stringify({
        ai: true,
        customDomains: false,
        email,
        githubActions: true,
        githubOAuth: true,
        googleOAuth: true,
        managedBuilds: true,
        sandbox: true,
      }),
    };
  }

  const UNAVAILABLE = {
    error: 'platform capability unavailable',
    capability: 'email',
    message: 'This Void platform does not enable email.',
  };

  async function get(path: string, jwt: string, bindings: TestEnv): Promise<Response> {
    return app.fetch(
      new Request(`http://localhost${path}`, { headers: { Authorization: `Bearer ${jwt}` } }),
      bindings,
    );
  }

  it('answers 501 on usage and logs without reading the counters', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const month = new Date().toISOString().slice(0, 7);
    await env.ROUTING.put(`email-sent:${project.id}:${month}`, '7');
    const kvGet = vi.spyOn(env.ROUTING, 'get');

    const usage = await get(`/projects/${project.id}/email/usage`, user.jwt, capabilityEnv(false));
    expect(usage.status).toBe(501);
    expect(await usage.json()).toEqual(UNAVAILABLE);

    const logs = await get(`/projects/${project.id}/email/logs`, user.jwt, capabilityEnv(false));
    expect(logs.status).toBe(501);
    expect(await logs.json()).toMatchObject({ capability: 'email' });

    expect(kvGet).not.toHaveBeenCalled();
  });

  it('answers 501 on every destinations route before Cloudflare or the database is touched', async () => {
    const user = await createTestUser(env.db);
    await setUserEmail(user.id, 'owner@example.com');
    const project = await createTestProject(env.db, user.id);
    await seedVerifiedPair(project.id);
    const fetchMock = mockCfWithEmail();
    const kvPut = vi.spyOn(env.ROUTING, 'put');
    const bindings = capabilityEnv(false, emailEnv());

    const list = await listDestinations(project.id, user.jwt, bindings);
    expect(list.status).toBe(501);
    expect(await list.json()).toMatchObject({ capability: 'email' });

    const add = await addDestination(project.id, user.jwt, 'new@example.com', bindings);
    expect(add.status).toBe(501);
    expect(await add.json()).toEqual(UNAVAILABLE);

    const remove = await removeDestination(project.id, 'edst_v1', user.jwt, bindings);
    expect(remove.status).toBe(501);
    expect(await remove.json()).toMatchObject({ capability: 'email' });

    expect(fetchMock).not.toHaveBeenCalled();
    // Not even the add rate-limit counter is charged.
    expect(kvPut).not.toHaveBeenCalled();
    expect((await rowsFor(project.id)).map((row) => row.id).sort()).toEqual(['edst_v1', 'edst_v2']);
    expect(await readVerifiedDestinations(project.id)).toEqual([
      'keep@example.com',
      'gone@example.com',
    ]);
  });

  it('answers 501 on the public confirm link and leaves the row pending', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await env.db.insert(emailDestinations).values({
      id: 'edst_gate',
      project_id: project.id,
      address: 'shared@example.com',
      status: 'pending',
      cf_destination_id: 'cf-tag-shared',
      verified_at: null,
      verification_source: 'platform',
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await signConfirmToken(
      {
        v: 1,
        pid: project.id,
        did: 'edst_gate',
        addr: 'shared@example.com',
        iat: now,
        exp: now + 3600,
      },
      env.EMAIL_SIGNING_SECRET,
    );

    const res = await app.fetch(
      new Request(
        `http://localhost/email/destinations/confirm?token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
        },
      ),
      capabilityEnv(false),
    );
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ capability: 'email' });

    const [row] = await rowsFor(project.id);
    expect(row).toMatchObject({ id: 'edst_gate', status: 'pending', verified_at: null });
    expect(await readVerifiedDestinations(project.id)).toEqual([]);
  });

  it('does not gate sibling routers mounted at /projects', async () => {
    // The gate is registered as `/:id/email/*`, not `use('*')`. A wildcard
    // would also have answered 501 for every router mounted after this one.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const github = await get(`/projects/${project.id}/github`, user.jwt, capabilityEnv(false));
    expect(github.status).toBe(404);
    expect(await github.json()).toEqual({ error: 'connection not found' });

    const detail = await get(`/projects/${project.id}`, user.jwt, capabilityEnv(false));
    expect(detail.status).toBe(200);
  });

  it('serves the routes when the capability is explicitly enabled', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const usage = await get(`/projects/${project.id}/email/usage`, user.jwt, capabilityEnv(true));
    expect(usage.status).toBe(200);
    expect(await usage.json()).toMatchObject({ attempts: 0, received: 0, limit: 200 });

    const list = await listDestinations(project.id, user.jwt, capabilityEnv(true));
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);
  });

  it('allows owner email destinations while custom-domain routes remain disabled', async () => {
    const user = await createTestUser(env.db);
    await setUserEmail(user.id, 'owner@example.com');
    const project = await createTestProject(env.db, user.id);
    mockCfWithEmail(cfAlreadyVerified('cf-owner', 'owner@example.com'));
    const bindings = capabilityEnv(true, emailEnv());

    const destination = await addDestination(project.id, user.jwt, 'owner@example.com', bindings);
    expect(destination.status).toBe(201);
    expect(await destination.json()).toMatchObject({
      address: 'owner@example.com',
      status: 'verified',
    });

    for (const [method, path] of [
      ['GET', `/projects/${project.id}/domains`],
      ['POST', `/projects/${project.id}/domains`],
      ['GET', `/projects/${project.id}/domains/missing`],
      ['DELETE', `/projects/${project.id}/domains/missing`],
    ]) {
      const response = await app.fetch(
        new Request(`http://localhost${path}`, {
          method,
          headers: { Authorization: `Bearer ${user.jwt}` },
        }),
        bindings,
      );
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({ capability: 'customDomains' });
    }
  });

  it('registers no owner destination on project creation, even with a mail domain configured', async () => {
    const user = await createTestUser(env.db);
    await setUserEmail(user.id, 'owner@example.com');
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'email-capability-off' }),
      }),
      capabilityEnv(false, emailEnv()),
    );
    expect(res.status).toBe(201);
    const project = (await res.json()) as { id: string; owner_email_destination?: unknown };
    // The CLI prints this field to explain a verification email that may
    // follow; a platform that cannot send one must not announce it.
    expect(project.owner_email_destination).toBeUndefined();

    expect(cfCalls(fetchMock, 'POST', '/email/routing/addresses')).toHaveLength(0);
    expect(await rowsFor(project.id)).toHaveLength(0);
  });
});
