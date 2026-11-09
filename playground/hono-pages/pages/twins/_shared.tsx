import { useRouter } from '@void/hono';

// Both twin routes render this one component.
export default function TwinPage() {
  const router = useRouter();
  return (
    <div>
      <h1>Twin page</h1>
      <p data-testid="twin-path">{router.path}</p>
    </div>
  );
}
