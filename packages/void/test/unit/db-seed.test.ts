import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { packageFixturePath } from '../../../../test/fixture-dir.ts';
// oxlint-disable-next-line import/no-namespace -- The test replaces or spies on members of the module object.
import * as output from '../../src/cli/output.ts';
import { createProjectTsconfig } from '../../src/codegen/project-tsconfig.ts';
import { getMiniflareDatabasePath } from '../../src/migrations/runner.ts';

const mockIntro = vi.fn<typeof import('@voidzero-dev/vite-plus-prompts').intro>();
const mockOutro = vi.fn<typeof import('@voidzero-dev/vite-plus-prompts').outro>();
const mockConfirm = vi.fn<typeof import('@voidzero-dev/vite-plus-prompts').confirm>();
const mockLog = {
  error: vi.fn<typeof import('@voidzero-dev/vite-plus-prompts').log.error>(),
  info: vi.fn<typeof import('@voidzero-dev/vite-plus-prompts').log.info>(),
  step: vi.fn<typeof import('@voidzero-dev/vite-plus-prompts').log.step>(),
  success: vi.fn<typeof import('@voidzero-dev/vite-plus-prompts').log.success>(),
};
const pgQueries = vi.hoisted((): Array<string> => []);

vi.mock('pg', async (importOriginal) => {
  // Keep pg's own connection-string parsing; record the queries instead of sending them.
  class Client extends (await importOriginal<typeof import('pg')>()).Client {}
  Object.assign(Client.prototype, {
    async connect() {},
    async end() {},
    async query(sql: string) {
      pgQueries.push(sql);
      return { rows: [] };
    },
  });
  return { Client };
});

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  confirm: (...args: Parameters<typeof mockConfirm>) => mockConfirm(...args),
  isCancel: () => false,
  intro: (...args: Parameters<typeof mockIntro>) => mockIntro(...args),
  outro: (...args: Parameters<typeof mockOutro>) => mockOutro(...args),
  log: {
    error: (...args: Parameters<typeof mockLog.error>) => mockLog.error(...args),
    info: (...args: Parameters<typeof mockLog.info>) => mockLog.info(...args),
    step: (...args: Parameters<typeof mockLog.step>) => mockLog.step(...args),
    success: (...args: Parameters<typeof mockLog.success>) => mockLog.success(...args),
  },
}));

const roots: Array<string> = [];

const messagesSchema = `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  text: text("text").notNull(),
});
`;

function createProjectRoot(options: {
  seedFile: { name: string; content: string };
  extraSeedFile?: { name: string; content: string };
  schema?: string;
  migration?: string;
  config?: Record<string, unknown>;
}): string {
  const root = mkdtempSync(packageFixturePath(import.meta.dirname, '.tmp-db-seed-'));
  const migrationsDir = join(root, 'db', 'migrations');
  mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
  writeFileSync(
    join(migrationsDir, '0000_messages.sql'),
    options.migration ??
      `CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL
);
`,
  );
  if (options.config) {
    writeFileSync(join(root, 'void.json'), JSON.stringify(options.config));
  }
  // Keep the journal coherent with the migration file above.
  writeFileSync(
    join(migrationsDir, 'meta', '_journal.json'),
    JSON.stringify(
      {
        version: '7',
        dialect: 'sqlite',
        entries: [
          {
            idx: 0,
            version: '7',
            when: 1_730_000_000_000,
            tag: '0000_messages',
            breakpoints: true,
          },
        ],
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(join(root, 'db', options.seedFile.name), options.seedFile.content);
  if (options.extraSeedFile) {
    writeFileSync(join(root, 'db', options.extraSeedFile.name), options.extraSeedFile.content);
  }
  if (options.schema) {
    writeFileSync(join(root, 'db', 'schema.ts'), options.schema);
  }
  roots.push(root);
  return root;
}

async function readMessages(root: string): Promise<Array<{ id: number; text: string }>> {
  const dbPath = getMiniflareDatabasePath(join(root, '.void'), 'local');
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT id, text FROM messages ORDER BY id').all() as Array<{
      id: number;
      text: string;
    }>;
  } finally {
    db.close();
  }
}

// Exercise Node’s module loaders without Vitest resolving the fixture imports.
function runSeedInNode(root: string, file?: string, preamble = '') {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `${preamble}const { runDbCommand } = await import(process.argv[1]); await runDbCommand(process.argv[2], { action: "seed", file: process.argv[3] });`,
      new URL('../../src/cli/db.ts', import.meta.url).href,
      root,
      ...(file ? [file] : []),
    ],
    { encoding: 'utf8', timeout: 20_000 },
  );
  expect(result.status, result.stderr).toBe(0);
}

