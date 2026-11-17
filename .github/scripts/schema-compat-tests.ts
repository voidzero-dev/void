import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// Copied to RUNNER_TEMP: native filesystem paths must work without workspace dependencies.
// eslint-disable-next-line no-restricted-imports
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const legacyZoneFixture = `      const second = await createTestProject(env.db, user.id, 'concurrent-zone-second');
      stubCustomerCf({ zones });`;
const correctedZoneFixture = `      const second = await createTestProject(env.db, user.id, 'concurrent-zone-second');
      const mx: Record<string, Array<string>> = {
        'concurrent-one.example.com': [],
        'concurrent-two.example.com': [],
      };
      let provisionedDomain = '';
      // Both lookups must identify the same provider zone for this locking regression.
      stubCustomerCf({
        zones: {
          ...zones,
          'concurrent-two.example.com': {
            ...zones['concurrent-two.example.com']!,
            id: zones['concurrent-one.example.com']!.id,
          },
        },
        mx,
        on: {
          routingDns: () => {
            mx[provisionedDomain] = ['route1.mx.cloudflare.net'];
          },
        },
      });`;

const legacyZoneProvision = `      await runEmailOperation(env.db, bindings(), accepted.value.operationId);`;
const correctedZoneProvision = `      provisionedDomain = (await env.db.select().from(emailDomainRoutes))[0]!.domain;
      await runEmailOperation(env.db, bindings(), accepted.value.operationId);`;

const legacyDeployBodyFixture = `    expect(res.status).not.toBe(413);
  });`;
const correctedDeployBodyFixture = `    expect(res.status).not.toBe(413);
    // Finish the deployment's database work before the next fixture resets its tables.
    await res.text();
  });`;

function correctKnownFixture(
  source: string,
  checksum: string,
  replacements: ReadonlyArray<readonly [string, string]>,
): string {
  const normalized = source.replaceAll('\r\n', '\n');
  if (createHash('sha256').update(normalized).digest('hex') !== checksum) {
    return source;
  }
  let corrected = normalized;
  for (const [before, after] of replacements) {
    if (corrected.split(before).length !== 2) {
      throw new Error('The known compatibility fixture correction no longer matches.');
    }
    corrected = corrected.replace(before, after);
  }
  return source.includes('\r\n') ? corrected.replaceAll('\n', '\r\n') : corrected;
}

/** Correct only the known deployed test fixture; runtime code and every assertion stay intact. */
function correctLegacyEmailFixture(source: string): string {
  return correctKnownFixture(
    source,
    'bf3ec4cd84c85a9e2cd01c7906ca6952dce5d7b957dc38487d6cfe99e9257eed',
    [
      [legacyZoneFixture, correctedZoneFixture],
      [legacyZoneProvision, correctedZoneProvision],
    ],
  );
}

function correctLegacyDeployFixture(source: string): string {
  return correctKnownFixture(
    source,
    'a62cdbc79573bba09da2212c441ebdcec74569d5ec4193d494f54fad98722f33',
    [[legacyDeployBodyFixture, correctedDeployBodyFixture]],
  );
}

/** Only the disposable CI database may be used as a template. */
function compatibilityTemplate(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('A disposable loopback PostgreSQL compatibility database is required.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username !== 'void_ci' ||
    url.pathname !== '/void_schema_compat' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Use the disposable void_schema_compat database on loopback as void_ci.');
  }
  return url;
}

export function compatibilityTestFiles(root: string): Array<string> {
  const files: Array<string> = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
        files.push(relative(root, path).replaceAll('\\', '/'));
      }
    }
  };
  walk(join(root, 'platform/packages/api/test/integration'));
  return files.sort();
}

