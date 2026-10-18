import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { log, outro } from '@voidzero-dev/vite-plus-prompts';
import { toSlash } from 'pathslash';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vite-plus/test';
import type { GenArgs } from '../../src/cli/gen-args.ts';
import { runGenCommand, formatTimestamp } from '../../src/cli/gen.ts';
import { collectMigrations } from '../../src/migrations/collect.ts';
import { assertJournalCoherence } from '../../src/migrations/validate.ts';

const mockSelect = vi.fn();

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: { success: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), step: vi.fn() },
  select: (...args: Array<unknown>) => mockSelect(...args),
  isCancel: (v: unknown) => v === Symbol.for('cancel'),
  cancel: vi.fn(),
}));

// `vi.mock` is hoisted above imports, so its factory can only reach `vi.hoisted` state.
const spawnMockState = vi.hoisted(() => ({
  // When set, replaces the default simulated `drizzle-kit generate --custom`.
  handler: null as
    | ((
        command: string,
        args: Array<string>,
        options: { cwd?: string },
      ) => {
        status: number;
        stdout: string;
        stderr: string;
        error?: Error;
      })
    | null,
  calls: [] as Array<{
    command: string;
    args: Array<string>;
    options: { cwd?: string; env?: NodeJS.ProcessEnv };
  }>,
}));

