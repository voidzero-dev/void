import { DurableObject } from 'cloudflare:workers';
import type { ApiEnv } from './env.ts';
import { ensureUsageSigningKey, signUsageEvent } from './usage-auth.ts';
import type { UsageEvent } from './usage-counter.ts';

export const RECONCILE_INTERVAL_MS = 60_000;

export type SandboxUsageAttribution = Readonly<{
  projectId: string;
  userId: string;
  slug: string;
}>;

export type SandboxControlResult =
  | { ok: true }
  | { ok: false; reason: 'concurrency' | 'runtime_budget' | 'unavailable' };

type Entry = {
  generation: string;
  attribution: SandboxUsageAttribution;
  /** Only a confirmed container start begins billing. Reservations are unbilled. */
  startedAt?: number;
  meteredThrough?: number;
  /** Persist before publishing, so a queue outage cannot bill time after stop. */
  stoppedAt?: number;
};

type EntriesMap = Record<string, Entry>;
// The previous tenant-controlled lease namespace is deliberately never adopted.
// The upgrade drain removes its containers before this protocol is admitted.
const STORAGE_KEY = 'controlled-entries-v1';
const COMPLETIONS_KEY = 'controlled-completions-v1';
const COMPLETION_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_COMPLETIONS = 4096;
const unavailable: SandboxControlResult = { ok: false, reason: 'unavailable' };

/** Account-wide capacity and usage, callable only through the private SandboxControl entrypoint. */
export class SandboxConcurrencyCounter extends DurableObject<ApiEnv['Bindings']> {
  private entries: EntriesMap | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    // Queue/network I/O releases the DO input gate. Hold application ordering
    // through persistence so delayed heartbeats cannot resurrect released runs.
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async getEntries(): Promise<EntriesMap> {
    if (!this.entries) {
      this.entries = (await this.ctx.storage.get<EntriesMap>(STORAGE_KEY)) ?? {};
    }
    return { ...this.entries };
  }

