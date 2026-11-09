import { Link } from '@void/hono';
import type { Props } from './index.server.ts';

export default function HomePage(props: Props) {
  return (
    <div>
      <h1>Welcome — {props.title}</h1>
      <p>This is the Hono Pages playground.</p>
      <Link href="/users" prefetch="mount">
        Go to Users
      </Link>
      <Link href="/link-behavior">Link behavior</Link>
    </div>
  );
}
