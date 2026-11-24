const UNSAFE_SCRIPT_CHARS = /[<>&\u2028\u2029]/g;

export function escapeScriptJson(json: string): string {
  return json.replaceAll(UNSAFE_SCRIPT_CHARS, (c) => {
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}
