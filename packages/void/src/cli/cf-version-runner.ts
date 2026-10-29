import { execFile, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getWorkerConfigPath, readBuildOutput } from '@cloudflare/build-output-utils';
import type {
  CloudflareCommandResult,
  CloudflareCommandRunner,
  CloudflareOperation,
  CloudflareVersionActivationOptions,
} from '@void/deploy-cloudflare';
import { isRecord as record } from '@void/deploy-core';
import { dirname, join } from 'pathslash';
import type { CfBuildOutput } from './cf-build-output.ts';
import {
  CF_VERSION_SOURCE_MAX_OUTPUT_BYTES,
  readCfUploadOutput,
  safePositional,
} from './cf-command-values.ts';
import { migrateBuiltWranglerConfig } from './cf-config-migrate.ts';
import { getCfCliVersion } from './cf-user-agent.ts';
import {
  isSecretBindingType,
  uploadPinnedCloudflareVersion,
  type CfCommand,
} from './cf-version-api.ts';
import { publishCloudflareWorkerSettings } from './cf-worker-settings.ts';
import { isCleanCloudflareExit } from './cloudflare-process.ts';

function failed(message: string): CloudflareCommandResult {
  return { status: 1, stdout: '', stderr: message };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/** Existing-Worker handoffs retain their separate link and binding checks. */
export function createActiveSecretPinner(options: {
  output: CfBuildOutput | null;
  handoffPending: boolean;
  requiredNames: ReadonlyArray<string>;
  explicitNames?: ReadonlyArray<string>;
}): CloudflareVersionActivationOptions['pinActiveSecrets'] {
  const { output } = options;
  if (!output || options.handoffPending) {
    return undefined;
  }
  return (activeVersionId, bindings) =>
    pinActiveWorkerSecrets({
      output,
      activeVersionId,
      bindings,
      requiredNames: options.requiredNames,
      explicitNames: options.explicitNames,
    });
}

/** Record the live secret source for the version-aware API uploader. */
export async function pinActiveWorkerSecrets(options: {
  output: CfBuildOutput;
  activeVersionId: string;
  bindings: ReadonlyArray<{ name: string; type: 'secret_text' | 'secret_key' }>;
  requiredNames: ReadonlyArray<string>;
  explicitNames?: ReadonlyArray<string>;
}): Promise<boolean> {
  const { activeVersionId, bindings, requiredNames, explicitNames = [] } = options;
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(activeVersionId)) {
    return false;
  }
  const secretNames = new Set(bindings.map((binding) => binding.name));
  const explicit = new Set(explicitNames);
  if (
    bindings.some((binding) => !safePositional(binding.name)) ||
    secretNames.size !== bindings.length
  ) {
    return false;
  }
  if (requiredNames.some((name) => !secretNames.has(name) && !explicit.has(name))) {
    return false;
  }
  const path = getWorkerConfigPath(options.output.directory);
  const worker = parseJson(readFileSync(path, 'utf8'));
  if (!record(worker) || (worker.env !== undefined && !record(worker.env))) {
    return false;
  }
  const env = (worker.env ?? {}) as Record<string, unknown>;
  for (const [name, value] of Object.entries(env)) {
    if (
      record(value) &&
      isSecretBindingType(value.type) &&
      !secretNames.has(name) &&
      !explicit.has(name)
    ) {
      return false;
    }
  }
  for (const { name } of bindings) {
    if (explicit.has(name)) {
      continue;
    }
    const current = env[name];
    if (current !== undefined && (!record(current) || !isSecretBindingType(current.type))) {
      return false;
    }
  }
  // The scripts upload API rejects a UUID inheritance source (10057). The
  // version-aware API accepts one, so leave cf's Build Output untouched and
  // carry the source only to that uploader.
  options.output.activeSecrets = { versionId: activeVersionId, bindings: [...bindings] };
  return true;
}

