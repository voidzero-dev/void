/**
 * `pg` falls back to `pgpass` when no password is present in the connection
 * config and the server requests one. Workers have no pgpass file, and the
 * Node fs/path polyfills can throw before `pg` reports the auth failure.
 */
export function disablePgPassFallback(client: unknown): void {
  const pgClient = client as {
    connectionParameters?: { password?: unknown };
    password?: unknown;
  };
  if (pgClient.password == null) {
    const noPassword = async () => undefined;
    pgClient.password = noPassword;
    if (pgClient.connectionParameters) {
      pgClient.connectionParameters.password = noPassword;
    }
  }
}
