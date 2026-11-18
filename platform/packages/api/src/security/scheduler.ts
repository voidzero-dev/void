import { DurableObject } from 'cloudflare:workers';
import type { ApiEnv } from '../env.ts';
import {
  admitModelCall,
  forgetModelCalls,
  readModelCallFailure,
  recordModelCallFailure,
  type AdmitModelCall,
  type AdmitModelCallResult,
  type ModelCallFailure,
} from './call-ledger.ts';

/** A poke arms the alarm this far ahead, like `BuildScheduler`. */
const POKE_DELAY_MS = 50;

/**
 * Singleton DO (`idFromName('global')`) that will run the security scan queue.
 *
 * The class and its `security-audits-v1` migration ship on every install, with
 * or without the `securityAudits` capability, so turning the feature on never
 * needs a new migration and turning it off never needs `deleted_classes`. For
 * now it answers `/poke` (its alarm does nothing) and keeps the model proxy's
 * per-attempt call state (`call-ledger.ts`): session counts, the `@cf` rate guard
 * and the last refused call.
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

  /** Model proxy: count the call for its session and take a `@cf` rate token. */
  async admitModelCall(input: AdmitModelCall): Promise<AdmitModelCallResult> {
    return admitModelCall(this.ctx.storage, input);
  }

  async recordModelCallFailure(
    scanId: string,
    attempt: number,
    failure: ModelCallFailure,
  ): Promise<void> {
    await recordModelCallFailure(this.ctx.storage, scanId, attempt, failure);
  }

  async modelCallFailure(scanId: string, attempt: number): Promise<ModelCallFailure | null> {
    return readModelCallFailure(this.ctx.storage, scanId, attempt);
  }

  /** Called when an attempt ends (result ingest, reaper), so nothing is kept for it. */
  async forgetModelCalls(scanId: string, attempt: number): Promise<number> {
    return forgetModelCalls(this.ctx.storage, scanId, attempt);
  }
}
