import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { cloudflareCommandDiagnostic, readBindingFieldPresence } from '@void/deploy-cloudflare';
import { Minimatch } from 'minimatch';
import { dirname, join, normalize, resolve } from 'pathslash';
import type { VoidAuthMigrationSchema } from '../auth/drizzle.ts';
import { type DatabaseDialect } from '../config.ts';
import { openMigrationValidationDatabase } from '../migrations/sqlite-validation.ts';
import { assertJournalCoherence, validateMigrations } from '../migrations/validate.ts';
import { readProjectPaths } from '../project-paths.ts';
import { isCleanCloudflareExit } from './cloudflare-process.ts';
import { hasDeploySchemaDrift, getDeploySchemaDriftMessage } from './deploy-drift.ts';
import { log } from './deploy-helpers.ts';
import { CLOUDFLARE_RESOURCE_LABELS } from './deploy-resources.ts';
import {
  type RequiredAuthTable,
  type TableInfoRow,
  type DeployWranglerRun,
  type DeployWranglerRunResult,
} from './deploy-types.ts';
import { formatCount, getErrorMessage } from './output.ts';
import type { ProvisionDriftEntry } from './provision.ts';
import { sanitizeTerminalLogText } from './terminal-log-text.ts';

/**
 * Apply the checked-in migrations to an in-memory SQLite database and assert the resulting
 * schema has every required auth table and column, with its primary key, NOT NULL, UNIQUE and
 * foreign key constraints. Drizzle's `.unique()` and `.references()` are opt-in, so matching
 * names alone would accept a weaker schema than the managed path builds.
 *
 * Column types, non-unique indexes and `onDelete` actions are not checked, because legitimate
 * schemas vary there. Throws naming each offending `table.column` (identifiers only, never
 * values), or when a migration cannot be applied.
 */
