export function vscodeFileUrl(root: string, file: string): string {
  const source = new URL(file.split('/').map(encodeURIComponent).join('/'), root);
  const host = source.host ? `//${source.host}` : '';
  return `vscode://file${host}${source.pathname}:1:1`;
}
