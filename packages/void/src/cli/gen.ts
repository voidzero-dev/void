import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { log, select, isCancel, cancel } from '@voidzero-dev/vite-plus-prompts';
import { join, dirname, relative } from 'pathslash';
import { readConfig, getDatabaseDialect, type DatabaseDialect } from '../config.ts';
import { PLACEHOLDER_DB_URL, writeDrizzleConfig } from '../drizzle/config.ts';
import { snapshotDrizzleOutputs } from '../drizzle/generate.ts';
import { collectMigrations, readJournal } from '../migrations/collect.ts';
import { assertJournalCoherence } from '../migrations/validate.ts';
import { readProjectPaths } from '../project-paths.ts';
import type { GenArgs } from './gen-args.ts';
import { printSuccess } from './output.ts';
import { buildDrizzleKitSpawnEnv, drizzleKitBin } from './yarn-pnp.ts';

export async function runGenCommand(root: string, args: GenArgs): Promise<void> {
  console.log();

  if (args.subcommand === 'model') {
    await runModel(root, args.name, args.columns);
  } else if (args.subcommand === 'migration') {
    runMigration(root, args.name);
  } else if (args.subcommand === 'route') {
    runRoute(root, args.path, args.methods);
  } else if (args.subcommand === 'middleware') {
    runMiddleware(root, args.name);
  } else if (args.subcommand === 'cron') {
    runCron(root, args.name);
  } else if (args.subcommand === 'queue') {
    runQueue(root, args.name);
  } else {
    runSsr(root, args.framework);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeIfNotExists(filePath: string, content: string): boolean {
  if (existsSync(filePath)) {
    log.warn(`Skipped (already exists): ${filePath}`);
    return false;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  log.step(`Created ${filePath}`);
  return true;
}

export function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    String(date.getUTCFullYear()) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds())
  );
}

function getMigrationTimestamp(migrationsDir: string): string {
  const now = new Date();
  let ts = formatTimestamp(now);
  // If a file with this timestamp already exists, increment seconds until unique
  while (readdirSync(migrationsDir).some((f) => f.startsWith(ts + '_'))) {
    now.setSeconds(now.getSeconds() + 1);
    ts = formatTimestamp(now);
  }
  return ts;
}

