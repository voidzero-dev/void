export function resourceNameWords(value: string): Array<string> {
  return value.split(/[^a-zA-Z0-9]+/).filter(Boolean);
}

export function isResourceName(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const words = resourceNameWords(value);
  return words.length > 0 && /^[a-zA-Z]/.test(words[0]);
}
