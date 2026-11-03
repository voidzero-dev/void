import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import * as output from '../../src/cli/output.ts';
import { getMiniflareDatabasePath } from '../../src/migrations/runner.ts';

const mockIntro = vi.fn();
const mockOutro = vi.fn();
const mockConfirm = vi.fn();
const mockLog = {
  error: vi.fn(),
  info: vi.fn(),
  step: vi.fn(),
  success: vi.fn(),
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
  confirm: (...args: Array<unknown>) => mockConfirm(...args),
  isCancel: () => false,
  intro: (...args: Array<unknown>) => mockIntro(...args),
  outro: (...args: Array<unknown>) => mockOutro(...args),
  log: {
    error: (...args: Array<unknown>) => mockLog.error(...args),
    info: (...args: Array<unknown>) => mockLog.info(...args),
    step: (...args: Array<unknown>) => mockLog.step(...args),
    success: (...args: Array<unknown>) => mockLog.success(...args),
  },
}));

const roots: Array<string> = [];

function createProjectRoot(options: {
  seedFile: { name: string; content: string };
  extraSeedFile?: { name: string; content: string };
  schema?: string;
  migration?: string;
  config?: Record<string, unknown>;
}): string {
  const root = mkdtempSync(join(import.meta.dirname, '.tmp-db-seed-'));
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
          { idx: 0, version: '7', when: 1730000000000, tag: '0000_messages', breakpoints: true },
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
    const dbModule = pathToFileURL(join(import.meta.dirname, '../../src/cli/db.ts')).href;

    // Plain Node, because Vitest's module runner resolves extensionless imports.
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { runDbCommand } = await import(${JSON.stringify(dbModule)});
await runDbCommand(${JSON.stringify(root)}, { action: 'seed' });`,
      ],
      { encoding: 'utf8', timeout: 20_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(await readMessages(root)).toEqual([{ id: 1, text: 'from barrel' }]);
  }, 30_000);

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
