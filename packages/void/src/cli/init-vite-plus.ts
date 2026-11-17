import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'pathslash';
import { parseDocument } from 'yaml';
import { getPackageDependencies, readPackageJson } from '../shared/package-json.ts';
import { SCAFFOLD_VITE_PLUS_DEV_DEPENDENCIES } from './template.ts';

type JsonObject = Record<string, unknown>;

/** Resolve a project's catalog reference before invoking npx outside its workspace. */
export function resolveVitePlusBootstrapSpec(root: string, pkg: JsonObject): string {
  const spec = getPackageDependencies(pkg)['vite-plus'];
  if (spec && !spec.startsWith('catalog:')) {
    return spec;
  }
  if (spec) {
    const catalog = spec.slice('catalog:'.length);
    let directory = root;
    while (true) {
      const workspace = join(directory, 'pnpm-workspace.yaml');
      const config = existsSync(workspace)
        ? parseDocument(readFileSync(workspace, 'utf8')).toJS()
        : readPackageJson(directory);
      const entries = catalog
        ? (config?.catalogs?.[catalog] ?? config?.workspaces?.catalogs?.[catalog])
        : (config?.catalog ?? config?.workspaces?.catalog);
      const version = entries?.['vite-plus'];
      if (typeof version === 'string' && version && !version.startsWith('catalog:')) {
        return version;
      }
      if (existsSync(workspace) || config?.workspaces || dirname(directory) === directory) {
        break;
      }
      directory = dirname(directory);
    }
  }
  throw new Error(
    'Could not resolve the project’s Vite+ version. Install its dependencies before running void init.',
  );
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
