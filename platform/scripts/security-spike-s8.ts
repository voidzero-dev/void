/**
 * Security audits Phase 0 spike S8: cost and time of an Engine B scan on a ~2k-line diff.
 *
 * What it runs (plan "Phase 0 spikes", PRD §15.2, spec §20 S8):
 *   - One T2 (built-output diff) input of about 2,000 changed source lines: the base is
 *     playground/react-pages with most pages removed; the head is the full app plus the
 *     `react-d1` fixture and the server half (lib, middleware, routes) of `svelte-auth`
 *     from platform/scripts/fixtures/security-seeded-apps/ (4 planted bugs).
 *   - The S4 harness (security-spike-s4.ts): the M5 runner in a locked Cloudflare
 *     Container, model calls through the proxy stand-in to the Workers AI binding with
 *     the M7 caps and the D24 rate guard (10 req/min per model, two scans per model at
 *     once). A Worker `void-spike-sa-s8` is deployed and deleted at the end.
 *   - `--runs` scans per model (default 3). Cost = metered usage x the list prices in
 *     packages/platform/src/security-models.ts (the cached-input discount is shown apart).
 *     Wall time = container start to the runner's status.json, rate waits included.
 *
 * Run (from the repo root):
 *   CLOUDFLARE_ACCOUNT_ID=... [CLOUDFLARE_API_TOKEN=...] NODE_USE_SYSTEM_CA=1 \
 *     WRANGLER_BIN=.../wrangler.js node platform/scripts/security-spike-s8.ts \
 *     [--models @cf/zai-org/glm-5.3,@cf/deepseek-ai/deepseek-v4.1-flash-1017] [--runs 3] \
 *     [--budget-usd 5] [--out report.json] [--keep] [--input-only]
 *   `--input-only` builds the input and prints its size without any Cloudflare call.
 *   Without CLOUDFLARE_API_TOKEN the wrangler OAuth login is used.
 *
 * Pass (PRD §15.2): default model median cost <= $3 per scan and p95 wall time <= 20 min.
 * Prints one JSON report and a PASS/FAIL line; exits 1 on FAIL.
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  DEFAULT_SECURITY_MODEL,
  isSecurityModelId,
} from '../../packages/platform/src/security-models.ts';
import { SPIKE_PREFIX, deleteSpikeResources, listSpikeResources } from './security-spike-s1.ts';
import {
  LIMITS,
  SPIKE_MODELS,
  buildVariant,
  deployHarness,
  freshToken,
  loadFixture,
  maxScanCost,
  runLiveScan,
  scoreScan,
  spikeEnv,
  summarize,
  t2Input,
} from './security-spike-s4.ts';
import type { Fixture, ScanRun, ScanScore } from './security-spike-s4.ts';

const COST_TARGET_USD = 3;
const P95_TARGET_MINUTES = 20;

/** Pages removed from the base, so the head adds them back as part of the diff. */
const BASE_STRIP = [
  'pages/action-error.server.ts',
  'pages/action-error.tsx',
  'pages/blog',
  'pages/client-only.server.ts',
  'pages/client-only.tsx',
  'pages/deferred.server.ts',
  'pages/deferred.tsx',
  'pages/form-errors.server.ts',
  'pages/form-errors.tsx',
  'pages/form-reset.server.ts',
  'pages/form-reset.tsx',
  'pages/initial-redirect.server.ts',
  'pages/initial-redirect.tsx',
  'pages/link-behavior.server.ts',
  'pages/link-behavior.tsx',
  'pages/live.server.ts',
  'pages/live.tsx',
  'pages/router-params',
  'pages/scroll-restoration.server.ts',
  'pages/scroll-restoration.tsx',
  'pages/transition-await.server.ts',
  'pages/transition-await.tsx',
  'pages/users',
  'pages/visit-await.server.ts',
  'pages/visit-await.tsx',
];

function s8Input() {
  const base = buildVariant({ key: 's8-base', base: 'react-pages', strip: BASE_STRIP });
  const head = buildVariant({
    key: 's8-head',
    base: 'react-pages',
    overlays: [
      { fixture: 'react-d1' },
      { fixture: 'svelte-auth', only: ['lib', 'middleware', 'routes'] },
    ],
  });
  return t2Input(base, head);
}

function s8Fixture(): Fixture {
  const react = loadFixture('react-d1');
  const svelte = loadFixture('svelte-auth');
  return {
    name: 's8-2k',
    base: 'react-pages',
    framework: 'react',
    kind: 'seeded',
    planted: [...react.planted, ...svelte.planted],
    decoys: [...react.decoys, ...svelte.decoys.filter((decoy) => !decoy.file.startsWith('pages/'))],
  };
}

const log = (line: string) =>
  console.error(`[s8 ${new Date().toISOString().slice(11, 19)}] ${line}`);

