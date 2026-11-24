import { sql as drizzleSql } from 'drizzle-orm';
import { getDomain, getProject, updateDomainStatus, updateDomainVerificationData } from '../db.ts';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { projectRouteKey } from '../routing.ts';
import type { DomainVerificationData } from '../schema.ts';
import type { Domain, Project } from '../types.ts';
import { ZeroTrustUnavailableError } from '../zero-trust/errors.ts';
import { reconcileProjectZeroTrustDomains } from '../zero-trust/project.ts';
import {
  resolveProjectZeroTrustRoutingForPublication,
  withProjectZeroTrustRouting,
} from '../zero-trust/routing.ts';
import { getCustomHostname, patchCustomHostname } from './cloudflare-api.ts';
import type { CustomHostnameInfo } from './cloudflare-api.ts';

export type ActivateDomainResult = Readonly<{
  cf: CustomHostnameInfo;
  gateOk: boolean;
  activated: boolean; // true iff THIS call wrote KV + flipped status -> active
  awaitingDeployment: boolean; // gate passed but project has no slug routing yet
}>;

// Polls CF, evaluates the activation gate, and — when satisfied and the project
// has live slug routing — copies the slug routing entry to `domain:<host>` in KV
// and flips the DB row to active. Also refreshes verification_data. Mutates the
// passed `domain` object's `status`/`verification_data` in place so a caller can
// spread it directly. Shared by the status route and the reconciliation cron so
// the security gate has ONE definition. Note: when `wasPending` is false (domain
// already active), `slugRouting` is not fetched and `awaitingDeployment` is
// therefore always false — callers should pass pending rows.
//
// `options.retriggerDcv` gates the best-effort HTTP-DCV re-trigger PATCH (see the
// PATCH block below). It defaults to OFF: the status route and the janitor never
// PATCH. Only the HOURLY reconcile tier passes `true`, which bounds the
// per-account CF custom-hostname API load — a burst of young pending domains on
// the every-2-min fast tier would otherwise fire ~N PATCH/2min and risk 429ing
// other tenants' hostname operations, while CF's own sub-minute early retries
// already cover that window. The PATCH's real value (re-triggering the long tail
// + resetting CF's decaying 7-day backoff) is fully served by the hourly cadence.
export async function tryActivateDomain(
  env: ApiEnv['Bindings'],
  db: Db,
  domain: Domain,
  project: Project,
  options?: { retriggerDcv?: boolean },
): Promise<ActivateDomainResult> {
  // Capture original pending status before any mutation so awaitingDeployment
  // is computed against the pre-mutation state.
  const wasPending = domain.status === 'pending';

  const cf = await getCustomHostname(env.CF_ZONE_ID, env.CF_API_TOKEN, domain.cf_hostname_id);

  // Custom-hostname validation has two independent axes:
  //   - Hostname OWNERSHIP — the input to the top-level `status`. CF accepts
  //     the `_cf-custom-hostname` TXT (`ownership_verification`), the HTTP
  //     token, or a CNAME to the SaaS zone (real-time validation).
  //   - Certificate DCV — `ssl.method` / `ssl.validation_records`, the input
  //     to `ssl.status`.
  // Because the CNAME alone proves ownership, a leftover or wildcard CNAME
  // (`*.victim → cname.void.app`) lets whoever adds the hostname first
  // activate it. Other hosting platforms accept the same trade-off; we keep
  // it so setup needs only the traffic CNAME. Cert DCV (HTTP-based,
  // edge-validated, auto-renewing) is orthogonal and method-agnostic here,
  // which also keeps pending domains still on `txt` DCV activatable.
  //
  // The primary signal is CF's own `status === 'active'`. The absence of
  // BOTH outstanding ownership challenges — the TXT `ownership_verification`
  // AND the HTTP `ownership_verification_http` — is defense-in-depth on top
  // of that (CF stops returning them once ownership is proven), so we refuse
  // to route even if CF ever surfaced `active` with an ownership challenge
  // still outstanding.
  const gateOk =
    cf.status === 'active' &&
    cf.ssl.status === 'active' &&
    !cf.ownership_verification &&
    !cf.ownership_verification_http;

  // Only activate after KV routing is in place. If the project has never
  // been deployed, `project.slug` is absent from KV; leaving the DB row in
  // 'pending' ensures the next poll retries (a future deploy populates the
  // slug entry).
  // Self-healing ordering: write KV BEFORE flipping the DB row to `active`.
  // A crash between the KV write and the DB flip leaves the row `pending`, so
  // the next poll/cron retries and re-writes the same KV entry — the system
  // heals itself. The converse ordering (DB flip first) would strand an
  // `active` row with no route, producing 404s until a manual deploy or fix.
  // Read slug routing whenever the CF gate is satisfied so we can surface
  // `awaitingDeployment` to the caller regardless of whether activation
  // actually happened (activation also requires `domain.status === 'pending'`).
  let slugRouting: string | null = null;
  let activated = false;
  if (gateOk && wasPending) {
    // A protected project needs an exact-host Access application and its
    // audience in dispatch routing before this custom hostname can become
    // reachable. Reconciliation is idempotent and fails closed: a Cloudflare
    // API failure leaves the domain pending with no routing entry.
    await reconcileProjectZeroTrustDomains(env, db, project.id, { verifiedDomainId: domain.id });
    await db.transaction(async (tx) => {
      await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${project.id} FOR UPDATE`);
      const [lockedProject, lockedDomain] = await Promise.all([
        getProject(tx, project.id),
        getDomain(tx, domain.id),
      ]);
      if (
        !lockedProject ||
        lockedProject.status === 'deleting' ||
        lockedDomain?.status !== 'pending'
      ) {
        return;
      }
      slugRouting = await env.ROUTING.get(projectRouteKey(lockedProject));
      if (!slugRouting) {
        return;
      }
      // Activation is retried while the domain stays pending, so unknown
      // protection, or a cached slug route that still belongs to a deleted
      // project, keeps it pending instead of publishing a route.
      let published;
      try {
        const protection = await resolveProjectZeroTrustRoutingForPublication(tx, project.id, {
          retryable: true,
        });
        published = withProjectZeroTrustRouting(slugRouting, protection, project.id);
      } catch (error) {
        if (error instanceof ZeroTrustUnavailableError) {
          return;
        }
        throw error;
      }
      await env.ROUTING.put(`domain:${lockedDomain.hostname}`, published);
      await updateDomainStatus(tx, lockedDomain.id, 'active');
      activated = true;
      domain.status = 'active';
    });
  }

  const awaitingDeployment = gateOk && wasPending && !slugRouting;

  if (cf.ownership_verification || cf.ssl.validation_records) {
    const verificationData: DomainVerificationData = {
      ownership_verification: cf.ownership_verification,
      ssl_validation_records: cf.ssl.validation_records,
    };
    await updateDomainVerificationData(db, domain.id, verificationData);
    domain.verification_data = verificationData;
  }

  // Best-effort re-trigger of HTTP DCV for an add-first domain that hasn't yet
  // validated. Void creates the CF hostname with `ssl.method:'http'` before the
  // user points the CNAME at `cname.void.app`; per CF's Create Custom Hostname
  // API docs the PATCH method must be used once the domain is pointing at the
  // Managed CNAME for HTTP validation to complete. A no-change PATCH re-sends
  // the `ssl` block, re-triggering DCV AND resetting CF's decaying validation
  // backoff so a user who fixes DNS doesn't wait out the slowing retry schedule
  // (and avoids CF's 7-day delete). Gated on:
  //   - `options.retriggerDcv` — only the hourly reconcile tier opts in, to
  //     bound CF custom-hostname API load (see the function-level comment).
  //   - `wasPending && !gateOk` — skip if already gated (validated) or active.
  //   - `cf.ssl.method === 'http'` — only re-trigger HTTP-DCV hostnames. A
  //     LEGACY pending hostname still on `txt` (created under the old TXT-DCV
  //     flow, user still publishing `_acme-challenge` records) must keep its
  //     existing method — switching it to HTTP-DCV would discard the user's
  //     in-progress validation and break the no-migration guarantee.
  // Fully isolated — a PATCH failure must never throw or affect the result.
  if (options?.retriggerDcv && wasPending && !gateOk && cf.ssl.method === 'http') {
    await patchCustomHostname(env.CF_ZONE_ID, env.CF_API_TOKEN, domain.cf_hostname_id).catch(
      (err) =>
        console.error(
          `[activate-domain] failed to re-trigger HTTP DCV for ${domain.hostname}:`,
          err,
        ),
    );
  }

  return { cf, gateOk, activated, awaitingDeployment };
}
