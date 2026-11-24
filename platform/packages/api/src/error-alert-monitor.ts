import { DurableObject } from 'cloudflare:workers';
import { createDb, getUser, getProject } from './db.ts';
import { sendErrorAlertEmail } from './email.ts';
import type { ApiEnv } from './env.ts';

const DEBOUNCE_MS = 120_000; // 2 minutes
const COUNT_CAP = 100; // immediate fire
const COOLDOWN_MS = 86_400_000; // 24 hours

type ErrorAlertState = {
  count: number;
  projectId: string;
  userId: string;
  slug: string;
  lastAlertAt: number | null;
  // Bounds of the errors currently accumulated in `count`. `firstErrorAt`
  // persists across the cooldown so a burst whose tail piled up while
  // suppressed still reports its true start time in the alert email.
  firstErrorAt: number | null;
  lastErrorAt: number | null;
};

export class ErrorAlertMonitor extends DurableObject<ApiEnv['Bindings']> {
  private state: ErrorAlertState | null = null;

  private async getState(): Promise<ErrorAlertState> {
    if (this.state) {
      return this.state;
    }
    const stored = await this.ctx.storage.get<Partial<ErrorAlertState>>('state');
    // Spread over defaults so legacy state (no firstErrorAt/lastErrorAt) backfills
    // to null rather than undefined.
    this.state = {
      count: 0,
      projectId: '',
      userId: '',
      slug: '',
      lastAlertAt: null,
      firstErrorAt: null,
      lastErrorAt: null,
      ...stored,
    };
    return this.state;
  }

  private async saveState(state: ErrorAlertState): Promise<void> {
    this.state = state;
    await this.ctx.storage.put('state', state);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/record') {
      return this.handleRecord(request);
    }
    return new Response('not found', { status: 404 });
  }

  private async handleRecord(request: Request): Promise<Response> {
    const body = await request.json<{
      projectId: string;
      count: number;
      userId: string;
      slug: string;
      // Edge enqueue times of the errors in this batch, carried from the usage
      // queue. Absent only on legacy in-flight calls — fall back to ingest time.
      firstAt?: number;
      lastAt?: number;
    }>();

    const state = await this.getState();
    const now = Date.now();
    const firstAt = body.firstAt ?? now;
    const lastAt = body.lastAt ?? now;
    if (state.count === 0) {
      // Accumulation starts from empty — the batch defines the window.
      state.firstErrorAt = firstAt;
      state.lastErrorAt = lastAt;
    } else {
      // Widen with min/max rather than assigning: queue batches can arrive out
      // of order, so a later batch may report errors older than what we hold.
      // Legacy state (written before this field existed) leaves these null; keep
      // them null so the email falls back to "recently" instead of claiming a
      // window that excludes the errors already counted.
      if (state.firstErrorAt !== null) {
        state.firstErrorAt = Math.min(state.firstErrorAt, firstAt);
      }
      if (state.lastErrorAt !== null) {
        state.lastErrorAt = Math.max(state.lastErrorAt, lastAt);
      }
    }
    state.count += body.count;
    state.projectId = body.projectId;
    state.userId = body.userId;
    state.slug = body.slug;

    // Within cooldown — accumulate but don't schedule alarm
    if (state.lastAlertAt && now - state.lastAlertAt < COOLDOWN_MS) {
      await this.saveState(state);
      return Response.json({ ok: true });
    }

    if (state.count >= COUNT_CAP) {
      await this.fireAlert(state);
      return Response.json({ ok: true });
    }

    // Debounce — reset alarm to now + 2 minutes
    await this.ctx.storage.setAlarm(now + DEBOUNCE_MS);
    await this.saveState(state);
    return Response.json({ ok: true });
  }

  async alarm(): Promise<void> {
    const state = await this.getState();

    if (state.lastAlertAt && Date.now() - state.lastAlertAt < COOLDOWN_MS) {
      this.resetWindow(state);
      await this.saveState(state);
      return;
    }

    await this.fireAlert(state);
  }

  private resetWindow(state: ErrorAlertState): void {
    state.count = 0;
    state.firstErrorAt = null;
    state.lastErrorAt = null;
  }

  private async fireAlert(state: ErrorAlertState): Promise<void> {
    if (!this.env.EMAIL) {
      this.resetWindow(state);
      await this.ctx.storage.deleteAlarm();
      await this.saveState(state);
      return;
    }

    try {
      const db = createDb(this.env.HYPERDRIVE.connectionString);
      const user = await getUser(db, state.userId);
      if (!user?.email) {
        // No email on record — not transient, don't retry
        this.resetWindow(state);
        await this.ctx.storage.deleteAlarm();
        await this.saveState(state);
        return;
      }
      // Resolve canonical slug from DB — dispatch may have sent a hostname for custom-domain traffic
      const project = await getProject(db, state.projectId);
      const slug = project?.slug ?? state.slug;
      const errorWindow =
        state.firstErrorAt !== null && state.lastErrorAt !== null
          ? { start: state.firstErrorAt, end: state.lastErrorAt }
          : null;
      await sendErrorAlertEmail(this.env, user.email, slug, state.count, errorWindow);
      // Success — cooldown and reset
      state.lastAlertAt = Date.now();
      this.resetWindow(state);
      await this.ctx.storage.deleteAlarm();
      await this.saveState(state);
    } catch (err) {
      // Transient failure — keep count and schedule retry
      console.error('[error-alert-monitor] failed to send alert:', err);
      await this.ctx.storage.setAlarm(Date.now() + DEBOUNCE_MS);
      await this.saveState(state);
    }
  }
}
