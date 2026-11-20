/**
 * Security audits Phase 0 spike S1b: where can the scanner image come from?
 *
 * Measures, on a real Cloudflare account (plan Risk R1, Engines A/C need a custom image):
 *   A. `durable_object` policy + a Docker Hub image by digest: does the API accept it
 *      (Worker upload with a `containers` image map, and `image-preparations`)?
 *   B. `durable_object` policy + an image in another account's registry
 *      (`registry.cloudflare.com/<other account>/...`): accepted or refused?
 *   C. `default` policy + a Docker Hub image by digest: does a container start from it,
 *      and do the egress intercepts still work (HTTP to example.com gets DenyAll's 403)?
 *   D. API-driven copy: a Worker copies a digest-pinned Docker Hub image into
 *      `registry.cloudflare.com/<this account>/void-spike-sa-copy` with short-lived
 *      registry credentials from the API (streamed, no Docker), then `image-preparations`,
 *      then a `durable_object` container starts from the copy. Time and cold start.
 * Test image: `docker.io/library/busybox` (linux/amd64, about 2 MB), pinned by digest.
 *
 * Run (from the repo root):
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... NODE_USE_SYSTEM_CA=1 \
 *     node platform/scripts/security-spike-s1b.ts [--keep]
 *   The token needs Workers Scripts Edit and Containers Edit. Only `void-spike-sa-*`
 *   Workers, container apps and registry repos are created; all are deleted at the end and
 *   the lists are checked afterwards.
 *
 * Pass: at least one way to run a Void-published image works (D: copy + prepare + start in
 * under 15 min, or C: `default` policy pulls Docker Hub). Prints one JSON report and a
 * PASS/FAIL line; exits 1 on FAIL. A and B are recorded as facts, not pass/fail.
 */
import { parseArgs } from 'node:util';
import {
  SPIKE_PREFIX,
  cfApi,
  deleteSpikeResources,
  deploySpikeWorker,
  listSpikeResources,
  percentile,
  readSpikeEnv,
  waitForWorker,
  type SpikeEnv,
} from './security-spike-s1.ts';

const SOURCE_REPO = 'library/busybox';
const SOURCE_TAG = '1.37.0';
const COPY_REPO = `${SPIKE_PREFIX}copy`;
const COPY_LIMIT_MS = 15 * 60_000;
const OTHER_ACCOUNT = '0123456789abcdef0123456789abcdef';

// Plain fetch-based copy. Runs inside the spike Worker, the same place the platform API
// Worker would run it. Layers stream from Docker Hub to the account registry.
const COPY_SOURCE = String.raw`
async function sha256Hex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// Tries each public source in order (anonymous pull token); a 429 moves on to the next one.
async function openSource(sources, tag, attempts) {
  const accept = 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';
  for (const source of sources) {
    for (let i = 0; i < 3; i++) {
      const tokenResponse = await fetch(source.tokenUrl);
      if (!tokenResponse.ok) { attempts.push(source.name + ' token HTTP ' + tokenResponse.status); await new Promise((r) => setTimeout(r, 2000)); continue; }
      const token = (await tokenResponse.json()).token;
      const headers = { Authorization: 'Bearer ' + token };
      const r = await fetch(source.base + '/v2/' + source.repo + '/manifests/' + tag, { headers: { ...headers, Accept: accept } });
      attempts.push(source.name + ' index HTTP ' + r.status);
      if (r.ok) return { source, headers, index: await r.json(), base: source.base + '/v2/' + source.repo };
      if (r.status !== 429) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('no source answered: ' + attempts.join(', '));
}
async function copyImage({ sources, tag, destRepo, destTag, auth }) {
  const t0 = Date.now();
  const attempts = [];
  const { source, headers: src, index, base: srcBase } = await openSource(sources, tag, attempts);
  let r;
  const pick = (index.manifests || []).find((m) => m.platform && m.platform.os === 'linux' && m.platform.architecture === 'amd64' && !m.platform.variant);
  if (!pick) throw new Error('no linux/amd64 manifest');
  r = await fetch(srcBase + '/manifests/' + pick.digest, { headers: { ...src, Accept: pick.mediaType } });
  const manifestBytes = new Uint8Array(await r.arrayBuffer());
  if ('sha256:' + (await sha256Hex(manifestBytes)) !== pick.digest) throw new Error('source manifest digest mismatch');
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  const base = 'https://registry.cloudflare.com/v2/' + destRepo;
  const dst = { Authorization: auth };
  const blobs = [];
  for (const blob of [manifest.config, ...manifest.layers]) {
    const b0 = Date.now();
    const head = await fetch(base + '/blobs/' + blob.digest, { method: 'HEAD', headers: dst });
    if (head.ok) { blobs.push({ digest: blob.digest, size: blob.size, skipped: true }); continue; }
    const body = await fetch(srcBase + '/blobs/' + blob.digest, { headers: src });
    if (!body.ok) throw new Error('source blob HTTP ' + body.status);
    const start = await fetch(base + '/blobs/uploads/', { method: 'POST', headers: dst });
    if (start.status !== 202) throw new Error('upload start HTTP ' + start.status + ' ' + (await start.text()).slice(0, 300));
    const location = new URL(start.headers.get('location'), 'https://registry.cloudflare.com');
    location.searchParams.set('digest', blob.digest);
    const { readable, writable } = new FixedLengthStream(blob.size);
    const piping = body.body.pipeTo(writable);
    const put = await fetch(location, { method: 'PUT', headers: { ...dst, 'Content-Type': 'application/octet-stream' }, body: readable });
    await piping;
    if (put.status !== 201) throw new Error('blob PUT HTTP ' + put.status + ' ' + (await put.text()).slice(0, 300));
    blobs.push({ digest: blob.digest, size: blob.size, ms: Date.now() - b0 });
  }
  const put = await fetch(base + '/manifests/' + destTag, { method: 'PUT', headers: { ...dst, 'Content-Type': pick.mediaType }, body: manifestBytes });
  if (put.status !== 201) throw new Error('manifest PUT HTTP ' + put.status + ' ' + (await put.text()).slice(0, 300));
  return { source: source.name, sourceAttempts: attempts, manifestDigest: pick.digest, pushedDigest: put.headers.get('docker-content-digest'), blobs, totalBytes: blobs.reduce((n, b) => n + b.size, 0), ms: Date.now() - t0 };
}
`;