export async function assertMigrationsProduceAuthSchema(
  migrations: Array<{ name: string; sql: string }>,
  required: Array<RequiredAuthTable>,
): Promise<void> {
  const db = await openMigrationValidationDatabase(migrations);
  const quote = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;
  // SQLite matches identifiers case-insensitively, but PRAGMAs echo the declared casing.
  const foldIdentifier = (identifier: string): string => identifier.toLowerCase();
  const sameIdentifier = (a: string, b: string): boolean => foldIdentifier(a) === foldIdentifier(b);
  // Foreign keys need the parent table's info too. A table no migration created yields `[]`.
  const tableInfoCache = new Map<string, Array<TableInfoRow>>();
  const tableInfoFor = (table: string): Array<TableInfoRow> => {
    const key = foldIdentifier(table);
    const cached = tableInfoCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const rows = db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<TableInfoRow>;
    tableInfoCache.set(key, rows);
    return rows;
  };
  // SQLite resolves an omitted foreign key target only to a single-column PRIMARY KEY.
  const singleColumnPrimaryKey = (table: string): string | null => {
    const primaryKey = tableInfoFor(table).filter((row) => Number(row.pk) > 0);
    return primaryKey.length === 1 && primaryKey[0] ? primaryKey[0].name : null;
  };
  try {
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
          name: string;
        }>
      ).map((row) => foldIdentifier(row.name)),
    );
    const problems: Array<string> = [];
    for (const req of required) {
      if (!tables.has(foldIdentifier(req.table))) {
        problems.push(`table "${req.table}" is not created by any checked-in migration`);
        continue;
      }
      const tableInfo = tableInfoFor(req.table);
      const columns = new Set(tableInfo.map((row) => foldIdentifier(row.name)));
      const missing = req.columns
        .filter((required) => !columns.has(foldIdentifier(required.column)))
        .map((required) => required.column);
      if (missing.length > 0) {
        problems.push(`table "${req.table}" is missing column(s): ${missing.join(', ')}`);
      }

      // A column is unique through a single-column PRIMARY KEY (including the rowid alias,
      // which has no index row) or any single-column, non-partial unique index.
      const uniqueColumns = new Set<string>();
      const primaryKey = tableInfo.filter((row) => Number(row.pk) > 0);
      if (primaryKey.length === 1 && primaryKey[0]) {
        uniqueColumns.add(foldIdentifier(primaryKey[0].name));
      }
      const indexes = db.prepare(`PRAGMA index_list(${quote(req.table)})`).all() as Array<{
        name: string;
        unique: number;
        origin?: string | null;
        partial?: number;
      }>;
      for (const index of indexes) {
        // A partial unique index constrains only the rows matching its WHERE clause.
        if (Number(index.unique) !== 1 || Number(index.partial ?? 0) !== 0) {
          continue;
        }
        const indexColumns = db.prepare(`PRAGMA index_info(${quote(index.name)})`).all() as Array<{
          name: string | null;
        }>;
        // A composite unique index constrains the tuple, not this column alone.
        if (indexColumns.length !== 1) {
          continue;
        }
        const only = indexColumns[0]?.name;
        if (typeof only === 'string') {
          uniqueColumns.add(foldIdentifier(only));
        }
      }
      // Auth foreign keys point at `id`. SQLite (and D1, which always enforces foreign keys)
      // rejects a non-unique parent key at runtime with "foreign key mismatch".
      const notIdentity = req.columns
        .filter(
          (required) =>
            required.primaryKey === true &&
            columns.has(foldIdentifier(required.column)) &&
            !uniqueColumns.has(foldIdentifier(required.column)),
        )
        .map((required) => required.column);
      for (const column of notIdentity) {
        problems.push(
          `table "${req.table}" column "${column}" must be the PRIMARY KEY (or otherwise ` +
            `uniquely constrained) — it is the row identity the auth foreign keys point at, and ` +
            `SQLite rejects a foreign key whose parent key is not unique at runtime with ` +
            `"foreign key mismatch"`,
        );
      }

      // The `INTEGER PRIMARY KEY` rowid alias reports `notnull = 0` but can never hold NULL.
      // `INTEGER PRIMARY KEY DESC` looks the same in `table_info` yet is not an alias; only a
      // real alias has no `origin = 'pk'` row in `index_list`.
      const hasPrimaryKeyIndex = indexes.some(
        (index) => String(index.origin ?? '').toLowerCase() === 'pk',
      );
      const isRowidAlias = (row: TableInfoRow): boolean =>
        primaryKey.length === 1 &&
        Number(row.pk) > 0 &&
        !hasPrimaryKeyIndex &&
        String(row.type ?? '')
          .trim()
          .toUpperCase() === 'INTEGER';
      const notNullColumns = new Set(
        tableInfo
          .filter((row) => Number(row.notnull) === 1 || isRowidAlias(row))
          .map((row) => foldIdentifier(row.name)),
      );

      // SQLite allows NULL in a PRIMARY KEY column other than the rowid alias, so the message
      // names that quirk.
      const nullableIdentity = req.columns
        .filter(
          (required) =>
            required.primaryKey === true &&
            required.required === true &&
            columns.has(foldIdentifier(required.column)) &&
            !notNullColumns.has(foldIdentifier(required.column)),
        )
        .map((required) => required.column);
      for (const column of nullableIdentity) {
        problems.push(
          `table "${req.table}" column "${column}" must be declared NOT NULL — SQLite permits ` +
            `NULL in a PRIMARY KEY column unless it is the INTEGER rowid alias, so rows could ` +
            `be inserted with no identity at all, and more than one of them (NULLs do not ` +
            `collide under a unique constraint)`,
        );
      }

      const nullableRequired = req.columns
        .filter(
          (required) =>
            required.required === true &&
            required.primaryKey !== true &&
            columns.has(foldIdentifier(required.column)) &&
            !notNullColumns.has(foldIdentifier(required.column)),
        )
        .map((required) => required.column);
      if (nullableRequired.length > 0) {
        problems.push(
          `table "${req.table}" is missing a NOT NULL constraint on column(s): ` +
            `${nullableRequired.join(', ')} (the emitted auth schema marks them required)`,
        );
      }

      const notUnique = req.columns
        .filter(
          (required) =>
            required.unique &&
            columns.has(foldIdentifier(required.column)) &&
            !uniqueColumns.has(foldIdentifier(required.column)),
        )
        .map((required) => required.column);
      if (notUnique.length > 0) {
        problems.push(
          `table "${req.table}" is missing a UNIQUE constraint on column(s): ${notUnique.join(', ')} ` +
            `(no column-level UNIQUE and no single-column unique index covers them)`,
        );
      }

      // `PRAGMA foreign_key_list` returns one row per column; rows of one constraint share `id`.
      const foreignKeys = db
        .prepare(`PRAGMA foreign_key_list(${quote(req.table)})`)
        .all() as Array<{
        id: number;
        table: string;
        from: string;
        to: string | null;
      }>;
      const foreignKeyConstraints = new Map<number, Array<(typeof foreignKeys)[number]>>();
      for (const fk of foreignKeys) {
        const group = foreignKeyConstraints.get(Number(fk.id));
        if (group) {
          group.push(fk);
        } else {
          foreignKeyConstraints.set(Number(fk.id), [fk]);
        }
      }
      const constraints = Array.from(foreignKeyConstraints.values());
      for (const required of req.columns) {
        const reference = required.references;
        if (!reference || !columns.has(foldIdentifier(required.column))) {
          continue;
        }
        const namesReference = (fk: (typeof foreignKeys)[number]): boolean =>
          typeof fk.from === 'string' &&
          sameIdentifier(fk.from, required.column) &&
          typeof fk.table === 'string' &&
          sameIdentifier(fk.table, reference.table);
        // Only a single-column foreign key counts: under MATCH SIMPLE, SQLite skips a composite
        // key whenever any of its child columns is NULL.
        const matching = constraints.flatMap((group) =>
          group.length === 1 && group[0] && namesReference(group[0]) ? [group[0]] : [],
        );
        const composite = constraints.some(
          (group) => group.length > 1 && group.some(namesReference),
        );
        // This checks only which column the key names; `foreign_key_check` below decides
        // whether SQLite accepts the parent key. A null `to` (`REFERENCES "user"`) means the
        // parent's single-column PRIMARY KEY.
        const satisfied = matching.some((fk) => {
          if (fk.to != null) {
            return sameIdentifier(String(fk.to), reference.column);
          }
          const parentPrimaryKey = singleColumnPrimaryKey(fk.table);
          return parentPrimaryKey !== null && sameIdentifier(parentPrimaryKey, reference.column);
        });
        if (!satisfied) {
          problems.push(
            matching.length === 0 && composite
              ? `table "${req.table}" column "${required.column}" references ` +
                  `"${reference.table}"."${reference.column}" only as part of a MULTI-COLUMN ` +
                  `foreign key — SQLite skips a composite foreign key entirely when any of its ` +
                  `child columns is NULL, so a row naming a "${reference.table}" that does not ` +
                  `exist is still accepted. This reference needs its own single-column foreign ` +
                  `key on "${required.column}"`
              : matching.some((fk) => fk.to == null)
                ? `table "${req.table}" column "${required.column}" references "${reference.table}" ` +
                  `without naming a target column, but "${reference.table}"."${reference.column}" ` +
                  `is not that table's single-column PRIMARY KEY — SQLite resolves an omitted ` +
                  `target only to the parent's PRIMARY KEY (a UNIQUE constraint does not qualify, ` +
                  `nor does a composite PRIMARY KEY) and rejects this at runtime with ` +
                  `"foreign key mismatch"`
                : `table "${req.table}" column "${required.column}" is missing a foreign key ` +
                  `referencing "${reference.table}"."${reference.column}"`,
          );
        }
      }

      // Let SQLite apply its own parent-key rules. `CREATE TABLE` accepts an invalid parent
      // key, which then fails at runtime; `foreign_key_check` reports it by throwing
      // "foreign key mismatch". Any other error propagates.
      try {
        const violations = db
          .prepare(`PRAGMA foreign_key_check(${quote(req.table)})`)
          .all() as Array<{ parent?: string | null }>;
        for (const violation of violations) {
          const parent = typeof violation.parent === 'string' ? violation.parent : 'its parent';
          problems.push(
            `table "${req.table}" has rows violating its foreign key to "${parent}" ` +
              `(PRAGMA foreign_key_check)`,
          );
        }
      } catch (err) {
        const message = getErrorMessage(err);
        const mismatch = /foreign key mismatch\s*-\s*"(.+?)"\s+referencing\s+"(.+?)"/i.exec(
          message,
        );
        if (!mismatch) {
          throw err;
        }
        problems.push(
          `table "${mismatch[1]}" has a foreign key referencing "${mismatch[2]}" whose parent ` +
            `key is not a valid foreign-key target — SQLite requires the referenced column(s) ` +
            `to be a PRIMARY KEY, or a UNIQUE index that MATCHES the reference (an index ` +
            `declared with a different COLLATE does not match), and an omitted target column ` +
            `resolves only to the parent's PRIMARY KEY. The table is created, but SQLite ` +
            `rejects every statement touching it at runtime with "foreign key mismatch"`,
        );
      }
    }
    if (problems.length > 0) {
      throw new Error(problems.join('; '));
    }
  } finally {
    db.close();
  }
}

