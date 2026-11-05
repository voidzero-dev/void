// Checks the runtime before the CLI loads. On an older Node, a static import of a
// newer API (such as `setGlobalProxyFromEnv` from `node:http`) fails at link time
// with a SyntaxError before any code can run, and child processes reuse
// `process.execPath`, so a deploy would stop halfway. This file must therefore
// load on any Node or Bun release: it has no imports and uses no new APIs.
//
// packages/void/src/cli/runtime-support.ts and packages/create-void/src/runtime-support.ts
// are byte-identical copies, because create-void runs before `void` is installed.
// A unit test keeps the two files and both `engines.node` fields equal.

/** Must equal `engines.node` in packages/void and packages/create-void. */
export const NODE_ENGINES = '^24.22.0 || >=26.12.0';

/**
 * Bun is not a documented runtime, but `bunx --bun` and Bun-only images (where
 * `node` is Bun) run the CLI on it. Bun reports a Node version below 26.12, so
 * it gets its own floor: 1.4.0 is the first release where Void's Cloudflare
 * helper process loads. This lets working setups keep working.
 */
export const BUN_MINIMUM = '1.4.0';

type Version = [major: number, minor: number, patch: number];

export type RuntimeVersions = { readonly node?: string; readonly bun?: string };

function isDigits(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) {
      return false;
    }
  }
  return true;
}

/**
 * Parses `1.2.3`, with an optional leading `v`. A pre-release or build tag
 * (`27.0.0-nightly2026...`, `1.4.0+abc`) is ignored, so a nightly counts as its
 * release line.
 */
export function parseVersion(text: string): Version | null {
  let core = text.trim();
  if (core.startsWith('v')) {
    core = core.slice(1);
  }
  for (const separator of ['-', '+']) {
    const index = core.indexOf(separator);
    if (index !== -1) {
      core = core.slice(0, index);
    }
  }
  const parts = core.split('.');
  if (parts.length !== 3 || !parts.every(isDigits)) {
    return null;
  }
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

type Clause = { caret: boolean; version: Version };

/** Supports only the forms used in `engines.node`: `^x.y.z` and `>=x.y.z`, joined by `||`. */
function parseRange(range: string): Array<Clause> {
  return range.split('||').map((raw) => {
    const clause = raw.trim();
    const caret = clause.startsWith('^');
    const prefix = caret ? '^' : clause.startsWith('>=') ? '>=' : null;
    const version = prefix === null ? null : parseVersion(clause.slice(prefix.length));
    if (!version) {
      throw new Error(`runtime-support: unsupported range clause '${clause}'`);
    }
    return { caret, version };
  });
}

export function satisfiesRange(version: Version, range: string): boolean {
  return parseRange(range).some(
    ({ caret, version: floor }) =>
      compareVersions(version, floor) >= 0 && (!caret || version[0] === floor[0]),
  );
}

/** `^24.22.0 || >=26.12.0` -> `24.22+ or 26.12+`. */
function describeRange(range: string): string {
  return parseRange(range)
    .map(({ version: [major, minor, patch] }) =>
      patch === 0 ? `${major}.${minor}+` : `${major}.${minor}.${patch}+`,
    )
    .join(' or ');
}

/**
 * Returns the error to print when this runtime cannot run the CLI, or `null`.
 * The text names only the runtime version and executable path, never env or argv.
 */
export function unsupportedRuntimeMessage(
  versions: RuntimeVersions,
  execPath: string,
  command = 'void',
): string | null {
  const nodeRange = describeRange(NODE_ENGINES);
  if (versions.bun !== undefined) {
    const bun = parseVersion(versions.bun);
    const minimum = parseVersion(BUN_MINIMUM);
    if (bun && minimum && compareVersions(bun, minimum) >= 0) {
      return null;
    }
    return (
      `${command}: Bun ${BUN_MINIMUM} or later is required. Found Bun ${versions.bun} (${execPath}).\n` +
      `Update Bun, or run ${command} on Node.js ${nodeRange}.`
    );
  }
  const node = versions.node === undefined ? null : parseVersion(versions.node);
  if (node && satisfiesRange(node, NODE_ENGINES)) {
    return null;
  }
  const found = versions.node === undefined ? 'an unknown version' : `v${versions.node}`;
  return (
    `${command}: Node.js ${nodeRange} is required. Found Node.js ${found} (${execPath}).\n` +
    'bunx, npx and package scripts use the `node` on PATH; vp/vpx use .node-version.\n' +
    'Update .node-version or the node on PATH. In GitHub Actions add actions/setup-node\n' +
    'with `node-version: lts/*` and `check-latest: true` before this step.'
  );
}