function workerSource(withCopied: boolean): string {
  return `
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
${COPY_SOURCE}
export class DenyAll extends WorkerEntrypoint {
  fetch(request) { return new Response('egress denied: ' + new URL(request.url).hostname, { status: 403 }); }
}
const decode = (b) => new TextDecoder().decode(b);
async function startAndProbe(ctx, options) {
  const t0 = Date.now();
  const c = ctx.container;
  await c.interceptAllOutboundHttp(ctx.exports.DenyAll({ props: {} }));
  c.start({ ...options, entrypoint: ['sleep', '3600'], enableInternet: false });
  await c.setInactivityTimeout(120000);
  let ready = 0, attempts = 0, lastError = '';
  while (Date.now() - t0 < 600000) {
    attempts++;
    try {
      const o = await (await c.exec(['busybox', 'echo', 'ok'])).output();
      if (o.exitCode === 0) { ready = Date.now(); break; }
      lastError = 'exit ' + o.exitCode;
    } catch (e) { lastError = String(e && e.message || e); await new Promise((r) => setTimeout(r, 500)); }
  }
  const result = { coldStartMs: ready ? ready - t0 : null, attempts, lastError: ready ? undefined : lastError, images: c.images };
  if (ready) {
    const o = await (await c.exec(['busybox', 'wget', '-q', '-O-', '-T', '8', 'http://example.com/'], { signal: AbortSignal.timeout(20000) })).output();
    result.httpExample = { exitCode: o.exitCode, stdout: decode(o.stdout).slice(0, 200), stderr: decode(o.stderr).slice(0, 200) };
  }
  try { await c.destroy(); } catch (e) { result.destroyError = String(e); }
  return result;
}
export class DefaultApp extends DurableObject {
  run() { return startAndProbe(this.ctx, { instance: 'lite' }); }
}
${
  withCopied
    ? `export class CopiedApp extends DurableObject {
  run() { return startAndProbe(this.ctx, { image: this.ctx.container.images.default, instance: 'lite' }); }
}`
    : ''
}
export default {
  async fetch(request, env) {
    if (request.headers.get('x-spike-key') !== env.SPIKE_KEY) return new Response('forbidden', { status: 403 });
    const url = new URL(request.url);
    try {
      if (url.pathname === '/health') return new Response('ok');
      if (url.pathname === '/copy') return Response.json(await copyImage(await request.json()));
      if (url.pathname === '/default') return Response.json(await env.DEFAULT_APP.getByName(crypto.randomUUID()).run());
      if (url.pathname === '/copied') return Response.json(await env.COPIED_APP.getByName(crypto.randomUUID()).run());
    } catch (e) {
      return Response.json({ error: String(e && e.stack || e) }, { status: 500 });
    }
    return new Response('not found', { status: 404 });
  },
};
`;
}