/**
 * Read the required auth tables from the `.void/better-auth-schema.ts` the build emitted, so
 * renamed and plugin tables are included. Its `migrationSchema` JSON literal closes with
 * `\n} as const;` because inner braces are indented. Throws when the file is missing or malformed.
 */
function readEmittedAuthMigrationSchema(root: string): Array<RequiredAuthTable> {
  const schemaPath = join(root, '.void', 'better-auth-schema.ts');
  if (!existsSync(schemaPath)) {
    throw new Error(
      `the build did not emit ${schemaPath}, so the generated auth schema could not be read from the build output.`,
    );
  }
  const content = readFileSync(schemaPath, 'utf-8');
  const marker = 'export const migrationSchema = ';
  const start = content.indexOf(marker);
  if (start === -1) {
    throw new Error(
      `${schemaPath} has no migrationSchema literal — cannot verify the auth schema.`,
    );
  }
  const jsonStart = start + marker.length;
  const end = content.indexOf('\n} as const;', jsonStart);
  if (end === -1) {
    throw new Error(
      `${schemaPath} migrationSchema literal is malformed — cannot verify the auth schema.`,
    );
  }
  let migrationSchema: VoidAuthMigrationSchema;
  try {
    migrationSchema = JSON.parse(content.slice(jsonStart, end + 2)) as VoidAuthMigrationSchema;
  } catch {
    throw new Error(
      `${schemaPath} migrationSchema is not valid JSON — cannot verify the auth schema.`,
    );
  }
  return migrationSchema.tables.map((table) => ({
    table: table.name,
    columns: [
      // `id` is the implicit primary key and is absent from `fields`.
      { column: 'id', unique: false, required: true, primaryKey: true },
      ...Object.entries(table.fields).map(([column, field]) => ({
        column,
        unique: field.unique === true,
        required: field.required === true,
        references: field.references
          ? { table: field.references.table, column: field.references.field }
          : undefined,
      })),
    ],
  }));
}

