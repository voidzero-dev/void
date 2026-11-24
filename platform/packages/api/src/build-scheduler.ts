import { DurableObject } from 'cloudflare:workers';
import type { BuildManager } from './build-manager.ts';
import { buildManagerNamespace } from './build-namespace.ts';
import { type BuildConfig, isContainerCapacityError } from './build-types.ts';
import {
  cancelQueuedContainerBuildsForUsers,
  claimBuildForStartWithinLimit,
  createDb,
  getGitHubConnection,
  getProject,
  getQueuedBuilds,
  getUsersByIds,
  getUsersWithQueuedContainerBuilds,
  hasGitHubConnectionAuthority,
  hasQueuedContainerBuilds,
  markBuildTerminalIfActive,
  requeueBuildIfStarting,
  updateBuildStatus,
} from './db.ts';
import type { ApiEnv } from './env.ts';
import { readPlanCatalog, planFromCatalog } from './plans.ts';
import { isAdminSuspended } from './suspension.ts';

/** A poke arms the alarm this far ahead so the next scan runs almost immediately. */
const POKE_DELAY_MS = 50;

/** While the queue still has work the alarm reschedules this far ahead. */
const RESCAN_DELAY_MS = 2000;

/** When the container fleet is at capacity, back off this long (jittered) before
 *  re-scanning instead of the normal 2s cadence — avoids burning GitHub/token calls
 *  every tick while builds are stalled. A completion poke re-arms sooner. */
const CAPACITY_BACKOFF_BASE_MS = 20_000;
const CAPACITY_BACKOFF_JITTER_MS = 10_000;

/** Cap on builds inspected per alarm scan (mirrors `getQueuedBuilds` default). */
const SCAN_LIMIT = 50;

/**
 * Singleton DO (`idFromName('global')`) that drains the `executor='container'`
 * build queue. A webhook `POST /poke` arms a near-immediate alarm; the alarm
 * pulls queued builds FIFO, enforces per-user tier concurrency, atomically
 * claims each startable build, and hands it to a per-build BuildManager over
 * DO→DO RPC. The alarm reschedules itself only while the queue is non-empty —
 * an empty queue lets the alarm go quiet until the next poke, exactly like
 * `CronScheduler` lets its alarm lapse when there are no schedules.
 */