async function resolveSourceDigest(): Promise<string> {
  const token = (
    (await (
      await fetch(
        `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${SOURCE_REPO}:pull`,
      )
    ).json()) as { token: string }
  ).token;
  const response = await fetch(
    `https://registry-1.docker.io/v2/${SOURCE_REPO}/manifests/${SOURCE_TAG}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept:
          'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json',
      },
    },
  );
  const index = (await response.json()) as {
    manifests: Array<{
      digest: string;
      platform?: { os: string; architecture: string; variant?: string };
    }>;
  };
  const pick = index.manifests.find(
    (m) => m.platform?.os === 'linux' && m.platform.architecture === 'amd64' && !m.platform.variant,
  );
  if (!pick) {
    throw new Error('busybox has no linux/amd64 manifest');
  }
  return pick.digest;
}

async function registryAuth(env: SpikeEnv): Promise<string> {
  const credentials = await cfApi<{ username: string; password: string }>(
    env,
    '/containers/registries/registry.cloudflare.com/credentials',
    {
      method: 'POST',
      body: JSON.stringify({ expiration_minutes: 15, permissions: ['push', 'pull'] }),
    },
  );
  if (!credentials.ok) {
    throw new Error(
      `registry credentials: ${credentials.status} ${JSON.stringify(credentials.errors)}`,
    );
  }
  return `Basic ${Buffer.from(`${credentials.result.username}:${credentials.result.password}`).toString('base64')}`;
}

async function listSpikeRepos(auth: string) {
  const response = await fetch('https://registry.cloudflare.com/v2/_catalog?tags=true', {
    headers: { Authorization: auth },
  });
  if (!response.ok) {
    throw new Error(`registry catalog HTTP ${response.status}`);
  }
  const body = (await response.json()) as { repositories?: Record<string, Array<string>> };
  return Object.entries(body.repositories ?? {})
    .filter(([repo, tags]) => repo.includes(`/${SPIKE_PREFIX}`) && tags.length > 0)
    .map(([repo, tags]) => ({ repo, tags }));
}

async function deleteCopiedImage(env: SpikeEnv, tag: string) {
  const auth = await registryAuth(env);
  const log: Array<string> = [];
  const base = `https://registry.cloudflare.com/v2/${env.accountId}/${COPY_REPO}`;
  const accept =
    'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';
  const head = await fetch(`${base}/manifests/${tag}`, {
    method: 'HEAD',
    headers: { Authorization: auth, Accept: accept },
  });
  if (head.ok) {
    const deleted = await fetch(`${base}/manifests/${tag}`, {
      method: 'DELETE',
      headers: { Authorization: auth, Accept: accept },
    });
    log.push(`DELETE ${COPY_REPO}:${tag}: ${deleted.status}`);
    const gc = await fetch('https://registry.cloudflare.com/v2/gc/layers', {
      method: 'PUT',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
    });
    log.push(`PUT /v2/gc/layers: ${gc.status}`);
  } else {
    log.push(`HEAD ${COPY_REPO}:${tag}: ${head.status} (nothing to delete)`);
  }
  return { log, reposAfter: await listSpikeRepos(auth) };
}

async function getJson(url: string, key: string, init: RequestInit = {}) {
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: { 'x-spike-key': key, ...init.headers },
        signal: AbortSignal.timeout(900_000),
      });
    } catch (error) {
      const cause =
        error instanceof Error ? (error.cause as { code?: string; message?: string }) : undefined;
      return {
        status: 0,
        ms: Date.now() - started,
        body: {
          error: `${String(error)} (${cause?.code ?? cause?.message ?? 'no cause'})`,
        } as Record<string, unknown>,
      };
    }
    const text = await response.text();
    // A fresh workers.dev route can still answer 404 for a while.
    if (response.status === 404 && attempt < 10) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: `HTTP ${response.status}: ${text.slice(0, 300)}` };
    }
    return { status: response.status, ms: Date.now() - started, body };
  }
}

