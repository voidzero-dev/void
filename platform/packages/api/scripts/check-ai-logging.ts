import pg from 'pg';

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 15000,
  statement_timeout: 15000,
});
await client.connect();
try {
  await client.query('BEGIN READ ONLY');
  const { rows } = await client.query('SELECT count(*) FROM project_ai_logging');
  console.log(`Saved project AI logging settings: ${rows[0].count}`);
  if (rows[0].count !== '0') {
    const settings = await client.query(
      'SELECT project_id, mode FROM project_ai_logging ORDER BY project_id',
    );
    console.log(JSON.stringify(settings.rows));
    console.log(
      'For the first rollout after 1.8.0, republish these settings after the API deploy as described in platform/meta/operations.md.',
    );
  }
  await client.query('COMMIT');
} catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== '42P01') {
    throw error;
  }
  console.log('AI logging settings are not installed; no saved settings to republish.');
} finally {
  await client.end();
}

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (accountId && token) {
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai-gateway/gateways/void`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) },
    );
    const gateway = (await response.json()) as { result?: { collect_logs?: boolean } };
    if (!response.ok || typeof gateway.result?.collect_logs !== 'boolean') {
      throw new Error(`HTTP ${response.status}`);
    }
    console.log(`Hosted void AI Gateway collect_logs: ${gateway.result.collect_logs}`);
  } catch {
    // Deployment tokens need not have AI Gateway Read permission.
    console.warn(
      'Could not read AI Gateway logging with the deployment token; check it in Cloudflare.',
    );
  }
}
