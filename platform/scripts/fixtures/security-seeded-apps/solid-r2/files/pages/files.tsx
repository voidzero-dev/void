import { For } from 'solid-js';
import type { Props } from './files.server.ts';

export default function FilesPage(props: Props) {
  return (
    <div>
      <h1>Your files</h1>
      <ul>
        <For each={props.files}>
          {(name) => (
            <li>
              <a href={`/api/files?name=${encodeURIComponent(name)}`}>{name}</a>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
