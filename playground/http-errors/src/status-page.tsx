export type StatusProps = {
  title: string;
  status: number;
  message: string;
};

export default function StatusPage({ title, status, message }: StatusProps) {
  return (
    <section>
      <h1>{title}</h1>
      <p>{message}</p>
      <p>Requested HTTP status: {status}. Check the actual response in the Network panel.</p>
      <p>
        This is the normal page, not an error boundary. Setting c.status() does not abort rendering.
      </p>
    </section>
  );
}
