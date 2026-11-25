/**
 * Keep Void's public CLI vocabulary at the product level while preserving real
 * Cloudflare config filenames and environment variables that users may need to
 * inspect. The underlying implementation remains available in source and deploy
 * diagnostics, but normal remediation always points back to Void commands.
 */
export function formatCloudflareUserMessage(message: string): string {
  const preserved: Array<string> = [];
  const protect = (value: string): string => {
    const index = preserved.push(value) - 1;
    return `\uE000VOID_CF_TERM_${index}\uE001`;
  };

  let result = message
    .replaceAll(/(?:[A-Za-z]:)?[^\s`"']*wrangler\.jsonc?/gi, protect)
    .replaceAll(/\bWRANGLER_[A-Z0-9_]+\b/g, protect)
    .replaceAll(/\.wrangler\b/gi, protect)
    .replaceAll(/`wrangler deploy`/gi, '`void deploy --platform cloudflare`')
    .replaceAll(/`wrangler secret list[^`]*`/gi, '`void secret list`')
    .replaceAll(/`wrangler secret put\s+([^`]*)`/gi, '`void secret put $1`')
    .replaceAll(/`wrangler d1 migrations apply[^`]*`/gi, '`void db migrate --remote`')
    .replaceAll(/`wrangler d1 migrations list[^`]*`/gi, '`void db status`')
    .replaceAll(/`wrangler[^`]*`/gi, 'the underlying Cloudflare operation')
    .replaceAll(/"wrangler[^"\n]*"/gi, '"Cloudflare operation"')
    .replaceAll(/\bwrangler uploader\b/gi, 'Cloudflare deployment tool')
    .replaceAll(/\bwrangler (?:CLI|binary|process|child)\b/gi, 'Cloudflare deployment tool')
    .replaceAll(/\bwrangler config\b/gi, 'Cloudflare config')
    .replaceAll(/\bwrangler\b/gi, 'Cloudflare tooling');

  result = result.replaceAll(/\uE000VOID_CF_TERM_(\d+)\uE001/g, (_match, index: string) => {
    return preserved[Number(index)] ?? '';
  });
  return result;
}
