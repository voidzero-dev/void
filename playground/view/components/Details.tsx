import type { BaseProps } from '@void/view';
import { greeting } from './greeting.ts';
function Text({ children }: BaseProps) {
  return <span>{children}</span>;
}
function Caption({ children }: BaseProps) {
  return <Text>{children}</Text>;
}
function Readout({ read }: { read: () => string }) {
  return <output>{read()}</output>;
}
function ForwardReadout({ read }: { read: () => string }) {
  return <Readout read={read} />;
}
function Message({ content }: { content: () => string }) {
  return <p class="imported-callback">{content()}</p>;
}
export function Details() {
  let count = 0;
  const badge = <b class="badge">Tom &amp; Jerry</b>;
  return (
    <section class="card details">
      <h2>Templates and callback props</h2>
      <button
        onclick={() => {
          count += 1;
        }}
      >
        {badge} — add row
      </button>
      <Caption>A static descendant of an interactive view</Caption>
      <ForwardReadout read={() => `Rows: ${count}`} />
      <Message content={greeting} />
      <table>
        <tbody>
          {Array.from({ length: count }, (_, index) => (
            <tr>
              <td>{index + 1}</td>
              <td>Row &amp; cell</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