/** Assert after the build that the checked-in migrations produce the emitted auth schema. */
export async function validateAuthMigrationSchema(
  root: string,
  migrations: Array<{ name: string; sql: string }>,
): Promise<void> {
  const required = readEmittedAuthMigrationSchema(root);
  await assertMigrationsProduceAuthSchema(migrations, required);
}

/** Format the drift / CI-gate guidance naming each un-provisioned resource. */
export function formatCloudflareDriftMessage(
  missing: Array<ProvisionDriftEntry>,
  reasons: Map<string, string>,
  header: string,
  footer: string,
): string {
  const lines = missing.map((entry) => {
    const reason = reasons.get(entry.binding);
    const label = CLOUDFLARE_RESOURCE_LABELS[entry.kind];
    return `  • ${entry.binding} (${label})${reason ? ` — ${reason}` : ''}`;
  });
  return [header, ...lines, '', footer].join('\n');
}

/**
 * Run the managed deploy's migration checks (schema drift, journal coherence, destructive
 * statements without a pragma). Throws instead of exiting, so the caller handles the failure.
 */
export function assertRemoteMigrationsDeployable(
  root: string,
  dialect: DatabaseDialect,
  migrationsDir: string,
  migrations: Array<{ name: string; sql: string }>,
): void {
  if (hasDeploySchemaDrift(root, dialect)) {
    throw new Error(getDeploySchemaDriftMessage(root));
  }
  assertJournalCoherence(migrationsDir, migrations, readProjectPaths(root).sourceRelative);
  if (migrations.length > 0) {
    validateMigrations(migrations);
  }
}