/** Prevent cf's prebuilt uploader from creating a resource as a side effect. */
export function createCfResourceVerifier(options: {
  configPath: string;
  runCf: CfCommand;
  runWrangler: CloudflareCommandRunner;
  verifyCompatibilityRunner: () => boolean;
}): (directory: string) => Promise<CloudflareCommandResult> {
  return async (directory) => {
    const worker = parseJson(readFileSync(getWorkerConfigPath(directory), 'utf8'));
    if (!record(worker) || (worker.env !== undefined && !record(worker.env))) {
      return failed('The Cloudflare Worker bindings were not readable.');
    }
    for (const [bindingName, value] of Object.entries(worker.env ?? {})) {
      if (!record(value)) {
        return failed(`Cloudflare binding ${bindingName} was not readable.`);
      }
      const identifier = (field: string) => (safePositional(value[field]) ? value[field] : null);
      if (value.type === 'kv' || value.type === 'd1' || value.type === 'flagship') {
        if (!identifier('id')) {
          return failed(
            `Cloudflare binding ${bindingName} has no ID; refusing automatic provisioning.`,
          );
        }
        continue;
      }
      if (value.type === 'queue') {
        const name = identifier('name');
        if (!name) {
          return failed(`Cloudflare Queue binding ${bindingName} has no name.`);
        }
        if (!options.verifyCompatibilityRunner()) {
          return failed('The Cloudflare resource verifier changed during deployment.');
        }
        const found = await Promise.resolve(
          options.runWrangler(
            { type: 'queues.info', name, configPath: options.configPath },
            {
              capture: true,
            },
          ),
        );
        if (!isCleanCloudflareExit(found) || !record(found.data) || found.data.name !== name) {
          return failed(
            `Cloudflare Queue ${name} is unavailable; refusing automatic provisioning.`,
          );
        }
        continue;
      }
      const resource =
        value.type === 'r2'
          ? {
              kind: 'R2 bucket',
              field: 'name',
              command: ['r2', 'buckets', 'get'],
              response: 'name',
            }
          : value.type === 'dispatch-namespace'
            ? {
                kind: 'dispatch namespace',
                field: 'namespace',
                command: ['workers-for-platforms', 'dispatch-namespaces', 'get'],
                response: 'namespace_name',
              }
            : value.type === 'ai-search-namespace'
              ? {
                  kind: 'AI Search namespace',
                  field: 'namespace',
                  command: ['ai-search', 'namespace', 'get'],
                  response: 'name',
                }
              : value.type === 'agent-memory'
                ? {
                    kind: 'Agent Memory namespace',
                    field: 'namespace',
                    command: ['agent-memory', 'get-namespace'],
                    response: 'name',
                  }
                : null;
      if (!resource) {
        continue;
      }
      const name = identifier(resource.field);
      if (!name) {
        return failed(`Cloudflare ${resource.kind} binding ${bindingName} has no name.`);
      }
      const jurisdiction = value.type === 'r2' ? value.jurisdiction : undefined;
      if (jurisdiction !== undefined && !safePositional(jurisdiction)) {
        return failed(`Cloudflare R2 binding ${bindingName} has an invalid jurisdiction.`);
      }
      const result = await options.runCf(
        [
          ...resource.command,
          name,
          ...(jurisdiction ? ['--cf-r2-jurisdiction', jurisdiction] : []),
        ],
        { cwd: directory, capture: true },
      );
      const body = result.data ?? parseJson(result.stdout);
      if (!isCleanCloudflareExit(result) || !record(body) || body[resource.response] !== name) {
        return failed(
          `Cloudflare ${resource.kind} ${name} is unavailable; refusing automatic provisioning.`,
        );
      }
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

/** Run the pinned package-local cf binary with Void's existing Cloudflare session. */
export function createCfCommand(options: {
  accountId: string;
  apiBaseUrl: string;
  env: (accountId: string, apiBaseUrl: string) => NodeJS.ProcessEnv;
  verifyUploader: () => boolean;
}): CfCommand {
  const cf = join(dirname(fileURLToPath(import.meta.resolve('cf/package.json'))), 'bin', 'cf');
  return async (args, run) => {
    if (!options.verifyUploader()) {
      return failed('The Cloudflare uploader changed during deployment.');
    }
    // Keep credentials in the verified CLI even if cwd resolves another cf.
    const env: NodeJS.ProcessEnv = {
      ...options.env(options.accountId, options.apiBaseUrl),
      CF_DELEGATION: '1',
      CLI_VERSION: getCfCliVersion(),
      // Void owns the terminal UI. Keep cf's notices, progress, and telemetry out
      // of successful deploys; retain its complete output for error diagnosis.
      CF_QUIET: '1',
      CF_NO_OSC_PROGRESS: '1',
      CF_SEND_TELEMETRY: 'false',
    };
    if (env.HTTP_PROXY || env.HTTPS_PROXY || env.http_proxy || env.https_proxy) {
      env.NODE_USE_ENV_PROXY = '1';
    }
    return await new Promise<CloudflareCommandResult>((resolve) => {
      const bounded = run.timeoutMs !== undefined;
      const processGroup = bounded && process.platform !== 'win32';
      const child = spawn(process.execPath, [cf, ...args], {
        cwd: run.cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: processGroup,
      });
      const stdout: Array<Buffer> = [];
      const stderr: Array<Buffer> = [];
      let bytes = 0;
      let error: string | null = null;
      const stop = () => {
        if (processGroup && child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') {
              child.kill('SIGKILL');
            }
          }
        } else if (bounded && process.platform === 'win32' && child.pid) {
          execFile(
            'taskkill',
            ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, timeout: 10_000 },
            (cause) => {
              if (cause) {
                child.kill('SIGKILL');
              }
            },
          );
        } else {
          child.kill('SIGKILL');
        }
      };
      const interrupted = () => {
        error = 'Cloudflare command interrupted.';
        stop();
      };
      if (bounded) {
        process.on('SIGINT', interrupted);
        process.on('SIGTERM', interrupted);
      }
      const timer =
        run.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              error = 'Cloudflare command timed out.';
              stop();
            }, run.timeoutMs);
      // Version lists contain full Worker records. Preserve the previous 256 MiB
      // limit while letting Void's spinner animate during the network operation.
      const collect = (chunks: Array<Buffer>, chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > (run.maxOutputBytes ?? 256 * 1024 * 1024)) {
          error = 'Cloudflare command output exceeded its verified limit.';
          stop();
        } else {
          chunks.push(chunk);
        }
      };
      child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
      child.on('error', (cause: Error) => {
        error = cause.message;
      });
      child.on('close', (status, signal) => {
        clearTimeout(timer);
        if (bounded) {
          process.off('SIGINT', interrupted);
          process.off('SIGTERM', interrupted);
        }
        const output = Buffer.concat(stdout).toString('utf8');
        const diagnostic = Buffer.concat(stderr).toString('utf8');
        const completed = typeof status === 'number' && signal == null && error == null;
        const code = completed
          ? (output + '\n' + diagnostic).match(/\[(?:code:\s*)?(\d{4,})\]/)?.[1]
          : undefined;
        // The pinned cf uploader replaces its missing-Worker API error with a
        // local diagnostic and drops code 10007. Decode it at this CLI boundary
        // so the activation protocol can safely select its first-deploy path.
        const missingUploadTarget =
          completed &&
          status !== 0 &&
          code === undefined &&
          args[0] === 'workers' &&
          args[1] === 'versions' &&
          args[2] === 'create' &&
          (output + '\n' + diagnostic)
            .replace(/\s+/g, ' ')
            .includes('You cannot upload a new version of a Worker that does not yet exist.');
        resolve({
          status: typeof status === 'number' ? status : 1,
          stdout: output,
          stderr: diagnostic,
          ...(code ? { errorCode: Number(code) } : {}),
          ...(missingUploadTarget ? { failure: 'not-found' as const } : {}),
          ...(completed && status !== 0
            ? { errors: [{ message: output + '\n' + diagnostic }] }
            : {}),
          signal,
          error,
        });
      });
    });
  };
}