describe('void db seed', () => {
  let runDbCommand: typeof import('../../src/cli/db.ts').runDbCommand;

  beforeEach(async () => {
    vi.spyOn(output, 'printSuccess').mockImplementation(() => {});
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    runDbCommand = (await import('../../src/cli/db.ts')).runDbCommand;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0, roots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('completes a seed that reads piped stdin and waits for beforeExit', async () => {
    const root = createProjectRoot({
      seedFile: {
        name: 'seed.mjs',
        content: `import { once } from 'node:events';
export default async function ({ db }) {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  db.$client.prepare('INSERT INTO messages (text) VALUES (?)').run(text.trim());
  await once(process, 'beforeExit');
  setImmediate(() => {});
  await once(process, 'beforeExit');
}
`,
      },
    });
    const cli = fileURLToPath(new URL('../../dist/cli/cli.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, 'db', 'seed', '--yes'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      input: 'seed message\n',
      timeout: 20_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Seeded from db[/\\]seed\.mjs\./);
    expect(await readMessages(root)).toEqual([{ id: 1, text: 'seed message' }]);
  }, 30_000);

  it('seeds from db/seed.sql by default', async () => {
    const root = createProjectRoot({
      seedFile: {
        name: 'seed.sql',
        content: "INSERT INTO messages (text) VALUES ('hello from sql');\n",
      },
    });

    await runDbCommand(root, { action: 'seed' });

    expect(await readMessages(root)).toEqual([{ id: 1, text: 'hello from sql' }]);
    expect(output.printSuccess).toHaveBeenCalledWith('Seeded from db/seed.sql.');
  });

  it('seeds from db/seed.ts by default and passes the schema context', async () => {
    const root = createProjectRoot({
      schema: `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  text: text("text").notNull(),
});
`,
      seedFile: {
        name: 'seed.ts',
        content: `export default async function seed({ db, schema }) {
  await db.insert(schema.messages).values([
    { text: "alpha" },
    { text: "beta" },
  ]);
}
`,
      },
    });

    await runDbCommand(root, { action: 'seed' });

    expect(await readMessages(root)).toEqual([
      { id: 1, text: 'alpha' },
      { id: 2, text: 'beta' },
    ]);
    expect(output.printSuccess).toHaveBeenCalledWith('Seeded from db/seed.ts.');
  });

  it('seeds the columns that database.casing names', async () => {
    const root = createProjectRoot({
      config: { database: { casing: 'snake_case' } },
      migration: `CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  sent_at INTEGER NOT NULL
);
`,
      schema: `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const messages = sqliteTable("messages", {
  id: integer().primaryKey({ autoIncrement: true }),
  text: text().notNull(),
  sentAt: integer().notNull(),
});
`,
      seedFile: {
        name: 'seed.ts',
        content: `export default async function seed({ db, schema }) {
  await db.insert(schema.messages).values({ text: "alpha", sentAt: 1815 });
}
`,
      },
    });

    await runDbCommand(root, { action: 'seed' });

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(getMiniflareDatabasePath(join(root, '.void'), 'local'), {
      readonly: true,
    });
    try {
      expect(db.prepare('SELECT text, sent_at FROM messages').all()).toEqual([
        { text: 'alpha', sent_at: 1815 },
      ]);
    } finally {
      db.close();
    }
  });

  it('seeds when db/schema.ts re-exports an extensionless module', async () => {
    const root = createProjectRoot({
      schema: 'export * from "./schema/messages";\n',
      seedFile: {
        name: 'seed.ts',
        content: `export default async function seed({ db, schema }) {
  await db.insert(schema.messages).values({ text: "from barrel" });
}
`,
      },
    });
    mkdirSync(join(root, 'db', 'schema'));
    writeFileSync(
      join(root, 'db', 'schema', 'messages.ts'),
      `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  text: text("text").notNull(),
});
`,
    );
    runSeedInNode(root);
    expect(await readMessages(root)).toEqual([{ id: 1, text: 'from barrel' }]);
  }, 30_000);

  it.each([
    { layout: 'file', importSchema: true },
    { layout: 'directory', importSchema: true },
    { layout: 'file', importSchema: false },
    { layout: 'directory', importSchema: false },
  ])(
    'resolves tsconfig paths in a schema $layout with seed imports: $importSchema',
    async ({ layout, importSchema }) => {
      const root = createProjectRoot({
        migration: `CREATE TABLE users (id TEXT PRIMARY KEY);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL REFERENCES users(id)
);
`,
        seedFile: {
          name: 'seed.ts',
          content: `import { defineSeed } from 'void/seed';
${importSchema ? "import { messages } from '@schema';\nimport { value } from '@seed-data/message';" : ''}

export default defineSeed(async ({ db, schema }) => {
  ${importSchema ? '' : "const { value } = await import('@seed-data/message');"}
  await db.insert(schema.userTable).values({ id: value });
  await db.insert(${importSchema ? 'messages' : 'schema.messages'}).values({ text: value });
});
`,
        },
      });
      mkdirSync(join(root, '.void'));
      mkdirSync(join(root, 'config'));
      mkdirSync(join(root, 'fixtures'));
      writeFileSync(
        join(root, '.void', 'better-auth-schema.ts'),
        `import { sqliteTable, text } from 'void/schema-d1';
export const userTable = sqliteTable('users', { id: text().primaryKey() });
`,
      );
      writeFileSync(join(root, 'fixtures', 'message.ts'), "export const value = 'from alias';\n");
      writeFileSync(
        join(root, 'fixtures', 'message.d.ts'),
        'export declare const value: string;\n',
      );
      const compilerOptions = {
        ...(layout === 'directory' ? { baseUrl: '..' } : {}),
        paths: {
          '@auth-schema': ['./.void/better-auth-schema.ts'],
          '@schema': ['./db/schema'],
          '@seed-data/*': ['./fixtures/*.d.ts', './missing/*', './fixtures/*'],
        },
      };
      writeFileSync(
        join(root, 'config', 'tsconfig.base.json'),
        JSON.stringify({ compilerOptions }),
      );
      writeFileSync(
        join(root, 'tsconfig.json'),
        `{
  // Support both root paths and paths inherited from another directory.
  ${layout === 'directory' ? '"extends": "./config/tsconfig.base.json"' : `"compilerOptions": ${JSON.stringify(compilerOptions)}`},
}
`,
      );
      const schemaDir = layout === 'directory' ? join(root, 'db', 'schema') : join(root, 'db');
      mkdirSync(schemaDir, { recursive: true });
      writeFileSync(
        join(schemaDir, layout === 'directory' ? 'index.ts' : 'schema.ts'),
        `import { integer, sqliteTable, text } from 'void/schema-d1';
import { userTable } from '@auth-schema';
export { userTable };

export const messages = sqliteTable('messages', {
  id: integer().primaryKey({ autoIncrement: true }),
  text: text().notNull().references(() => userTable.id),
});
`,
      );
      // Loading CLI modules must not evaluate the app's Vite config.
      writeFileSync(join(root, 'vite.config.ts'), "throw new Error('Vite config was loaded');\n");

      runSeedInNode(root);
      expect(await readMessages(root)).toEqual([{ id: 1, text: 'from alias' }]);
    },
    30_000,
  );

  it.each(['ts', 'mjs', 'js'])(
    'keeps runtime helpers in %s seeds when extending generated declaration aliases',
    async (extension) => {
      const root = createProjectRoot({
        schema: `import { integer, sqliteTable, text } from 'void/schema-d1';
export const messages = sqliteTable('messages', {
  id: integer().primaryKey({ autoIncrement: true }),
  text: text().notNull(),
});
`,
        seedFile: {
          name: `seed.${extension}`,
          content: `import { defineSeed } from 'void/seed';
import { routeUrl } from 'void/routes';
import { messages } from '@schema';
export default defineSeed(async ({ db }) => {
  await db.insert(messages).values({ text: routeUrl('/messages/[id]', { params: { id: 'hello world' } }) });
});
`,
        },
      });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
      mkdirSync(join(root, 'node_modules'));
      symlinkSync(
        join(import.meta.dirname, '../..'),
        join(root, 'node_modules', 'void'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      mkdirSync(join(root, '.void'));
      const config = createProjectTsconfig(root, true, true, true);
      config.compilerOptions!.paths!['void/seed'] = ['./seed.d.mts'];
      config.compilerOptions!.paths!['void/schema-d1'] = ['./schema.d.cts'];
      writeFileSync(join(root, '.void', 'tsconfig.json'), JSON.stringify(config));
      writeFileSync(
        join(root, '.void', 'routes.d.ts'),
        'export declare function routeUrl(): string;\n',
      );
      writeFileSync(join(root, '.void', 'db.d.ts'), 'export {};\n');
      writeFileSync(
        join(root, '.void', 'seed.d.mts'),
        'export declare function defineSeed(): void;\n',
      );
      writeFileSync(join(root, '.void', 'schema.d.cts'), 'export {};\n');
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify({ extends: './.void/tsconfig.json' }),
      );
      runSeedInNode(root);
      expect(await readMessages(root)).toEqual([{ id: 1, text: '/messages/hello%20world' }]);
    },
    30_000,
  );

  it.each(
    ['ts', 'mjs', 'js'].flatMap((extension) =>
      ['static', 'dynamic'].map((importMode) => ({ extension, importMode })),
    ),
  )(
    'resolves $importMode aliases in $extension seeds before matching packages',
    async ({ extension, importMode }) => {
      const root = createProjectRoot({
        seedFile: {
          name: `seed.${extension}`,
          content: `import { sql } from 'drizzle-orm';
${importMode === 'static' ? "import { value } from 'seed-fixture';" : ''}
export default async function seed({ db }) {
  ${importMode === 'dynamic' ? "const { value } = await import('seed-fixture');" : ''}
  await db.run(sql\`INSERT INTO messages (text) VALUES (\${value})\`);
}
`,
        },
      });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: {
              'seed-fixture': ['./missing', './fixtures/message.mjs'],
              'seed-*': ['./fixtures/*.d.ts', './fixtures/*.js'],
              'better-sqlite3': ['./fixtures/not-a-driver.js'],
            },
          },
        }),
      );
      mkdirSync(join(root, 'fixtures'));
      writeFileSync(
        join(root, 'fixtures', 'message.mjs'),
        `import { basename } from 'node:path';
import { value as prefix } from 'seed-value';
export const value = prefix + (await import('seed-value')).value;
if (basename(import.meta.url) !== 'message.mjs') throw new Error('Wrong module URL');
`,
      );
      writeFileSync(join(root, 'fixtures', 'value.js'), "export const value = 'local';\n");
      writeFileSync(join(root, 'fixtures', 'value.d.ts'), 'export declare const value: string;\n');
      writeFileSync(
        join(root, 'fixtures', 'not-a-driver.js'),
        "throw new Error('CLI database imports used seed aliases');\n",
      );
      for (const name of ['seed-fixture', 'seed-value']) {
        const directory = join(root, 'node_modules', name);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, 'package.json'),
          JSON.stringify({ name, type: 'module', exports: './index.js' }),
        );
        writeFileSync(join(directory, 'index.js'), "export const value = 'package';\n");
      }
      writeFileSync(
        join(root, 'db', 'broken.mjs'),
        "import 'seed-fixture';\nexport const value = 1;\n",
      );
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { createRequire } from 'node:module';
const { runDbCommand } = await import(process.argv[1]);
await runDbCommand(process.argv[2], { action: 'seed' });
const require = createRequire(process.argv[2] + '/package.json');
if (!require.resolve('seed-fixture').includes('node_modules')) throw new Error('Seed alias hook leaked');
let error;
try { await runDbCommand(process.argv[2], { action: 'seed', file: 'db/broken.mjs' }); }
catch (cause) { error = cause; }
if (!error?.message.includes('must export')) throw new Error('Invalid seed was accepted');
if (!require.resolve('seed-fixture').includes('node_modules')) throw new Error('Failed seed leaked its alias hook');`,
          new URL('../../src/cli/db.ts', import.meta.url).href,
          root,
        ],
        { encoding: 'utf8', timeout: 20_000 },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(await readMessages(root)).toEqual([{ id: 1, text: 'locallocal' }]);
    },
    30_000,
  );

  it('dynamically imports a generated schema barrel from an mjs seed', async () => {
    const root = createProjectRoot({
      schema: 'export * from "./schema/messages";',
      seedFile: {
        name: 'seed.mjs',
        content: `export default async function ({ db }) {
  const { messages } = await import('@schema');
  await db.insert(messages).values({ text: 'from barrel' });
}`,
      },
    });
    mkdirSync(join(root, 'db/schema'));
    writeFileSync(
      join(root, 'db/schema/messages.ts'),
      `import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const messages = sqliteTable('messages', { text: text().notNull() });`,
    );
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@schema': ['./db/schema.ts'] } } }),
    );
    runSeedInNode(root);
    expect(await readMessages(root)).toEqual([{ id: 1, text: 'from barrel' }]);
  }, 30_000);

  it.each([
    'installed package',
    'linked workspace package',
    'linked TypeScript package',
    'local CommonJS helper',
  ])(
    'resolves a dynamic #internal import from %s',
    async (importer) => {
      const installed = importer !== 'local CommonJS helper';
      const root = createProjectRoot({
        seedFile: {
          name: installed ? 'seed.mjs' : 'seed.ts',
          content: `import { sql } from 'drizzle-orm';
${installed ? "import { readValue } from 'seed-package';" : "const { readValue } = require('./helper.cjs');"}
export default async function ({ db }) {
  const value = await readValue();
  await db.run(sql\`INSERT INTO messages (text) VALUES (\${value})\`);
}`,
        },
      });
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { paths: { '#internal': ['./app.mjs'] } } }),
      );
      writeFileSync(join(root, 'app.mjs'), "export default 'app';");
      const helper = "async () => (await import('#internal')).default";
      if (installed) {
        const linked = importer.startsWith('linked');
        const entry = importer === 'linked TypeScript package' ? 'index.ts' : 'index.js';
        const directory = join(
          root,
          linked ? 'packages/seed-package' : 'node_modules/seed-package',
        );
        mkdirSync(directory, { recursive: true });
        if (linked) {
          mkdirSync(join(root, 'node_modules'));
          symlinkSync(directory, join(root, 'node_modules/seed-package'), 'junction');
        }
        writeFileSync(
          join(directory, 'package.json'),
          JSON.stringify({
            type: 'module',
            exports: './' + entry,
            imports: { '#internal': './internal.js' },
          }),
        );
        if (entry === 'index.ts') {
          writeFileSync(join(directory, entry), "export { readValue } from './helper';");
          writeFileSync(join(directory, 'helper.ts'), 'export const readValue = ' + helper);
        } else {
          writeFileSync(join(directory, entry), 'export const readValue = ' + helper);
        }
        writeFileSync(join(directory, 'internal.js'), "export default 'package';");
      } else {
        writeFileSync(join(root, 'db/helper.cjs'), 'exports.readValue = ' + helper);
      }
      runSeedInNode(root);
      expect(await readMessages(root)).toEqual([{ id: 1, text: installed ? 'package' : 'app' }]);
    },
    30_000,
  );

  it.each([
    { name: 'seed.mjs', external: false },
    { name: 'seed.js', external: false },
    { name: 'seed.mjs', external: true },
  ])(
    'loads a TypeScript enum via a dynamic alias from $name (external: $external)',
    async ({ name, external }) => {
      const root = createProjectRoot({
        seedFile: { name: 'seed.sql', content: '' },
        schema:
          "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'; export const messages = sqliteTable('messages', {text: text().notNull()});",
      });
      writeFileSync(join(root, 'package.json'), '{"type":"module"}');
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { paths: { '@fixture': ['./fixture.ts'] } },
        }),
      );
      writeFileSync(join(root, 'fixture.ts'), "export enum Label { Local = 'local' }");
      const seedDir = external
        ? mkdtempSync(join(root, '../.tmp-external-seed-'))
        : join(root, 'db');
      if (external) {
        roots.push(seedDir);
      }
      const seedPath = join(seedDir, name);
      writeFileSync(
        seedPath,
        `export default async ({ db, schema }) => {
  const { Label } = await import('@fixture');
  await db.insert(schema.messages).values({text: Label.Local});
};`,
      );
      runSeedInNode(root, seedPath);
      expect(await readMessages(root)).toEqual([{ id: 1, text: 'local' }]);
    },
  );

  it('suggests void prepare for a missing generated tsconfig before resetting data', async () => {
    const root = createProjectRoot({
      seedFile: { name: 'seed.sql', content: "INSERT INTO messages (text) VALUES ('keep me');" },
    });
    await runDbCommand(root, { action: 'seed' });
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ extends: './.void/tsconfig.json' }),
    );
    writeFileSync(join(root, 'db', 'seed.ts'), 'export default async function seed() {}\n');

    await expect(runDbCommand(root, { action: 'seed', file: 'db/seed.ts' })).rejects.toThrow(
      /void prepare/,
    );
    expect(await readMessages(root)).toEqual([{ id: 1, text: 'keep me' }]);
  });

  it('preserves errors for unrelated missing tsconfig bases', async () => {
    const root = createProjectRoot({
      seedFile: { name: 'seed.ts', content: 'export default async function seed() {}\n' },
    });
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ extends: './missing.json' }));

    await expect(runDbCommand(root, { action: 'seed' })).rejects.toThrow(
      "File './missing.json' not found.",
    );
  });

  it('loads CommonJS JavaScript seeds', async () => {
    const root = createProjectRoot({
      seedFile: {
        name: 'seed.js',
        content: `module.exports = async function seed({ db }) {
  const { sql } = require('drizzle-orm');
  await db.run(sql\`INSERT INTO messages (text) VALUES ('from CommonJS')\`);
};
`,
      },
    });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'commonjs' }));
    await runDbCommand(root, { action: 'seed' });
    expect(await readMessages(root)).toEqual([{ id: 1, text: 'from CommonJS' }]);
  });

  it('keeps ESM syntax in a JavaScript seed and its helpers in a CommonJS app', async () => {
    const root = createProjectRoot({
      seedFile: {
        name: 'seed.js',
        content: `import {value} from './helper.js';
import { sql } from 'drizzle-orm';
export default async ({db})=>{ await db.run(sql\`INSERT INTO messages (text) VALUES (\${value})\`); };`,
      },
    });
    writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}');
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@data': ['./data.json'] } } }),
    );
    writeFileSync(join(root, 'data.json'), '{"text":"from json"}');
    writeFileSync(
      join(root, 'db/helper.js'),
      "export const value = (await import('@data')).default.text;",
    );
    runSeedInNode(root);
    expect(await readMessages(root)).toEqual([{ id: 1, text: 'from json' }]);
  });

  it('loads seeds when the runtime has no module hooks', async () => {
    const root = createProjectRoot({
      seedFile: {
        name: 'seed.ts',
        content: `export default async ({ db, schema }) => {
  await db.insert(schema.messages).values({ text: 'without hooks' });
};`,
      },
      schema: messagesSchema,
    });
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@schema': ['./db/schema.ts'] } } }),
    );
    // Bun's node:module has no registerHooks.
    runSeedInNode(
      root,
      undefined,
      "(await import('node:module')).default.registerHooks = undefined; ",
    );
    expect(await readMessages(root)).toEqual([{ id: 1, text: 'without hooks' }]);
  });

  it('keeps package resolution for extensionless subpaths, .tsx helpers, and .json neighbours', async () => {
    const root = createProjectRoot({
      seedFile: {
        name: 'seed.ts',
        content: `import legacy from 'legacy/plugin/value';
import named from 'named';
import { text } from './text';
export default async ({ db, schema }) => {
  await db.insert(schema.messages).values({ text: [legacy, named, text].join(',') });
};`,
      },
      schema: messagesSchema,
    });
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@schema': ['./db/schema.ts'] } },
      }),
    );
    mkdirSync(join(root, 'node_modules/legacy/plugin'), { recursive: true });
    writeFileSync(join(root, 'node_modules/legacy/package.json'), '{"name":"legacy"}');
    writeFileSync(join(root, 'node_modules/legacy/plugin/value.js'), "module.exports = 'legacy';");
    mkdirSync(join(root, 'node_modules/named'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules/named/package.json'),
      '{"name":"named","type":"module","exports":"./index.js"}',
    );
    writeFileSync(join(root, 'node_modules/named/index.js'), "export default 'package';");
    // TypeScript never maps the baseUrl candidate `named` to this file.
    writeFileSync(join(root, 'named.json'), '"json"');
    writeFileSync(join(root, 'db/text.tsx'), "export const text: string = 'tsx';");
    runSeedInNode(root);
    expect(await readMessages(root)).toEqual([{ id: 1, text: 'legacy,package,tsx' }]);
  });

  it('keeps JSON and extensionless imports in TypeScript seeds', async () => {
    const root = createProjectRoot({
      seedFile: {
        name: 'seed.ts',
        content: `import fixture, { text } from './fixture.json';
import { value as pkg } from 'extensionless-esm';
import { label } from './helper';
import data from './data.cjs';
import { join } from 'node:path';
export default async ({ db, schema }) => {
  const helper = await import(join(import.meta.dirname, 'helper'));
  await db.insert(schema.messages).values({ text: [text, label, data.label, helper.label, pkg, data.fixture === fixture].join(',') });
};`,
      },
      schema: messagesSchema,
    });
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@schema': ['./db/schema.ts'] } } }),
    );
    // Editors on Windows may save JSON with a byte order mark.
    writeFileSync(join(root, 'db/fixture.json'), '\uFEFF{"text":"json"}');
    writeFileSync(join(root, 'db/helper.ts'), "export const label = 'helper';");
    // CommonJS that requires a module the seed has already imported.
    writeFileSync(
      join(root, 'db/data.cjs'),
      "module.exports = { label: require('./helper.ts').label, fixture: require('./fixture.json') };",
    );
    // A package whose ESM omits the extension of its own files, which jiti accepted.
    mkdirSync(join(root, 'node_modules/extensionless-esm'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules/extensionless-esm/package.json'),
      '{"name":"extensionless-esm","type":"module","exports":"./index.js"}',
    );
    writeFileSync(
      join(root, 'node_modules/extensionless-esm/index.js'),
      "export { value } from './value';",
    );
    writeFileSync(
      join(root, 'node_modules/extensionless-esm/value.js'),
      "export const value = 'package';",
    );
    runSeedInNode(root);
    expect(await readMessages(root)).toEqual([
      { id: 1, text: 'json,helper,helper,helper,package,true' },
    ]);
  });

  it('keeps require and __dirname in ESM-syntax JavaScript seeds of a CommonJS app', async () => {
    const root = createProjectRoot({
      seedFile: {
        name: 'seed.js',
        content: `import { basename } from 'node:path';
export default async ({ db, schema }) => {
  const { text } = require('./fixture.json');
  await db.insert(schema.messages).values({ text: [text, basename(__dirname)].join(',') });
};`,
      },
      schema: messagesSchema,
    });
    writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}');
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@schema': ['./db/schema.ts'] } } }),
    );
    writeFileSync(join(root, 'db/fixture.json'), '{"text":"json"}');
    runSeedInNode(root);
    expect(await readMessages(root)).toEqual([{ id: 1, text: 'json,db' }]);
  });

  it('checks the seed file before it resets the database', async () => {
    const root = createProjectRoot({
      seedFile: {
        name: 'seed.sql',
        content: "INSERT INTO messages (text) VALUES ('kept');\n",
      },
    });
    writeFileSync(join(root, 'db', 'no-export.ts'), 'export const value = 1;\n');
    await runDbCommand(root, { action: 'seed' });

    await expect(runDbCommand(root, { action: 'seed', file: 'db/missing.sql' })).rejects.toThrow(
      'process.exit:1',
    );
    await expect(runDbCommand(root, { action: 'seed', file: 'db/no-export.ts' })).rejects.toThrow(
      'must export a default function',
    );

    expect(await readMessages(root)).toEqual([{ id: 1, text: 'kept' }]);
  });

  it('asks about a non-local database before it imports the seed module', async () => {
    const root = createProjectRoot({ seedFile: { name: 'seed.ts', content: '' } });
    const marker = join(root, 'seed-module-ran');
    writeFileSync(
      join(root, 'db', 'seed.ts'),
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "");
export default async function seed() {}
`,
    );
    writeFileSync(join(root, 'void.json'), JSON.stringify({ database: 'pg' }));
    writeFileSync(
      join(root, '.env'),
      'DATABASE_URL="postgresql://user:secret@db.example.com:5432/prod"\n',
    );
    pgQueries.length = 0;
    const stdinTty = process.stdin.isTTY;
    try {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
      await expect(runDbCommand(root, { action: 'seed' })).rejects.toThrow('process.exit:1');
      expect(existsSync(marker)).toBe(false);

      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
      mockConfirm.mockResolvedValue(false);
      await expect(runDbCommand(root, { action: 'seed' })).rejects.toThrow('process.exit:0');
      expect(mockConfirm).toHaveBeenCalledOnce();
      expect(existsSync(marker)).toBe(false);
      // Nothing reached the database.
      expect(pgQueries).toEqual([]);

      // One answer covers the reset too.
      mockConfirm.mockResolvedValue(true);
      await runDbCommand(root, { action: 'seed' });
      expect(mockConfirm).toHaveBeenCalledTimes(2);
      expect(existsSync(marker)).toBe(true);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinTty });
    }
  });

  it('fails when multiple default seed files exist', async () => {
    const root = createProjectRoot({
      seedFile: {
        name: 'seed.sql',
        content: "INSERT INTO messages (text) VALUES ('hello from sql');\n",
      },
      extraSeedFile: {
        name: 'seed.ts',
        content: 'export default async function seed() {}\n',
      },
    });

    await expect(runDbCommand(root, { action: 'seed' })).rejects.toThrow('process.exit:1');
    expect(mockLog.error).toHaveBeenCalledWith(
      'db: Multiple default seed files found: db/seed.ts, db/seed.sql. Use --file <path> to choose one.',
    );
  });
});
