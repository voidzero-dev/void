import { Link, useParams, useRouter } from '@void/react';

export default function RouterParamsDetail() {
  const { id } = useParams<'/router-params/:id'>();
  const router = useRouter();

  return (
    <main>
      <h1>Router Param {id}</h1>
      <p data-testid="router-param-id">{id}</p>
      <p data-testid="router-path">{router.path}</p>
      <Link href="/router-params/bravo">Open bravo</Link>
    </main>
  );
}