vi.mock('node:child_process', async () => {
  const nodeFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  const nodePath = await vi.importActual<typeof import('node:path')>('node:path');
  return {
    spawnSync: (
      command: string,
      args: Array<string>,
      options: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => {
      spawnMockState.calls.push({ command, args, options });
      if (spawnMockState.handler !== null) {
        return spawnMockState.handler(command, args, options);
      }
      if (args[1] === 'generate' && args.includes('--custom') && typeof options?.cwd === 'string') {
        const nameIdx = args.indexOf('--name');
        const name = nameIdx !== -1 ? args[nameIdx + 1] : 'custom';
        simulateDrizzleCustom(options.cwd, name, nodeFs, nodePath);
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
});

/**
 * Writes what `drizzle-kit generate --custom --name <name>` writes: an empty
 * `.sql` file, a new journal entry and a snapshot chained to the previous one.
 */
function simulateDrizzleCustom(
  cwd: string,
  name: string,
  nodeFs: typeof import('node:fs'),
  nodePath: typeof import('node:path'),
): void {
  const migrationsDir = nodePath.join(cwd, 'db', 'migrations');
  const metaDir = nodePath.join(migrationsDir, 'meta');
  if (!nodeFs.existsSync(metaDir)) {
    return;
  }

  const now = new Date();
  let ts = formatTimestamp(now);
  while (nodeFs.readdirSync(migrationsDir).some((f) => f.startsWith(ts + '_'))) {
    now.setSeconds(now.getSeconds() + 1);
    ts = formatTimestamp(now);
  }
  const tag = `${ts}_${name}`;

  nodeFs.writeFileSync(nodePath.join(migrationsDir, `${tag}.sql`), '');

  const journalPath = nodePath.join(metaDir, '_journal.json');
  const journal = JSON.parse(nodeFs.readFileSync(journalPath, 'utf-8')) as {
    version: string;
    dialect: string;
    entries: Array<{
      idx: number;
      version: string;
      when: number;
      tag: string;
      breakpoints: boolean;
    }>;
  };
  const lastEntry = journal.entries[journal.entries.length - 1];
  const nextIdx =
    journal.entries.length > 0 ? Math.max(...journal.entries.map((e) => e.idx)) + 1 : 0;
  journal.entries.push({
    idx: nextIdx,
    version: lastEntry?.version ?? journal.version,
    when: Date.now(),
    tag,
    breakpoints: lastEntry?.breakpoints ?? true,
  });
  nodeFs.writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n');

  if (lastEntry) {
    const prevPrefix = lastEntry.tag.split('_')[0];
    const prevSnapshotPath = nodePath.join(metaDir, `${prevPrefix}_snapshot.json`);
    if (nodeFs.existsSync(prevSnapshotPath)) {
      const prevSnapshot = JSON.parse(nodeFs.readFileSync(prevSnapshotPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      const nextSnapshot = {
        ...prevSnapshot,
        id: `sim-${ts}`,
        prevId: prevSnapshot.id,
        tables: { fresh: { name: 'fresh' } },
      };
      const newSnapshotPath = nodePath.join(metaDir, `${ts}_snapshot.json`);
      nodeFs.writeFileSync(newSnapshotPath, JSON.stringify(nextSnapshot, null, 2));
    }
  }
}

const TMP = join(import.meta.dirname, '.tmp-gen-test');

function read(path: string): string {
  return readFileSync(join(TMP, path), 'utf-8');
}

function writePkg(deps: Record<string, string>): void {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, 'package.json'), JSON.stringify({ dependencies: deps }));
}

/** `writeDrizzleConfig()` throws when there is no `db/schema.ts`. */
function seedSchema(): void {
  const schemaPath = join(TMP, 'db', 'schema.ts');
  mkdirSync(dirname(schemaPath), { recursive: true });
  writeFileSync(
    schemaPath,
    'import { sqliteTable, text } from "drizzle-orm/sqlite-core";\nexport const t = sqliteTable("t", { a: text("a") });\n',
  );
}

/** Runs `void gen`, expects it to call `process.exit`, and returns the logged errors. */
async function expectExit(args: GenArgs): Promise<string> {
  vi.mocked(log.error).mockClear();
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
  try {
    await expect(runGenCommand(TMP, args)).rejects.toThrow('process.exit');
  } finally {
    exitSpy.mockRestore();
  }
  return vi
    .mocked(log.error)
    .mock.calls.map((call) => String(call[0]))
    .join('\n');
}

beforeEach(() => {
  spawnMockState.calls = [];
  spawnMockState.handler = null;
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mockSelect.mockReset();
});

describe('gen model', () => {
  it('generates Drizzle table definition', async () => {
    writePkg({ valibot: '^1.0.0' });
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [
        { name: 'title', type: 'string', nullable: false },
        { name: 'body', type: 'text', nullable: false },
        { name: 'published', type: 'boolean', nullable: false },
      ],
    });

    const schema = read('db/schema/posts.ts');
    expect(schema).toContain('from "void/schema-d1"');
    expect(schema).toContain('import { sqliteTable');
    expect(schema).toContain('export const posts = sqliteTable("posts"');
    expect(schema).toContain('id: integer("id").primaryKey({ autoIncrement: true })');
    expect(schema).toContain('title: text("title").notNull()');
    expect(schema).toContain('body: text("body").notNull()');
    expect(schema).toContain('integer("published", { mode: "boolean" }).notNull()');
    expect(schema).toContain('createdAt:');
    expect(schema).toContain('updatedAt:');
  });

  it('maps all column types correctly in schema', async () => {
    writePkg({ valibot: '^1.0.0' });
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 't',
      columns: [
        { name: 'a', type: 'string', nullable: false },
        { name: 'b', type: 'text', nullable: false },
        { name: 'c', type: 'integer', nullable: false },
        { name: 'd', type: 'boolean', nullable: false },
        { name: 'e', type: 'real', nullable: false },
      ],
    });

    const schema = read('db/schema/t.ts');
    expect(schema).toContain('a: text("a").notNull()');
    expect(schema).toContain('b: text("b").notNull()');
    expect(schema).toContain('c: integer("c").notNull()');
    expect(schema).toContain('integer("d", { mode: "boolean" }).notNull()');
    expect(schema).toContain('e: real("e").notNull()');
  });

  it.each([
    {
      dialect: 'sqlite',
      database: undefined,
      required: [
        'title: text("title").notNull(),',
        'flag: integer("flag", { mode: "boolean" }).notNull().default(false),',
      ],
      nullable: [
        'bio: text("bio"),',
        'views: integer("views"),',
        'score: real("score"),',
        'hidden: integer("hidden", { mode: "boolean" }).default(false),',
      ],
    },
    {
      dialect: 'postgresql',
      database: 'pg',
      required: [
        'title: text("title").notNull(),',
        'flag: boolean("flag").notNull().default(false),',
      ],
      nullable: [
        'bio: text("bio"),',
        'views: integer("views"),',
        'score: doublePrecision("score"),',
        'hidden: boolean("hidden").default(false),',
      ],
    },
    {
      dialect: 'mysql',
      database: 'mysql',
      required: [
        'title: text("title").notNull(),',
        'flag: boolean("flag").notNull().default(false),',
      ],
      nullable: [
        'bio: text("bio"),',
        'views: int("views"),',
        'score: double("score"),',
        'hidden: boolean("hidden").default(false),',
      ],
    },
  ])(
    'omits .notNull() only for nullable columns ($dialect)',
    async ({ database, required, nullable }) => {
      writePkg({ valibot: '^1.0.0' });
      if (database) {
        writeFileSync(join(TMP, 'void.json'), JSON.stringify({ database }));
      }
      await runGenCommand(TMP, {
        subcommand: 'model',
        name: 'posts',
        columns: [
          { name: 'title', type: 'string', nullable: false },
          { name: 'flag', type: 'boolean', nullable: false },
          { name: 'bio', type: 'text', nullable: true },
          { name: 'views', type: 'integer', nullable: true },
          { name: 'score', type: 'real', nullable: true },
          { name: 'hidden', type: 'boolean', nullable: true },
        ],
      });

      const schema = read('db/schema/posts.ts');
      for (const line of [...required, ...nullable]) {
        expect(schema).toContain(`  ${line}\n`);
      }
    },
  );

  it('creates barrel export in db/schema.ts', async () => {
    writePkg({ valibot: '^1.0.0' });
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [{ name: 'title', type: 'string', nullable: false }],
    });

    const barrel = read('db/schema.ts');
    expect(barrel).toContain('export * from "./schema/posts"');
  });

  it('appends to existing barrel export', async () => {
    writePkg({ valibot: '^1.0.0' });
    mkdirSync(join(TMP, 'db'), { recursive: true });
    writeFileSync(join(TMP, 'db/schema.ts'), 'export * from "./schema/users";\n');

    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [],
    });

    const barrel = read('db/schema.ts');
    expect(barrel).toContain('export * from "./schema/users"');
    expect(barrel).toContain('export * from "./schema/posts"');
  });

  it('generates index route with GET and POST using Drizzle', async () => {
    writePkg({ valibot: '^1.0.0' });
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [
        { name: 'title', type: 'string', nullable: false },
        { name: 'body', type: 'text', nullable: false },
      ],
    });

    const route = read('routes/api/posts/index.ts');
    expect(route).toContain('import * as v from "valibot"');
    expect(route).toContain('import { defineHandler } from "void"');
    expect(route).toContain('import { db } from "void/db"');
    expect(route).toContain('import { posts } from "@schema"');
    expect(route).toContain('export const GET = defineHandler');
    expect(route).toContain('db.select().from(posts)');
    expect(route).toContain('export const POST = defineHandler.withValidator');
    expect(route).toContain('title: v.string()');
    expect(route).toContain('body: v.string()');
    expect(route).toContain('db.insert(posts).values({ title: body.title, body: body.body })');
  });

  it('generates index route without validator when no columns', async () => {
    writePkg({ valibot: '^1.0.0' });
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'events',
      columns: [],
    });

    const route = read('routes/api/events/index.ts');
    expect(route).not.toContain('valibot');
    expect(route).not.toContain('withValidator');
    expect(route).toContain('db.select().from(events)');
    expect(route).toContain('db.insert(events).values(body)');

    // [id] route is still generated even with no columns
    const idRoute = read('routes/api/events/[id].ts');
    expect(idRoute).toContain('params: v.object({ id: v.string() })');
    expect(idRoute).toContain('db.select().from(events)');
    expect(idRoute).toContain('eq(events.id');
  });

  it('generates [id] route with Drizzle query and 404 handling', async () => {
    writePkg({ valibot: '^1.0.0' });
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [{ name: 'title', type: 'string', nullable: false }],
    });

    const route = read('routes/api/posts/[id].ts');
    expect(route).toContain('import { db, eq } from "void/db"');
    expect(route).toContain('import * as v from "valibot"');
    expect(route).toContain('import { posts } from "@schema"');
    expect(route).toContain('params: v.object({ id: v.string() })');
    expect(route).toContain('db.select().from(posts).where(eq(posts.id, Number(params.id)))');
    expect(route).toContain('new Response("Not found", { status: 404 })');
  });

  it('uses correct valibot types for each column type', async () => {
    writePkg({ valibot: '^1.0.0' });
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 't',
      columns: [
        { name: 'a', type: 'string', nullable: false },
        { name: 'b', type: 'integer', nullable: false },
        { name: 'c', type: 'boolean', nullable: false },
        { name: 'd', type: 'real', nullable: false },
        { name: 'e', type: 'blob', nullable: false },
        { name: 'f', type: 'text', nullable: true },
      ],
    });

    const route = read('routes/api/t/index.ts');
    expect(route).toContain('a: v.string()');
    expect(route).toContain('b: v.number()');
    expect(route).toContain('c: v.boolean()');
    expect(route).toContain('d: v.number()');
    expect(route).toContain('e: v.instance(Blob)');
    expect(route).toContain('f: v.optional(v.string())');
  });

  it('sets up project tsconfig with @schema paths', async () => {
    writePkg({ valibot: '^1.0.0' });
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [{ name: 'title', type: 'string', nullable: false }],
    });

    const tsconfig = JSON.parse(read('.void/tsconfig.json'));
    expect(tsconfig.compilerOptions.paths['@schema']).toBeDefined();
    expect(tsconfig.compilerOptions.paths['@schema/*']).toEqual(['../db/schema/*']);
  });

  it('writes .void/db.d.ts typed with the new schema', async () => {
    writePkg({ valibot: '^1.0.0' });
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [{ name: 'title', type: 'string', nullable: false }],
    });

    const dbTypes = read('.void/db.d.ts');
    expect(dbTypes).toContain('import type * as schema from "@schema";');
    expect(dbTypes).toContain('DrizzleD1Database<Schema>');
  });

  it('writes a PostgreSQL .void/db.d.ts for pg projects', async () => {
    writePkg({ valibot: '^1.0.0' });
    writeFileSync(join(TMP, 'void.json'), JSON.stringify({ database: 'pg' }));
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [{ name: 'title', type: 'string', nullable: false }],
    });

    expect(read('.void/db.d.ts')).toContain('NodePgDatabase<Schema>');
  });

  it('writes every file .void/tsconfig.json lists in a project with routes and queues', async () => {
    writePkg({ valibot: '^1.0.0' });
    mkdirSync(join(TMP, 'routes', 'api'), { recursive: true });
    writeFileSync(join(TMP, 'routes', 'api', 'hello.ts'), 'export const GET = () => "hi";\n');
    mkdirSync(join(TMP, 'queues'), { recursive: true });
    writeFileSync(join(TMP, 'queues', 'emails.ts'), 'export default async () => {};\n');

    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [{ name: 'title', type: 'string', nullable: false }],
    });

    const tsconfig = JSON.parse(read('.void/tsconfig.json')) as { files: Array<string> };
    expect(tsconfig.files).toEqual(
      expect.arrayContaining(['routes.d.ts', 'db.d.ts', 'queues.d.ts']),
    );
    for (const file of tsconfig.files) {
      expect(existsSync(join(TMP, '.void', file)), file).toBe(true);
    }
  });

  it('skips existing files without overwriting', async () => {
    writePkg({ valibot: '^1.0.0' });
    const routePath = join(TMP, 'routes/api/posts/index.ts');
    mkdirSync(join(TMP, 'routes/api/posts'), { recursive: true });
    writeFileSync(routePath, 'existing content');

    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [],
    });

    expect(readFileSync(routePath, 'utf-8')).toBe('existing content');
  });

  it('generates zod routes when zod is in package.json', async () => {
    writePkg({ zod: '^3.0.0' });
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [
        { name: 'title', type: 'string', nullable: false },
        { name: 'count', type: 'integer', nullable: false },
        { name: 'published', type: 'boolean', nullable: false },
        { name: 'data', type: 'blob', nullable: false },
        { name: 'bio', type: 'text', nullable: true },
      ],
    });

    const index = read('routes/api/posts/index.ts');
    expect(index).toContain('import { z } from "zod"');
    expect(index).toContain('title: z.string()');
    expect(index).toContain('count: z.number()');
    expect(index).toContain('published: z.boolean()');
    expect(index).toContain('data: z.instanceof(Blob)');
    expect(index).toContain('bio: z.string().optional()');
    expect(index).toContain('defineHandler.withValidator');
    expect(index).toContain('z.object(');
    expect(index).not.toContain('valibot');

    const idRoute = read('routes/api/posts/[id].ts');
    expect(idRoute).toContain('import { z } from "zod"');
    expect(idRoute).toContain('z.object({ id: z.string() })');
    expect(idRoute).not.toContain('valibot');
  });

  it('generates arktype routes when arktype is in package.json', async () => {
    writePkg({ arktype: '^2.0.0' });
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [
        { name: 'title', type: 'string', nullable: false },
        { name: 'count', type: 'integer', nullable: false },
        { name: 'published', type: 'boolean', nullable: false },
        { name: 'data', type: 'blob', nullable: false },
        { name: 'bio', type: 'text', nullable: true },
      ],
    });

    const index = read('routes/api/posts/index.ts');
    expect(index).toContain('import { type } from "arktype"');
    expect(index).toContain('title: "string"');
    expect(index).toContain('count: "number"');
    expect(index).toContain('published: "boolean"');
    expect(index).toContain('data: "instanceof Blob"');
    expect(index).toContain('bio: "string | undefined"');
    expect(index).toContain('defineHandler.withValidator');
    expect(index).not.toContain('valibot');
    expect(index).not.toContain('zod');

    const idRoute = read('routes/api/posts/[id].ts');
    expect(idRoute).toContain('import { type } from "arktype"');
    expect(idRoute).toContain('type({ id: "string" })');
  });

  it('generates routes without validation when none selected', async () => {
    mockSelect.mockResolvedValueOnce('none');
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [
        { name: 'title', type: 'string', nullable: false },
        { name: 'body', type: 'text', nullable: false },
      ],
    });

    const index = read('routes/api/posts/index.ts');
    expect(index).not.toContain('valibot');
    expect(index).not.toContain('zod');
    expect(index).not.toContain('arktype');
    expect(index).not.toContain('withValidator');
    expect(index).toContain('c.req.json()');
    expect(index).toContain('db.insert(posts).values(');

    const idRoute = read('routes/api/posts/[id].ts');
    expect(idRoute).not.toContain('valibot');
    expect(idRoute).not.toContain('withValidator');
    expect(idRoute).toContain('c.req.param("id")');
    expect(idRoute).toContain('db.select().from(posts)');
    expect(idRoute).toContain('eq(posts.id');
    expect(idRoute).toContain('Number(id)');
  });

  it('prompts when no validator found in package.json', async () => {
    writePkg({ react: '^19.0.0' });
    mockSelect.mockResolvedValueOnce('zod');
    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [{ name: 'title', type: 'string', nullable: false }],
    });

    expect(mockSelect).toHaveBeenCalledOnce();
    const index = read('routes/api/posts/index.ts');
    expect(index).toContain('import { z } from "zod"');
  });

  it('exits when user cancels validator prompt', async () => {
    mockSelect.mockResolvedValueOnce(Symbol.for('cancel'));
    await expectExit({ subcommand: 'model', name: 'posts', columns: [] });
  });
});

