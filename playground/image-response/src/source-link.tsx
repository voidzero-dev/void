declare const __IMAGE_RESPONSE_SOURCE_ROOT__: string;

export function SourceLink({ file }: { file: string }) {
  const source = new URL(
    file.split('/').map(encodeURIComponent).join('/'),
    __IMAGE_RESPONSE_SOURCE_ROOT__,
  );
  const host = source.host ? `//${source.host}` : '';
  return (
    <a href={`vscode://file${host}${source.pathname}:1:1`} title={`Open ${file} in VS Code`}>
      <code>{file}</code>
    </a>
  );
}
