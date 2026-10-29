import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AssetConfig, HeaderRule, RedirectRule } from '@void/deploy-core';
import {
  createScanner,
  parse,
  parseTree,
  type Node,
  type ParseError,
  SyntaxKind,
} from 'jsonc-parser';
import { dirname, join, relative, resolve } from 'pathslash';
import { setJsoncValue } from './config.ts';

export type CloudflareStaticDeployConfig = Readonly<{
  configPath: string;
  name: string;
  accountId: string;
  main: string;
  assetsDirectory: string;
  compatibilityDate: string;
  assetConfig: AssetConfig;
}>;

/** Generate the deterministic thin Worker entry bundled by Wrangler. */
export function renderCloudflareStaticEntry(options: {
  runtimeImport?: string;
  alwaysUseHttps?: boolean;
  headerRules?: ReadonlyArray<HeaderRule>;
  redirectRules?: ReadonlyArray<RedirectRule>;
  fallbackRules?: ReadonlyArray<RedirectRule>;
  versionMetadataBinding?: string;
}): string {
  const config = JSON.stringify({
    ...(options.alwaysUseHttps !== undefined ? { alwaysUseHttps: options.alwaysUseHttps } : {}),
    ...(options.headerRules?.length ? { headerRules: options.headerRules } : {}),
    ...(options.redirectRules?.length ? { redirectRules: options.redirectRules } : {}),
    ...(options.fallbackRules?.length ? { fallbackRules: options.fallbackRules } : {}),
    ...(options.versionMetadataBinding
      ? { versionMetadataBinding: options.versionMetadataBinding }
      : {}),
  });
  return [
    `import { createStaticEdgeHandler } from ${JSON.stringify(options.runtimeImport ?? '@void/edge')};`,
    `export default createStaticEdgeHandler(${config});`,
    '',
  ].join('\n');
}

/**
 * Copy static assets into Void's deploy area without Cloudflare's reserved routing files.
 *
 * Void has already compiled the root `_headers` and `_redirects` files into the thin edge
 * Worker. Wrangler parses those files independently of `.assetsignore`, so uploading the source
 * directory would apply every rule twice and can reject valid Void fallbacks as redirect loops.
 */
export function stageCloudflareStaticAssets(options: {
  sourceDirectory: string;
  destinationDirectory: string;
}): void {
  const sourceDirectory = resolve(options.sourceDirectory);
  const destinationDirectory = resolve(options.destinationDirectory);
  if (sourceDirectory === destinationDirectory) {
    throw new Error(
      'Cloudflare static asset staging requires distinct source and destination directories.',
    );
  }

  const reserved = new Set([
    join(sourceDirectory, '_headers'),
    join(sourceDirectory, '_redirects'),
  ]);
  const isInsideDestination = (path: string): boolean => {
    const fromDestination = relative(destinationDirectory, resolve(path));
    return (
      fromDestination === '' || (fromDestination !== '..' && !fromDestination.startsWith('../'))
    );
  };

  rmSync(destinationDirectory, { recursive: true, force: true });
  mkdirSync(dirname(destinationDirectory), { recursive: true });
  cpSync(sourceDirectory, destinationDirectory, {
    recursive: true,
    filter(path) {
      const absolute = resolve(path);
      return !reserved.has(absolute) && !isInsideDestination(absolute);
    },
  });
}

/**
 * Persist the mutable Cloudflare target state without replacing comments,
 * Durable Object migrations, resource ids, or unrelated user configuration.
 */
export function writeCloudflareStaticDeployConfig(options: CloudflareStaticDeployConfig): boolean {
  const initial = existsSync(options.configPath)
    ? readFileSync(options.configPath, 'utf-8')
    : '{}\n';
  const hasBom = initial.startsWith('\uFEFF');
  const source = hasBom ? initial.slice(1) : initial;
  assertValidStaticConfig(source, options.configPath);
  const originalComments = extractCommentTokens(source);
  let content = source;
  const upsert = (path: Array<string>, value: unknown): void => {
    content = setJsoncValue(content, path, value);
  };

  upsert(['name'], options.name);
  upsert(['account_id'], options.accountId);
  upsert(['main'], options.main);
  upsert(['compatibility_date'], options.compatibilityDate);
  upsert(['no_bundle'], false);
  upsert(['assets', 'directory'], options.assetsDirectory);
  upsert(['assets', 'binding'], 'ASSETS');
  upsert(['assets', 'run_worker_first'], true);
  upsert(['assets', 'not_found_handling'], options.assetConfig.not_found_handling ?? 'none');
  upsert(['assets', 'html_handling'], options.assetConfig.html_handling ?? 'auto-trailing-slash');
  // The generated static entry only exports a fetch handler. Keep Durable Object migration
  // history, which Cloudflare treats as append-only, but detach every configuration surface that
  // would require an application-worker export or event handler.
  upsert(['durable_objects', 'bindings'], []);
  upsert(['queues', 'producers'], []);
  upsert(['queues', 'consumers'], []);
  upsert(['triggers', 'crons'], []);
  upsert(['containers'], []);
  upsert(['workflows'], []);

  assertValidStaticConfig(content, options.configPath);
  const droppedComment = findDroppedComment(originalComments, extractCommentTokens(content));
  if (droppedComment !== undefined) {
    throw new Error(
      `deploy: cannot update "${options.configPath}" without dropping comment ${JSON.stringify(droppedComment)}. ` +
        'Move comments out of worker-only configuration and retry.',
    );
  }

  const finalContent = hasBom ? `\uFEFF${content}` : content;

  if (finalContent !== initial) {
    writeFileSync(options.configPath, finalContent);
    return true;
  }
  return false;
}

function assertValidStaticConfig(text: string, configPath: string): void {
  const errors: Array<ParseError> = [];
  const parsed = parse(text, errors, { allowTrailingComma: true });
  const root = parseTree(text, undefined, { allowTrailingComma: true });
  if (
    errors.length > 0 ||
    !root ||
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      `deploy: cannot update "${configPath}" — it is not valid JSON/JSONC. Fix the file and retry.`,
    );
  }
  const walk = (node: Node): void => {
    if (node.type === 'object' && node.children) {
      const seen = new Set<string>();
      for (const property of node.children) {
        const key = property.children?.[0]?.value;
        if (typeof key !== 'string') {
          continue;
        }
        if (seen.has(key)) {
          throw new Error(
            `deploy: cannot update "${configPath}" — duplicate key ${JSON.stringify(key)}. ` +
              'Wrangler reads the last duplicate while JSONC edits update the first. Remove the duplicate and retry.',
          );
        }
        seen.add(key);
      }
    }
    node.children?.forEach(walk);
  };
  walk(root);
}

function extractCommentTokens(text: string): Array<string> {
  const scanner = createScanner(text, false);
  const comments: Array<string> = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EOF; kind = scanner.scan()) {
    if (kind === SyntaxKind.LineCommentTrivia || kind === SyntaxKind.BlockCommentTrivia) {
      const offset = scanner.getTokenOffset();
      comments.push(text.slice(offset, offset + scanner.getTokenLength()));
    }
  }
  return comments;
}

function findDroppedComment(before: Array<string>, after: Array<string>): string | undefined {
  const counts = new Map<string, number>();
  for (const token of after) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  for (const token of before) {
    const remaining = counts.get(token) ?? 0;
    if (remaining === 0) {
      return token;
    }
    counts.set(token, remaining - 1);
  }
  return undefined;
}
