import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'jsonc-parser';
import { dirname, join, relative } from 'pathslash';
import { setJsoncValue } from './config.ts';

export type CloudflareFrameworkDeployConfig = Readonly<{
  configPath: string;
  deployPointerPath: string;
  name: string;
  accountId: string;
  main: string;
  assetsDirectory: string;
  compatibilityDate: string;
  compatibilityFlags?: ReadonlyArray<string>;
  assetsIgnore?: ReadonlyArray<string>;
  crons?: ReadonlyArray<string>;
  requiredSecrets?: ReadonlyArray<string>;
  versionMetadataBinding?: string;
  ai?: Readonly<{ binding: string; gateway?: string }>;
  /** Cloudflare Images binding for `env.IMAGES` reads; an authored `images` entry is kept. */
  images?: Readonly<{ binding: string }>;
}>;

/**
 * Point a standalone framework Worker at the canonical root Cloudflare state.
 *
 * Resource ids and deployment history remain in the user's root wrangler
 * config. The generated deploy pointer contains only a relative path back to
 * that file, so Wrangler uploads the exact config Void verifies.
 */
export function writeCloudflareFrameworkDeployConfig(
  options: CloudflareFrameworkDeployConfig,
): boolean {
  const initial = existsSync(options.configPath)
    ? readFileSync(options.configPath, 'utf-8')
    : '{}\n';
  let content = initial;
  const upsert = (path: Array<string>, value: unknown): void => {
    content = setJsoncValue(content, path, value);
  };

  upsert(['name'], options.name);
  upsert(['account_id'], options.accountId);
  upsert(['main'], options.main);
  upsert(['compatibility_date'], options.compatibilityDate);
  if (options.versionMetadataBinding && parse(content).version_metadata === undefined) {
    upsert(['version_metadata'], { binding: options.versionMetadataBinding });
  }
  if (options.compatibilityFlags && options.compatibilityFlags.length > 0) {
    const config = parse(content) as { compatibility_flags?: unknown };
    const current = Array.isArray(config.compatibility_flags)
      ? config.compatibility_flags.filter((flag): flag is string => typeof flag === 'string')
      : [];
    upsert(['compatibility_flags'], [...new Set([...current, ...options.compatibilityFlags])]);
  }
  upsert(['no_bundle'], false);
  upsert(['assets', 'directory'], options.assetsDirectory);
  upsert(['assets', 'binding'], 'ASSETS');
  upsert(['assets', 'run_worker_first'], true);
  upsert(['assets', 'not_found_handling'], 'none');
  if (options.crons !== undefined) {
    upsert(['triggers', 'crons'], [...options.crons]);
  }
  if (options.requiredSecrets && options.requiredSecrets.length > 0) {
    const config = parse(content) as { secrets?: unknown };
    if (
      config.secrets !== undefined &&
      (typeof config.secrets !== 'object' ||
        config.secrets === null ||
        Array.isArray(config.secrets))
    ) {
      throw new Error('Cloudflare framework config has a malformed secrets field.');
    }
    const required = (config.secrets as { required?: unknown } | undefined)?.required;
    if (
      required !== undefined &&
      (!Array.isArray(required) || !required.every((name) => typeof name === 'string'))
    ) {
      throw new Error('Cloudflare framework config has a malformed secrets.required field.');
    }
    const current = (required as Array<string> | undefined) ?? [];
    upsert(['secrets', 'required'], [...new Set([...current, ...options.requiredSecrets])]);
  }

  if (options.ai) {
    const config = parse(content) as { ai?: { binding?: unknown }; vars?: Record<string, unknown> };
    if (config.ai === undefined) {
      upsert(['ai'], { binding: options.ai.binding });
    }
    const binding = typeof config.ai?.binding === 'string' ? config.ai.binding : options.ai.binding;
    if (binding !== 'AI') {
      upsert(['vars', '__VOID_AI_BINDING'], binding);
    }
    if (options.ai.gateway) {
      upsert(['vars', '__VOID_AI_GATEWAY'], options.ai.gateway);
    }
  }

  if (options.images && (parse(content) as { images?: unknown }).images === undefined) {
    upsert(['images'], { binding: options.images.binding });
  }

  let changed = content !== initial;
  if (changed) {
    writeFileSync(options.configPath, content);
  }

  const pointer = `${JSON.stringify(
    {
      configPath: relative(dirname(options.deployPointerPath), options.configPath),
      auxiliaryWorkers: [],
    },
    null,
    2,
  )}\n`;
  const previousPointer = existsSync(options.deployPointerPath)
    ? readFileSync(options.deployPointerPath, 'utf-8')
    : null;
  if (previousPointer !== pointer) {
    mkdirSync(dirname(options.deployPointerPath), { recursive: true });
    writeFileSync(options.deployPointerPath, pointer);
    changed = true;
  }

  if (options.assetsIgnore && options.assetsIgnore.length > 0) {
    const ignorePath = join(dirname(options.configPath), options.assetsDirectory, '.assetsignore');
    const previousIgnore = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf-8') : null;
    const existingLines = new Set((previousIgnore ?? '').split(/\r?\n/));
    let ignore = previousIgnore ?? '';
    if (ignore.length > 0 && !ignore.endsWith('\n') && !ignore.endsWith('\r')) {
      ignore += '\n';
    }
    for (const pattern of options.assetsIgnore) {
      if (!existingLines.has(pattern)) {
        ignore += `${pattern}\n`;
      }
    }
    if (previousIgnore !== ignore) {
      writeFileSync(ignorePath, ignore);
      changed = true;
    }
  }
  return changed;
}
