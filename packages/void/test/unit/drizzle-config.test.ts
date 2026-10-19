import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toSlash } from 'pathslash';
import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { generateVoidAuthDrizzleSchema } from '../../src/auth/drizzle.ts';
import { validateAuthMigrationSchema } from '../../src/cli/deploy-migrations.ts';
import { withPrivateDrizzleConfig, writeDrizzleConfig } from '../../src/drizzle/config.ts';
import { collectMigrations } from '../../src/migrations/collect.ts';

describe('writeDrizzleConfig', () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `void-drizzle-cfg-${Date.now()}`);
    mkdirSync(join(root, '.void'), { recursive: true });
    mkdirSync(join(root, 'db'), { recursive: true });
    writeFileSync(join(root, 'db/schema.ts'), 'export const users = {};');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes a valid JSON config to .void/', () => {
    const configPath = writeDrizzleConfig(root, '/tmp/test.sqlite');
    expect(configPath).toBe(toSlash(join(root, '.void', 'drizzle.config.json')));
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.dialect).toBe('sqlite');
    expect(config.schema).toBe('./db/schema.ts');
    expect(config.out).toBe('./db/migrations');
    expect(config.dbCredentials.url).toBe('/tmp/test.sqlite');
    expect(config.migrations).toEqual({ prefix: 'timestamp' });
    expect(config).not.toHaveProperty('casing');
  });

  it.each(['snake_case', 'camelCase'])('passes database.casing %s to drizzle-kit', (casing) => {
    writeFileSync(join(root, 'void.json'), JSON.stringify({ database: { dialect: 'pg', casing } }));
    const configPath = writeDrizzleConfig(root, 'postgresql://dummy', 'postgresql');
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).casing).toBe(casing);
  });

  it('generates PostgreSQL config', () => {
    const configPath = writeDrizzleConfig(root, 'postgresql://localhost/test', 'postgresql');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.dialect).toBe('postgresql');
    expect(config.schema).toBe('./db/schema.ts');
    expect(config.out).toBe('./db/migrations');
    expect(config.dbCredentials.url).toBe('postgresql://localhost/test');
  });

  it('generates MySQL config', () => {
    const configPath = writeDrizzleConfig(root, 'mysql://localhost/test', 'mysql');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.dialect).toBe('mysql');
    expect(config.schema).toBe('./db/schema.ts');
    expect(config.dbCredentials.url).toBe('mysql://localhost/test');
  });

  it('includes generated schemas alongside the application schema', () => {
    const authSchema = join(root, '.void', 'better-auth-schema.ts');
    writeFileSync(authSchema, 'export const user = {};');

    const configPath = writeDrizzleConfig(root, ':memory:', 'sqlite', {
      additionalSchemas: [authSchema],
    });

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.schema).toEqual(['./db/schema.ts', './.void/better-auth-schema.ts']);
  });

  it('supports an auth-only project without an application schema', () => {
    rmSync(join(root, 'db', 'schema.ts'));
    const authSchema = join(root, '.void', 'better-auth-schema.ts');
    writeFileSync(authSchema, 'export const user = {};');

    const configPath = writeDrizzleConfig(root, ':memory:', 'sqlite', {
      additionalSchemas: [authSchema],
    });

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.schema).toBe('./.void/better-auth-schema.ts');
  });
});