export class BuildScheduler extends DurableObject<ApiEnv['Bindings']> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST' && path === '/poke') {
      // Arm a near-immediate alarm relative to the current clock (same
      // clock+offset pattern CronScheduler uses for setAlarm). Idempotent:
      // overwriting an already-armed alarm just keeps the earliest scan.
      await this.ctx.storage.setAlarm(Date.now() + POKE_DELAY_MS);
      return Response.json({ ok: true });
    }
    if (request.method === 'GET' && path === '/status') {
      const alarm = await this.ctx.storage.getAlarm();
      return Response.json({ nextAlarm: alarm });
    }

    return new Response('not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    const db = createDb(this.env.HYPERDRIVE.connectionString);

    // Clear manually suspended owners' whole queues, including builds hidden
    // behind active work, then exclude capped owners to avoid scan starvation.
    const owners = await getUsersWithQueuedContainerBuilds(db);
    const suspendedUserIds = owners
      .filter((owner) => isAdminSuspended(owner.suspendedReason))
      .map((owner) => owner.userId);
    await cancelQueuedContainerBuildsForUsers(db, suspendedUserIds);
    const catalog = await readPlanCatalog(db);
    const cappedUserIds = owners
      .filter((o) => {
        if (isAdminSuspended(o.suspendedReason)) {
          return false;
        }
        const limit = planFromCatalog(catalog, o.plan).limits.concurrentBuilds;
        return limit > 0 && o.activeBuilds >= limit;
      })
      .map((o) => o.userId);

    const queued = await getQueuedBuilds(db, SCAN_LIMIT, cappedUserIds);
    if (queued.length === 0) {
      // No STARTABLE builds this tick. getQueuedBuilds excludes builds whose project
      // already has an active build, so a queue that is fully blocked returns [] here
      // even though queued work remains. Keep the heartbeat armed (rather than relying
      // solely on a completion poke, which can be missed) so the blocked build is
      // retried as soon as its project frees. A genuinely empty queue lets the alarm
      // lapse; a subsequent `/poke` re-arms it.
      if (await hasQueuedContainerBuilds(db)) {
        await this.ctx.storage.setAlarm(Date.now() + RESCAN_DELAY_MS);
      }
      return;
    }

    // Read the selected owners in one query after the queue scan. Admission
    // checks plan and suspension again under the owner lock before any start.
    const usersById = new Map(
      (await getUsersByIds(db, [...new Set(queued.map((build) => build.user_id))])).map((user) => [
        user.id,
        user,
      ]),
    );

    // Container namespaces (fleets) found AT capacity THIS tick. There are
    // two independent container apps — base `BUILD_MANAGER` (free) and
    // `BUILD_MANAGER_LARGE` (paid `standard-4`) — each with its own
    // `max_instances`. `getQueuedBuilds` returns a mixed free+paid list ordered
    // by age, so shedding must be PER-NAMESPACE: one fleet being full must not
    // stall builds that target the other (non-saturated) fleet. Keyed on the
    // stable namespace binding identity (`this.env.BUILD_MANAGER` vs
    // `this.env.BUILD_MANAGER_LARGE`). Per-tick local state — rebuilt each alarm,
    // never persisted. Drives the longer, jittered re-arm so we don't hot-loop
    // GitHub/token calls every 2s while a fleet is full.
    const saturatedNamespaces = new Set<DurableObjectNamespace>();
    for (const build of queued) {
      const user = usersById.get(build.user_id);
      if (!user) {
        // Orphaned build with no owning user — can't attribute concurrency or
        // mint a token. Fail it so it leaves the queue and never blocks.
        await updateBuildStatus(db, build.id, 'failed', {
          error: 'owning user not found',
          completedAt: new Date().toISOString(),
        });
        continue;
      }
      if (isAdminSuspended(user.suspended_reason)) {
        await updateBuildStatus(db, build.id, 'cancelled', {
          error: 'project owner suspended',
          completedAt: new Date().toISOString(),
        });
        continue;
      }

      // Resolve the connection + project BEFORE claiming. A claim flips the row
      // queued->starting (it becomes "active"), but the per-build BuildManager —
      // which owns the wall-clock timeout — is only created later, inside the
      // try/catch around startBuild. If a lookup here THREW after the claim, the
      // alarm would abort with the row stuck `starting` forever: there is no
      // BuildManager to time it out, and the scheduled stale reaper only covers
      // github_actions builds. Doing the lookups first means a transient DB error
      // leaves the build `queued` (retried next tick) and a genuinely missing
      // connection/project marks it failed while it is still terminalizable.
      const connection = await getGitHubConnection(db, build.project_id);
      if (!connection) {
        // A container build can't run without a github connection (no repo to
        // fetch, no installation token). Mark failed and move on.
        await updateBuildStatus(db, build.id, 'failed', {
          error: 'no github connection for project',
          completedAt: new Date().toISOString(),
        });
        continue;
      }
      if (!(await hasGitHubConnectionAuthority(db, connection.id, build.project_id))) {
        await updateBuildStatus(db, build.id, 'cancelled', {
          error: 'github repository authorization is no longer valid; reconnect the repository',
          completedAt: new Date().toISOString(),
        });
        continue;
      }

      // Defense-in-depth: refuse to START a queued build whose stored
      // branch/executor no longer matches the current connection. The enqueue
      // path is serialized on the github_connections row so it won't insert a
      // build for a stale config, but a build that was already queued before the
      // connection flipped (branch retarget, or executor switched to
      // github_actions) must not run here — the JIT freshness check in
      // BuildManager is branch-HEAD-only and does NOT catch a branch/executor
      // mismatch. A config change is not a build failure, so mark it `cancelled`.
      // A row without a branch never matches, so it is cancelled the same way.
      if (build.branch !== connection.branch || build.executor !== connection.build_executor) {
        await updateBuildStatus(db, build.id, 'cancelled', {
          error: 'github connection config changed',
          completedAt: new Date().toISOString(),
        });
        continue;
      }

      const project = await getProject(db, build.project_id);
      if (!project) {
        await updateBuildStatus(db, build.id, 'failed', {
          error: 'project not found',
          completedAt: new Date().toISOString(),
        });
        continue;
      }

      // Persisted sizes can be shed before claiming. Legacy-null rows need the
      // owner's plan under lock before their target fleet is known.
      if (
        build.instance_type &&
        saturatedNamespaces.has(buildManagerNamespace(this.env, build.instance_type))
      ) {
        continue;
      }

      // Admission, legacy size resolution, and the owner plan are read under the
      // same user lock used by GitHub Actions admission.
      const claimed = await claimBuildForStartWithinLimit(db, {
        buildId: build.id,
        userId: build.user_id,
        projectId: build.project_id,
      });
      if (!claimed) {
        continue;
      }
      const instanceType = claimed.instanceType;
      const ns = buildManagerNamespace(this.env, instanceType);
      if (saturatedNamespaces.has(ns)) {
        try {
          await requeueBuildIfStarting(db, build.id);
        } catch (error) {
          console.error(
            `[build-scheduler] failed to requeue build ${build.id} after its fleet saturated; it will be reaped as stale`,
            error,
          );
        }
        continue;
      }

      const config: BuildConfig = {
        buildId: build.id,
        projectId: build.project_id,
        projectSlug: project.slug,
        userId: build.user_id,
        login: user.login,
        commitSha: build.commit_sha ?? '',
        branch: build.branch,
        repoFullName: connection.repo_full_name,
        installationId: connection.installation_id,
        connectionId: connection.id,
        // The build row carries no repository id, so the connection bound to this
        // project (resolved above by the UNIQUE project_id) is the source of
        // truth — mirrors webhooks.ts / auth-oidc.ts. startBuild re-verifies the
        // App installation still covers this repo before minting the deploy
        // token; a missing id fails that check closed.
        repositoryId: connection.repository_id,
        instanceType,
        timeoutMinutes: claimed.timeoutMinutes,
      };

      // `ns` (the build's target fleet) was resolved above; address the per-build
      // BuildManager on it, keyed by build id.
      const stub = ns.get(ns.idFromName(build.id)) as unknown as DurableObjectStub<BuildManager>;
      try {
        await stub.startBuild(config);
      } catch (error) {
        if (isContainerCapacityError(error)) {
          // This build's target fleet (`ns`.max_instances) is full — transient
          // platform pressure, not a build failure. Return the row to `queued` so
          // a later alarm retries it once an instance frees; the heartbeat keeps
          // the alarm armed while queued work remains. Guarded (starting -> queued
          // only): if a concurrent terminalizer (push-supersede, branch/executor
          // change, disconnect, install removal) already drove this claimed row
          // terminal while startBuild was in flight, this no-ops and the terminal
          // status is preserved — a superseded/cancelled commit can't be
          // resurrected here.
          // Mark only THIS fleet saturated and KEEP scanning (do NOT break).
          // There are two independent container fleets; a free build hitting
          // capacity on base must not stall a paid build that targets the (non-
          // saturated) LARGE fleet, and vice versa. Further builds targeting this
          // same saturated fleet are skipped up front (the pre-claim check above),
          // so we never re-run the GitHub compare + token mint against a full
          // fleet — but builds targeting the other fleet still drain this tick.
          // The longer jittered re-arm below backs off until a slot frees (a
          // completion poke re-arms sooner).
          //
          // Mark the fleet saturated BEFORE the requeue write so a transient throw
          // in requeueBuildIfStarting can't escape the loop and leave later
          // same-fleet builds un-skipped or skip the tail re-arm/backoff below.
          // Best-effort requeue (mirrors the generic-error branch's terminal-write
          // guard): on failure the row stays `starting` and the stale reaper
          // reclaims it, while the scan continues and the backoff stays armed.
          saturatedNamespaces.add(ns);
          try {
            await requeueBuildIfStarting(db, build.id);
          } catch (requeueError) {
            console.error(
              `[build-scheduler] failed to requeue build ${build.id} after a capacity error; it will be reaped as stale (continuing the scan so the backoff stays armed)`,
              requeueError,
            );
          }
          continue;
        }
        // Defense-in-depth: a throw here must not abort the rest of the scan.
        // BuildManager.startBuild already fails the row + frees the slot on a
        // pre-alarm error, but a transport-level RPC failure (the manager never
        // reaches its own catch) would otherwise leave the row stuck `starting`
        // and permanently consume a concurrency slot. Mark it failed so the slot
        // frees, then keep draining the queue.
        //
        // CAS terminal-if-active (NOT an unconditional write): a concurrent cancel
        // (terminateBuildsForProject commits 'cancelled' out-of-band, then the
        // cancelBuild RPC) can have already driven this claimed row terminal while
        // startBuild was in flight. An unconditional updateBuildStatus('failed')
        // would clobber that 'cancelled' to 'failed'; the CAS no-ops on an
        // already-terminal row (the slot is already freed).
        //
        // Best-effort: a transient Hyperdrive/Postgres error on THIS write must
        // not abort `alarm()` before the tail reschedule below. Without the
        // try/catch the throw escapes the loop AND skips the re-arm, so the global
        // scheduler goes quiet while this row stays `starting` (slot held) until an
        // unrelated poke or the stale reaper. Swallow + log instead: the row is
        // reaped, and the heartbeat below stays armed so the rest of the queue
        // keeps draining. Mirrors BuildManager's finally-poke invariant for its own
        // terminal write.
        const message = error instanceof Error ? error.message : String(error);
        try {
          await markBuildTerminalIfActive(db, build.id, 'failed', {
            error: `failed to start build: ${message}`,
            completedAt: new Date().toISOString(),
          });
        } catch (writeError) {
          console.error(
            `[build-scheduler] failed to mark build ${build.id} failed after a startBuild RPC error; continuing the scan so the queue heartbeat stays armed`,
            writeError,
          );
        }
      }
    }

    // Reschedule while ANY queued container build remains — not just startable
    // ones. `getQueuedBuilds` surfaces only builds whose project is idle, so
    // a queue that is fully blocked (every project has an active build) returns
    // []; if we keyed the heartbeat off that, blocked builds would resume only
    // on a completion poke and a missed poke would strand them. `hasQueued*`
    // keeps the alarm armed until the queue is genuinely empty, so a freed
    // project is always picked up on the next tick. Compute the wake time from
    // the current clock + offset, exactly like CronScheduler.
    if (await hasQueuedContainerBuilds(db)) {
      // When at least one fleet hit capacity this tick, back off with a jittered
      // delay instead of the normal 2s cadence — otherwise we'd re-run the GitHub
      // compare + token mint every 2s for builds that will keep hitting the full
      // fleet. The backoff is only the missed-poke backstop: BuildManager.onStop /
      // timeout / cancelBuild all pokeScheduler() (a ~50ms alarm), and setAlarm
      // overwrites the pending backoff to the earliest armed time, so a freed slot
      // pulls the next scan in immediately.
      const delay =
        saturatedNamespaces.size > 0
          ? CAPACITY_BACKOFF_BASE_MS + Math.floor(Math.random() * CAPACITY_BACKOFF_JITTER_MS)
          : RESCAN_DELAY_MS;
      await this.ctx.storage.setAlarm(Date.now() + delay);
    }
  }
}