/** Keep the deployed runtime/tests intact, with one upgraded database snapshot per file. */
async function runIsolatedCompatibilityTests(options: {
  templateUrl: string;
  files: ReadonlyArray<string>;
  query: (statement: string) => Promise<unknown>;
  runTest: (file: string, databaseUrl: string) => Promise<number>;
}): Promise<Array<string>> {
  const template = compatibilityTemplate(options.templateUrl);
  const concurrency = 2;
  if (!options.files.length || new Set(options.files).size !== options.files.length) {
    throw new Error('Compatibility tests must contain unique test files.');
  }
  const prefix = `void_compat_${randomUUID().replaceAll('-', '')}`;
  const failures: Array<string> = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < options.files.length) {
      const index = cursor++;
      const file = options.files[index]!;
      const name = `${prefix}_${index}`;
      const database = new URL(template);
      database.pathname = `/${name}`;
      await options.query(`CREATE DATABASE "${name}" TEMPLATE "void_schema_compat"`);
      try {
        if ((await options.runTest(file, database.href)) !== 0) {
          failures.push(file);
        }
      } catch {
        failures.push(file);
      } finally {
        // The name was generated and created by this invocation, never supplied by a caller.
        await options.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      }
    }
  };
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, options.files.length) }, worker),
  );
  const error = results.find((result) => result.status === 'rejected');
  if (error?.status === 'rejected') {
    throw error.reason;
  }
  return failures;
}

function runFile(root: string, file: string, databaseUrl: string): Promise<number> {
  console.log(`[schema-compat] ${file}`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      'vp',
      ['test', 'run', '--project', 'platform-api-integration*', '--maxWorkers', '1', file],
      {
        cwd: root,
        env: { ...process.env, VOID_TEST_DATABASE_URL: databaseUrl },
        stdio: 'inherit',
        detached: process.platform !== 'win32',
      },
    );
    let expired = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw error;
        }
      }
    };
    const timeout = setTimeout(() => {
      expired = true;
      kill('SIGTERM');
      force = setTimeout(() => kill('SIGKILL'), 5_000);
    }, 180_000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      clearTimeout(force);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      clearTimeout(force);
      resolvePromise(expired ? 1 : (code ?? 1));
    });
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const root = process.cwd();
  const template = compatibilityTemplate(process.env.COMPAT_DATABASE_URL ?? '');
  const allFiles = compatibilityTestFiles(root);
  const selected = process.argv
    .slice(2)
    .map((file) => relative(root, resolve(root, file)).replaceAll('\\', '/'));
  if (selected.some((file) => !allFiles.includes(file))) {
    throw new Error('Select existing platform API integration test files.');
  }
  const files = selected.length ? selected : allFiles;
  for (const [fixture, correct] of [
    ['platform/packages/api/test/integration/email-connections.test.ts', correctLegacyEmailFixture],
    ['platform/packages/api/test/integration/deploy-direct-r2.test.ts', correctLegacyDeployFixture],
  ] as const) {
    if (files.includes(fixture)) {
      const fixturePath = join(root, fixture);
      const original = readFileSync(fixturePath, 'utf8');
      const corrected = correct(original);
      if (corrected !== original) {
        writeFileSync(fixturePath, corrected);
        console.log(
          `[schema-compat] Corrected checksum-verified legacy fixture ${fixture}; assertions unchanged.`,
        );
      }
    }
  }
  const maintenance = new URL(template);
  maintenance.pathname = '/postgres';
  // Resolve from the immutable checkout being exercised, including when this runner is in RUNNER_TEMP.
  const { Pool } = createRequire(pathToFileURL(join(root, 'platform/packages/api/package.json')))(
    'pg',
  );
  const pool = new Pool({ connectionString: maintenance.href });
  try {
    const failures = await runIsolatedCompatibilityTests({
      templateUrl: template.href,
      files,
      query: (statement) => pool.query(statement),
      runTest: (file, databaseUrl) => runFile(root, file, databaseUrl),
    });
    console.log(`[schema-compat] ${files.length - failures.length}/${files.length} files passed.`);
    if (failures.length) {
      console.error('Failed compatibility files:', failures.join(', '));
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}