describe('formatTimestamp', () => {
  it('produces YYYYMMDDHHMMSS from a UTC date', () => {
    const date = new Date(Date.UTC(2026, 3, 10, 16, 15, 0)); // April 10, 2026 16:15:00 UTC
    expect(formatTimestamp(date)).toBe('20260410161500');
  });

  it('pads single-digit months and days', () => {
    const date = new Date(Date.UTC(2025, 0, 5, 3, 7, 9)); // Jan 5, 2025 03:07:09 UTC
    expect(formatTimestamp(date)).toBe('20250105030709');
  });
});

/** Writes a one-entry journal, its `.sql` file and, by default, its snapshot. */
function seedJournalBackedProject({
  dialect = 'sqlite',
  tag = '20200101000000_initial',
  snapshot = true,
}: { dialect?: string; tag?: string; snapshot?: boolean } = {}) {
  seedSchema();
  const migrationsDir = join(TMP, 'db', 'migrations');
  const metaDir = join(migrationsDir, 'meta');
  mkdirSync(metaDir, { recursive: true });
  const journal = {
    version: '7',
    dialect,
    entries: [{ idx: 0, version: '6', when: 1_700_000_000_000, tag, breakpoints: true }],
  };
  const journalPath = join(metaDir, '_journal.json');
  writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n');
  writeFileSync(join(migrationsDir, `${tag}.sql`), '-- initial\n');
  const snapshotPath = join(metaDir, `${tag.split('_')[0]}_snapshot.json`);
  if (snapshot) {
    writeFileSync(
      snapshotPath,
      JSON.stringify(
        {
          version: '6',
          dialect,
          id: '11111111-1111-1111-1111-111111111111',
          prevId: '00000000-0000-0000-0000-000000000000',
          tables: { stale: { name: 'stale' } },
        },
        null,
        2,
      ),
    );
  }
  return { migrationsDir, journalPath, journal, snapshotPath };
}

