import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { runRemoteMigrations } from '../../src/migrations/remote-runner.ts';

// The REST query endpoint executes one submitted SQL body as a batch. Model
// that boundary with SQLite transactions so splitting requests loses atomicity.
describe('managed D1 migration commits', () => {
  let db: DatabaseSync;
  let failTracking: boolean;
  let loseResponse: boolean;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE counters (n INTEGER); INSERT INTO counters VALUES (0);
      CREATE TABLE _void_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
    failTracking = false;
    loseResponse = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        const { sql, params = [] } = JSON.parse(String(init.body)) as {
          sql: string;
          params?: Array<string | number | null>;
        };
        db.exec('BEGIN');
        try {
          if (sql.startsWith('SELECT')) {
            const results = db.prepare(sql).all(...params);
            db.exec('COMMIT');
            return Response.json({ success: true, result: [{ results }] });
          }
          if (failTracking) {
            db.exec(`CREATE TEMP TRIGGER fail_tracking BEFORE INSERT ON _void_migrations
            BEGIN SELECT RAISE(ABORT, 'tracking unavailable'); END;`);
          }
          if (params.length) {
            db.prepare(sql).run(...params);
          } else {
            db.exec(sql);
          }
          db.exec('DROP TRIGGER IF EXISTS fail_tracking; COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          return Response.json({
            success: false,
            errors: [{ message: String(error) }],
            result: [],
          });
        }
        if (loseResponse && sql.includes('UPDATE counters')) {
          throw new Error('connection lost after commit');
        }
        return Response.json({ success: true, result: [{ results: [] }] });
      }),
    );
  });
  afterEach(() => {
    db.close();
    vi.unstubAllGlobals();
  });
  const increment = {
    name: "001_joe's_increment.sql",
    sql: 'UPDATE counters SET n=n+1 -- trailing comment',
  };
  const run = (migrations = [increment]) =>
    runRemoteMigrations('account', 'token', 'db', migrations);
  const count = () => db.prepare('SELECT n FROM counters').get()!.n;

  it('upgrades legacy tracking and skips previously applied migrations', async () => {
    db.exec(`CREATE TABLE _migrations(name TEXT PRIMARY KEY, applied_at TEXT);
      INSERT INTO _migrations VALUES ('legacy.sql', 'now');`);
    const result = await run([{ name: 'legacy.sql', sql: 'UPDATE counters SET n=n+1' }]);
    expect(result.skipped).toEqual(['legacy.sql']);
    expect(count()).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='_migrations'").all()).toEqual([]);
  });

  it('preserves completed migrations when a later migration fails', async () => {
    const result = await run([
      increment,
      { name: 'broken.sql', sql: 'INSERT INTO missing VALUES (1)' },
    ]);
    expect(result.applied).toEqual([increment.name]);
    expect(result.failed?.name).toBe('broken.sql');
    expect(count()).toBe(1);
    expect(db.prepare('SELECT name FROM _void_migrations').all()).toEqual([
      { name: increment.name },
    ]);
  });

  it('rolls back earlier statements in a migration on a later SQL failure', async () => {
    const result = await run([
      { name: 'multi.sql', sql: 'UPDATE counters SET n=n+1; INSERT INTO missing VALUES (1);' },
    ]);
    expect(result.failed).toBeDefined();
    expect(count()).toBe(0);
  });

  it('rejects an unterminated comment that would hide the tracking insert', async () => {
    const result = await run([
      { name: 'comment.sql', sql: 'UPDATE counters SET n=n+1; /* unfinished' },
    ]);
    expect(result.failed).toBeDefined();
    expect(count()).toBe(0);
  });

  it('rolls back a data change when tracking fails, then applies it once on retry', async () => {
    failTracking = true;
    expect((await run()).failed).toBeDefined();
    expect(count()).toBe(0);
    failTracking = false;
    expect((await run()).applied).toEqual([increment.name]);
    expect(count()).toBe(1);
  });

  it('reconciles a lost commit response without repeating the data change', async () => {
    loseResponse = true;
    await run();
    loseResponse = false;
    expect((await run()).skipped).toEqual([increment.name]);
    expect(count()).toBe(1);
  });

  it('rolls back duplicate execution against a stale applied set', async () => {
    await run();
    const result = await runRemoteMigrations('account', 'token', 'db', [increment], new Set());
    expect(result.skipped).toEqual([increment.name]);
    expect(count()).toBe(1);
  });

  it('does not infer migration success from an unrelated existing schema object', async () => {
    db.exec('CREATE TABLE users(id INTEGER);');
    const result = await run([{ name: '001_users.sql', sql: 'CREATE TABLE users(id INTEGER)' }]);
    expect(result.failed).toBeDefined();
    expect(db.prepare('SELECT * FROM _void_migrations').all()).toEqual([]);
  });
});
