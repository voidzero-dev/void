import { vscodeFileUrl } from './editor-url.ts';

export function SourceLink({ file }: { file: string }) {
  return (
    <a href={vscodeFileUrl(__HTTP_ERRORS_SOURCE_ROOT__, file)} title={`Open ${file} in VS Code`}>
      <code>{file}</code>
    </a>
  );
}