/**
 * The cf CLI's D1 migration order: per path segment, the leading number before `_` compares
 * numerically (`2_x.sql` before `10_x.sql`), numbers sort before non-numbers, and ties fall
 * back to string order.
 */
function leadingWranglerMigrationNumber(relativePath: string): number {
  const firstSegment = relativePath.split('/')[0] ?? '';
  return parseInt(firstSegment.split('_')[0] ?? '', 10);
}

function compareWranglerMigrationSegments(a: string, b: string): number {
  const aNum = leadingWranglerMigrationNumber(a);
  const bNum = leadingWranglerMigrationNumber(b);
  if (aNum !== bNum) {
    if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
      return aNum - bNum;
    }
    if (Number.isFinite(aNum)) {
      return -1;
    }
    if (Number.isFinite(bNum)) {
      return 1;
    }
  }
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

export function compareWranglerMigrationPaths(a: string, b: string): number {
  const aSegments = a.split('/');
  const bSegments = b.split('/');
  const shared = Math.min(aSegments.length, bSegments.length);
  for (let i = 0; i < shared; i++) {
    const cmp = compareWranglerMigrationSegments(aSegments[i] as string, bSegments[i] as string);
    if (cmp !== 0) {
      return cmp;
    }
  }
  return aSegments.length - bSegments.length;
}

export function resolveWranglerMigrationPattern(
  config: Record<string, unknown>,
  binding: string,
  migrationsDirRaw: string,
): { ok: true; pattern: string } | { ok: false; reason: string } {
  const field = readBindingFieldPresence(config, 'd1_databases', binding, 'migrations_pattern');
  const migrationsDir = normalize(migrationsDirRaw.replace(/\\/g, '/')).replace(/\/$/, '');
  if (!field.present) {
    return { ok: true, pattern: '*.sql' };
  }
  const directoryField = readBindingFieldPresence(
    config,
    'd1_databases',
    binding,
    'migrations_dir',
  );
  if (!directoryField.present) {
    return {
      ok: false,
      reason:
        `deploy: migrations_pattern for D1 binding ${binding} requires an explicit ` +
        'migrations_dir in the same binding.',
    };
  }
  if (typeof field.value !== 'string' || field.value.length === 0) {
    return {
      ok: false,
      reason: `deploy: migrations_pattern for D1 binding ${binding} must be a non-empty string.`,
    };
  }
  const normalized = normalize(field.value.replace(/\\/g, '/')).replace(/\/$/, '');
  const prefix = migrationsDir === '.' ? '' : `${migrationsDir}/`;
  if (prefix && !normalized.startsWith(prefix)) {
    return {
      ok: false,
      reason:
        `deploy: migrations_pattern ${JSON.stringify(field.value)} must start with ` +
        `${JSON.stringify(`${migrationsDir}/`)} to match migrations_dir ${JSON.stringify(migrationsDirRaw)}.`,
    };
  }
  const pattern = prefix ? normalized.slice(prefix.length) : normalized;
  try {
    new Minimatch(pattern, { dot: false });
  } catch (error) {
    return {
      ok: false,
      reason: `deploy: invalid migrations_pattern ${JSON.stringify(field.value)} — ${getErrorMessage(error)}`,
    };
  }
  return { ok: true, pattern };
}

