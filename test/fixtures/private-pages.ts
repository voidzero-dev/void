/** Shared application input, not a model of the adapter's implementation. */
export function privatePages(
  framework: 'react' | 'solid',
  counter: string,
): Record<string, string> {
  const attribute = framework === 'react' ? 'className' : 'class';
  return {
    'pages/_ui/frame.tsx': `import './frame.css';
export function Frame(props) {
  return <main ${attribute}="private-frame" data-frame="575_SERVER_FRAME">{props.children}</main>;
}`,
    'pages/_ui/frame.css': '.private-frame { outline-offset: 11px; }',
    'pages/_ui/counter.tsx': counter,
    'pages/_layouts/docs.tsx': `import './docs.css';
export default function Docs(props) {
  return <section ${attribute}="private-layout" data-layout="docs">{props.children}</section>;
}`,
    'pages/_layouts/docs.css': '.private-layout { word-spacing: 3px; }',
    'pages/private.island.tsx': `import { Frame } from './_ui/frame';
import Counter from './_ui/counter' with { island: 'load' };
export const layout = 'docs';
export default function Private() { return <Frame><Counter /></Frame>; }`,
  };
}
