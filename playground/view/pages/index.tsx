import { Button } from '../components/Button.tsx';
import { Counter } from '../components/Counter.tsx';
import * as Examples from '../components/index.ts';
import './style.css';
function Intro() {
  return (
    <p class="intro">
      Server-rendered HTML. Small custom elements only where interaction is needed.
    </p>
  );
}
export default function Home() {
  return (
    <main>
      <h1>Void View</h1>
      <Intro />
      <section class="card">
        <h2>The Button example</h2>
        <Button label="Press me" />
        <Button label="Independent button" />
      </section>
      <Counter />
      <Counter initial={2} />
      <Examples.Details />
      <p>
        <a href="/about">Visit a static page</a>
        {' · '}
        <a href="/button">Just one button</a>
        {' · '}
        <a href="/conditional">Server-selected interaction</a>
      </p>
    </main>
  );
}
