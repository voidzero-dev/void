const sourceBase = import.meta.env.DEMO_SOURCE_BASE;
const sourceLabel = sourceBase.startsWith('vscode:') ? 'Open in VS Code' : 'View on GitHub';

export function SourceLink({ file }: { file: string }) {
  const path = file.split('/').map(encodeURIComponent).join('/');
  return (
    <p>
      <a class="source-link" href={sourceBase + path} title={sourceLabel}>
        <code>{file}</code>
      </a>
    </p>
  );
}
