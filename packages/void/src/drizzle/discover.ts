import { existsSync, statSync } from 'node:fs';
import { relative } from 'pathslash';
import { readProjectPaths } from '../project-paths.ts';
import type { ProjectPaths } from '../project-paths.ts';

export type SchemaLocation = { type: 'file'; path: string } | { type: 'directory'; path: string };

/**
 * Discover the user's Drizzle schema.
 *
 * Resolution order:
 * 1. `db/schema.ts` (single file or barrel re-export)
 * 2. `db/schema/` directory (glob pattern for Drizzle Kit)
 *
 * Returns null if no schema is found.
 */
export function discoverSchema(
  root: string,
  paths: ProjectPaths = readProjectPaths(root),
): SchemaLocation | null {
  const filePath = paths.schemaFile;
  if (existsSync(filePath) && statSync(filePath).isFile()) {
    return { type: 'file', path: filePath };
  }

  const dirPath = paths.schemaDir;
  if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
    return { type: 'directory', path: dirPath };
  }

  return null;
}

/**
 * Resolve the root-relative schema specifier for Drizzle Kit config.
 * - File: `"./db/schema.ts"`
 * - Directory: `"./db/schema/*.ts"`
 */
export function schemaSpecifier(location: SchemaLocation, root: string): string {
  const rel = relative(root, location.path);
  return location.type === 'file' ? `./${rel}` : `./${rel}/*.ts`;
}
