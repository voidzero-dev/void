import type { BuildManager } from '../build-manager.ts';
import { buildManagerNamespace } from '../build-namespace.ts';
import type { ApiEnv } from '../env.ts';
import type { Build } from '../types.ts';

/**
 * Best-effort stop the BuildManager DO for each cancelled CONTAINER build.
 *
 * Terminalizing the build row (→ `cancelled`) is what actually revokes its
 * deploy token: the middleware guard rejects any deploy token whose bound
 * build is no longer in `ACTIVE_BUILD_STATUSES`. This step is a non-security
 * cleanup that also tears down the still-running container so it stops billing.
 *
 * Called AFTER the DB transaction commits — never while holding a row lock — so
 * an external DO round-trip can't extend the lock hold across the network. A
 * never-started queued container build has no live DO, so its `cancelBuild()` is
 * a harmless no-op. `github_actions` builds have no DO and are skipped here:
 * terminalizing their row is what revokes their token. Failures are swallowed:
 * the token is already revoked by the committed status flip.
 *
 * Uses the trusted `cancelBuild` RPC on BuildManager (NOT the agent-authenticated
 * POST /cancel — that secret is minted inside the DO and unavailable here).
 * Without it a 0/unlimited-plan build (no timeout alarm) could run far past any
 * sane ceiling.
 *
 * The container size is a distinct DO class per size (`@cloudflare/containers`
 * has no per-start sizing), so the cancel MUST address the SAME namespace the
 * scheduler started the build on — keyed off the build's persisted
 * `instance_type`. `buildManagerNamespace` maps `standard-4` → `BUILD_MANAGER_LARGE`
 * and everything else (free, legacy, null/unknown) → the base `BUILD_MANAGER`.
 * Cancelling a paid build against the base namespace would hit a DIFFERENT, empty
 * DO and leave the real container running until its own timeout/idle-net.
 */
export async function cancelContainerBuildDos(
  env: ApiEnv['Bindings'],
  cancelled: ReadonlyArray<{
    id: string;
    executor: Build['executor'];
    instance_type?: string | null;
  }>,
  reason = 'build cancelled',
): Promise<void> {
  for (const build of cancelled) {
    if (build.executor !== 'container') {
      continue;
    }
    try {
      const ns = buildManagerNamespace(env, build.instance_type);
      const stub = ns.get(ns.idFromName(build.id)) as DurableObjectStub<BuildManager>;
      await stub.cancelBuild(reason);
    } catch (err) {
      console.warn(`[github] best-effort cancel of build ${build.id} failed:`, err);
    }
  }
}
