import { DynamicStyles } from '../components/DynamicStyles.tsx';

export default function DynamicStylesPage() {
  return (
    <>
      <h1>Instance-scoped dynamic styles</h1>
      <DynamicStyles initial="red" />
      <DynamicStyles initial="blue" />
      <a href="/styles">Static styles example</a>
    </>
  );
}
