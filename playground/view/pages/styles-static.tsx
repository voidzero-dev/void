import { StyledChild } from '../components/ScopedStyles.tsx';
export default function StaticStyles() {
  return (
    <>
      <h1>Static scoped CSS</h1>
      <StyledChild />
      <a href="/styles">Interactive styles example</a>
    </>
  );
}
