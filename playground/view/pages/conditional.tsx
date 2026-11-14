import { Reveal } from '../components/Reveal.tsx';
export default function Conditional({ enabled }: { enabled: boolean }) {
  return (
    <>
      <h1>Server-selected interaction</h1>
      {enabled ? <Reveal /> : <p>No interactive component was rendered.</p>}
      <a href="?enabled=1">Enable the interactive example</a>
    </>
  );
}