async function main() {
  const { values } = parseArgs({
    options: {
      models: { type: 'string', default: SPIKE_MODELS.join(',') },
      runs: { type: 'string', default: '3' },
      concurrency: { type: 'string', default: '2' },
      'budget-usd': { type: 'string', default: '5' },
      out: { type: 'string' },
      keep: { type: 'boolean', default: false },
      'input-only': { type: 'boolean', default: false },
    },
  });
  const models = values.models.split(',').map((id) => {
    if (!isSecurityModelId(id)) {
      throw new Error(`Unknown model ${id}`);
    }
    return id;
  });
  const runs = Number(values.runs);
  const budget = Number(values['budget-usd']);
  const input = s8Input();
  const fixture = s8Fixture();
  const report: Record<string, unknown> = {
    spike: 'S8',
    limits: LIMITS,
    input: {
      tier: 'built_diff',
      files: input.files.size,
      changedFiles: input.changedFiles.length,
      sourceDiffLines: input.sourceDiffLines,
      diffLines: input.diffLines,
      inputBytes: input.inputBytes,
      planted: fixture.planted.map((bug) => bug.id),
    },
  };
  log(`input: ${JSON.stringify(report.input)}`);
  if (values['input-only']) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const env = spikeEnv();
  const worker = `${SPIKE_PREFIX}s8`;
  const results: Array<ScanRun & { score: ScanScore }> = [];
  const failures: Array<string> = [];
  let spent = 0;
  let reserved = 0;
  try {
    report.baseline = await listSpikeResources(env);
    log(`deploying ${worker}`);
    const harness = await deployHarness(env, worker);
    await Promise.all(
      models.map(async (model) => {
        const queue = Array.from({ length: runs }, (_, run) => run);
        const lane = async () => {
          for (;;) {
            const run = queue.shift();
            if (run === undefined) {
              return;
            }
            const reserve = maxScanCost(model);
            if (spent + reserved + reserve > budget) {
              log(`skip run ${run} on ${model}: budget`);
              continue;
            }
            reserved += reserve;
            try {
              const result = await runLiveScan(harness, input, fixture.name, model, run, log);
              spent += result.costUsd;
              const score = scoreScan(result, fixture, input);
              results.push({ ...result, score });
              log(
                `${model} run ${run}: ${result.status}/${result.reason} calls=${result.calls} in=${result.tokensIn} out=${result.tokensOut} $${result.costUsd} ${(result.wallMs / 60_000).toFixed(1)} min`,
              );
            } finally {
              reserved -= reserve;
            }
          }
        };
        await Promise.all(Array.from({ length: Number(values.concurrency) }, lane));
      }),
    );
  } catch (error) {
    failures.push(String(error instanceof Error ? error.stack : error));
  } finally {
    if (!values.keep) {
      env.token = freshToken();
      report.cleanup = await deleteSpikeResources(env, [worker]);
      const after = (
        report.cleanup as { after: { workers: Array<string>; containerApps: Array<unknown> } }
      ).after;
      if (after.workers.length || after.containerApps.length) {
        failures.push(`leftover spike resources: ${JSON.stringify(after)}`);
      }
    }
  }

  const perModel: Record<string, unknown> = {};
  for (const model of models) {
    const runsFor = results.filter((run) => run.model === model);
    const summary = summarize(runsFor);
    const medianCost = summary.costUsd.median ?? Number.POSITIVE_INFINITY;
    const p95Wall = summary.wallMinutes.p95 ?? Number.POSITIVE_INFINITY;
    const pass =
      runsFor.length > 0 && medianCost <= COST_TARGET_USD && p95Wall <= P95_TARGET_MINUTES;
    perModel[model] = {
      ...summary,
      pass,
      checks: {
        medianCost: `$${medianCost} <= $${COST_TARGET_USD}: ${medianCost <= COST_TARGET_USD}`,
        p95Wall: `${p95Wall} min <= ${P95_TARGET_MINUTES}: ${p95Wall <= P95_TARGET_MINUTES}`,
      },
      perRun: runsFor.map((run) => ({
        status: `${run.status}/${run.reason}`,
        calls: run.calls,
        tokensIn: run.tokensIn,
        tokensOut: run.tokensOut,
        costUsd: run.costUsd,
        wallMinutes: Math.round(run.wallMs / 600) / 100,
        rateWaitMinutes: Math.round(run.rateWaitMs / 600) / 100,
        stops: run.stops,
        bugs: run.score.bugs.map((bug) => `${bug.id}: ${bug.verdict}`),
        falseConfirmed: run.score.falseConfirmed.length,
      })),
    };
    if (model === DEFAULT_SECURITY_MODEL && !pass) {
      failures.push(`default model ${model} misses the S8 target`);
    }
  }
  report.models = perModel;
  report.spentUsd = Math.round(spent * 10_000) / 10_000;
  report.failures = failures;
  const text = JSON.stringify(report, null, 2);
  if (values.out) {
    writeFileSync(values.out, text);
  }
  console.log(text);
  console.log(failures.length ? 'S8 FAIL' : 'S8 PASS');
  process.exitCode = failures.length ? 1 : 0;
}

if (import.meta.main) {
  await main();
}
