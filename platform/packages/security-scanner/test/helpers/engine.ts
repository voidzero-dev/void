import { expect } from 'vite-plus/test';
import { LAST_FAILURE_PATH } from '../../src/runner/engines/proxy-failure.ts';
import type { Engine, SessionSpec } from '../../src/runner/engines/types.ts';
import type { ScanReport } from '../../src/runner/report.ts';
import type { OutcomeBody } from '../../src/runner/status.ts';
import { record } from './findings.ts';

/** A hunt session spec. */
export function spec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  return {
    phase: 'hunt',
    index: 0,
    system: 'system text',
    prompt: 'hunt',
    maxTurns: 40,
    ...overrides,
  };
}

/** The proxy last-failure route at `http://model.test`: the next failure, then the last. */
export function fetchOf(failures: Array<unknown>): typeof fetch {
  let index = 0;
  return async (input: string | URL | Request) => {
    expect(String(input)).toBe(`http://model.test${LAST_FAILURE_PATH}`);
    return Response.json({ failure: failures[Math.min(index++, failures.length - 1)] });
  };
}

export function reportOf(raws: Array<Record<string, unknown>>, runStatus = 'complete'): ScanReport {
  return {
    run_status: runStatus as ScanReport['run_status'],
    findings: raws.map(record),
    notes: '',
  };
}

/** A session that submitted these raw records. */
export function submitted(raws: Array<Record<string, unknown>>, runStatus?: string): OutcomeBody {
  return { kind: 'submitted', report: reportOf(raws, runStatus), repaired: false };
}

type Unread = OutcomeBody & { reads?: number };

/** A session outcome from a session that read no file. */
export function unread(body: OutcomeBody): OutcomeBody {
  return { ...body, reads: 0 } as Unread;
}

type Scripted = OutcomeBody | ((spec: SessionSpec) => OutcomeBody | Promise<OutcomeBody>);

/** An engine that answers sessions from a script and records the specs it got. */
export function scriptedEngine(script: Array<Scripted>): Engine & { specs: Array<SessionSpec> } {
  const specs: Array<SessionSpec> = [];
  return {
    id: 'void_loop',
    version: 'test',
    specs,
    async runSession(spec) {
      specs.push(spec);
      const next = script.shift();
      if (next === undefined) {
        throw new Error(`no scripted session for ${spec.phase} ${spec.index}`);
      }
      const { reads = 1, ...body } = (await (typeof next === 'function'
        ? next(spec)
        : next)) as Unread;
      return {
        ...body,
        stats: { turns: 2, modelCalls: 2, inputTokens: 100, outputTokens: 10, reads },
      };
    },
  };
}
