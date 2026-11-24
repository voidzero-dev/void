import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'pathslash';

export type PackageJson = Record<string, unknown>;

export type PackageDependencyField =
  | 'dependencies'
  | 'devDependencies'
  | 'peerDependencies'
  | 'optionalDependencies';

const DEFAULT_DEPENDENCY_FIELDS: ReadonlyArray<PackageDependencyField> = [
  'dependencies',
  'devDependencies',
];

export function isPackageJson(value: unknown): value is PackageJson {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readPackageJson(root: string): PackageJson | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as unknown;
    return isPackageJson(pkg) ? pkg : null;
  } catch {
    return null;
  }
}

export function readNearestPackageJson(
  startDir: string,
): { root: string; packageJson: PackageJson } | null {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, 'package.json'))) {
      const packageJson = readPackageJson(dir);
      return packageJson ? { root: dir, packageJson } : null;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

export function getPackageDependencies(
  packageJson: PackageJson,
  fields: ReadonlyArray<PackageDependencyField> = DEFAULT_DEPENDENCY_FIELDS,
): Record<string, string> {
  const dependencies: Record<string, string> = {};
  for (const field of fields) {
    const group = packageJson[field];
    if (!isPackageJson(group)) {
      continue;
    }
    for (const [name, spec] of Object.entries(group)) {
      if (typeof spec === 'string') {
        dependencies[name] = spec;
      }
    }
  }
  return dependencies;
}

export function hasPackageDependency(
  packageJson: PackageJson,
  packageName: string,
  fields?: ReadonlyArray<PackageDependencyField>,
): boolean {
  return packageName in getPackageDependencies(packageJson, fields);
}
