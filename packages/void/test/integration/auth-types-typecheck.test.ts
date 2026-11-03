import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { generateAuthTypes } from '../../src/codegen/auth-types.ts';

const workspaceRoot = join(import.meta.dirname, '..', '..', '..', '..');
const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Typecheck `auth.ts` plus `handler.ts` in a kitchen-sink app that depends on
 * `void` only, the way pnpm lays it out: the app has no `better-auth` of its own.
 * An `auth.js` config is left out of `files`, as in a TS app without `allowJs`.
 */
function typecheck(
  authSource: string,
  handlerSource: string,
  paths: Record<string, Array<string>>,
  authFileName = 'auth.ts',
) {
  const root = mkdtempSync(join(workspaceRoot, 'playground/kitchen-sink/.tmp-auth-types-'));
  roots.push(root);
  const authFile = join(root, authFileName);
  const outDir = join(root, '.void');
  mkdirSync(outDir);
  writeFileSync(authFile, authSource);
  writeFileSync(join(outDir, 'auth.d.ts'), generateAuthTypes(authFile, outDir).dts);
  writeFileSync(join(root, 'handler.ts'), handlerSource);
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        paths,
      },
      files: [
        ...(authFileName.endsWith('.js') ? [] : [authFileName]),
        '.void/auth.d.ts',
        'handler.ts',
      ],
    }),
  );
  return spawnSync(
    process.execPath,
    [join(workspaceRoot, 'node_modules/typescript/lib/tsc.js'), '--project', root],
    { encoding: 'utf8' },
  );
}

describe('generated auth types in a consumer project', () => {
  it('types plugin fields and additionalFields on user, session, and context', () => {
    // Only auth.ts's own plugin import needs a mapping; the generated file
    // reaches better-auth through void/auth.
    const betterAuthPkg = join(workspaceRoot, 'packages/void/node_modules/better-auth');
    const adminTypes = join(betterAuthPkg, 'dist/plugins/admin/index.d.mts');
    const result = typecheck(
      'import { admin } from "better-auth/plugins/admin";\n' +
        'import { defineAuth } from "void/auth";\n' +
        'export default defineAuth(({ defaults }) => ({\n' +
        '  ...defaults,\n' +
        '  plugins: [admin()],\n' +
        '  user: { additionalFields: { plan: { type: "string", required: false } } },\n' +
        '}));\n',
      'import { defineHandler } from "void";\n' +
        'import { getUser, getSession, requireAuth } from "void/auth";\n' +
        'import { logger } from "void/log";\n' +
        'export const loader = defineHandler((c) => {\n' +
        '  const role: string | null | undefined = c.get("user")?.role;\n' +
        '  const plan: string | null | undefined = getUser()?.plan;\n' +
        '  const impersonatedBy: string | null | undefined = c.get("session")?.impersonatedBy;\n' +
        '  const sessionImpersonatedBy: string | null | undefined =\n' +
        '    getSession()?.session.impersonatedBy;\n' +
        '  const user = requireAuth(c);\n' +
        '  const requiredRole: string | null | undefined = user.role;\n' +
        '  const fields: Record<string, unknown> = user;\n' +
        '  logger.info("signed in", user);\n' +
        '  // @ts-expect-error not a field of the inferred user\n' +
        '  getUser()?.notAField;\n' +
        '  return { role, plan, impersonatedBy, sessionImpersonatedBy, requiredRole, fields };\n' +
        '});\n',
      { 'better-auth/plugins/admin': [adminTypes] },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('keeps fields every branch shares when auth.ts returns different shapes', () => {
    const result = typecheck(
      'import { defineAuth } from "void/auth";\n' +
        'const plan = { type: "string", required: true } as const;\n' +
        'const trialDays = { type: "number", required: true } as const;\n' +
        'const seats = { type: "number", required: true } as const;\n' +
        'export default defineAuth(({ defaults, env }) => {\n' +
        '  const trial = { ...defaults, user: { additionalFields: { plan, trialDays } } };\n' +
        '  const paid = { ...defaults, user: { additionalFields: { plan, seats } } };\n' +
        '  return env.TRIAL ? trial : paid;\n' +
        '});\n',
      'import { getUser } from "void/auth";\n' +
        'export const plan: string = getUser()!.plan;\n' +
        '// @ts-expect-error only one branch adds trialDays\n' +
        'export const trialDays: number = getUser()!.trialDays;\n',
      {},
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('keeps Better Auth base types when a JS auth config cannot be typed', () => {
    const result = typecheck(
      'import { defineAuth } from "void/auth";\n' +
        'export default defineAuth({\n' +
        '  user: { additionalFields: { plan: { type: "string", required: true } } },\n' +
        '});\n',
      'import { getUser, type AuthUser } from "void/auth";\n' +
        'export const email: string = getUser()!.email;\n' +
        '// @ts-expect-error not a key of the base user\n' +
        'export const key: keyof AuthUser = "notAField";\n' +
        '// @ts-expect-error not a field of the base user\n' +
        'export const plan: number = getUser()!.notAField;\n',
      {},
      'auth.js',
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
