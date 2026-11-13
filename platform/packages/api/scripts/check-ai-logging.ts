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
} finally {
  await client.end();
}
