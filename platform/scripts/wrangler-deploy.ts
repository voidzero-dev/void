import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { platformVersionDeployArgs } from './platform-version.ts';

const EMAIL_SIGNING_SECRET = 'EMAIL_SIGNING_SECRET';
const DASHBOARD_DIRECTORY = fileURLToPath(new URL('../packages/dashboard', import.meta.url));
const EMAIL_WORKER_DIRECTORIES = new Set(
  ['api', 'email-gateway', 'proxy'].map((name) =>
    fileURLToPath(new URL(`../packages/${name}`, import.meta.url)),
  ),
);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    build: {
      type: 'boolean',
    },
    env: {
      short: 'e',
      type: 'string',
    },
    config: {
      short: 'c',
      type: 'string',
    },
    'dry-run': {
      type: 'boolean',
    },
    outdir: {
      type: 'string',
    },
    outfile: {
      type: 'string',
    },
    preflight: {
      type: 'boolean',
    },
  },
  strict: false,
});

const env = values.env;

if (env !== 'production' && env !== 'staging') {
  console.error(
    'wrangler deploy must be called with an explicit environment: --env production or --env staging.',
  );
  process.exit(1);
}

function readEmailSigningSecret(): string {
  const value = process.env[EMAIL_SIGNING_SECRET];
  if (!value) {
    console.error(`${EMAIL_SIGNING_SECRET} is required for ${env} platform deployments.`);
    process.exit(1);
  }
  if (value !== value.trim() || (Buffer as BufferConstructor).byteLength(value, 'utf8') < 32) {
    console.error(
      `${EMAIL_SIGNING_SECRET} must have at least 32 bytes and no leading or trailing whitespace.`,
    );
    process.exit(1);
  }
  return value;
}

const subprocessEnv = { ...process.env };
delete subprocessEnv[EMAIL_SIGNING_SECRET];

if (values.preflight === true) {
  readEmailSigningSecret();
  console.log(`Platform deployment preflight passed for ${env}.`);
  process.exit(0);
}

const wranglerArgs = process.argv.slice(2).filter((arg) => arg !== '--build');
const usesEmailSigningSecret =
  EMAIL_WORKER_DIRECTORIES.has(process.cwd()) &&
  process.env.WRANGLER_CI_OVERRIDE_NAME === undefined &&
  positionals.length === 0 &&
  Object.keys(values).every((option) =>
    ['build', 'env', 'dry-run', 'outdir', 'outfile'].includes(option),
  );
const emailSigningSecret = usesEmailSigningSecret ? readEmailSigningSecret() : undefined;

if (values.build === true) {
  const build = spawnSync('vp', ['build'], {
    env: {
      ...subprocessEnv,
      CLOUDFLARE_ENV: process.env.CLOUDFLARE_ENV ?? env,
    },
    stdio: 'inherit',
  });

  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
}

let secretsDirectory: string | undefined;
try {
  let deployArgs = ['deploy', ...wranglerArgs];
  if (process.cwd() === DASHBOARD_DIRECTORY) {
    const generatedConfig = join('dist', 'ssr', 'wrangler.json');
    const built = JSON.parse(readFileSync(generatedConfig, 'utf8')) as {
      targetEnvironment?: string;
      name?: string;
    };
    if (built.targetEnvironment !== env || !built.name) {
      throw new Error(`Dashboard build does not target the ${env} environment.`);
    }
    const withoutEnvironment = wranglerArgs.filter(
      (arg, index) =>
        arg !== '--env' &&
        arg !== '-e' &&
        !(index > 0 && ['--env', '-e'].includes(wranglerArgs[index - 1])) &&
        !arg.startsWith('--env='),
    );
    deployArgs = [
      'deploy',
      ...withoutEnvironment,
      '--config',
      generatedConfig,
      '--autoconfig=false',
    ];
  }
  if (emailSigningSecret) {
    secretsDirectory = mkdtempSync(join(tmpdir(), 'void-platform-secrets-'));
    const secretsPath = join(secretsDirectory, 'secrets.json');
    writeFileSync(secretsPath, JSON.stringify({ [EMAIL_SIGNING_SECRET]: emailSigningSecret }), {
      mode: 0o600,
    });
    deployArgs.push('--secrets-file', secretsPath);
  }
  deployArgs.push(...platformVersionDeployArgs(process.cwd(), values.config !== undefined));

  const deploy = spawnSync('wrangler', deployArgs, {
    env: subprocessEnv,
    stdio: 'inherit',
  });
  process.exitCode = deploy.status ?? 1;
} finally {
  if (secretsDirectory) {
    rmSync(secretsDirectory, { force: true, recursive: true });
  }
}