function findGenerateCall() {
  return spawnMockState.calls.find((c) => c.args[1] === 'generate');
}

function listSql(dir: string): Array<string> {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

describe('gen migration', () => {
  it('generates timestamp-prefixed migration file (bare-legacy)', async () => {
    await runGenCommand(TMP, { subcommand: 'migration', name: 'add_avatar_to_users' });

    const files = listSql(join(TMP, 'db', 'migrations'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{14}_add_avatar_to_users\.sql$/);

    const sql = readFileSync(join(TMP, 'db', 'migrations', files[0]), 'utf-8');
    expect(sql).toBe('-- add_avatar_to_users\n');
  });

  it('avoids same-second timestamp collisions (bare-legacy)', async () => {
    mkdirSync(join(TMP, 'db', 'migrations'), { recursive: true });
    const currentTs = formatTimestamp(new Date());
    writeFileSync(join(TMP, `db/migrations/${currentTs}_existing.sql`), '');

    await runGenCommand(TMP, { subcommand: 'migration', name: 'new_one' });

    const files = listSql(join(TMP, 'db', 'migrations'));
    expect(files).toHaveLength(2);
    const newFile = files.find((f) => f.includes('new_one'));
    expect(newFile).toBeDefined();
    expect(newFile).not.toContain(currentTs);
  });

  it('ignores seed.sql (bare-legacy)', async () => {
    mkdirSync(join(TMP, 'db', 'migrations'), { recursive: true });
    writeFileSync(join(TMP, 'db/migrations/seed.sql'), '');

    await runGenCommand(TMP, { subcommand: 'migration', name: 'first' });

    const files = readdirSync(join(TMP, 'db', 'migrations')).filter(
      (f) => f.endsWith('.sql') && f !== 'seed.sql',
    );
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{14}_first\.sql$/);
  });

  it('bare-legacy: leaves existing .sql files alone and skips the journal write', async () => {
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(join(migrationsDir, '0001_create_users.sql'), '-- users\n');
    writeFileSync(join(migrationsDir, '0002_add_email.sql'), '-- email\n');

    await runGenCommand(TMP, { subcommand: 'migration', name: 'add_avatar' });

    const files = listSql(migrationsDir);
    expect(files).toHaveLength(3);
    expect(files[0]).toBe('0001_create_users.sql');
    expect(files[1]).toBe('0002_add_email.sql');
    expect(files[2]).toMatch(/^\d{14}_add_avatar\.sql$/);

    // A journal without matching snapshots would break the chain once the
    // project adopts drizzle-kit.
    expect(existsSync(join(migrationsDir, 'meta', '_journal.json'))).toBe(false);
    expect(existsSync(join(migrationsDir, 'meta'))).toBe(false);

    expect(() =>
      assertJournalCoherence(migrationsDir, collectMigrations(migrationsDir)),
    ).not.toThrow();
  });

  it('allows migration on a journal with empty entries (playground placeholder)', async () => {
    // The kitchen-sink playground ships `entries: []`; it is treated like no journal.
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    const journalPath = join(migrationsDir, 'meta', '_journal.json');
    const placeholder =
      JSON.stringify({ version: '7', dialect: 'sqlite', entries: [] }, null, 2) + '\n';
    writeFileSync(journalPath, placeholder);

    await runGenCommand(TMP, { subcommand: 'migration', name: 'add_table' });

    const files = listSql(migrationsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{14}_add_table\.sql$/);
    expect(readFileSync(journalPath, 'utf-8')).toBe(placeholder);
  });

  it('refuses to scaffold when _journal.json is missing but meta/*_snapshot.json is present', async () => {
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(join(migrationsDir, 'meta'), { recursive: true });
    const snapshotPath = join(migrationsDir, 'meta', '0000_silent_the_anarchist_snapshot.json');
    const snapshotBytes = Buffer.from(JSON.stringify({ id: 'snap-0000', prevId: null }));
    writeFileSync(snapshotPath, snapshotBytes);

    const errors = await expectExit({ subcommand: 'migration', name: 'add_column' });

    expect(listSql(migrationsDir)).toEqual([]);
    expect(readFileSync(snapshotPath).equals(snapshotBytes)).toBe(true);
    expect(errors).toContain('partial drizzle-kit state');
    expect(errors).toContain('db/migrations/meta/0000_silent_the_anarchist_snapshot.json');
  });

  it('delegates a data migration to drizzle-kit generate --custom on a journal-backed project', async () => {
    const { migrationsDir, journalPath, journal } = seedJournalBackedProject();

    await runGenCommand(TMP, { subcommand: 'migration', name: 'backfill_users' });

    const generateCall = findGenerateCall();
    expect(generateCall).toBeDefined();
    expect(generateCall!.args).toContain('--custom');
    expect(generateCall!.args).toContain('--name');
    expect(generateCall!.args[generateCall!.args.indexOf('--name') + 1]).toBe('backfill_users');
    expect(generateCall!.args).toContain('--config');
    expect(generateCall!.options.cwd).toBe(TMP);

    const sqlFiles = listSql(migrationsDir);
    expect(sqlFiles).toHaveLength(2);
    expect(sqlFiles[0]).toBe('20200101000000_initial.sql');
    expect(sqlFiles[1]).toMatch(/^\d{14}_backfill_users\.sql$/);

    const updatedJournal = JSON.parse(readFileSync(journalPath, 'utf-8'));
    expect(updatedJournal.entries).toHaveLength(2);
    expect(updatedJournal.entries[0]).toEqual(journal.entries[0]);
    expect(updatedJournal.entries[1].tag).toMatch(/_backfill_users$/);

    const snapshotFiles = readdirSync(join(migrationsDir, 'meta')).filter((f) =>
      f.endsWith('_snapshot.json'),
    );
    expect(snapshotFiles).toHaveLength(2);
    const newSnapshot = snapshotFiles.find((f) => f !== '20200101000000_snapshot.json')!;
    expect(
      JSON.parse(readFileSync(join(migrationsDir, 'meta', newSnapshot), 'utf-8')).tables,
    ).toEqual({ fresh: { name: 'fresh' } });
  });

  // cmd.exe would split `C:\Program Files\nodejs\node.exe` and paths with spaces.
  it('runs drizzle-kit without a shell on Windows', async () => {
    seedJournalBackedProject();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      await runGenCommand(TMP, { subcommand: 'migration', name: 'backfill_users' });
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }

    expect(findGenerateCall()!.options).not.toHaveProperty('shell', true);
  });

  it('refuses when the journal dialect disagrees with the void.json dialect', async () => {
    const { migrationsDir, journalPath, journal } = seedJournalBackedProject();
    writeFileSync(join(TMP, 'void.json'), JSON.stringify({ database: 'pg' }));

    const errors = await expectExit({ subcommand: 'migration', name: 'backfill_users' });

    expect(errors).toContain('sqlite');
    expect(errors).toContain('postgresql');
    expect(errors).toContain('_journal.json');
    expect(findGenerateCall()).toBeUndefined();
    expect(listSql(migrationsDir)).toEqual(['20200101000000_initial.sql']);
    expect(JSON.parse(readFileSync(journalPath, 'utf-8'))).toEqual(journal);
  });

  it('proceeds when the journal dialect matches the void.json dialect (postgresql)', async () => {
    seedJournalBackedProject({ dialect: 'postgresql' });
    writeFileSync(join(TMP, 'void.json'), JSON.stringify({ database: 'pg' }));

    await runGenCommand(TMP, { subcommand: 'migration', name: 'backfill_users' });

    const generateCall = findGenerateCall();
    expect(generateCall).toBeDefined();
    expect(generateCall!.args).toContain('--custom');
    expect(generateCall!.args).toContain('--name');
  });

  it('refuses when the journal dialect is unsupported', async () => {
    const { journalPath, journal } = seedJournalBackedProject({ dialect: 'mariadb' });
    // The dialect check runs before the void.json cross-check.
    writeFileSync(join(TMP, 'void.json'), JSON.stringify({}));

    const errors = await expectExit({ subcommand: 'migration', name: 'backfill_users' });

    expect(errors).toContain('unsupported dialect');
    expect(errors).toContain('mariadb');
    expect(errors).toContain('_journal.json');
    expect(findGenerateCall()).toBeUndefined();
    expect(JSON.parse(readFileSync(journalPath, 'utf-8'))).toEqual(journal);
  });

  it('refuses when the journal tag has no matching snapshot (even if unrelated snapshots exist)', async () => {
    // The previous snapshot is named by the last journal tag, not the newest file in meta/.
    const { migrationsDir } = seedJournalBackedProject({
      tag: '20260412171331_initial',
      snapshot: false,
    });
    const unrelatedPath = join(migrationsDir, 'meta', '99999999_other_snapshot.json');
    writeFileSync(
      unrelatedPath,
      JSON.stringify({ version: '6', dialect: 'sqlite', tables: {}, id: 'other' }, null, 2) + '\n',
    );

    const errors = await expectExit({ subcommand: 'migration', name: 'backfill' });

    expect(errors).toContain('20260412171331_initial');
    expect(errors).toContain('20260412171331_snapshot.json');
    expect(errors).toContain('missing under meta/');
    expect(listSql(migrationsDir)).toEqual(['20260412171331_initial.sql']);
    expect(existsSync(unrelatedPath)).toBe(true);
  });

  it('surfaces partial-drizzle state before bundled-mode guard when migrations.js is present but _journal.json is missing', async () => {
    const migrationsDir = join(TMP, 'db', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(join(migrationsDir, 'migrations.js'), 'export default {};\n');

    const errors = await expectExit({ subcommand: 'migration', name: 'should_refuse' });

    expect(listSql(migrationsDir)).toEqual([]);
    expect(existsSync(join(migrationsDir, 'migrations.js'))).toBe(true);
    // Deleting only migrations.js would leave orphan .sql files, so the
    // bundled-mode advice must not be shown here.
    expect(errors).toContain('partial drizzle-kit state');
    expect(errors).toContain('db/migrations/migrations.js');
    expect(errors).not.toContain('Either run `drizzle-kit generate`');
  });

  it('refuses to scaffold a migration when db/migrations/migrations.js exists (bundled mode)', async () => {
    const { migrationsDir, journalPath } = seedJournalBackedProject();
    const journalBefore = readFileSync(journalPath, 'utf-8');
    writeFileSync(join(migrationsDir, 'migrations.js'), 'export default {};\n');

    await expectExit({ subcommand: 'migration', name: 'should_refuse' });

    expect(listSql(migrationsDir)).toEqual(['20200101000000_initial.sql']);
    expect(readFileSync(journalPath, 'utf-8')).toBe(journalBefore);
  });

  it('rolls back any partial artifacts when drizzle-kit fails mid-run', async () => {
    const { migrationsDir, journalPath, snapshotPath } = seedJournalBackedProject();
    const journalBefore = readFileSync(journalPath, 'utf-8');
    const snapshotBefore = readFileSync(snapshotPath, 'utf-8');
    spawnMockState.handler = () => {
      writeFileSync(join(migrationsDir, '99999999_partial.sql'), '');
      writeFileSync(join(migrationsDir, 'meta', '99999999_snapshot.json'), '{}');
      writeFileSync(journalPath, '{"corrupted": true}');
      return { status: 1, stdout: '', stderr: 'simulated drizzle-kit failure' };
    };

    await expectExit({ subcommand: 'migration', name: 'backfill' });

    expect(listSql(migrationsDir)).toEqual(['20200101000000_initial.sql']);
    const snapshotFiles = readdirSync(join(migrationsDir, 'meta')).filter((f) =>
      f.endsWith('_snapshot.json'),
    );
    expect(snapshotFiles).toEqual(['20200101000000_snapshot.json']);
    expect(readFileSync(journalPath, 'utf-8')).toBe(journalBefore);
    expect(readFileSync(snapshotPath, 'utf-8')).toBe(snapshotBefore);
  });

  // Under Yarn PnP there is no node_modules, so drizzle-kit needs the PnP
  // loaders to resolve `void/schema-*` imports from db/schema.ts.
  describe('Yarn PnP NODE_OPTIONS injection', () => {
    let savedNodeOptions: string | undefined;
    beforeEach(() => {
      savedNodeOptions = process.env.NODE_OPTIONS;
      delete process.env.NODE_OPTIONS;
    });
    afterEach(() => {
      if (savedNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = savedNodeOptions;
      }
    });

    it('injects --require .pnp.cjs into NODE_OPTIONS when .pnp.cjs exists', async () => {
      seedJournalBackedProject();
      const pnpCjsPath = join(TMP, '.pnp.cjs');
      writeFileSync(pnpCjsPath, '// fake pnp shim\n');

      await runGenCommand(TMP, { subcommand: 'migration', name: 'backfill' });

      const generateCall = findGenerateCall();
      expect(generateCall).toBeDefined();
      const env = generateCall!.options.env;
      expect(env).toBeDefined();
      expect(typeof env!.NODE_OPTIONS).toBe('string');
      expect(env!.NODE_OPTIONS).toContain('--require');
      // Quoted so Node's NODE_OPTIONS parser accepts spaces in the path.
      expect(env!.NODE_OPTIONS).toContain(JSON.stringify(toSlash(pnpCjsPath)));
      expect(env!.NODE_OPTIONS).not.toContain('--experimental-loader');
    });

    it('also injects --experimental-loader file URL when .pnp.loader.mjs exists', async () => {
      seedJournalBackedProject();
      const pnpCjsPath = join(TMP, '.pnp.cjs');
      const pnpLoaderPath = join(TMP, '.pnp.loader.mjs');
      writeFileSync(pnpCjsPath, '// fake pnp shim\n');
      writeFileSync(pnpLoaderPath, '// fake pnp loader\n');

      await runGenCommand(TMP, { subcommand: 'migration', name: 'backfill' });

      const generateCall = findGenerateCall();
      expect(generateCall).toBeDefined();
      const env = generateCall!.options.env;
      expect(env).toBeDefined();
      expect(typeof env!.NODE_OPTIONS).toBe('string');
      expect(env!.NODE_OPTIONS).toContain('--require');
      expect(env!.NODE_OPTIONS).toContain(JSON.stringify(toSlash(pnpCjsPath)));
      expect(env!.NODE_OPTIONS).toContain('--experimental-loader');
      // Node requires a file:// URL for the loader, not a path.
      expect(env!.NODE_OPTIONS).toContain(pathToFileURL(pnpLoaderPath).href);
    });

    it('leaves NODE_OPTIONS untouched when no PnP markers exist', async () => {
      seedJournalBackedProject();

      await runGenCommand(TMP, { subcommand: 'migration', name: 'backfill' });

      const generateCall = findGenerateCall();
      expect(generateCall).toBeDefined();
      expect(generateCall!.options.env?.NODE_OPTIONS).toBeUndefined();
    });

    it('preserves pre-existing NODE_OPTIONS when injecting the PnP --require flag', async () => {
      seedJournalBackedProject();
      const pnpCjsPath = join(TMP, '.pnp.cjs');
      writeFileSync(pnpCjsPath, '// fake pnp shim\n');
      process.env.NODE_OPTIONS = '--max-old-space-size=4096';

      await runGenCommand(TMP, { subcommand: 'migration', name: 'backfill' });

      const generateCall = findGenerateCall();
      expect(generateCall).toBeDefined();
      const env = generateCall!.options.env;
      expect(env).toBeDefined();
      expect(typeof env!.NODE_OPTIONS).toBe('string');
      // The PnP `--require` must run before anything the user registered.
      expect(env!.NODE_OPTIONS!.startsWith('--require ')).toBe(true);
      expect(env!.NODE_OPTIONS).toContain(JSON.stringify(toSlash(pnpCjsPath)));
      expect(env!.NODE_OPTIONS).toContain('--max-old-space-size=4096');
    });
  });
});

describe('gen route', () => {
  it('keeps an existing route and prints no creation success when skipped', async () => {
    const path = join(TMP, 'routes/api/health.ts');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '// Keep this route.');
    vi.mocked(outro).mockClear();

    await runGenCommand(TMP, { subcommand: 'route', path: 'api/health', methods: ['get'] });

    expect(readFileSync(path, 'utf8')).toBe('// Keep this route.');
    expect(outro).not.toHaveBeenCalled();
  });
  it('generates route with default GET handler', async () => {
    await runGenCommand(TMP, {
      subcommand: 'route',
      path: 'api/health',
      methods: ['get'],
    });

    const content = read('routes/api/health.ts');
    expect(content).toContain('import { defineHandler } from "void"');
    expect(content).toContain('export const GET = defineHandler');
    expect(content).toContain('"GET api/health"');
    expect(content).not.toContain('export const POST');
  });

  it('generates route with multiple methods and no extras', async () => {
    await runGenCommand(TMP, {
      subcommand: 'route',
      path: 'api/users',
      methods: ['get', 'post', 'delete'],
    });

    const content = read('routes/api/users.ts');
    expect(content).toContain('export const GET = defineHandler');
    expect(content).toContain('export const POST = defineHandler');
    expect(content).toContain('export const DELETE = defineHandler');
    expect(content).toContain('"GET api/users"');
    expect(content).toContain('"POST api/users"');
    expect(content).toContain('"DELETE api/users"');
    expect(content).not.toContain('export const PUT');
    expect(content).not.toContain('export const PATCH');
  });

  it('generates PUT and PATCH methods', async () => {
    await runGenCommand(TMP, {
      subcommand: 'route',
      path: 'api/items',
      methods: ['put', 'patch'],
    });

    const content = read('routes/api/items.ts');
    expect(content).toContain('export const PUT = defineHandler');
    expect(content).toContain('export const PATCH = defineHandler');
    expect(content).not.toContain('export const GET');
  });

  it('creates nested directory structure', async () => {
    await runGenCommand(TMP, {
      subcommand: 'route',
      path: 'api/v2/users/profile',
      methods: ['get'],
    });

    expect(existsSync(join(TMP, 'routes/api/v2/users/profile.ts'))).toBe(true);
  });
});

