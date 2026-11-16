export default function Result({
  user,
  expiresAt,
}: {
  user: { name: string; email: string } | null;
  expiresAt?: Date | null;
}) {
  return (
    <section>
      <h1>Loader rendered the page</h1>
      <p>{user ? `Signed in as ${user.email}.` : 'Anonymous visitor: user is null.'}</p>
      {expiresAt && <p>Session expires: {expiresAt.toISOString()}</p>}
      <p>This is the requested page, inside the root layout. No error boundary was selected.</p>
    </section>
  );
}
