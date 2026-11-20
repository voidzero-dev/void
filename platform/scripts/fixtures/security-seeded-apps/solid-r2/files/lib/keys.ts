/**
 * Builds a tidy R2 object key: drops empty and "." segments and resolves ".."
 * so the same file never ends up under two keys ("a//b", "a/./b", "a/x/../b").
 */
export function normalizeKey(...parts: Array<string>): string {
  const out: Array<string> = [];
  for (const segment of parts.join('/').split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

export function userPrefix(userId: string): string {
  return `users/${userId}/`;
}
