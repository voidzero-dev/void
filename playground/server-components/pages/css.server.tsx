import { SourceLink } from '../components/SourceLink.tsx';
import './styles.css';

export const layout = false;

export default function Styles() {
  return (
    <main class="example-container">
      <h1>CSS without hydration</h1>
      <SourceLink file="pages/css.server.tsx" />
      <p>
        This page imports the example stylesheet directly. Disable JavaScript or resize the window:
        the columns still respond to the viewport.
      </p>
      <div class="examples">
        <section class="example">
          <h2>HTML</h2>
          <p>The server renders the markup.</p>
        </section>
        <section class="example">
          <h2>CSS</h2>
          <p>The stylesheet supplies the grid.</p>
        </section>
        <section class="example">
          <h2>JavaScript</h2>
          <p>No browser script is needed.</p>
        </section>
      </div>
      <p>
        <a href="/">Back to the playground</a>
      </p>
    </main>
  );
}
