import { DurableObject } from 'cloudflare:workers';
import type { ApiEnv } from '../env.ts';

/** A poke arms the alarm this far ahead, like `BuildScheduler`. */
const POKE_DELAY_MS = 50;

/**
 * Singleton DO (`idFromName('global')`) that will run the security scan queue.
 *
 * The class and its `security-audits-v1` migration ship on every install, with
 * or without the `securityAudits` capability, so turning the feature on never
 * needs a new migration and turning it off never needs `deleted_classes`. For
 * now it only answers `/poke`, and its alarm does nothing.
 */
export class SecurityScanScheduler extends DurableObject<ApiEnv['Bindings']> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/poke') {
      await this.ctx.storage.setAlarm(Date.now() + POKE_DELAY_MS);
      return Response.json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    // No queue to drain yet.
  }
}
