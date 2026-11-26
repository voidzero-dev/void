/**
 * Release step for security audits Engines A and C (design doc 0095 M13b): build the two
 * scanner images for linux/amd64, push them to ghcr.io, and pin their digests in
 * `platform/packages/api/src/security/scanner-images.json`. The API copies each image by
 * that digest into the operator's own Cloudflare registry; a release with `digest: null`
 * keeps that engine's models off.
 *
 *   vp pack ─► docker buildx build --platform linux/amd64 --provenance=false --sbom=false
 *                 --label org.opencontainers.image.revision=<full git sha>
 *          ─► (--push) ghcr.io/<owner>/void-security-scanner-engine-a:<git sha>
 *          ─► the pushed digest must be one linux/amd64 manifest (not an index) whose
 *             revision label is HEAD, so a reviewer can trace the pin to its commit
 *          ─► scanner-images.json gets the digest; commit it with the release
 *
 * Run from the repository root:
 *   node platform/scripts/publish-security-scanner-images.ts            # build only, writes nothing
 *   docker login ghcr.io && node platform/scripts/publish-security-scanner-images.ts --push
 * The ghcr.io packages must be public: the API Worker pulls them without credentials.
 * `--push` refuses a working tree with changes: the revision label must name the code it built.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SCANNER = join(REPO, 'platform/packages/security-scanner');
const PINS = join(REPO, 'platform/packages/api/src/security/scanner-images.json');
const REVISION_LABEL = 'org.opencontainers.image.revision';

const ENGINES = [
  { engine: 'agent_sdk', dockerfile: 'Dockerfile.claude' },
  { engine: 'codex_sdk', dockerfile: 'Dockerfile.codex' },
] as const;

type Pins = Record<
  (typeof ENGINES)[number]['engine'],
  { repository: string; digest: string | null }
>;

function run(command: string, args: Array<string>, cwd = REPO): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status})`);
  }
  return result.stdout;
}

function isDigest(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('sha256:') &&
    value.length === 71 &&
    Array.from(value.slice(7)).every((char) => '0123456789abcdef'.includes(char))
  );
}

/** The pushed reference must be one linux/amd64 manifest (the API copy refuses an index) built from `revision`. */
function checkPushed(reference: string, revision: string): void {
  const inspect = (...args: Array<string>) =>
    JSON.parse(run('docker', ['buildx', 'imagetools', 'inspect', ...args, reference])) as unknown;
  const raw = inspect('--raw') as { mediaType?: string; manifests?: unknown };
  if (Array.isArray(raw.manifests) || raw.mediaType?.includes('index')) {
    throw new Error(`${reference} is an image index; build with --provenance=false --sbom=false.`);
  }
  const image = inspect('--format', '{{json .Image}}') as {
    os?: string;
    architecture?: string;
    config?: { Labels?: Record<string, string> };
  };
  if (image.os !== 'linux' || image.architecture !== 'amd64') {
    throw new Error(`${reference} is ${image.os}/${image.architecture}, not linux/amd64.`);
  }
  const label = image.config?.Labels?.[REVISION_LABEL];
  if (label !== revision) {
    throw new Error(`${reference} has ${REVISION_LABEL}=${label ?? '(none)'}, not ${revision}.`);
  }
}

function main(): void {
  const { values } = parseArgs({
    options: { push: { type: 'boolean', default: false }, tag: { type: 'string' } },
    strict: true,
  });
  const pins = JSON.parse(readFileSync(PINS, 'utf8')) as Pins;
  const revision = run('git', ['rev-parse', 'HEAD']).trim();
  if (values.push && run('git', ['status', '--porcelain']).trim() !== '') {
    throw new Error('The working tree has changes; push only from a clean checkout of a commit.');
  }
  const tag = values.tag ?? revision.slice(0, 12);
  run(join(SCANNER, 'node_modules/.bin/vp'), ['pack'], SCANNER);

  const work = mkdtempSync(join(tmpdir(), 'void-scanner-images-'));
  const next: Pins = structuredClone(pins);
  for (const { engine, dockerfile } of ENGINES) {
    const repository = pins[engine].repository;
    const metadata = join(work, `${engine}.json`);
    run('docker', [
      'buildx',
      'build',
      '--platform',
      'linux/amd64',
      '--provenance=false',
      '--sbom=false',
      '--file',
      join(SCANNER, 'image', dockerfile),
      '--label',
      `${REVISION_LABEL}=${revision}`,
      '--tag',
      `${repository}:${tag}`,
      '--metadata-file',
      metadata,
      // A release image is built from scratch, never from a cached layer.
      ...(values.push ? ['--no-cache', '--push'] : ['--load']),
      '.',
    ]);
    if (!values.push) {
      console.log(`built ${repository}:${tag} (not pushed)`);
      continue;
    }
    const digest = (JSON.parse(readFileSync(metadata, 'utf8')) as Record<string, unknown>)[
      'containerimage.digest'
    ];
    if (!isDigest(digest)) {
      throw new Error(`buildx reported no manifest digest for ${repository}:${tag}.`);
    }
    checkPushed(`${repository}@${digest}`, revision);
    next[engine] = { repository, digest };
    console.log(`pushed ${repository}@${digest}`);
  }
  if (values.push) {
    writeFileSync(PINS, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`updated ${PINS}; commit it with the release.`);
  } else {
    console.log('scanner-images.json unchanged (run with --push to publish and pin).');
  }
}

if (import.meta.main) {
  main();
}
