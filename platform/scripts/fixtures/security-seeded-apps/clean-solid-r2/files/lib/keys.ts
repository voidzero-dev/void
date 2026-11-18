export function userPrefix(userId: string): string {
  return `users/${userId}/`;
}

/** A plain file name: letters, digits, dot, dash, underscore; no leading dot, no slash. */
export function isPlainName(name: string): boolean {
  if (name.length === 0 || name.length > 128 || name.startsWith('.')) {
    return false;
  }
  for (const char of name) {
    const ok =
      (char >= 'a' && char <= 'z') ||
      (char >= 'A' && char <= 'Z') ||
      (char >= '0' && char <= '9') ||
      char === '.' ||
      char === '-' ||
      char === '_';
    if (!ok) {
      return false;
    }
  }
  return true;
}
