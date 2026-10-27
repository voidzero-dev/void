import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { outro, log, cancel, isCancel, password, confirm } from '@voidzero-dev/vite-plus-prompts';
import { getToken } from './auth.ts';
import { PlatformClient } from './client.ts';
import { validateSecretValues } from './env-validation.ts';
import { printSuccess, formatCount, note } from './output.ts';
import { readDeploymentPlatform, readProjectConfig } from './project.ts';
import { getRequestedProjectSlug, resolveProjectBySlug } from './resolve-project.ts';
import type { SecretArgs } from './secret-args.ts';

type SecretEntry = { name: string; value: string };

type SecretBackend = {
  /** Named in the sync confirmation. */
  target: string;
  list(): Promise<Array<string>>;
  put(name: string, value: string): Promise<void>;
  sync(secrets: Array<SecretEntry>): Promise<void>;
  delete(name: string): Promise<void>;
};

export async function runSecretCommand(root: string, args: SecretArgs): Promise<void> {
  console.log();

  const backend = await resolveSecretBackend(root, args);

  if (args.action === 'list') {
    const names = await backend.list();
    if (names.length === 0) {
      outro('No secrets set.');
      return;
    }
    note(names.map((name) => `  ${name}`).join('\n'), 'Secrets');
    outro(formatCount(names.length, 'secret'));
    return;
  }

  if (args.action === 'put') {
    const value = args.value ?? (await readSecretValue());
    await validateSecretValues(root, [{ name: args.name, value }]);
    await backend.put(args.name, value);
    printSuccess(`Secret ${args.name} set.`);
    return;
  }

  if (args.action === 'sync') {
    const secrets = parseDotenvFile(args.file);
    if (secrets.length === 0) {
      log.warn('No secrets found in file.');
      outro('Nothing to sync.');
      return;
    }

    await validateSecretValues(root, secrets);

    log.info(`Found ${formatCount(secrets.length, 'secret')}:`);
    for (const s of secrets) {
      log.message(`  ${s.name}`);
    }

    const proceed = await confirm({
      message: `This will overwrite ${formatCount(secrets.length, 'secret')} in the ${backend.target}. Continue?`,
    });
    if (isCancel(proceed) || !proceed) {
      cancel('Secret sync cancelled.');
      process.exit(0);
    }

    await backend.sync(secrets);
    printSuccess(`Synced ${formatCount(secrets.length, 'secret')}.`);
    return;
  }

  await backend.delete(args.name);
  printSuccess(`Secret ${args.name} deleted.`);
}

async function resolveSecretBackend(root: string, args: SecretArgs): Promise<SecretBackend> {
  const platform = readDeploymentPlatform(root);
  if (platform === 'cloudflare') {
    return resolveCloudflareSecretBackend(root, args);
  }
  if (platform === 'none') {
    throw new Error('secret: Deployment is disabled. Run `void init` to choose a platform.');
  }

  const token = getToken(root);
  if (!token) {
    log.error('Not logged in. Run `void account login` first.');
    process.exit(1);
  }

  const client = new PlatformClient(token, { root });
  const requestedProjectName = getRequestedProjectSlug({ projectSlug: args.projectName });
  let projectId: string;
  if (requestedProjectName) {
    const projects = await client.listProjects();
    const config = resolveProjectBySlug(projects, requestedProjectName);
    if (!config) {
      throw new Error(`secret: No project found with slug '${requestedProjectName}'.`);
    }
    projectId = config.projectId;
  } else {
    const config = readProjectConfig(root);
    if (!config) {
      throw new Error(
        'No linked project found. Run `void project link`, `void deploy`, or pass --project <name>.',
      );
    }
    projectId = config.projectId;
  }

  return {
    target: 'remote environment',
    list: async () => (await client.listSecrets(projectId)).map((s) => s.name),
    put: async (name, value) => {
      await client.setSecret(projectId, name, value);
    },
    sync: async (secrets) => {
      for (const s of secrets) {
        await client.setSecret(projectId, s.name, s.value);
        log.step(`Set ${s.name}`);
      }
    },
    delete: async (name) => {
      await client.deleteSecret(projectId, name);
    },
  };
}

async function resolveCloudflareSecretBackend(
  root: string,
  args: SecretArgs,
): Promise<SecretBackend> {
  if (args.projectName) {
    throw new Error(
      'secret: --project selects a Void platform project and is not used for direct Cloudflare apps.',
    );
  }
  const {
    deleteCloudflareSecret,
    listCloudflareSecrets,
    putCloudflareSecret,
    resolveCloudflareOperationContext,
    syncCloudflareSecrets,
  } = await import('./cloudflare-operations.ts');
  const context = resolveCloudflareOperationContext(root);
  return {
    target: 'Cloudflare Worker',
    list: () => listCloudflareSecrets(context),
    put: (name, value) => putCloudflareSecret(context, name, value),
    sync: (secrets) => syncCloudflareSecrets(context, secrets),
    delete: (name) => deleteCloudflareSecret(context, name),
  };
}

const SECRET_KEY_RE = /^[A-Z][A-Z0-9_]*$/;
const UTF8_BOM = '\uFEFF';

// Reads the file with Node's dotenv grammar, the same one `.env` loading uses,
// but calls `parseEnv` directly: shared/dotenv.ts would expand `$VAR`, and a
// `$` inside a secret value must stay literal.
export function parseDotenvFile(filePath: string): Array<{ name: string; value: string }> {
  const secrets: Array<{ name: string; value: string }> = [];

  const raw = readFileSync(filePath, 'utf-8');
  // parseEnv keeps a leading BOM as part of the first key name.
  const text = raw.startsWith(UTF8_BOM) ? raw.slice(UTF8_BOM.length) : raw;
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (value === undefined) {
      continue;
    }
    if (!SECRET_KEY_RE.test(key)) {
      throw new Error(
        `secret: Invalid secret name '${key}'. Use uppercase letters, digits, and underscores.`,
      );
    }

    secrets.push({ name: key, value });
  }

  return secrets;
}

async function readSecretValue(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Array<Buffer> = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const value = Buffer.concat(chunks).toString('utf-8');
    if (value.length === 0) {
      throw new Error('Secret value is required.');
    }
    return value;
  }

  const result = await password({
    message: 'Enter secret value:',
    mask: '*',
  });

  if (isCancel(result) || typeof result === 'symbol') {
    cancel('Secret command cancelled.');
    process.exit(0);
  }

  const value = result ?? '';
  if (value.length === 0) {
    throw new Error('Secret value is required.');
  }
  return value;
}
