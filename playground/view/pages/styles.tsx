import { StyledPanel } from '../components/ScopedStyles.tsx';
export default function Styles() {
  return (
    <>
      <h1>Component-scoped CSS</h1>
      <h2 class="outside-heading">Unstyled outside heading</h2>
      <StyledPanel />
      <p class="global-nested">Global through a nested :root block</p>
      <p class="global-flat">Global through a :root selector</p>
      <a href="/styles-static">Static styled component, without View JavaScript</a>
      <p>
        <a href="/styles-dynamic">Dynamic styles and independent instances</a>
      </p>
      <p>
        <a href="/">All examples</a>
      </p>
    </>
  );
}
