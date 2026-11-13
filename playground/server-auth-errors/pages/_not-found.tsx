export default function NotFound() {
  return (
    <section>
      <h1>Not-found boundary</h1>
      <p>HTTP 404 selects this boundary inside the layout, unlike the 401 from requireAuth.</p>
    </section>
  );
}
