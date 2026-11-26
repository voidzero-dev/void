import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'pathslash';
import { parseDocument } from 'yaml';
import { getPackageDependencies, readPackageJson } from '../shared/package-json.ts';
import { SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES } from './template.ts';

type JsonObject = Record<string, unknown>;

/**
 * Resolve a project's catalog reference before invoking npx outside its
 * workspace. pnpm, Bun and Yarn name the default catalog `catalog:` or
 * `catalog:default`, and write it as `catalog` or `catalogs.default`.
 */
export function resolveVitePlusBootstrapSpec(root: string, pkg: JsonObject): string {
  const spec = getPackageDependencies(pkg)['vite-plus'];
  if (spec && !spec.startsWith('catalog:')) {
    return spec;
  }
  if (spec) {
    const catalog = spec.slice('catalog:'.length) || 'default';
    let directory = root;
    while (true) {
      const workspace = join(directory, 'pnpm-workspace.yaml');
      const yarnrc = join(directory, '.yarnrc.yml');
      const config = existsSync(workspace) ? readYaml(workspace) : readPackageJson(directory);
      // Yarn keeps its catalogs in .yarnrc.yml, next to the root package.json.
      const configs = existsSync(yarnrc) ? [config, readYaml(yarnrc)] : [config];
      for (const entry of configs) {
        const version = catalogEntries(entry, catalog)?.['vite-plus'];
        if (typeof version === 'string' && version && !version.startsWith('catalog:')) {
          return version;
        }
      }
      if (existsSync(workspace) || config?.workspaces || dirname(directory) === directory) {
        break;
      }
      directory = dirname(directory);
    }
  }
  // `vp install` then installs the project's own Vite+, so this version only
  // picks the vp that runs that install.
  return SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES['vite-plus'];
}

/** A named catalog in a workspace config, or in its `workspaces` field (Bun). */
function catalogEntries(config: JsonObject | null, name: string): JsonObject | undefined {
  for (const scope of [config, config?.workspaces]) {
    if (!scope || typeof scope !== 'object') {
      continue;
    }
    const { catalog, catalogs } = scope as { catalog?: unknown; catalogs?: unknown };
    const named = (catalogs as JsonObject | undefined)?.[name];
    const entries = name === 'default' ? (catalog ?? named) : named;
    if (entries && typeof entries === 'object') {
      return entries as JsonObject;
    }
  }
  return undefined;
}

function readYaml(path: string): JsonObject | null {
  return parseDocument(readFileSync(path, 'utf8')).toJS() as JsonObject | null;
}

/** Keep every Vite consumer on the core used by the selected Vite+ toolchain. */
export function configureVitePlusScaffold(
  root: string,
  packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm',
  pkg: JsonObject,
): void {
  const core = SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES.vite;
  if (packageManager === 'pnpm') {
    editYaml(root, 'pnpm-workspace.yaml', (document) => {
      if (document.hasIn(['overrides', 'vite'])) {
        document.deleteIn(['overrides', 'vite']);
      }
      document.setIn(['overrides', 'vite@*'], core);
      document.setIn(['peerDependencyRules', 'allowedVersions', 'vite'], '*');
    });
  } else if (packageManager === 'yarn') {
    pkg.resolutions = { ...(pkg.resolutions as JsonObject | undefined), vite: core };
    editYaml(root, '.yarnrc.yml', (document) => {
      document.set('nodeLinker', 'node-modules');
    });
  } else {
    pkg.overrides = {
      ...(pkg.overrides as JsonObject | undefined),
      vite: packageManager === 'npm' ? '$vite' : core,
    };
  }
}

function editYaml(
  root: string,
  name: string,
  edit: (document: ReturnType<typeof parseDocument>) => void,
): void {
  const path = join(root, name);
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const document = parseDocument(before);
  if (document.errors.length) {
    throw new Error(`Could not parse ${name}: ${document.errors[0].message}`);
  }
  edit(document);
  writeFileSync(path, document.toString());
}