describe('withPrivateDrizzleConfig', () => {
  let root: string;
  const dbUrl = 'postgres://user:secret@db.example.com:5432/app';

  beforeEach(() => {
    root = join(tmpdir(), `void-drizzle-private-${Date.now()}`);
    mkdirSync(join(root, 'db'), { recursive: true });
    writeFileSync(join(root, 'db/schema.ts'), 'export const users = {};');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('passes a config outside the project that holds the database URL', () => {
    const result = withPrivateDrizzleConfig(root, dbUrl, 'postgresql', (configPath) => {
      expect(relative(root, configPath).startsWith('..')).toBe(true);
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.dbCredentials.url).toBe(dbUrl);
      expect(config.dialect).toBe('postgresql');
      expect(config.schema).toBe('./db/schema.ts');
      expect(config.out).toBe('./db/migrations');
      return 'ran';
    });
    expect(result).toBe('ran');
    expect(existsSync(join(root, '.void', 'drizzle.config.json'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('writes the config readable by the owner only', () => {
    withPrivateDrizzleConfig(root, dbUrl, 'postgresql', (configPath) => {
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(configPath)).mode & 0o777).toBe(0o700);
    });
  });

  it('removes the config after run returns', () => {
    let seen = '';
    withPrivateDrizzleConfig(root, dbUrl, 'postgresql', (configPath) => {
      seen = configPath;
    });
    expect(seen).not.toBe('');
    expect(existsSync(dirname(seen))).toBe(false);
  });

  it('removes the config after run throws', () => {
    let seen = '';
    expect(() =>
      withPrivateDrizzleConfig(root, dbUrl, 'mysql', (configPath) => {
        seen = configPath;
        throw new Error('drizzle-kit failed');
      }),
    ).toThrow('drizzle-kit failed');
    expect(seen).not.toBe('');
    expect(existsSync(dirname(seen))).toBe(false);
  });

  it('keeps a SIGINT listener only while run executes', () => {
    const before = process.listenerCount('SIGINT');
    withPrivateDrizzleConfig(root, dbUrl, 'postgresql', () => {
      expect(process.listenerCount('SIGINT')).toBe(before + 1);
    });
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('still reports a missing schema', () => {
    rmSync(join(root, 'db', 'schema.ts'));
    const before = process.listenerCount('SIGINT');
    expect(() => withPrivateDrizzleConfig(root, dbUrl, 'postgresql', () => undefined)).toThrow(
      'No Drizzle schema found',
    );
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('removes a project config that an older CLI left with a database URL', () => {
    const leftover = join(root, '.void', 'drizzle.config.json');
    mkdirSync(dirname(leftover), { recursive: true });
    writeFileSync(
      leftover,
      JSON.stringify({ dialect: 'postgresql', dbCredentials: { url: 'postgres://u:old@db/app' } }),
    );
    withPrivateDrizzleConfig(root, dbUrl, 'postgresql', () => undefined);
    expect(existsSync(leftover)).toBe(false);
  });

  it.each(['postgresql://dummy', 'mysql://dummy', ':memory:', '/project/.void/local.sqlite'])(
    'keeps a project config whose URL is %j',
    (url) => {
      const config = join(root, '.void', 'drizzle.config.json');
      mkdirSync(dirname(config), { recursive: true });
      writeFileSync(config, JSON.stringify({ dbCredentials: { url } }));
      withPrivateDrizzleConfig(root, dbUrl, 'postgresql', () => undefined);
      expect(existsSync(config)).toBe(true);
    },
  );
});

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const drizzleKitBin = join(fileURLToPath(import.meta.resolve('drizzle-kit')), '..', 'bin.cjs');

// Real drizzle-kit processes; Windows CI can take over five seconds for one.
describe(
  'drizzle-kit generate with database.casing',
  {
    timeout: process.platform === 'win32' ? 30_000 : 10_000,
  },
  () => {
    let root: string;

    beforeEach(() => {
      // drizzle-kit loads the schema, which must resolve drizzle-orm from the package.
      root = mkdtempSync(join(packageRoot, '.tmp-drizzle-casing-'));
      mkdirSync(join(root, 'db'));
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    function generate(dialect: 'sqlite' | 'postgresql', additionalSchemas?: Array<string>) {
      const configPath = writeDrizzleConfig(
        root,
        dialect === 'sqlite' ? ':memory:' : 'postgresql://dummy',
        dialect,
        { additionalSchemas },
      );
      execFileSync(process.execPath, [drizzleKitBin, 'generate', '--config', configPath], {
        cwd: root,
        stdio: 'pipe',
      });
      return collectMigrations(join(root, 'db', 'migrations'));
    }

    it('names PostgreSQL columns without a name in snake_case', () => {
      writeFileSync(
        join(root, 'void.json'),
        JSON.stringify({ database: { dialect: 'pg', casing: 'snake_case' } }),
      );
      writeFileSync(
        join(root, 'db', 'schema.ts'),
        [
          'import { pgTable, serial, timestamp } from "drizzle-orm/pg-core";',
          'export const posts = pgTable("posts", {',
          '  id: serial().primaryKey(),',
          '  createdAt: timestamp().notNull(),',
          '});',
          '',
        ].join('\n'),
      );

      const [migration] = generate('postgresql');

      expect(migration.sql).toContain('"created_at" timestamp NOT NULL');
      expect(migration.sql).not.toContain('createdAt');
    });

    it('keeps the Better Auth column names that the auth schema declares', async () => {
      writeFileSync(
        join(root, 'void.json'),
        JSON.stringify({ database: { casing: 'snake_case' } }),
      );
      writeFileSync(
        join(root, 'db', 'schema.ts'),
        [
          'import { integer, sqliteTable } from "drizzle-orm/sqlite-core";',
          'export const posts = sqliteTable("posts", {',
          '  id: integer().primaryKey(),',
          '  createdAt: integer().notNull(),',
          '});',
          '',
        ].join('\n'),
      );
      const authSchema = join(root, '.void', 'better-auth-schema.ts');
      mkdirSync(dirname(authSchema), { recursive: true });
      writeFileSync(
        authSchema,
        generateVoidAuthDrizzleSchema({ dialect: 'sqlite', providers: ['email'] }).replace(
          '"void/schema-d1"',
          '"drizzle-orm/sqlite-core"',
        ),
      );

      const migrations = generate('sqlite', [authSchema]);

      expect(migrations).toHaveLength(1);
      expect(migrations[0].sql).toContain('`created_at` integer NOT NULL');
      expect(migrations[0].sql).toContain('`emailVerified` integer');
      expect(migrations[0].sql).not.toContain('email_verified');
      // The deploy gate compares the SQL with the tables Better Auth reads and writes.
      await expect(validateAuthMigrationSchema(root, migrations)).resolves.toBeUndefined();
    });
  },
);