function getNextMiddlewareNumber(middlewareDir: string): string {
  if (!existsSync(middlewareDir)) {
    return '01';
  }
  const files = readdirSync(middlewareDir);
  let max = 0;
  for (const file of files) {
    const match = file.match(/^(\d+)\./);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return String(max + 1).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// Column type mapping
// ---------------------------------------------------------------------------

type ColumnSpec = {
  name: string;
  type: string;
  nullable: boolean;
};

type ColumnBuilder = { fn: string; options?: string };

const TEXT_COLUMN: ColumnBuilder = { fn: 'text' };

// Types without a builder (`datetime`, `blob`) fall back to a plain `text()` column.
const COLUMN_BUILDERS: Record<DatabaseDialect, Partial<Record<string, ColumnBuilder>>> = {
  sqlite: {
    string: TEXT_COLUMN,
    text: TEXT_COLUMN,
    integer: { fn: 'integer' },
    boolean: { fn: 'integer', options: '{ mode: "boolean" }' },
    real: { fn: 'real' },
  },
  postgresql: {
    string: TEXT_COLUMN,
    text: TEXT_COLUMN,
    integer: { fn: 'integer' },
    boolean: { fn: 'boolean' },
    real: { fn: 'doublePrecision' },
  },
  mysql: {
    string: TEXT_COLUMN,
    text: TEXT_COLUMN,
    integer: { fn: 'int' },
    boolean: { fn: 'boolean' },
    real: { fn: 'double' },
  },
};

const BASE_IMPORTS: Record<DatabaseDialect, Array<string>> = {
  sqlite: ['text', 'integer'],
  postgresql: ['text', 'serial', 'timestamp'],
  mysql: ['int', 'text', 'timestamp'],
};

function drizzleColumnDef(dialect: DatabaseDialect, col: ColumnSpec): string {
  const { name } = col;
  const builder = COLUMN_BUILDERS[dialect][col.type];
  if (!builder) {
    return `  ${name}: text("${name}"),`;
  }
  const args = builder.options ? `"${name}", ${builder.options}` : `"${name}"`;
  const notNull = col.nullable ? '' : '.notNull()';
  const defaultValue = col.type === 'boolean' ? '.default(false)' : '';
  return `  ${name}: ${builder.fn}(${args})${notNull}${defaultValue},`;
}

function drizzleImportsForColumns(
  dialect: DatabaseDialect,
  columns: Array<ColumnSpec>,
): Array<string> {
  const imports = new Set(BASE_IMPORTS[dialect]);
  for (const col of columns) {
    imports.add(COLUMN_BUILDERS[dialect][col.type]?.fn ?? 'text');
  }
  return [...imports].sort();
}

// ---------------------------------------------------------------------------
// Validator detection + templates
// ---------------------------------------------------------------------------

type Validator = 'valibot' | 'zod' | 'arktype' | 'none';

export function detectValidator(root: string): Validator | null {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) {
    return null;
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  if ('valibot' in allDeps) {
    return 'valibot';
  }
  if ('zod' in allDeps) {
    return 'zod';
  }
  if ('arktype' in allDeps) {
    return 'arktype';
  }
  return null;
}

async function resolveValidator(root: string): Promise<Validator> {
  const detected = detectValidator(root);
  if (detected) {
    log.info(`Detected validator: ${detected}`);
    return detected;
  }

  const choice = await select({
    message: 'No validation library detected. Which would you like to use?',
    options: [
      { value: 'valibot', label: 'Valibot' },
      { value: 'zod', label: 'Zod' },
      { value: 'arktype', label: 'ArkType' },
      { value: 'none', label: 'No validation' },
    ],
  });

  if (isCancel(choice) || typeof choice === 'symbol') {
    cancel('Cancelled.');
    process.exit(0);
  }

  if (choice !== 'none') {
    log.warn(`Remember to install ${choice}: npm install ${choice}`);
  }

  return choice as Validator;
}

type SchemaValidator = Exclude<Validator, 'none'>;

type ValidatorTypes = {
  string: string;
  number: string;
  boolean: string;
  blob: string;
  optional: (base: string) => string;
};

const VALIDATOR_TYPES: Record<SchemaValidator, ValidatorTypes> = {
  valibot: {
    string: 'v.string()',
    number: 'v.number()',
    boolean: 'v.boolean()',
    blob: 'v.instance(Blob)',
    optional: (base) => `v.optional(${base})`,
  },
  zod: {
    string: 'z.string()',
    number: 'z.number()',
    boolean: 'z.boolean()',
    blob: 'z.instanceof(Blob)',
    optional: (base) => `${base}.optional()`,
  },
  arktype: {
    string: 'string',
    number: 'number',
    boolean: 'boolean',
    blob: 'instanceof Blob',
    optional: (base) => `${base} | undefined`,
  },
};

// Column types not listed here (`string`, `text`, `datetime`) validate as strings.
const VALUE_KINDS: Partial<Record<string, 'number' | 'boolean' | 'blob'>> = {
  integer: 'number',
  real: 'number',
  boolean: 'boolean',
  blob: 'blob',
};

function validatorType(validator: SchemaValidator, col: ColumnSpec): string {
  const types = VALIDATOR_TYPES[validator];
  const base = types[VALUE_KINDS[col.type] ?? 'string'];
  return col.nullable ? types.optional(base) : base;
}

function getImportLine(validator: Validator): string | null {
  switch (validator) {
    case 'valibot':
      return 'import * as v from "valibot";';
    case 'zod':
      return 'import { z } from "zod";';
    case 'arktype':
      return 'import { type } from "arktype";';
    case 'none':
      return null;
  }
}

function getBodySchema(validator: SchemaValidator, columns: Array<ColumnSpec>): string {
  if (validator === 'arktype') {
    const fields = columns
      .map((c) => `    ${c.name}: "${validatorType(validator, c)}",`)
      .join('\n');
    return `type({\n${fields}\n  })`;
  }
  const fields = columns.map((c) => `    ${c.name}: ${validatorType(validator, c)},`).join('\n');
  const prefix = validator === 'valibot' ? 'v' : 'z';
  return `${prefix}.object({\n${fields}\n  })`;
}

function getParamsSchema(validator: Validator): string {
  switch (validator) {
    case 'valibot':
      return 'v.object({ id: v.string() })';
    case 'zod':
      return 'z.object({ id: z.string() })';
    case 'arktype':
      return 'type({ id: "string" })';
    case 'none':
      return '';
  }
}

// ---------------------------------------------------------------------------
// Route templates
// ---------------------------------------------------------------------------

function generateIndexRoute(
  name: string,
  columns: Array<ColumnSpec>,
  validator: Validator,
): string {
  const importLine = getImportLine(validator);
  const imports = [
    importLine,
    'import { defineHandler } from "void";',
    'import { db } from "void/db";',
    `import { ${name} } from "@schema";`,
  ]
    .filter(Boolean)
    .join('\n');

  const insertFields = columns.map((c) => `${c.name}: body.${c.name}`).join(', ');

  if (columns.length === 0 || validator === 'none') {
    const values = columns.length > 0 ? `{ ${insertFields} }` : 'body';
    return `import { defineHandler } from "void";
import { db } from "void/db";
import { ${name} } from "@schema";

export const GET = defineHandler(async () => {
  return db.select().from(${name});
});

export const POST = defineHandler(async (c) => {
  const body = await c.req.json();
  await db.insert(${name}).values(${values});
  return { created: true };
});
`;
  }

  const bodySchema = getBodySchema(validator, columns);
  return `${imports}

export const GET = defineHandler(async () => {
  return db.select().from(${name});
});

export const POST = defineHandler.withValidator({
  body: ${bodySchema},
})(async (c, { body }) => {
  await db.insert(${name}).values({ ${insertFields} });
  return { created: true };
});
`;
}

function generateIdRoute(name: string, validator: Validator): string {
  if (validator === 'none') {
    return `import { defineHandler } from "void";
import { db, eq } from "void/db";
import { ${name} } from "@schema";

export const GET = defineHandler(async (c) => {
  const id = c.req.param("id");
  const [row] = await db.select().from(${name}).where(eq(${name}.id, Number(id)));

  if (!row) {
    return new Response("Not found", { status: 404 });
  }
  return row;
});
`;
  }

  const importLine = getImportLine(validator)!;
  const paramsSchema = getParamsSchema(validator);

  return `${importLine}
import { defineHandler } from "void";
import { db, eq } from "void/db";
import { ${name} } from "@schema";

export const GET = defineHandler.withValidator({
  params: ${paramsSchema},
})(async (c, { params }) => {
  const [row] = await db.select().from(${name}).where(eq(${name}.id, Number(params.id)));

  if (!row) {
    return new Response("Not found", { status: 404 });
  }
  return row;
});
`;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function runModel(root: string, name: string, columns: Array<ColumnSpec>): Promise<void> {
  const validator = await resolveValidator(root);

  const dialect = getDatabaseDialect(readConfig(root));
  const paths = readProjectPaths(root);

  const schemaDir = paths.schemaDir;
  const barrelPath = paths.schemaFile;
  const modelPath = join(schemaDir, `${name}.ts`);

  // 1. Generate Drizzle table definition
  const colDefs = columns.map((col) => drizzleColumnDef(dialect, col));
  const columnImports = drizzleImportsForColumns(dialect, columns).join(', ');
  let content: string;
  if (dialect === 'postgresql') {
    content = [
      `import { pgTable, ${columnImports} } from "void/schema-pg";`,
      '',
      `export const ${name} = pgTable("${name}", {`,
      `  id: serial("id").primaryKey(),`,
      ...colDefs,
      `  createdAt: timestamp("created_at").notNull().defaultNow(),`,
      `  updatedAt: timestamp("updated_at").notNull().defaultNow(),`,
      '});',
      '',
    ].join('\n');
  } else if (dialect === 'mysql') {
    content = [
      `import { mysqlTable, ${columnImports} } from "void/schema-mysql";`,
      '',
      `export const ${name} = mysqlTable("${name}", {`,
      `  id: int("id").autoincrement().primaryKey(),`,
      ...colDefs,
      `  createdAt: timestamp("created_at").notNull().defaultNow(),`,
      `  updatedAt: timestamp("updated_at").notNull().defaultNow(),`,
      '});',
      '',
    ].join('\n');
  } else {
    content = [
      `import { sqliteTable, ${columnImports} } from "void/schema-d1";`,
      `import { sql } from "void/db";`,
      '',
      `export const ${name} = sqliteTable("${name}", {`,
      `  id: integer("id").primaryKey({ autoIncrement: true }),`,
      ...colDefs,
      '  createdAt: text("created_at").notNull().default(sql`(datetime(\'now\'))`),',
      '  updatedAt: text("updated_at").notNull().default(sql`(datetime(\'now\'))`),',
      '});',
      '',
    ].join('\n');
  }

  // Write the model file
  mkdirSync(schemaDir, { recursive: true });
  writeIfNotExists(modelPath, content);

  // 2. Update or create barrel export
  const exportLine = `export * from "./schema/${name}";`;
  if (existsSync(barrelPath)) {
    const existing = readFileSync(barrelPath, 'utf-8');
    if (!existing.includes(exportLine)) {
      writeFileSync(barrelPath, existing.trimEnd() + '\n' + exportLine + '\n');
    }
  } else {
    writeFileSync(barrelPath, exportLine + '\n');
  }

  // 3. Regenerate .void, including every file that .void/tsconfig.json lists
  const { prepareProject } = await import('../codegen/prepare.ts');
  await prepareProject(root);

  log.step(`Created ${relative(root, modelPath)}`);
  log.step(`Updated ${relative(root, barrelPath)}`);

  // 4. Routes: routes/api/<name>/index.ts
  const routeIndexPath = join(paths.routesDir, 'api', name, 'index.ts');
  writeIfNotExists(routeIndexPath, generateIndexRoute(name, columns, validator));

  // 5. Route: routes/api/<name>/[id].ts
  const routeIdPath = join(paths.routesDir, 'api', name, '[id].ts');
  writeIfNotExists(routeIdPath, generateIdRoute(name, validator));

  printSuccess('Model scaffolding complete. Run `void db push` to apply.');
}

function runMigration(root: string, name: string): void {
  const paths = readProjectPaths(root);
  const migrationsDir = paths.migrationsDir;
  const dir = paths.sourceRelative('db/migrations');
  mkdirSync(migrationsDir, { recursive: true });

  // The same preflight as the other db commands, before any write. It runs
  // before the bundle check so a leftover migrations.js without a journal
  // gets the partial-state recovery advice.
  const currentMigrations = collectMigrations(migrationsDir);
  try {
    assertJournalCoherence(migrationsDir, currentMigrations, paths.sourceRelative);
  } catch (err: unknown) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Bundled mode needs a matching `m000N` import in migrations.js for every
  // journal entry, and only drizzle-kit can regenerate that file.
  const bundlePath = join(migrationsDir, 'migrations.js');
  if (existsSync(bundlePath)) {
    log.error(
      `Your project uses Drizzle's bundled migration format (${dir}/migrations.js).\n` +
        '`void gen migration` cannot add custom hand-written migrations to a bundled project\n' +
        'because the bundle must be regenerated by drizzle-kit.\n\n' +
        'Either run `drizzle-kit generate` to regenerate the bundle, or migrate away from\n' +
        `bundled mode by deleting ${dir}/migrations.js and re-running \`void db generate\`.`,
    );
    process.exit(1);
  }

  // With journal entries, delegate to `drizzle-kit generate --custom`: it also
  // snapshots the current schema, so the next `void db generate` does not
  // re-emit DDL that the custom migration already applies.
  const existingJournal = readJournal(migrationsDir, paths.sourceRelative);
  if (existingJournal !== undefined && existingJournal.entries.length > 0) {
    const lastEntry = existingJournal.entries[existingJournal.entries.length - 1];
    const metaDir = join(migrationsDir, 'meta');
    // Use the snapshot named by the last journal tag, not the newest file in
    // meta/, which may be a stale leftover.
    const lastSnapshotPrefix = lastEntry.tag.split('_')[0];
    const prevSnapshotPath = join(metaDir, `${lastSnapshotPrefix}_snapshot.json`);
    if (!existsSync(prevSnapshotPath)) {
      log.error(
        `${dir}/meta/_journal.json's last entry is \`${lastEntry.tag}\` but the matching snapshot \`${lastSnapshotPrefix}_snapshot.json\` is missing under meta/.`,
      );
      log.error(
        'Restore the snapshot from version control, or regenerate migrations with `void db generate` before running `void gen migration`.',
      );
      process.exit(1);
    }

    const rollBack = snapshotDrizzleOutputs(migrationsDir);
    const sqlFilesBefore = new Set(readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')));

    // The existing snapshot chain was built for the journal's dialect. Refuse
    // rather than append a snapshot in a different dialect.
    let journalDialect: 'sqlite' | 'postgresql' | 'mysql';
    if (existingJournal.dialect === 'sqlite') {
      journalDialect = 'sqlite';
    } else if (existingJournal.dialect === 'postgresql') {
      journalDialect = 'postgresql';
    } else if (existingJournal.dialect === 'mysql') {
      journalDialect = 'mysql';
    } else {
      log.error(
        `${dir}/meta/_journal.json has an unsupported dialect: \`${existingJournal.dialect}\`.`,
      );
      log.error(
        `void supports \`sqlite\`, \`postgresql\`, and \`mysql\` only. Restore the journal from version control, or drop ${dir}/ and regenerate from scratch.`,
      );
      process.exit(1);
    }
    const configDialect = getDatabaseDialect(readConfig(root));
    if (configDialect !== journalDialect) {
      log.error(
        `${dir}/meta/_journal.json was generated for ${journalDialect}, but void.config.ts is configured for ${configDialect}.`,
      );
      log.error(
        `Generating a new custom migration now would append a snapshot in the wrong dialect. Revert void.config.ts's \`database\` field to ${journalDialect}, or drop ${dir}/ and regenerate from scratch.`,
      );
      process.exit(1);
    }
    const authSchemaPath = join(root, '.void', 'better-auth-schema.ts');
    const additionalSchemas = existsSync(authSchemaPath) ? [authSchemaPath] : undefined;
    const configPath = writeDrizzleConfig(
      root,
      PLACEHOLDER_DB_URL[journalDialect],
      journalDialect,
      { additionalSchemas },
    );

    const result = spawnSync(
      process.execPath,
      [drizzleKitBin, 'generate', '--config', configPath, '--custom', '--name', name],
      {
        cwd: root,
        stdio: 'pipe',
        encoding: 'utf-8',
        // Yarn PnP projects need the PnP loader to resolve `void/schema-*`.
        env: buildDrizzleKitSpawnEnv(root),
      },
    );

    if (result.error || result.status !== 0) {
      rollBack();
      const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
      log.error(
        [
          `Failed to run \`drizzle-kit generate --custom --name ${name}\`.`,
          ...(detail ? [detail] : []),
          '',
          `This is usually a schema-compilation error. Fix any TypeScript errors in ${paths.sourceRelative('db/schema.ts')} and try again.`,
        ].join('\n'),
      );
      process.exit(1);
    }

    const newSqlFile = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .find((f) => !sqlFilesBefore.has(f));
    if (newSqlFile) {
      log.step(`Created ${dir}/${newSqlFile}`);
    }

    printSuccess('Migration created and journal updated.');
    return;
  }

  const timestamp = getMigrationTimestamp(migrationsDir);
  const tag = `${timestamp}_${name}`;
  const filePath = join(migrationsDir, `${tag}.sql`);

  if (writeIfNotExists(filePath, `-- ${name}\n`)) {
    printSuccess('Migration created.');
  }
}

function runRoute(root: string, routePath: string, methods: Array<string>): void {
  const filePath = join(readProjectPaths(root).routesDir, routePath + '.ts');
  const exports = methods
    .map((m) => {
      const upper = m.toUpperCase();
      return `export const ${upper} = defineHandler(async () => {
  return { message: "${upper} ${routePath}" };
});`;
    })
    .join('\n\n');

  const content = `import { defineHandler } from "void";

${exports}
`;
  if (writeIfNotExists(filePath, content)) {
    printSuccess('Route created.');
  }
}

function runMiddleware(root: string, name: string): void {
  const middlewareDir = readProjectPaths(root).middlewareDir;
  mkdirSync(middlewareDir, { recursive: true });

  const num = getNextMiddlewareNumber(middlewareDir);
  const filePath = join(middlewareDir, `${num}.${name}.ts`);
  const content = `import { defineMiddleware } from "void";

export default defineMiddleware(async (c, next) => {
  // TODO: implement ${name} middleware
  await next();
});
`;
  if (writeIfNotExists(filePath, content)) {
    printSuccess('Middleware created.');
  }
}

function runCron(root: string, name: string): void {
  const filePath = join(readProjectPaths(root).cronsDir, name + '.ts');
  const content = `import { defineScheduled } from "void";

export const cron = "* * * * *";

export default defineScheduled(async (controller, env) => {
  // TODO: implement ${name}
});
`;
  if (writeIfNotExists(filePath, content)) {
    printSuccess('Cron job created.');
  }
}

function runQueue(root: string, name: string): void {
  const filePath = join(readProjectPaths(root).queuesDir, name + '.ts');
  const content = `import { defineQueue } from "void";

type Message = {};

// export const maxBatchSize = 10;
// export const maxBatchTimeout = 5;

export default defineQueue<Message>(async (batch, env) => {
  for (const message of batch.messages) {
    // TODO: process message
  }
});
`;
  if (writeIfNotExists(filePath, content)) {
    printSuccess('Queue consumer created.');
  }
}

function runSsr(root: string, framework?: 'react' | 'vue' | 'svelte' | 'solid'): void {
  if (!framework) {
    framework = detectFramework(root);
  }

  if (framework === 'react') {
    writeReactSsr(root);
  } else if (framework === 'vue') {
    writeVueSsr(root);
  } else if (framework === 'svelte') {
    writeSvelteSsr(root);
  } else {
    writeSolidSsr(root);
  }

  printSuccess('SSR scaffolding complete.');
}

function detectFramework(root: string): 'react' | 'vue' | 'svelte' | 'solid' {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) {
    log.error(
      'No package.json found. Use --react, --vue, --svelte, or --solid to specify a framework.',
    );
    process.exit(1);
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  if ('react' in allDeps) {
    return 'react';
  }
  if ('vue' in allDeps) {
    return 'vue';
  }
  if ('svelte' in allDeps) {
    return 'svelte';
  }
  if ('solid-js' in allDeps) {
    return 'solid';
  }

  log.error(
    'Could not detect framework from package.json. Use --react, --vue, --svelte, or --solid.',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// SSR templates
// ---------------------------------------------------------------------------

function writeReactSsr(root: string): void {
  const ssrDir = readProjectPaths(root).ssrDir;
  writeIfNotExists(
    join(ssrDir, 'main.ssr.tsx'),
    `import { renderToString } from "react-dom/server";
import { defineRender } from "void";
import App from "./App";

export default defineRender(async (c, assetTags) => {
  const appHtml = renderToString(<App />);
  const html = \`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
    \${assetTags.css}\${assetTags.preloads}
  </head>
  <body>
    <div id="root">\${appHtml}</div>
    \${assetTags.body}
  </body>
</html>\`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
`,
  );

  writeIfNotExists(
    join(ssrDir, 'main.client.tsx'),
    `import { hydrateRoot } from "react-dom/client";
import App from "./App";

hydrateRoot(document.getElementById("root")!, <App />);
`,
  );

  writeIfNotExists(
    join(ssrDir, 'App.tsx'),
    `import { useState } from "react";

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <main>
      <h1>Hello Void</h1>
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        Count: {count}
      </button>
    </main>
  );
}
`,
  );
}

function writeVueSsr(root: string): void {
  const ssrDir = readProjectPaths(root).ssrDir;
  writeIfNotExists(
    join(ssrDir, 'main.ssr.ts'),
    `import { createSSRApp } from "vue";
import { renderToString, type SSRContext } from "vue/server-renderer";
import { defineRender } from "void";
import App from "./App.vue";

export default defineRender(async (c, assetTags) => {
  const app = createSSRApp(App);
  // \`Image\` from @void/vue collects its <link rel="preload"> tags here.
  const ssrContext: SSRContext = {};
  const appHtml = await renderToString(app, ssrContext);
  const imagePreloads = ssrContext.__voidImagePreloads?.render() ?? "";
  const html = \`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
    \${imagePreloads}\${assetTags.css}\${assetTags.preloads}
  </head>
  <body>
    <div id="app">\${appHtml}</div>
    \${assetTags.body}
  </body>
</html>\`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
`,
  );

  writeIfNotExists(
    join(ssrDir, 'main.client.ts'),
    `import { createSSRApp } from "vue";
import App from "./App.vue";

const app = createSSRApp(App);
app.mount("#app");
`,
  );

  writeIfNotExists(
    join(ssrDir, 'App.vue'),
    `<script setup lang="ts">
import { ref } from "vue";

const count = ref(0);
</script>

<template>
  <main>
    <h1>Hello Void</h1>
    <button type="button" @click="count++">Count: {{ count }}</button>
  </main>
</template>
`,
  );
}

function writeSvelteSsr(root: string): void {
  const ssrDir = readProjectPaths(root).ssrDir;
  writeIfNotExists(
    join(ssrDir, 'main.ssr.ts'),
    `import { render } from "svelte/server";
import { defineRender } from "void";
import App from "./App.svelte";

export default defineRender(async (c, assetTags) => {
  const { head, body: appHtml } = render(App);
  const html = \`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
    \${head}\${assetTags.css}\${assetTags.preloads}
  </head>
  <body>
    <div id="app">\${appHtml}</div>
    \${assetTags.body}
  </body>
</html>\`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
`,
  );

  writeIfNotExists(
    join(ssrDir, 'main.client.ts'),
    `import { hydrate } from "svelte";
import App from "./App.svelte";

hydrate(App, { target: document.getElementById("app")! });
`,
  );

  writeIfNotExists(
    join(ssrDir, 'App.svelte'),
    `<script>
  let count = $state(0);
</script>

<main>
  <h1>Hello Void</h1>
  <button type="button" onclick={() => count++}>Count: {count}</button>
</main>
`,
  );
}

function writeSolidSsr(root: string): void {
  const ssrDir = readProjectPaths(root).ssrDir;
  writeIfNotExists(
    join(ssrDir, 'main.ssr.tsx'),
    `import { renderToString } from "solid-js/web";
import { defineRender } from "void";
import App from "./App";

export default defineRender(async (c, assetTags) => {
  const appHtml = renderToString(() => <App />);
  const html = \`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
    \${assetTags.css}\${assetTags.preloads}
  </head>
  <body>
    <div id="app">\${appHtml}</div>
    \${assetTags.body}
  </body>
</html>\`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
`,
  );

  writeIfNotExists(
    join(ssrDir, 'main.client.tsx'),
    `import { hydrate } from "solid-js/web";
import App from "./App";

hydrate(() => <App />, document.getElementById("app")!);
`,
  );

  writeIfNotExists(
    join(ssrDir, 'App.tsx'),
    `import { createSignal } from "solid-js";

export default function App() {
  const [count, setCount] = createSignal(0);

  return (
    <main>
      <h1>Hello Void</h1>
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        Count: {count()}
      </button>
    </main>
  );
}
`,
  );
}