async function main() {
  const { values } = parseArgs({ options: { keep: { type: 'boolean', default: false } } });
  const env = readSpikeEnv();
  const worker = `${SPIKE_PREFIX}s1b`;
  const probeWorker = `${SPIKE_PREFIX}s1b-dh`;
  const key = `vssk_${crypto.randomUUID().replaceAll('-', '')}`;
  const tag = `s1b-${Date.now()}`;
  const report: Record<string, unknown> = { spike: 'S1b' };
  const failures: Array<string> = [];
  let copyWorks = false;
  let defaultWorks = false;
  try {
    report.baseline = await listSpikeResources(env);
    const digest = await resolveSourceDigest();
    const dockerHubRef = `docker.io/${SOURCE_REPO}@${digest}`;
    report.sourceImage = { ref: dockerHubRef, tag: SOURCE_TAG };

    // A. durable_object + Docker Hub, at the API level (no Docker, no wrangler checks).
    const prepareDockerHub = await cfApi(env, '/containers/image-preparations', {
      method: 'POST',
      body: JSON.stringify({ image: dockerHubRef }),
    });
    const form = new FormData();
    form.append(
      'metadata',
      new Blob(
        [
          JSON.stringify({
            main_module: 'index.js',
            compatibility_date: '2026-09-01',
            bindings: [{ type: 'durable_object_namespace', name: 'APP', class_name: 'App' }],
            migrations: { new_tag: 'v1', steps: [{ new_sqlite_classes: ['App'] }] },
            containers: [
              { class_name: 'App', name: `${probeWorker}-app`, images: { default: dockerHubRef } },
            ],
          }),
        ],
        { type: 'application/json' },
      ),
    );
    form.append(
      'index.js',
      new Blob(
        [
          "import { DurableObject } from 'cloudflare:workers'; export class App extends DurableObject {} export default { fetch() { return new Response('ok'); } };",
        ],
        { type: 'application/javascript+module' },
      ),
      'index.js',
    );
    const upload = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.accountId}/workers/scripts/${probeWorker}`,
      { method: 'PUT', headers: { Authorization: `Bearer ${env.token}` }, body: form },
    );
    const uploadBody = (await upload.json()) as { success: boolean; errors?: unknown };
    report.A_durableObjectDockerHub = {
      imagePreparation: {
        status: prepareDockerHub.status,
        ok: prepareDockerHub.ok,
        errors: prepareDockerHub.errors,
        result: prepareDockerHub.result,
      },
      workerUploadWithImageMap: {
        status: upload.status,
        success: uploadBody.success,
        errors: uploadBody.errors,
      },
    };

    // B. durable_object + another account's registry.
    const prepareOther = await cfApi(env, '/containers/image-preparations', {
      method: 'POST',
      body: JSON.stringify({
        image: `registry.cloudflare.com/${OTHER_ACCOUNT}/${COPY_REPO}@${digest}`,
      }),
    });
    report.B_durableObjectOtherAccount = {
      imagePreparation: {
        status: prepareOther.status,
        ok: prepareOther.ok,
        errors: prepareOther.errors,
      },
    };

    // C. default policy + Docker Hub, through wrangler deploy (the documented path).
    let deployed: Awaited<ReturnType<typeof deploySpikeWorker>> | undefined;
    const baseConfig = {
      durable_objects: { bindings: [{ name: 'DEFAULT_APP', class_name: 'DefaultApp' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['DefaultApp'] }],
      containers: [
        {
          class_name: 'DefaultApp',
          name: `${worker}-default-app`,
          image: dockerHubRef,
          instance_type: 'lite',
          max_instances: 2,
        },
      ],
    };
    try {
      deployed = await deploySpikeWorker(env, worker, workerSource(false), baseConfig, {
        SPIKE_KEY: key,
      });
      report.reachableAfterMs = await waitForWorker(deployed.url, key);
      const runs = [];
      for (let index = 0; index < 3; index++) {
        runs.push(await getJson(`${deployed.url}/default`, key));
      }
      const cold = runs.flatMap((r) =>
        typeof r.body.coldStartMs === 'number' ? [r.body.coldStartMs] : [],
      );
      defaultWorks = cold.length > 0;
      report.C_defaultPolicyDockerHub = { deployMs: deployed.deployMs, runs, coldStartMs: cold };
    } catch (error) {
      report.C_defaultPolicyDockerHub = {
        error: String(error instanceof Error ? error.message : error).slice(0, 3000),
      };
    }

    // D. API-driven copy into this account's registry, from a Worker.
    if (!deployed) {
      deployed = await deploySpikeWorker(
        env,
        worker,
        workerSource(false),
        {
          durable_objects: { bindings: [{ name: 'DEFAULT_APP', class_name: 'DefaultApp' }] },
          migrations: [{ tag: 'v1', new_sqlite_classes: ['DefaultApp'] }],
        },
        { SPIKE_KEY: key },
      );
      await waitForWorker(deployed.url, key);
    }
    const d0 = Date.now();
    const copy = await getJson(`${deployed.url}/copy`, key, {
      method: 'POST',
      body: JSON.stringify({
        sources: [
          {
            name: 'docker.io',
            base: 'https://registry-1.docker.io',
            repo: SOURCE_REPO,
            tokenUrl: `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${SOURCE_REPO}:pull`,
          },
          {
            // Amazon ECR Public mirror of the Docker official images (same digests).
            name: 'public.ecr.aws',
            base: 'https://public.ecr.aws',
            repo: `docker/${SOURCE_REPO}`,
            tokenUrl: `https://public.ecr.aws/token/?scope=repository:docker/${SOURCE_REPO}:pull`,
          },
        ],
        tag: SOURCE_TAG,
        destRepo: `${env.accountId}/${COPY_REPO}`,
        destTag: tag,
        auth: await registryAuth(env),
      }),
    });
    const D: Record<string, unknown> = { copy };
    report.D_copyIntoAccountRegistry = D;
    const pushedDigest = copy.body.pushedDigest as string | undefined;
    if (copy.status === 200 && pushedDigest) {
      const copiedRef = `registry.cloudflare.com/${env.accountId}/${COPY_REPO}@${pushedDigest}`;
      D.copiedRef = copiedRef;
      const p0 = Date.now();
      let preparation: Awaited<ReturnType<typeof cfApi<{ status: string }>>> | undefined;
      while (Date.now() - p0 < COPY_LIMIT_MS) {
        preparation = await cfApi<{ status: string }>(env, '/containers/image-preparations', {
          method: 'POST',
          body: JSON.stringify({ image: copiedRef }),
        });
        if (!preparation.ok || preparation.result.status !== 'pending') {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      D.imagePreparation = {
        ms: Date.now() - p0,
        status: preparation?.status,
        result: preparation?.result,
        errors: preparation?.errors,
      };
      if (preparation?.ok && preparation.result.status === 'ready') {
        const withCopied = {
          durable_objects: {
            bindings: [
              { name: 'DEFAULT_APP', class_name: 'DefaultApp' },
              { name: 'COPIED_APP', class_name: 'CopiedApp' },
            ],
          },
          migrations: [
            { tag: 'v1', new_sqlite_classes: ['DefaultApp'] },
            { tag: 'v2', new_sqlite_classes: ['CopiedApp'] },
          ],
          containers: [
            ...(defaultWorks ? baseConfig.containers : []),
            {
              class_name: 'CopiedApp',
              name: `${worker}-copied-app`,
              scheduling_policy: 'durable_object',
              images: { default: { image: copiedRef } },
            },
          ],
        };
        const redeployed = await deploySpikeWorker(env, worker, workerSource(true), withCopied, {
          SPIKE_KEY: key,
        });
        D.redeployMs = redeployed.deployMs;
        await waitForWorker(redeployed.url, key);
        const runs = [];
        for (let index = 0; index < 3; index++) {
          runs.push(await getJson(`${redeployed.url}/copied`, key));
        }
        const cold = runs.flatMap((r) =>
          typeof r.body.coldStartMs === 'number' ? [r.body.coldStartMs] : [],
        );
        D.runs = runs;
        D.coldStartMs = cold.length
          ? { values: cold, p50: percentile(cold, 50), max: Math.max(...cold) }
          : null;
        D.copyToRunnableMs = Date.now() - d0;
        copyWorks = cold.length > 0 && Date.now() - d0 < COPY_LIMIT_MS;
      }
    }
    if (!copyWorks && !defaultWorks) {
      failures.push('neither the API copy (D) nor the default policy (C) ran the image');
    }
  } catch (error) {
    failures.push(String(error instanceof Error ? (error.stack ?? error.message) : error));
  } finally {
    if (!values.keep) {
      const cleanup: Record<string, unknown> = {};
      cleanup.workers = await deleteSpikeResources(env, [worker, probeWorker]);
      cleanup.registry = await deleteCopiedImage(env, tag);
      report.cleanup = cleanup;
      const after = (
        cleanup.workers as { after: { workers: Array<string>; containerApps: Array<unknown> } }
      ).after;
      const repos = (cleanup.registry as { reposAfter: Array<unknown> }).reposAfter;
      if (after.workers.length || after.containerApps.length || repos.length) {
        failures.push(`leftover spike resources: ${JSON.stringify({ after, repos })}`);
      }
    }
  }
  report.copyWorks = copyWorks;
  report.defaultPolicyWorks = defaultWorks;
  report.failures = failures;
  console.log(JSON.stringify(report, null, 2));
  console.log(failures.length ? 'S1b FAIL' : 'S1b PASS');
  process.exitCode = failures.length ? 1 : 0;
}

if (import.meta.main) {
  await main();
}