describe('gen middleware', () => {
  it('generates numbered middleware file', async () => {
    await runGenCommand(TMP, { subcommand: 'middleware', name: 'auth' });

    const content = read('middleware/01.auth.ts');
    expect(content).toContain('import { defineMiddleware } from "void"');
    expect(content).toContain('export default defineMiddleware');
    expect(content).toContain('await next()');
    expect(content).toContain('implement auth middleware');
  });

  it('auto-numbers after existing middleware with correct content', async () => {
    mkdirSync(join(TMP, 'middleware'), { recursive: true });
    writeFileSync(join(TMP, 'middleware/01.logger.ts'), '');
    writeFileSync(join(TMP, 'middleware/02.cors.ts'), '');

    await runGenCommand(TMP, { subcommand: 'middleware', name: 'auth' });

    expect(existsSync(join(TMP, 'middleware/03.auth.ts'))).toBe(true);
    const content = read('middleware/03.auth.ts');
    expect(content).toContain('defineMiddleware');
    expect(content).toContain('await next()');
    expect(content).toContain('implement auth middleware');
  });
});

describe('gen ssr', () => {
  it('generates React SSR files', async () => {
    await runGenCommand(TMP, { subcommand: 'ssr', framework: 'react' });

    const ssr = read('src/main.ssr.tsx');
    expect(ssr).toContain('import { renderToString } from "react-dom/server"');
    expect(ssr).toContain('import { defineRender } from "void"');
    expect(ssr).toContain('export default defineRender');

    const client = read('src/main.client.tsx');
    expect(client).toContain('import { hydrateRoot } from "react-dom/client"');

    const app = read('src/App.tsx');
    expect(app).toContain('import { useState } from "react"');
    expect(app).toContain('export default function App');
  });

  it('generates Vue SSR files', async () => {
    await runGenCommand(TMP, { subcommand: 'ssr', framework: 'vue' });

    const ssr = read('src/main.ssr.ts');
    expect(ssr).toContain('import { createSSRApp } from "vue"');
    expect(ssr).toContain('import { renderToString, type SSRContext } from "vue/server-renderer"');
    // `Image` from @void/vue collects preload links in the SSR context.
    expect(ssr).toContain('const appHtml = await renderToString(app, ssrContext);');
    expect(ssr).toContain('const imagePreloads = ssrContext.__voidImagePreloads?.render() ?? "";');
    expect(ssr).toContain('${imagePreloads}${assetTags.css}${assetTags.preloads}\n  </head>');

    const client = read('src/main.client.ts');
    expect(client).toContain('import { createSSRApp } from "vue"');
    expect(client).toContain('app.mount("#app")');

    const app = read('src/App.vue');
    expect(app).toContain('<script setup lang');
    expect(app).toContain('<template>');
  });

  it('generates Svelte SSR files', async () => {
    await runGenCommand(TMP, { subcommand: 'ssr', framework: 'svelte' });

    const ssr = read('src/main.ssr.ts');
    expect(ssr).toContain('import { render } from "svelte/server"');
    // `<svelte:head>` output, including `Image` preload links, goes into <head>.
    expect(ssr).toContain('const { head, body: appHtml } = render(App);');
    expect(ssr).toContain('${head}${assetTags.css}${assetTags.preloads}\n  </head>');

    const client = read('src/main.client.ts');
    expect(client).toContain('import { hydrate } from "svelte"');

    const app = read('src/App.svelte');
    expect(app).toContain('$state(0)');
  });

  it('generates Solid SSR files', async () => {
    await runGenCommand(TMP, { subcommand: 'ssr', framework: 'solid' });

    const ssr = read('src/main.ssr.tsx');
    expect(ssr).toContain('import { renderToString } from "solid-js/web"');

    const client = read('src/main.client.tsx');
    expect(client).toContain('import { hydrate } from "solid-js/web"');

    const app = read('src/App.tsx');
    expect(app).toContain('import { createSignal } from "solid-js"');
    expect(app).toContain('count()');
  });

  it('auto-detects React from package.json', async () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(
      join(TMP, 'package.json'),
      JSON.stringify({ dependencies: { react: '^19.0.0' } }),
    );

    await runGenCommand(TMP, { subcommand: 'ssr', framework: undefined });

    expect(existsSync(join(TMP, 'src/main.ssr.tsx'))).toBe(true);
    expect(read('src/main.ssr.tsx')).toContain('react-dom/server');
  });

  it('auto-detects Vue from package.json devDependencies', async () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(
      join(TMP, 'package.json'),
      JSON.stringify({ devDependencies: { vue: '^3.0.0' } }),
    );

    await runGenCommand(TMP, { subcommand: 'ssr', framework: undefined });

    expect(read('src/main.ssr.ts')).toContain('vue/server-renderer');
  });

  it('does not overwrite existing SSR files', async () => {
    mkdirSync(join(TMP, 'src'), { recursive: true });
    writeFileSync(join(TMP, 'src/App.tsx'), '// my custom App');

    await runGenCommand(TMP, { subcommand: 'ssr', framework: 'react' });

    expect(readFileSync(join(TMP, 'src/App.tsx'), 'utf-8')).toBe('// my custom App');
    expect(existsSync(join(TMP, 'src/main.ssr.tsx'))).toBe(true);
    expect(existsSync(join(TMP, 'src/main.client.tsx'))).toBe(true);
  });

  it('exits when no package.json and no framework flag', async () => {
    await expectExit({ subcommand: 'ssr', framework: undefined });
  });

  it('exits when package.json has no supported framework', async () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(
      join(TMP, 'package.json'),
      JSON.stringify({ dependencies: { angular: '^17.0.0' } }),
    );

    await expectExit({ subcommand: 'ssr', framework: undefined });
  });
});

