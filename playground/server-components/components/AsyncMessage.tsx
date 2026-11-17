import { useContext } from 'void/jsx';
import { GreetingContext } from './greeting.ts';

export async function AsyncMessage({ name }: { name: string }) {
  const greeting = useContext(GreetingContext);
  await Promise.resolve();
  return (
    <p>
      {greeting}, {name}!
    </p>
  );
}
