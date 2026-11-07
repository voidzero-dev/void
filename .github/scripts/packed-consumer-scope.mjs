import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path/posix';
import { fileURLToPath } from 'node:url';

const fullSuitePaths = [
  /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.node-version|\.npmrc|\.pnpmfile\.cjs|vite\.config\.[jt]s)$/,
  /^packages\/[^/]+\/(?:package\.json|(?:vite|tsdown)\.config\.[cm]?[jt]s|tsconfig[^/]*\.json)$/,
  /^packages\/(?:create-void|react|vue|svelte|solid|hono|md)\/(?:src|bin)\//,
  /^packages\/void\/src\/cli\/(?:init|template|package|agents)(?:[-./])/,
  /^\.github\/scripts\/(?:packed-|release-policy)/,
  /^\.github\/workflows\/(?:packed-consumers|prepublish-test|publish)\.yml$/,
];

/** Cheap default coverage, with the full acceptance matrix at packaging boundaries. */
export function selectPackedSuite(paths) {
  if (paths === null) {
    return 'full';
  }
  const code = paths.filter(
    (path) =>
      !path.startsWith('docs/') &&
      !path.startsWith('platform/meta/') &&
      !/\.(?:md|mdx|txt)$/.test(path) &&
      !/(?:^|\/)(?:LICENSE|NOTICE)(?:\.[^/]*)?$/.test(path),
  );
  if (code.length === 0) {
    return 'skip';
  }
  return code.some((path) => fullSuitePaths.some((pattern) => pattern.test(path)))
    ? 'full'
    : 'smoke';
}

function pathsFromFiles(files) {
  if (!Array.isArray(files) || files.some((file) => typeof file.filename !== 'string')) {
    throw new Error('Invalid changed-file response');
  }
  return files.flatMap((file) =>
    file.previous_filename ? [file.filename, file.previous_filename] : [file.filename],
  );
}

export async function resolvePackedSuite({ eventName, event, requested = 'auto', request }) {
  if (!['auto', 'smoke', 'full'].includes(requested)) {
    throw new Error('Invalid packed suite');
  }
  if (requested !== 'auto') {
    return requested;
  }
  if (eventName === 'workflow_dispatch' || event.ref?.startsWith('refs/tags/')) {
    return 'full';
  }
  if (event.forced) {
    return 'full';
  }
  const repository = event.repository?.full_name;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) {
    return 'full';
  }
  try {
    if (eventName === 'pull_request' && Number.isInteger(event.number)) {
      const paths = [];
      for (let page = 1; page <= 30; page++) {
        const files = await request(
          `/repos/${repository}/pulls/${event.number}/files?per_page=100&page=${page}`,
        );
        paths.push(...pathsFromFiles(files));
        if (files.length < 100) {
          return selectPackedSuite(paths);
        }
      }
      // GitHub caps this endpoint at 3,000 files; an incomplete list must not skip tests.
      return 'full';
    }
    if (
      eventName === 'push' &&
      /^[a-f0-9]{40}$/.test(event.before ?? '') &&
      !/^0+$/.test(event.before)
    ) {
      if (!/^[a-f0-9]{40}$/.test(event.after ?? '')) {
        return 'full';
      }
      const comparison = await request(
        `/repos/${repository}/compare/${event.before}...${event.after}?per_page=1`,
      );
      // Compare responses contain at most 300 changed files, regardless of commit pagination.
      if (!Array.isArray(comparison.files) || comparison.files.length >= 300) {
        return 'full';
      }
      return selectPackedSuite(pathsFromFiles(comparison.files));
    }
  } catch {
    // API outages, inaccessible history, or malformed data retain full coverage.
    console.warn('Could not inspect changed files; keeping the full packed suite.');
    return 'full';
  }
  return 'full';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const suite = await resolvePackedSuite({
    eventName: process.env.GITHUB_EVENT_NAME,
    event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
    requested: process.env.PACKED_REQUESTED_SUITE || 'auto',
    async request(path) {
      const response = await fetch(`https://api.github.com${path}`, {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        throw new Error('Could not read changed files');
      }
      return response.json();
    },
  });
  appendFileSync(process.env.GITHUB_OUTPUT, `suite=${suite}\n`);
  console.log(`Packed consumer suite: ${suite}`);
}