/**
 * Adapt the stable activation protocol to cf's prebuilt and API commands.
 * The protocol keeps the existing preview, inheritance, traffic and rollback checks.
 */
export function createCfVersionRunner(options: {
  output: CfBuildOutput;
  workerName: string;
  runCf: CfCommand;
  verifyResources: (directory: string) => Promise<CloudflareCommandResult>;
  pinnedUpload?: {
    accountId: string;
    apiBaseUrl: string;
    getToken: () => Promise<string | null>;
    verifyUploader: () => boolean;
  };
}): CloudflareCommandRunner {
  const { output, workerName, runCf } = options;
  const run = async (args: Array<string>, capture: boolean, cwd = output.directory) => {
    const result = await runCf(args, { cwd, capture });
    return { ...result, data: result.data ?? parseJson(result.stdout) };
  };
  const uploadedResult = (result: CloudflareCommandResult): CloudflareCommandResult => {
    if (!isCleanCloudflareExit(result)) {
      return result;
    }
    if (record(result.data) && typeof result.data.versionId === 'string') {
      return result;
    }
    const { versionId, previewUrl, workersDevUrl } = readCfUploadOutput(result.stdout);
    return {
      ...result,
      data: versionId
        ? {
            versionId,
            ...(previewUrl ? { previewUrl } : {}),
            ...(workersDevUrl ? { workersDevUrl } : {}),
          }
        : undefined,
    };
  };
  const verifyResources = async (directory: string) => {
    try {
      return await options.verifyResources(directory);
    } catch {
      return failed('Cloudflare resources could not be verified before upload.');
    }
  };
  /** Return a failure when the upload target drifted or its resources are not verified. */
  const checkUploadTarget = async (
    operation: Extract<CloudflareOperation, { type: 'versions.upload' | 'worker.deploy' }>,
    targetChanged: string,
  ): Promise<CloudflareCommandResult | null> => {
    if (
      operation.workerName !== workerName ||
      (operation.assetsDirectory !== undefined &&
        operation.assetsDirectory !== output.assetsDirectory)
    ) {
      return failed(targetChanged);
    }
    const verified = await verifyResources(output.directory);
    return isCleanCloudflareExit(verified) ? null : verified;
  };

  const uploadPinnedVersion = async (
    operation: Extract<CloudflareOperation, { type: 'versions.upload' | 'worker.deploy' }>,
    atomic: boolean,
  ) => {
    if (!options.pinnedUpload || !options.pinnedUpload.verifyUploader()) {
      return failed('The version-aware Cloudflare uploader is unavailable.');
    }
    const token = await options.pinnedUpload.getToken();
    if (!token) {
      return failed('Cloudflare session has no bearer for version-aware upload.');
    }
    try {
      const version = await uploadPinnedCloudflareVersion({
        output,
        accountId: options.pinnedUpload.accountId,
        apiBaseUrl: options.pinnedUpload.apiBaseUrl,
        workerName,
        token,
        ...(operation.message ? { message: operation.message } : {}),
        ...(operation.secretsFilePath ? { secretsFilePath: operation.secretsFilePath } : {}),
        atomic,
        verifyUploader: options.pinnedUpload.verifyUploader,
        runCf,
      });
      const preview = version.urls.find((url) => /^https:\/\//.test(url));
      return {
        status: 0,
        stdout: '',
        data: { versionId: version.id, ...(preview ? { previewUrl: preview } : {}) },
        stderr: '',
      };
    } catch (cause) {
      return failed(cause instanceof Error ? cause.message : 'Cloudflare version upload failed.');
    }
  };

  return async (operation, command) => {
    if (operation.type === 'deployments.status') {
      const result = await run(['workers', 'deployments', 'list', '--worker', workerName], true);
      if (!isCleanCloudflareExit(result)) {
        return result;
      }
      const body = result.data;
      const deployments = record(body) ? body.deployments : undefined;
      if (Array.isArray(deployments) && deployments.length === 0) {
        return { ...failed('The Cloudflare Worker has no deployments.'), errorCode: 10007 };
      }
      if (!Array.isArray(deployments) || !record(deployments[0])) {
        return failed('The Cloudflare Worker deployment was not readable.');
      }
      return { ...result, data: deployments[0] };
    }

    if (operation.type === 'versions.list') {
      const pageSize = 10;
      const readPage = async (page: number) => {
        const result = await run(
          [
            'workers',
            'versions',
            'list',
            '--worker-id',
            workerName,
            '--per-page',
            String(pageSize),
            '--page',
            String(page),
          ],
          true,
        );
        const body = result.data;
        return {
          result,
          versions:
            Array.isArray(body) &&
            body.length <= pageSize &&
            body.every(
              (item) =>
                record(item) && typeof item.id === 'string' && Number.isSafeInteger(item.number),
            ) &&
            new Set(body.map((item) => item.number)).size === body.length
              ? body
              : null,
        };
      };
      const first = await readPage(1);
      if (!isCleanCloudflareExit(first.result)) {
        return first.result;
      }
      if (!first.versions) {
        return failed('The Cloudflare Worker version list was not readable.');
      }
      const versions = [...first.versions];
      if (versions.length === pageSize) {
        const second = await readPage(2);
        if (!isCleanCloudflareExit(second.result)) {
          return second.result;
        }
        if (!second.versions) {
          return failed('The Cloudflare Worker version history was not readable.');
        }
        if (second.versions.length > 0) {
          const firstNumbers = versions.map((item) => item.number as number);
          const secondNumbers = second.versions.map((item) => item.number as number);
          if (Math.min(...secondNumbers) > Math.max(...firstNumbers)) {
            versions.push(...second.versions);
            let last = Math.max(...secondNumbers);
            for (let page = 3; page <= 1000 && second.versions.length === pageSize; page++) {
              const next = await readPage(page);
              if (!isCleanCloudflareExit(next.result)) {
                return next.result;
              }
              if (!next.versions) {
                return failed('The Cloudflare Worker version history was not readable.');
              }
              if (next.versions.length === 0) {
                break;
              }
              const numbers = next.versions.map((item) => item.number as number);
              if (Math.min(...numbers) <= last) {
                return failed('The Cloudflare Worker version history changed during inspection.');
              }
              versions.push(...next.versions);
              last = Math.max(...numbers);
              if (next.versions.length < pageSize) {
                break;
              }
              if (page === 1000) {
                return failed('The Cloudflare Worker version history is too large to verify.');
              }
            }
          } else if (Math.max(...secondNumbers) >= Math.min(...firstNumbers)) {
            return failed('The Cloudflare Worker version history changed during inspection.');
          }
        }
      }
      return {
        ...first.result,
        data: versions.sort((a, b) => (a.number as number) - (b.number as number)).slice(-10),
      };
    }

    if (operation.type === 'versions.view') {
      const args = [
        'workers',
        'versions',
        'get',
        operation.versionId,
        '--worker-id',
        workerName,
        ...(operation.includeSource ? ['--include', 'modules'] : []),
      ];
      const called = operation.includeSource
        ? await runCf(args, {
            cwd: output.directory,
            capture: true,
            timeoutMs: 30_000,
            maxOutputBytes: CF_VERSION_SOURCE_MAX_OUTPUT_BYTES,
          })
        : await run(args, true);
      const result = { ...called, data: called.data ?? parseJson(called.stdout) };
      if (!isCleanCloudflareExit(result)) {
        return result;
      }
      const version = result.data;
      if (!record(version) || version.id !== operation.versionId) {
        return failed('The Cloudflare Worker version was not readable.');
      }
      // Cloudflare omits `bindings` for a version that has none.
      const bindings = version.bindings === undefined ? [] : version.bindings;
      if (!Array.isArray(bindings)) {
        return failed('The Cloudflare Worker version was not readable.');
      }
      return {
        ...result,
        data: { ...version, bindings, resources: { bindings } },
      };
    }

    if (operation.type === 'versions.upload') {
      const blocked = await checkUploadTarget(
        operation,
        'The Cloudflare version upload target changed.',
      );
      if (blocked) {
        return blocked;
      }
      if (output.activeSecrets) {
        return uploadPinnedVersion(operation, false);
      }
      return uploadedResult(
        await run(
          [
            'workers',
            'versions',
            'create',
            '--prebuilt',
            // One argv item, so a message that starts with "-" is not read as a flag.
            ...(operation.message ? [`--message=${operation.message}`] : []),
            ...(operation.secretsFilePath ? ['--secrets-file', operation.secretsFilePath] : []),
            ...(operation.previewAlias ? ['--preview-alias', operation.previewAlias] : []),
          ],
          command.capture,
        ),
      );
    }

    if (operation.type === 'versions.deploy') {
      if (operation.workerName !== workerName) {
        return failed('The Cloudflare deployment target changed.');
      }
      const parsed = operation.versions.map(({ versionId, percentage }) => ({
        version_id: versionId,
        percentage,
      }));
      if (
        !parsed.every(
          (version) =>
            /^[0-9a-f-]{36}$/i.test(version.version_id) && Number.isFinite(version.percentage),
        )
      ) {
        return failed('The Cloudflare deployment versions were invalid.');
      }
      if (
        parsed.length === 0 ||
        new Set(parsed.map((item) => item.version_id)).size !== parsed.length ||
        parsed.some((item) => item.percentage < 0 || item.percentage > 100) ||
        Math.abs(parsed.reduce((sum, item) => sum + item.percentage, 0) - 100) > 0.001
      ) {
        return failed('The Cloudflare deployment percentages were invalid.');
      }
      return run(
        [
          'workers',
          'deployments',
          'create',
          '--worker',
          workerName,
          '--strategy',
          'percentage',
          '--versions',
          JSON.stringify(parsed),
          ...(operation.message
            ? [
                '--body',
                JSON.stringify({
                  strategy: 'percentage',
                  versions: parsed,
                  annotations: { 'workers/message': operation.message },
                }),
              ]
            : []),
          ...(operation.bypassDeploymentChecks ? ['--bypass-deployment-checks'] : []),
        ],
        command.capture,
      );
    }

    if (operation.type === 'worker.deploy') {
      const blocked = await checkUploadTarget(
        operation,
        'The Cloudflare bootstrap target changed.',
      );
      if (blocked) {
        return blocked;
      }
      if (output.activeSecrets) {
        return uploadPinnedVersion(operation, true);
      }
      return uploadedResult(
        await run(
          [
            'deploy',
            '--prebuilt',
            // One argv item, so a message that starts with "-" is not read as a flag.
            ...(operation.message ? [`--message=${operation.message}`] : []),
            ...(operation.secretsFilePath ? ['--secrets-file', operation.secretsFilePath] : []),
          ],
          command.capture,
        ),
      );
    }

    if (operation.type === 'triggers.deploy') {
      const configPath = operation.configPath;
      if (!configPath || operation.workerName !== workerName) {
        return failed('The Cloudflare trigger target changed.');
      }
      const raw = parseJson(readFileSync(configPath, 'utf8'));
      if (!record(raw) || raw.name !== workerName) {
        return failed('The Cloudflare trigger snapshot was not readable.');
      }
      const directory = mkdtempSync(join(tmpdir(), 'void-cf-triggers-'));
      try {
        cpSync(join(output.directory, '.cloudflare'), join(directory, '.cloudflare'), {
          recursive: true,
        });
        const workerPath = getWorkerConfigPath(directory);
        const worker = parseJson(readFileSync(workerPath, 'utf8'));
        if (!record(worker)) {
          return failed('The private Cloudflare Worker config was not readable.');
        }
        const migrated = migrateBuiltWranglerConfig({
          ...raw,
          compatibility_date: worker.compatibilityDate,
        }).worker;
        if (!migrated) {
          return failed('The Cloudflare trigger snapshot was not convertible.');
        }
        const next = migrated.triggers ?? [];
        const previous = Array.isArray(worker.triggers) ? worker.triggers : [];
        const preserveRoutes = raw.routes === undefined && raw.route === undefined;
        const preserveEmail = raw.addresses === undefined;
        worker.triggers = [
          ...next,
          ...(preserveRoutes
            ? previous.filter((trigger) => record(trigger) && trigger.type === 'fetch')
            : []),
          ...(preserveEmail
            ? previous.filter((trigger) => record(trigger) && trigger.type === 'email')
            : []),
        ];
        // Workflow schedules and settings live on exports, outside `triggers`.
        // Replay the snapshot even during compensation or removal, when the
        // candidate's workflow declarations describe the version being left.
        for (const field of ['env', 'exports'] as const) {
          const previous = record(worker[field]) ? worker[field] : {};
          worker[field] = {
            ...Object.fromEntries(
              Object.entries(previous).filter(
                ([, value]) => !record(value) || value.type !== 'workflow',
              ),
            ),
            ...migrated[field],
          };
        }
        if (!preserveRoutes) {
          worker.domains = migrated.domains ?? [];
        }
        if (typeof raw.workers_dev === 'boolean') {
          worker.workersDev = raw.workers_dev;
        }
        if (typeof raw.preview_urls === 'boolean') {
          worker.previewUrls = raw.preview_urls;
        }
        writeFileSync(workerPath, JSON.stringify(worker), { mode: 0o600 });
        await readBuildOutput(directory);
        const verified = await verifyResources(directory);
        if (!isCleanCloudflareExit(verified)) {
          return verified;
        }
        const deployed = await run(
          ['workers', 'triggers', 'deploy', '--prebuilt'],
          command.capture,
          directory,
        );
        if (
          isCleanCloudflareExit(deployed) &&
          (raw.observability !== undefined || raw.logpush !== undefined)
        ) {
          const credentials = options.pinnedUpload;
          if (!credentials || !credentials.verifyUploader()) {
            return failed('The Cloudflare settings publisher is unavailable.');
          }
          try {
            const token = await credentials.getToken();
            if (!token || !credentials.verifyUploader()) {
              return failed('Cloudflare session is unavailable for publishing Worker settings.');
            }
            await publishCloudflareWorkerSettings({
              apiBaseUrl: credentials.apiBaseUrl,
              accountId: credentials.accountId,
              workerName,
              observability: raw.observability,
              logpush: raw.logpush,
              headers: { Authorization: `Bearer ${token}` },
            });
          } catch (cause) {
            return failed(
              cause instanceof Error ? cause.message : 'Cloudflare settings update failed.',
            );
          }
        }
        return deployed;
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }

    if (operation.type === 'queues.consumer.remove') {
      const queueName = operation.queueName;
      if (!queueName || operation.workerName !== workerName) {
        return failed('The Cloudflare Queue consumer target changed.');
      }
      const queues = await run(['queues', 'list'], true);
      if (!isCleanCloudflareExit(queues)) {
        return queues;
      }
      const allQueues = queues.data;
      if (!Array.isArray(allQueues)) {
        return failed('The Cloudflare Queue list was not readable.');
      }
      const queue = allQueues.find((item) => record(item) && item.queue_name === queueName);
      if (!record(queue) || typeof queue.queue_id !== 'string') {
        return failed(`Cloudflare Queue ${queueName} was not found.`);
      }
      const consumers = await run(
        ['queues', 'consumers', 'list', '--queue-id', queue.queue_id],
        true,
      );
      if (!isCleanCloudflareExit(consumers)) {
        return consumers;
      }
      const allConsumers = consumers.data;
      if (!Array.isArray(allConsumers)) {
        return failed('The Cloudflare Queue consumers were not readable.');
      }
      const matching: Array<Record<string, unknown>> = [];
      for (const item of allConsumers) {
        if (!record(item)) {
          return failed('The Cloudflare Queue consumers were not readable.');
        }
        const name = item.script_name ?? item.script;
        if (
          (item.script_name !== undefined && !safePositional(item.script_name)) ||
          (item.script !== undefined && !safePositional(item.script)) ||
          (item.script_name !== undefined &&
            item.script !== undefined &&
            item.script_name !== item.script) ||
          (item.type === 'worker' && name === undefined)
        ) {
          return failed('The Cloudflare Queue consumer Worker identity was ambiguous.');
        }
        if (name === workerName) {
          matching.push(item);
        }
      }
      if (matching.length === 0) {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (
        matching.length !== 1 ||
        !safePositional(matching[0].consumer_id) ||
        (matching[0].type !== undefined && matching[0].type !== 'worker')
      ) {
        return failed('The Cloudflare Queue consumer identity was ambiguous.');
      }
      return run(
        [
          'queues',
          'consumers',
          'delete',
          matching[0].consumer_id,
          '--queue-id',
          queue.queue_id,
          '--force',
        ],
        command.capture,
      );
    }

    return failed(`Unsupported Cloudflare activation operation: ${operation.type}`);
  };
}
