import { describe, expect, it } from 'vite-plus/test';
import { compileRouteTable, type AuthCompileOptions } from '../../src/router/compile.ts';
import type { ScanResult } from '../../src/router/scan.ts';

const emptyScan: ScanResult = {
  routes: [],
  middleware: [],
  jobs: [],
  queues: [],
  pages: { pages: [], layouts: [], namedLayouts: [] },
};

const baseOptions = {
  honoPath: '/resolved/hono/index.mjs',
  honoRoutePath: '/resolved/hono/route.mjs',

  runtimeEnvPath: '/resolved/void/runtime/env.mjs',
  projectRoot: '/project',
  homeDir: '/Users/test',
  reactRefresh: false,
};

const sqliteAuth: AuthCompileOptions = {
  authRuntimePath: '/resolved/void/runtime/better-auth.mjs',
  authConfigPath: null,
  authDatabasePath: '/project/.void/better-auth-db.ts',
  authSchemaPath: '/project/.void/better-auth-schema.ts',
  dialect: 'sqlite',
  providers: null,
};

const pgAuth: AuthCompileOptions = {
  authRuntimePath: '/resolved/void/runtime/better-auth.mjs',
  authConfigPath: '/app/auth.ts',
  authDatabasePath: '/project/.void/better-auth-db.ts',
  authSchemaPath: '/project/.void/better-auth-schema.ts',
  dialect: 'postgresql',
  providers: ['email', 'github'],
};

describe('compileRouteTable auth integration', () => {
  it('generates no auth code when auth is disabled', () => {
    const code = compileRouteTable(emptyScan, '/routes', '/middleware', '/crons', '/queues', null, {
      ...baseOptions,
      auth: null,
    });

    expect(code).not.toContain('runVoidAuthMiddleware');
    expect(code).not.toContain('"/api/auth"');
    expect(code).not.toContain('"/auth/login"');
  });

  it('mounts Better Auth middleware and routes when auth is enabled', () => {
    const code = compileRouteTable(emptyScan, '/routes', '/middleware', '/crons', '/queues', null, {
      ...baseOptions,
      auth: sqliteAuth,
    });

    expect(code).toContain('from "/resolved/void/runtime/better-auth.mjs"');
    expect(code).toContain('import { __voidAuthDatabase } from "/project/.void/better-auth-db.ts"');
    expect(code).toContain(
      'import { migrationSchema as __voidAuthMigrationSchema } from "/project/.void/better-auth-schema.ts"',
    );
    expect(code).toContain('runVoidAuthMiddleware');
    expect(code).toContain('handleVoidAuthRequest');
    expect(code).toContain('runVoidAuthMiddleware(c, next, __voidAuthOptions, __voidAuthDatabase)');
    expect(code).toContain('handleVoidAuthRequest(c, __voidAuthOptions, __voidAuthDatabase)');
    expect(code).toContain('app.all("/api/auth", __markRouteHandler(');
    expect(code).toContain('app.all("/api/auth/*", __markRouteHandler(');
    expect(code).not.toContain('app.post("/auth/register"');
    expect(code).not.toContain('app.post("/auth/login"');
    expect(code).not.toContain('app.get("/auth/me"');
    expect(code).not.toContain('app.post("/auth/logout"');
  });

  it('bakes the build mode into auth options independently of requests', () => {
    const compile = (dev: boolean) =>
      compileRouteTable(emptyScan, '/routes', '/middleware', '/crons', '/queues', null, {
        ...baseOptions,
        auth: sqliteAuth,
        dev,
      });

    expect(compile(true)).toContain('userConfig: undefined, dev: true };');
    expect(compile(false)).toContain('userConfig: undefined, dev: false };');
  });

  it('passes the detected dialect into the auth helpers', () => {
    const code = compileRouteTable(emptyScan, '/routes', '/middleware', '/crons', '/queues', null, {
      ...baseOptions,
      auth: pgAuth,
    });

    expect(code).toContain('dialect: "postgresql"');
    expect(code).toContain('providers: ["email","github"]');
  });

  it('imports and threads the user auth config when present', () => {
    const code = compileRouteTable(emptyScan, '/routes', '/middleware', '/crons', '/queues', null, {
      ...baseOptions,
      auth: pgAuth,
    });

    expect(code).toContain('import __voidAuthConfig from "/app/auth.ts"');
    expect(code).toContain('userConfig: __voidAuthConfig');
  });

  it('places auth middleware before user middleware and auth routes before user routes', () => {
    const scan: ScanResult = {
      routes: [
        {
          pattern: '/api/hello',
          methods: ['GET'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/hello.ts',
        },
      ],
      middleware: [{ order: 1, filePath: '01.logger.ts' }],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const code = compileRouteTable(scan, '/routes', '/middleware', '/crons', '/queues', null, {
      ...baseOptions,
      auth: sqliteAuth,
    });

    const authMiddlewareIdx = code.indexOf('runVoidAuthMiddleware');
    const userMiddlewareIdx = code.indexOf('app.use(middleware0)');
    const authRouteIdx = code.indexOf('app.all("/api/auth"');
    const userRouteIdx = code.indexOf('app.get("/api/hello"');

    expect(authMiddlewareIdx).toBeLessThan(userMiddlewareIdx);
    expect(userMiddlewareIdx).toBeLessThan(authRouteIdx);
    expect(authRouteIdx).toBeLessThan(userRouteIdx);
  });

  it('wires auth migrations into the in-worker migration route', () => {
    const code = compileRouteTable(emptyScan, '/routes', '/middleware', '/crons', '/queues', null, {
      ...baseOptions,
      auth: sqliteAuth,
      migrationHandlerPath: '/resolved/migration-handler.mjs',
      migrations: [{ name: '001_init.sql', sql: 'select 1;' }],
    });

    expect(code).toContain('runVoidAuthMigrations');
    expect(code).toContain(
      'runVoidAuthMigrations(__voidGetMigrationEnv(), __voidAuthOptions, __voidAuthMigrationSchema)',
    );
    expect(code).toContain('export async function __voidHandleInternalRoute(request)');
    expect(code).toContain('if (request.method === "POST" && url.pathname === "/__void/migrate")');
    expect(code).toContain('app.post("/__void/migrate"');
  });

  it('aliases custom D1 binding names for internal sqlite migrations', () => {
    const code = compileRouteTable(emptyScan, '/routes', '/middleware', '/crons', '/queues', null, {
      ...baseOptions,
      auth: sqliteAuth,
      bindingNames: { d1: 'myapp_db' },
      migrationHandlerPath: '/resolved/migration-handler.mjs',
      migrations: [{ name: '001_init.sql', sql: 'select 1;' }],
    });

    expect(code).toContain('env["myapp_db"]');
    expect(code).not.toContain('env.DB != null');
    expect(code).toContain('return { ...env, DB: env["myapp_db"] };');
    expect(code).toContain('__createMigrationHandler(\n    __voidGetMigrationEnv(),');
    expect(code).toContain(
      'runVoidAuthMigrations(__voidGetMigrationEnv(), __voidAuthOptions, __voidAuthMigrationSchema)',
    );
  });
});
