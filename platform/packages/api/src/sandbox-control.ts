import { PLATFORM_DISABLED_KEY, PLATFORM_DISABLED_VALUE } from '@void/platform';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { and, eq, sql } from 'drizzle-orm';
import { getPlatformCapabilities } from './capabilities.ts';
import { createDb } from './db.ts';
import type { ApiEnv } from './env.ts';
import { resolvePlanLimits } from './plans.ts';
import { sandboxBlockKey } from './routing.ts';
import type { SandboxControlResult } from './sandbox-concurrency-counter.ts';
import { readSandboxDrainCheckpoint } from './sandbox-drain.ts';
import { deployments, projects, users } from './schema.ts';
import { REASON_SANDBOX_RUNTIME_EXCEEDED } from './suspension.ts';

type SandboxControllerIdentity = Readonly<{
  projectId: string;
  deploymentId: string;
  userId: string;
  slug: string;
}>;

const unavailable: SandboxControlResult = { ok: false, reason: 'unavailable' };
const validIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128;

/**
 * This entrypoint has no HTTP route. Only a platform-owned controller receives
 * its service binding; Cloudflare sets immutable identity props on that binding.
 * Never bind or return it (or the counter namespace) to a tenant Worker.
 */
export class SandboxControl extends WorkerEntrypoint<
  ApiEnv['Bindings'],
  SandboxControllerIdentity
> {
  private identity(): SandboxControllerIdentity | null {
    const props = this.ctx.props;
    return props &&
      validIdentifier(props.projectId) &&
      validIdentifier(props.deploymentId) &&
      validIdentifier(props.userId) &&
      validIdentifier(props.slug)
      ? props
      : null;
  }

  private instanceId(identity: SandboxControllerIdentity, instance: string): string {
    return JSON.stringify([identity.projectId, identity.deploymentId, instance]);
  }

  private counter(identity: SandboxControllerIdentity) {
    const namespace = this.env.SANDBOX_CONCURRENCY_COUNTER;
    return namespace.get(namespace.idFromName(`account:${identity.userId}`));
  }

  private async authorize(
    identity: SandboxControllerIdentity,
  ): Promise<
    | { ok: true; limit: number; slug: string }
    | { ok: false; reason: 'runtime_budget' | 'unavailable' }
  > {
    if (
      !getPlatformCapabilities(this.env).sandbox ||
      this.env.PLATFORM_TRAFFIC_STATE === 'staging' ||
      this.env.PLATFORM_TRAFFIC_STATE === 'sandbox-drain' ||
      (await this.env.ROUTING.get(PLATFORM_DISABLED_KEY)) === PLATFORM_DISABLED_VALUE
    ) {
      return { ok: false, reason: 'unavailable' };
    }
    const db = createDb(this.env.HYPERDRIVE.connectionString);
    const checkpoint = await readSandboxDrainCheckpoint(db);
    if (!checkpoint || checkpoint.state !== 'complete' || checkpoint.admission_protocol < 3) {
      return { ok: false, reason: 'unavailable' };
    }
    // One database snapshot resolves authority; routing KV is not an ownership
    // or plan cache. Fresh prerender/cutover candidates may run under their
    // deployment fence, but failed, abandoned and retained deployments cannot.
    const [authority] = await db
      .select({
        project: projects,
        deployment: deployments,
        owner: users,
        candidateFresh: sql<boolean>`CASE
          WHEN ${deployments.status} = 'prerendering'
            THEN ${deployments.updated_at} > now() - interval '10 minutes'
          WHEN ${deployments.status} = 'cutover'
            THEN ${deployments.updated_at} > now() - interval '90 minutes'
          ELSE false END`,
      })
      .from(projects)
      .innerJoin(deployments, eq(deployments.project_id, projects.id))
      .innerJoin(users, eq(users.id, projects.user_id))
      .where(and(eq(projects.id, identity.projectId), eq(deployments.id, identity.deploymentId)))
      .limit(1);
    if (!authority) {
      return { ok: false, reason: 'unavailable' };
    }
    const { project, deployment, owner, candidateFresh } = authority;
    if (
      project.status !== 'active' ||
      project.user_id !== identity.userId ||
      owner.id !== identity.userId ||
      deployment.project_id !== project.id ||
      deployment.admission_protocol < 3 ||
      !(
        (deployment.status === 'live' && project.active_deployment_id === deployment.id) ||
        (candidateFresh &&
          (deployment.status === 'prerendering' || deployment.status === 'cutover'))
      )
    ) {
      return { ok: false, reason: 'unavailable' };
    }
    type SandboxManifest = { sandbox?: { runtime?: { protocol?: unknown } } };
    let manifest: SandboxManifest | null;
    try {
      manifest = JSON.parse(deployment.manifest ?? 'null') as SandboxManifest | null;
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    if (manifest?.sandbox?.runtime?.protocol !== 1 && manifest?.sandbox?.runtime?.protocol !== 2) {
      return { ok: false, reason: 'unavailable' };
    }
    if (
      owner.suspended_reason === REASON_SANDBOX_RUNTIME_EXCEEDED ||
      (await this.env.ROUTING.get(sandboxBlockKey(owner.id))) !== null
    ) {
      return { ok: false, reason: 'runtime_budget' };
    }
    if (owner.suspended_reason) {
      return { ok: false, reason: 'unavailable' };
    }
    return {
      ok: true,
      limit: (await resolvePlanLimits(db, owner.plan)).sandboxMaxConcurrentInstances,
      slug: project.slug,
    };
  }

  private async admit(
    action: 'reserve' | 'started' | 'heartbeat',
    instance: string,
    generation: string,
  ): Promise<SandboxControlResult> {
    const identity = this.identity();
    if (!identity || !validIdentifier(instance) || !validIdentifier(generation)) {
      return unavailable;
    }
    const authority = await this.authorize(identity);
    if (!authority.ok) {
      return authority;
    }
    const counter = this.counter(identity);
    const id = this.instanceId(identity, instance);
    return action === 'reserve'
      ? counter.reserve(id, generation, authority.limit, {
          projectId: identity.projectId,
          userId: identity.userId,
          slug: authority.slug,
        })
      : counter[action](id, generation, authority.limit);
  }

  reserve(instance: string, generation: string): Promise<SandboxControlResult> {
    return this.admit('reserve', instance, generation);
  }

  started(instance: string, generation: string): Promise<SandboxControlResult> {
    return this.admit('started', instance, generation);
  }

  heartbeat(instance: string, generation: string): Promise<SandboxControlResult> {
    return this.admit('heartbeat', instance, generation);
  }

  async stopped(instance: string, generation: string): Promise<void> {
    const identity = this.identity();
    if (!identity || !validIdentifier(instance) || !validIdentifier(generation)) {
      throw new Error('Invalid Sandbox controller identity.');
    }
    // Teardown must remain available after deletion, suspension, ownership
    // transfer or DB outage. Props address only this controller's original
    // account and generation; it cannot free another controller's capacity.
    await this.counter(identity).stopped(this.instanceId(identity, instance), generation);
  }
}