function listWranglerMigrationFiles(directory: string, pattern: string): Array<string> {
  const matcher = new Minimatch(pattern, { dot: false });
  const files: Array<string> = [];
  const visit = (absolute: string, relativeDirectory: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(join(absolute, entry.name), relativePath);
      } else if (entry.isFile() && matcher.match(relativePath)) {
        files.push(relativePath);
      }
    }
  };
  visit(directory, '');
  return files.sort(compareWranglerMigrationPaths);
}

/**
 * Assert the files `d1 migrations apply` would apply from the binding's `migrations_dir` and
 * `migrations_pattern` match the validated migrations by name and content, and in the same
 * order. Otherwise a stray file such as `seed.sql`, or an unpadded `2_` vs `10_` prefix, would
 * reach remote D1 unvalidated or out of order. `displayDir` is the project's migrations folder
 * as the messages name it.
 */
export async function checkWranglerMigrationApplySet(
  configPath: string,
  config: Record<string, unknown>,
  binding: string,
  migrationsDirRaw: string,
  gated: Array<{ name: string; sql: string }>,
  displayDir = 'db/migrations',
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const absDir = resolve(dirname(configPath), migrationsDirRaw);
  if (!existsSync(absDir)) {
    return {
      ok: false,
      reason:
        `deploy: configured migrations_dir ${JSON.stringify(migrationsDirRaw)} resolves to ` +
        `${absDir}, which does not exist — wrangler would have nothing to apply (or error). ` +
        `Align "migrations_dir" with your ${displayDir}, then rerun.`,
    };
  }
  const resolvedPattern = resolveWranglerMigrationPattern(config, binding, migrationsDirRaw);
  if (!resolvedPattern.ok) {
    return resolvedPattern;
  }
  const wranglerNames = listWranglerMigrationFiles(absDir, resolvedPattern.pattern);
  const wranglerContent = new Map(
    wranglerNames.map((name) => [name, readFileSync(join(absDir, name), 'utf-8')]),
  );
  const gatedNames = gated.map((m) => m.name.replace(/\\/g, '/'));
  const gatedContent = new Map(gatedNames.map((name, i) => [name, gated[i]!.sql]));

  const wranglerSet = new Set(wranglerNames);
  const extra = wranglerNames.filter((k) => !gatedContent.has(k));
  const missing = gatedNames.filter((k) => !wranglerSet.has(k)).sort();
  const changed = wranglerNames.filter(
    (k) => gatedContent.has(k) && gatedContent.get(k) !== wranglerContent.get(k),
  );
  if (extra.length > 0 || missing.length > 0 || changed.length > 0) {
    const lines = [
      `deploy: the migrations wrangler would apply to remote D1 do not match Void's validated set (${absDir}).`,
    ];
    if (extra.length > 0) {
      lines.push(`  • wrangler would ALSO apply (not validated by Void): ${extra.join(', ')}`);
    }
    if (missing.length > 0) {
      lines.push(`  • validated by Void but NOT in wrangler's set: ${missing.join(', ')}`);
    }
    if (changed.length > 0) {
      lines.push(`  • content differs between Void's copy and wrangler's: ${changed.join(', ')}`);
    }
    lines.push(
      `Only Void-managed ${displayDir}/*.sql may be applied. Remove stray .sql (e.g. seed.sql) ` +
        'from migrations_dir, then rerun.',
    );
    return { ok: false, reason: lines.join('\n') };
  }

  const orderDiffers =
    gatedNames.length !== wranglerNames.length ||
    gatedNames.some((name, i) => name !== wranglerNames[i]);
  if (orderDiffers) {
    return {
      ok: false,
      reason: [
        `deploy: wrangler would apply your migrations in a DIFFERENT order than Void validated (${absDir}).`,
        `  • wrangler (numeric-prefix) order: ${wranglerNames.join(', ')}`,
        `  • Void's validated order:          ${gatedNames.join(', ')}`,
        "This happens when a migration's numeric prefix is not zero-padded (e.g. `2_` vs `10_`),",
        'so it sorts differently for wrangler (numeric) than for Void (lexicographic) — remote D1',
        'would receive them out of the validated order. Rename only migrations that are not applied',
        'yet (a renamed applied migration runs again), or give the new file a name that sorts last',
        'in both orders, then rerun.',
      ].join('\n'),
    };
  }

  return { ok: true };
}

