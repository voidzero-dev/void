import { describe, expect, it } from 'vite-plus/test';
import { securityFingerprintKey } from '../../src/security/findings.ts';
import {
  buildSecurityMemory,
  SECURITY_MEMORY_HISTORY_MAX_FILES,
  SECURITY_MEMORY_INDEX_MAX_BYTES,
  SECURITY_MEMORY_INDEX_MAX_RECORDS,
  securityAuthorRole,
} from '../../src/security/input/memory.ts';
import type {
  SecurityMemoryEvent,
  SecurityMemoryFinding,
  SecurityMemoryInput,
} from '../../src/security/input/memory.ts';

let nextNumber = 1;

function finding(overrides: Partial<SecurityMemoryFinding> = {}): SecurityMemoryFinding {
  const number = overrides.number ?? nextNumber++;
  return {
    id: `fnd_${number}`,
    number,
    fingerprintKey: `key-${number}`,
    modelFingerprint: `model-${number}`,
    verdict: 'confirmed',
    severity: 'medium',
    title: `Finding ${number}`,
    category: 'injection',
    cwe: null,
    file: `src/f${number}.ts`,
    lineStart: 10,
    lineEnd: 12,
    sinkPath: `src/f${number}.ts`,
    detail: { evidence: 'db.query(input)' },
    source: 'scanner',
    state: 'open',
    resolution: null,
    resolvedAt: null,
    resolvedSinkHash: null,
    notSeenInLatest: false,
    reopenCount: 0,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function event(
  findingId: string,
  overrides: Partial<SecurityMemoryEvent> = {},
): SecurityMemoryEvent {
  return {
    findingId,
    action: 'commented',
    actorKind: 'user',
    actorRole: 'collaborator',
    resolution: null,
    comment: 'looks fine to me',
    scanId: null,
    createdAt: '2026-11-02T00:00:00.000Z',
    ...overrides,
  };
}

function input(overrides: Partial<SecurityMemoryInput> = {}): SecurityMemoryInput {
  return {
    findings: [],
    events: [],
    lastSucceededAt: '2026-11-10T00:00:00.000Z',
    diffPaths: new Set(),
    ledgerSummary: null,
    backlog: [],
    ...overrides,
  };
}

type IndexFile = {
  records: Array<Record<string, unknown> & { id: string; group: string }>;
  ledger_summary: unknown;
  backlog: Array<string>;
  backlog_total: number;
  trimmed_records: number;
};

function index(files: ReturnType<typeof buildSecurityMemory>): IndexFile {
  return JSON.parse(files.index!) as IndexFile;
}

describe('buildSecurityMemory', () => {
  it('writes nothing for a project with no past', () => {
    expect(buildSecurityMemory(input())).toEqual({
      index: null,
      history: [],
      indexTrimmed: 0,
      historyTrimmed: 0,
    });
  });

  it('orders the index by group, in-diff first inside a group', () => {
    const open = finding({ number: 1, severity: 'low' });
    const urgentOld = finding({ number: 2, severity: 'high' });
    const urgentInDiff = finding({ number: 3, severity: 'critical', sinkPath: 'src/changed.ts' });
    const fixedRecent = finding({
      number: 4,
      state: 'resolved',
      resolution: 'fixed',
      resolvedAt: '2026-11-12T00:00:00.000Z',
    });
    const fixedOld = finding({
      number: 5,
      state: 'resolved',
      resolution: 'fixed',
      resolvedAt: '2026-11-01T00:00:00.000Z',
    });
    const rejected = finding({
      number: 6,
      state: 'resolved',
      resolution: 'false_positive',
      resolvedAt: '2026-11-03T00:00:00.000Z',
      resolvedSinkHash: 'sink-6',
    });
    const accepted = finding({
      number: 7,
      state: 'resolved',
      resolution: 'accepted_risk',
      resolvedAt: '2026-11-03T00:00:00.000Z',
    });
    const lead = finding({ number: 8, verdict: 'needs_validation', severity: null });
    const files = buildSecurityMemory(
      input({
        findings: [open, urgentOld, urgentInDiff, fixedRecent, fixedOld, rejected, accepted, lead],
        events: [
          event(rejected.id, {
            action: 'resolved',
            resolution: 'false_positive',
            actorRole: 'admin',
            comment: 'input is a fixed enum',
          }),
          event(accepted.id, {
            action: 'resolved',
            resolution: 'accepted_risk',
            actorKind: 'installation_admin',
            actorRole: null,
            comment: 'internal tool only',
          }),
        ],
        diffPaths: new Set(['src/changed.ts']),
        ledgerSummary: { files: [{ path: 'src/a.ts', status: 'reviewed' }] },
        backlog: ['src/later.ts'],
      }),
    );
    const parsed = index(files);
    expect(parsed.records.map((record) => [record.id, record.group])).toEqual([
      ['F-3', 'open_urgent'],
      ['F-2', 'open_urgent'],
      ['F-4', 'recheck_fixed'],
      ['F-6', 'rejected'],
      ['F-7', 'accepted_risk'],
      ['F-1', 'open'],
      ['F-8', 'open'],
    ]);
    expect(parsed.records[2]).toMatchObject({ recheck: true });
    expect(parsed.records[3]).toMatchObject({
      verdict: 'rejected',
      resolved_sink_hash: 'sink-6',
      reason: { author_role: 'admin', untrusted_text: 'input is a fixed enum' },
    });
    expect(parsed.records[4]).toMatchObject({
      reason: { author_role: 'installation_admin', untrusted_text: 'internal tool only' },
    });
    expect(parsed.ledger_summary).toEqual({ files: [{ path: 'src/a.ts', status: 'reviewed' }] });
    expect(parsed.backlog).toEqual(['src/later.ts']);
    // Every finding has a history file, also the old fixed one left out of the index.
    expect(files.history.map((file) => file.path).sort()).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `history/F-${n}.json`).sort(),
    );
  });

  it('feeds comments as untrusted data by role, last 3 newest first, cut at 1,000', () => {
    const target = finding({ number: 20 });
    const events = [1, 2, 3, 4].map((n) =>
      event(target.id, {
        actorRole: n === 4 ? 'owner' : 'collaborator',
        comment: n === 4 ? 'x'.repeat(1500) : `comment ${n}`,
        createdAt: `2026-11-0${n}T00:00:00.000Z`,
      }),
    );
    const files = buildSecurityMemory(input({ findings: [target], events }));
    const record = index(files).records[0]!;
    expect(record.comments).toEqual([
      { author_role: 'owner', untrusted_text: `${'x'.repeat(1000)}…` },
      { author_role: 'collaborator', untrusted_text: 'comment 3' },
      { author_role: 'collaborator', untrusted_text: 'comment 2' },
    ]);
    const history = JSON.parse(files.history[0]!.text) as { events: Array<{ comment: unknown }> };
    expect(history.events).toHaveLength(4);
    expect(history.events[3]!.comment).toEqual({
      author_role: 'owner',
      untrusted_text: 'x'.repeat(1500),
    });
    // No names, emails or user ids anywhere.
    expect(files.index).not.toContain('actor_user_id');
  });

  it('never feeds a model-written rejection: only human calls suppress (edge #40)', () => {
    // A finding the model once called "rejected: verified safe" is still open: it is
    // fed as an open finding, never as a rejected record.
    const target = finding({ number: 30, severity: 'high' });
    const files = buildSecurityMemory(
      input({
        findings: [target],
        events: [event(target.id, { action: 'seen_again', actorKind: 'scanner', comment: null })],
      }),
    );
    const parsed = index(files);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]).toMatchObject({ group: 'open_urgent', verdict: 'confirmed' });
    expect(files.index).not.toContain('"rejected"');
  });

  it('caps the index at 200 records and 64 KB, backlog first, then ledger, then records', () => {
    const findings = Array.from({ length: 260 }, (_, index) =>
      finding({ number: 100 + index, title: `T${index} ${'y'.repeat(200)}` }),
    );
    const files = buildSecurityMemory(
      input({
        findings,
        ledgerSummary: { blob: 'z'.repeat(4000) },
        backlog: Array.from({ length: 5000 }, (_, index) => `src/backlog/${index}.ts`),
      }),
    );
    const parsed = index(files);
    expect(new TextEncoder().encode(files.index!).length).toBeLessThanOrEqual(
      SECURITY_MEMORY_INDEX_MAX_BYTES,
    );
    expect(parsed.records.length).toBeLessThanOrEqual(SECURITY_MEMORY_INDEX_MAX_RECORDS);
    expect(parsed.backlog).toEqual([]);
    expect(parsed.backlog_total).toBe(5000);
    expect(parsed.ledger_summary).toBeNull();
    expect(files.indexTrimmed).toBe(260 - parsed.records.length);
    expect(parsed.records[0]!.id).toBe('F-100');
    expect(files.history).toHaveLength(260);
  });

  it('keeps at most 2,000 history files, the oldest resolved dropped first', () => {
    const findings = Array.from({ length: SECURITY_MEMORY_HISTORY_MAX_FILES + 5 }, (_, index) =>
      finding({
        number: 10_000 + index,
        ...(index < 5
          ? {
              state: 'resolved' as const,
              resolution: 'fixed' as const,
              resolvedAt: '2026-11-02T00:00:00.000Z',
            }
          : {}),
      }),
    );
    const files = buildSecurityMemory(input({ findings }));
    expect(files.history).toHaveLength(SECURITY_MEMORY_HISTORY_MAX_FILES);
    expect(files.historyTrimmed).toBe(5);
    expect(files.history.some((file) => file.path === 'history/F-10000.json')).toBe(false);
  });

  it('keeps the backlog paths that fit', () => {
    const files = buildSecurityMemory(
      input({ backlog: Array.from({ length: 10_000 }, (_, index) => `src/backlog/${index}.ts`) }),
    );
    const parsed = index(files);
    expect(parsed.backlog.length).toBeGreaterThan(0);
    expect(parsed.backlog.length).toBeLessThan(10_000);
    expect(parsed.backlog[0]).toBe('src/backlog/0.ts');
  });

  it('hands back the model fingerprint, so a reused one keys to the same finding', () => {
    const sinkPath = 'src/db.ts';
    const stored = finding({
      number: 1,
      modelFingerprint: 'sqli-invoices-query',
      fingerprintKey: securityFingerprintKey('prj_1', 'sqli-invoices-query', sinkPath),
      sinkPath,
    });
    const files = buildSecurityMemory(input({ findings: [stored] }));
    const record = index(files).records[0]!;
    const history = JSON.parse(files.history[0]!.text) as { fingerprint: string };
    expect(record.fingerprint).toBe('sqli-invoices-query');
    expect(history.fingerprint).toBe('sqli-invoices-query');
    // Ingest hashes what the model sends back: it must land on the stored key.
    expect(securityFingerprintKey('prj_1', record.fingerprint as string, sinkPath)).toBe(
      stored.fingerprintKey,
    );
  });
});

describe('securityAuthorRole', () => {
  it('maps actors to the four roles only', () => {
    expect(securityAuthorRole('user', 'owner')).toBe('owner');
    expect(securityAuthorRole('user', 'admin')).toBe('admin');
    expect(securityAuthorRole('user', 'reader')).toBe('collaborator');
    expect(securityAuthorRole('user', null)).toBe('collaborator');
    expect(securityAuthorRole('installation_admin', 'owner')).toBe('installation_admin');
  });
});