describe('gen cron', () => {
  it('generates cron job file with defineScheduled', async () => {
    mkdirSync(TMP, { recursive: true });
    await runGenCommand(TMP, { subcommand: 'cron', name: 'hourly-sync' });

    const content = read('crons/hourly-sync.ts');
    expect(content).toContain('import { defineScheduled } from "void"');
    expect(content).toContain('export const cron = "* * * * *"');
    expect(content).toContain('export default defineScheduled(');
    expect(content).toContain('// TODO: implement hourly-sync');
  });

  it('does not overwrite existing file', async () => {
    mkdirSync(join(TMP, 'crons'), { recursive: true });
    writeFileSync(join(TMP, 'crons/sync.ts'), '// existing');

    await runGenCommand(TMP, { subcommand: 'cron', name: 'sync' });

    expect(read('crons/sync.ts')).toBe('// existing');
  });
});

describe('gen queue', () => {
  it('generates queue consumer file with defineQueue', async () => {
    mkdirSync(TMP, { recursive: true });
    await runGenCommand(TMP, { subcommand: 'queue', name: 'emails' });

    const content = read('queues/emails.ts');
    expect(content).toContain('import { defineQueue } from "void"');
    expect(content).toContain('type Message = {};');
    expect(content).toContain('// export const maxBatchSize = 10;');
    expect(content).toContain('// export const maxBatchTimeout = 5;');
    expect(content).toContain('export default defineQueue<Message>(');
    expect(content).toContain('batch.messages');
  });

  it('does not overwrite existing file', async () => {
    mkdirSync(join(TMP, 'queues'), { recursive: true });
    writeFileSync(join(TMP, 'queues/emails.ts'), '// existing');

    await runGenCommand(TMP, { subcommand: 'queue', name: 'emails' });

    expect(read('queues/emails.ts')).toBe('// existing');
  });
});