  private async saveEntries(entries: EntriesMap): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY, entries);
    this.entries = { ...entries };
  }

  private async ensureAlarm(): Promise<void> {
    if (!(await this.ctx.storage.getAlarm())) {
      await this.ctx.storage.setAlarm(Date.now() + RECONCILE_INTERVAL_MS);
    }
  }

  private completionKey(id: string, generation: string): string {
    return JSON.stringify([id, generation]);
  }

  private async completions(): Promise<Record<string, number>> {
    const stored = (await this.ctx.storage.get<Record<string, number>>(COMPLETIONS_KEY)) ?? {};
    const cutoff = Date.now() - COMPLETION_RETENTION_MS;
    return Object.fromEntries(
      Object.entries(stored)
        .filter(([, completedAt]) => completedAt >= cutoff)
        .sort((left, right) => left[1] - right[1])
        .slice(-MAX_COMPLETIONS),
    );
  }

  private async hasCompletion(id: string, generation: string): Promise<boolean> {
    return this.completionKey(id, generation) in (await this.completions());
  }

  private async recordCompletion(id: string, generation: string): Promise<void> {
    const completions = await this.completions();
    completions[this.completionKey(id, generation)] = Date.now();
    const bounded = Object.fromEntries(
      Object.entries(completions)
        .sort((left, right) => left[1] - right[1])
        .slice(-MAX_COMPLETIONS),
    );
    await this.ctx.storage.put(COMPLETIONS_KEY, bounded);
  }

  private withinLimit(entries: EntriesMap, id: string, limit: number): boolean {
    // A plan downgrade deterministically preserves at most the new capacity.
    // Stopping reservations still consume capacity until their receipt commits.
    return limit === 0 || Object.keys(entries).sort().indexOf(id) < limit;
  }

  private async meterThrough(id: string, entry: Entry, through: number): Promise<Entry> {
    if (entry.startedAt === undefined) {
      return entry;
    }
    const from = entry.startedAt;
    const seconds = Math.floor(Math.max(0, through - from) / 1000);
    const meteredThrough = from + seconds * 1000;
    if (meteredThrough <= (entry.meteredThrough ?? from)) {
      return entry;
    }
    // Include the random run generation, not just its millisecond start time.
    const instance = JSON.stringify([id, entry.generation]);
    const event: UsageEvent = {
      ...entry.attribution,
      requests: 0,
      responseBytes: 0,
      sandboxInstanceId: instance,
      sandboxMeteredFrom: from,
      sandboxMeteredThrough: meteredThrough,
    };
    if (!this.env.USAGE_EVENTS_QUEUE) {
      throw new Error('trusted usage queue binding is unavailable');
    }
    const key = await ensureUsageSigningKey(this.env.ROUTING, this.env.JWT_SECRET);
    await this.env.USAGE_EVENTS_QUEUE.send(
      await signUsageEvent(
        key,
        'sandbox-counter',
        `sandbox:${instance}:${from}:${meteredThrough}`,
        event,
      ),
    );
    return { ...entry, meteredThrough };
  }

  async reserve(
    id: string,
    generation: string,
    limit: number,
    attribution: SandboxUsageAttribution,
  ): Promise<SandboxControlResult> {
    return this.serialize(async () => {
      const entries = await this.getEntries();
      const current = entries[id];
      if (current) {
        if (current.generation !== generation || current.stoppedAt !== undefined) {
          return unavailable;
        }
        return this.withinLimit(entries, id, limit)
          ? { ok: true }
          : { ok: false, reason: 'concurrency' };
      }
      // A timed-out reserve can finish after stop. Never admit that run again.
      if (await this.hasCompletion(id, generation)) {
        return unavailable;
      }
      if (limit !== 0 && Object.keys(entries).length >= limit) {
        return { ok: false, reason: 'concurrency' };
      }
      entries[id] = { generation, attribution };
      await this.saveEntries(entries);
      return { ok: true };
    });
  }

  async started(id: string, generation: string, limit: number): Promise<SandboxControlResult> {
    return this.serialize(async () => {
      const entries = await this.getEntries();
      const current = entries[id];
      if (!current || current.generation !== generation || current.stoppedAt !== undefined) {
        return unavailable;
      }
      if (!this.withinLimit(entries, id, limit)) {
        return { ok: false, reason: 'concurrency' };
      }
      if (current.startedAt === undefined) {
        entries[id] = { ...current, startedAt: Date.now() };
        await this.saveEntries(entries);
      }
      return { ok: true };
    });
  }

  async heartbeat(id: string, generation: string, limit: number): Promise<SandboxControlResult> {
    return this.serialize(async () => {
      const entries = await this.getEntries();
      const current = entries[id];
      if (!current || current.generation !== generation || current.stoppedAt !== undefined) {
        return unavailable;
      }
      if (!this.withinLimit(entries, id, limit)) {
        return { ok: false, reason: 'concurrency' };
      }
      entries[id] = await this.meterThrough(id, current, Date.now());
      await this.saveEntries(entries);
      return { ok: true };
    });
  }

  /** The trusted controller calls this only after confirming the container stopped. */
  async stopped(id: string, generation: string): Promise<void> {
    const stoppedAt = Date.now();
    return this.serialize(async () => {
      const entries = await this.getEntries();
      const current = entries[id];
      if (!current || current.generation !== generation) {
        // Stop may overtake a reserve request whose transport timed out.
        await this.recordCompletion(id, generation);
        return;
      }
      if (current.stoppedAt === undefined) {
        entries[id] = { ...current, stoppedAt };
        await this.saveEntries(entries);
      }
      // Retry final usage even if the controller is subsequently deleted.
      await this.ensureAlarm();
      await this.finishStopped(entries, id);
    });
  }

  /** Called only after the API confirms every container for a deployment is gone. */
  async revokeDeployment(projectId: string, deploymentId: string): Promise<void> {
    const stoppedAt = Date.now();
    return this.serialize(async () => {
      const entries = await this.getEntries();
      const matching = Object.keys(entries).filter((id) => {
        try {
          const identity = JSON.parse(id) as unknown;
          return (
            Array.isArray(identity) && identity[0] === projectId && identity[1] === deploymentId
          );
        } catch {
          return false;
        }
      });
      if (matching.length === 0) {
        return;
      }
      for (const id of matching) {
        const entry = entries[id];
        if (entry.stoppedAt === undefined) {
          entries[id] = { ...entry, stoppedAt };
        }
      }
      await this.saveEntries(entries);
      await this.ensureAlarm();
      for (const id of matching) {
        await this.finishStopped(entries, id);
      }
    });
  }

  private async finishStopped(entries: EntriesMap, id: string): Promise<void> {
    const entry = entries[id];
    if (entry.stoppedAt === undefined) {
      throw new Error('Cannot finalize a sandbox lease before it has stopped.');
    }
    await this.meterThrough(id, entry, entry.stoppedAt);
    // Receipt precedes capacity release; any partial failure is safe to retry.
    await this.recordCompletion(id, entry.generation);
    delete entries[id];
    await this.saveEntries(entries);
  }

  async alarm(): Promise<void> {
    return this.serialize(async () => {
      const entries = await this.getEntries();
      for (const [id, entry] of Object.entries(entries)) {
        if (entry.stoppedAt !== undefined) {
          await this.finishStopped(entries, id);
        }
      }
      // Never infer stop from age or meter unverified time. The controller's
      // own alarm verifies liveness and destroys denied containers.
    });
  }
}