function cloudflareReason(result: DeployWranglerRunResult): string {
  // stdout can hold binding values, so only the error output is shown.
  const detail = cloudflareCommandDiagnostic({ ...result, stdout: '' });
  return detail ? `\nCloudflare: ${sanitizeTerminalLogText(detail)}` : '';
}

/** Name the restore point when deploy stops after it applied D1 migrations. */
export function logD1RestoreAfterDeployFailure(restoreCommand: string): void {
  log.error(
    'deploy: D1 migrations were applied before the deploy stopped. Fix the error and deploy again.\n' +
      'If the live version cannot run against the new schema, restore the point saved before them ' +
      `(discards every later write):\n  ${restoreCommand}`,
  );
}

/**
 * Apply remote D1 changes and prove no migrations remain pending. Returns the command that
 * restores the point saved before them, if this deploy applied any.
 */
export async function applyAndVerifyRemoteD1Migrations(
  d1MigrateToken: string | undefined,
  configPath: string,
  runWrangler: DeployWranglerRun,
  assertUploaderStillPinned: () => boolean,
  /** Set after a one-off `--platform cloudflare` deploy, which does not change the saved platform. */
  restorePlatformFlag = false,
): Promise<false | { restoreCommand: string | undefined }> {
  let restoreCommand: string | undefined;
  // Runs only after every local gate passes, so a failed gate never changes remote D1.
  if (d1MigrateToken) {
    log.step('Applying D1 migrations...');
    // The local gates ran project code, which could have replaced the pinned uploader.
    if (!assertUploaderStillPinned()) {
      return false;
    }
    // A Worker rollback does not undo a migration. Time Travel does, and a bookmark taken right
    // before the apply restores exactly the state the migrations started from.
    const readPending = async (): Promise<Array<unknown> | undefined> => {
      const listed = await Promise.resolve(
        runWrangler(
          { type: 'd1.migrations.list', database: d1MigrateToken, configPath },
          { capture: true },
        ),
      );
      const pending = (listed.data as { pending?: unknown } | undefined)?.pending;
      if (isCleanCloudflareExit(listed) && Array.isArray(pending)) {
        return pending;
      }
      log.error(
        `deploy: could not read the pending D1 migrations for "${d1MigrateToken}" before applying them ` +
          (isCleanCloudflareExit(listed)
            ? '(Cloudflare returned no pending migration list). '
            : `(exit ${String(listed.status)}). `) +
          'Refusing to migrate without knowing whether a restore point is needed. Rerun once Cloudflare can be reached.' +
          cloudflareReason(listed),
      );
      return undefined;
    };
    const pendingBefore = await readPending();
    if (!pendingBefore) {
      return false;
    }
    let restoreHint = '';
    if (pendingBefore.length > 0) {
      const restorePoint = await Promise.resolve(
        runWrangler(
          { type: 'd1.time-travel.bookmark', database: d1MigrateToken, configPath },
          { capture: true },
        ),
      );
      const bookmark = (restorePoint.data as { bookmark?: unknown } | undefined)?.bookmark;
      if (!isCleanCloudflareExit(restorePoint) || typeof bookmark !== 'string') {
        log.error(
          `deploy: could not save a D1 restore point for "${d1MigrateToken}" before applying ` +
            `${formatCount(pendingBefore.length, 'migration')}. A Worker rollback does not undo a migration. ` +
            'Refusing to migrate without a restore point. Rerun once the restore point can be saved.' +
            cloudflareReason(restorePoint),
        );
        return false;
      }
      // An overlapping deploy may have applied some of them before the bookmark. Whatever is still
      // pending now is applied after it, so the bookmark undoes exactly those.
      const pendingAfterBookmark = await readPending();
      if (!pendingAfterBookmark) {
        return false;
      }
      if (pendingAfterBookmark.length > 0) {
        restoreCommand = `void db restore${restorePlatformFlag ? ' --platform cloudflare' : ''} --bookmark=${bookmark}`;
        restoreHint =
          '\nTo undo these migrations, restore this point (discards every later write):\n' +
          `  ${restoreCommand}`;
        log.info(
          `Saved a D1 restore point before applying ${formatCount(pendingAfterBookmark.length, 'migration')}.${restoreHint}`,
        );
      }
      if (!assertUploaderStillPinned()) {
        return false;
      }
    }
    const migrate = await Promise.resolve(
      runWrangler(
        { type: 'd1.migrations.apply', database: d1MigrateToken, configPath },
        { capture: false },
      ),
    );
    if (!isCleanCloudflareExit(migrate)) {
      log.error(
        `deploy: remote D1 migrations failed for "${d1MigrateToken}" (exit ${String(migrate.status)}). ` +
          'Fix the migration and rerun. Note: D1 always enforces foreign_keys=ON — a Drizzle ' +
          'table-rebuild using PRAGMA foreign_keys=OFF must use PRAGMA defer_foreign_keys instead.' +
          restoreHint,
      );
      return false;
    }

    // A clean exit does not prove the schema is current, so read the pending set.
    if (!assertUploaderStillPinned()) {
      if (restoreCommand) {
        logD1RestoreAfterDeployFailure(restoreCommand);
      }
      return false;
    }
    const migrateList = await Promise.resolve(
      runWrangler(
        { type: 'd1.migrations.list', database: d1MigrateToken, configPath },
        { capture: true },
      ),
    );
    if (!isCleanCloudflareExit(migrateList)) {
      log.error(
        `deploy: could not verify the remote migration state for "${d1MigrateToken}" ` +
          `(\`d1 migrations list\` exit ${String(migrateList.status)}). Refusing to deploy against ` +
          'an unverified schema — rerun once wrangler can reach your account.' +
          restoreHint,
      );
      return false;
    }
    const migrationState = migrateList.data as { pending?: unknown } | undefined;
    if (Array.isArray(migrationState?.pending) && migrationState.pending.length > 0) {
      log.error(
        [
          `deploy: remote D1 still has UNAPPLIED migrations for "${d1MigrateToken}" after apply.`,
          'The schema is not current for this deployment. Fix or apply the pending migrations, then retry.',
        ].join('\n') + restoreHint,
      );
      return false;
    }
    if (
      !Array.isArray(migrationState?.pending) ||
      !migrationState.pending.every((name) => typeof name === 'string')
    ) {
      log.error(
        [
          `deploy: could not confirm the remote migration state for "${d1MigrateToken}".`,
          'Cloudflare returned an invalid pending migration set. Refusing to deploy against an unverified schema.',
          'Retry once the database migration state can be read.',
        ].join('\n') + restoreHint,
      );
      return false;
    }
  }

  return { restoreCommand };
}