describe('gen model (postgresql)', () => {
  it('generates pgTable definition', async () => {
    writePkg({ valibot: '^1.0.0' });
    writeFileSync(join(TMP, 'void.json'), JSON.stringify({ database: 'pg' }));

    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'posts',
      columns: [
        { name: 'title', type: 'string', nullable: false },
        { name: 'views', type: 'integer', nullable: false },
      ],
    });

    const schema = read('db/schema/posts.ts');
    expect(schema).toContain('pgTable');
    expect(schema).toContain('serial("id").primaryKey()');
    expect(schema).toContain('timestamp("created_at").notNull().defaultNow()');
    expect(schema).toContain('text("title").notNull()');
    expect(schema).toContain('integer("views").notNull()');
    expect(schema).not.toContain('sqliteTable');
    expect(schema).not.toContain('import { sql }');
  });
});

describe('gen model (mysql)', () => {
  it('generates mysqlTable definitions with native MySQL columns', async () => {
    writePkg({ valibot: '^1.0.0' });
    writeFileSync(join(TMP, 'void.json'), JSON.stringify({ database: 'mysql' }));

    await runGenCommand(TMP, {
      subcommand: 'model',
      name: 'products',
      columns: [
        { name: 'title', type: 'string', nullable: false },
        { name: 'active', type: 'boolean', nullable: false },
        { name: 'price', type: 'real', nullable: false },
      ],
    });

    const schema = read('db/schema/products.ts');
    expect(schema).toContain('mysqlTable');
    expect(schema).toContain('from "void/schema-mysql"');
    expect(schema).toContain('int("id").autoincrement().primaryKey()');
    expect(schema).toContain('boolean("active")');
    expect(schema).toContain('double("price")');
    expect(schema).not.toContain('sqliteTable');
  });
});
