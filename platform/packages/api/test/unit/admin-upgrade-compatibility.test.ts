import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { platformDatabaseSchemaDigest } from '@void/platform/installer';
import { expect, it } from 'vite-plus/test';

it('upgrades the OAuth schema without elevating existing grants or changing production projects', async () => {
  const root = resolve(import.meta.dirname, '../../drizzle');
  const journal = JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  const compatibility = JSON.parse(readFileSync(resolve(root, 'compatibility.json'), 'utf8'));
  const previous = journal.entries.filter((entry) => entry.idx < 60);
  const schemaDigest = platformDatabaseSchemaDigest(
    compatibility.lineage,
    previous.map((entry) => ({
      index: entry.idx,
      tag: entry.tag,
      timestampMillis: entry.when,
      sha256: createHash('sha256')
        .update(readFileSync(resolve(root, entry.tag + '.sql')))
        .digest('hex'),
    })),
  );
  for (const platformVersion of ['0.28.0', '1.0.0', '1.1.0']) {
    expect(compatibility.rollbackSafeFrom).toContainEqual({ platformVersion, schemaDigest });
  }
  const db = new PGlite();
  try {
    for (const entry of previous) {
      await db.exec(readFileSync(resolve(root, entry.tag + '.sql'), 'utf8'));
    }
    await db.exec(
      "INSERT INTO users (id, login) VALUES ('migration-user', 'migration-user'); INSERT INTO projects (id, user_id, slug, active_deployment_id) VALUES ('production', 'migration-user', 'production', 'old-deployment'); INSERT INTO oauth_clients (id, name, operator, redirect_uris, scopes, secret_hash) VALUES ('client', 'client', 'operator', '[]', '[\"profile\"]', 'hash'); INSERT INTO oauth_grants (id, client_id, user_id, session, token_hash, expires_at) VALUES ('grant', 'client', 'migration-user', '{}', 'token-hash', now() + interval '1 hour');",
    );
    await db.exec(readFileSync(resolve(root, '0060_private_previews.sql'), 'utf8'));
    expect((await db.query('SELECT scopes FROM oauth_grants')).rows).toEqual([
      { scopes: ['profile'] },
    ]);
    expect(
      (
        await db.query(
          'SELECT active_deployment_id, preview_client_id, preview_workspace_id, preview_expires_at FROM projects',
        )
      ).rows,
    ).toEqual([
      {
        active_deployment_id: 'old-deployment',
        preview_client_id: null,
        preview_workspace_id: null,
        preview_expires_at: null,
      },
    ]);
    // The previous runtime can still create ordinary projects and identity grants.
    await db.exec(
      "INSERT INTO projects (id, user_id, slug) VALUES ('older-runtime', 'migration-user', 'older-runtime'); INSERT INTO oauth_grants (id, client_id, user_id, session, token_hash, expires_at) VALUES ('older-grant', 'client', 'migration-user', '{}', 'older-token-hash', now() + interval '1 hour');",
    );
  } finally {
    await db.close();
  }
}, 30000);

it('normalizes worker project modes without changing deployment pointers and retains rollback to 0.22.0', async () => {
  const root = resolve(import.meta.dirname, '../../drizzle');
  const journal = JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string; idx: number; when: number }>;
  };
  const compatibility = JSON.parse(readFileSync(resolve(root, 'compatibility.json'), 'utf8')) as {
    lineage: string;
    rollbackSafeFrom: Array<{ platformVersion: string; schemaDigest: string }>;
  };
  const previous = journal.entries.filter((entry) => entry.idx < 54);
  expect(compatibility.rollbackSafeFrom).toContainEqual({
    platformVersion: '0.22.0',
    schemaDigest: platformDatabaseSchemaDigest(
      compatibility.lineage,
      previous.map((entry) => ({
        index: entry.idx,
        tag: entry.tag,
        timestampMillis: entry.when,
        sha256: createHash('sha256')
          .update(readFileSync(resolve(root, `${entry.tag}.sql`)))
          .digest('hex'),
      })),
    ),
  });
  const db = new PGlite();
  try {
    for (const entry of previous) {
      await db.exec(readFileSync(resolve(root, `${entry.tag}.sql`), 'utf8'));
    }
    await db.exec("INSERT INTO users (id, login) VALUES ('migration-user', 'migration-user')");
    await db.exec(
      "INSERT INTO projects (id, user_id, slug, mode, active_deployment_id) VALUES ('worker-project', 'migration-user', 'worker-project', 'worker', 'serving-older'), ('static-project', 'migration-user', 'static-project', 'static', NULL)",
    );
    await db.exec(readFileSync(resolve(root, '0054_project_mode.sql'), 'utf8'));
    await db.exec(
      "INSERT INTO projects (id, user_id, slug) VALUES ('new-project', 'migration-user', 'new-project')",
    );
    expect(
      (await db.query('SELECT id, mode, active_deployment_id FROM projects ORDER BY id')).rows,
    ).toEqual([
      { id: 'new-project', mode: 'void', active_deployment_id: null },
      { id: 'static-project', mode: 'static', active_deployment_id: null },
      { id: 'worker-project', mode: 'void', active_deployment_id: 'serving-older' },
    ]);
  } finally {
    await db.close();
  }
}, 30_000);

// 0.10.14 and 0.20.1 can write GitHub connections without an authorizer and
// delete users without removing the connections they authorized.
it('requires 0.10.14 and 0.20.1 to upgrade through a release that enforces GitHub authority', () => {
  const compatibility = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../drizzle/compatibility.json'), 'utf8'),
  ) as { rollbackSafeFrom: Array<{ platformVersion: string }> };
  const versions = compatibility.rollbackSafeFrom.map((entry) => entry.platformVersion);
  expect(versions).not.toContain('0.10.14');
  expect(versions).not.toContain('0.20.1');
});

it('allows rollback to the 0.20.3 schema after adding invitation delivery status', () => {
  const root = resolve(import.meta.dirname, '../../drizzle');
  const journal = JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string; idx: number; when: number }>;
  };
  const compatibility = JSON.parse(readFileSync(resolve(root, 'compatibility.json'), 'utf8')) as {
    lineage: string;
    rollbackSafeFrom: Array<{ platformVersion: string; schemaDigest: string }>;
  };
  const previous = journal.entries.filter((entry) => entry.idx <= 48);
  expect(previous.at(-1)?.tag).toBe('0048_project_teams');
  const schemaDigest = platformDatabaseSchemaDigest(
    compatibility.lineage,
    previous.map((entry) => ({
      index: entry.idx,
      tag: entry.tag,
      timestampMillis: entry.when,
      sha256: createHash('sha256')
        .update(readFileSync(resolve(root, `${entry.tag}.sql`)))
        .digest('hex'),
    })),
  );
  expect(schemaDigest).toBe('089431e230970d03afa429c102613598e88371155cb693c076002c5d632bb0b6');
  expect(compatibility.rollbackSafeFrom).toContainEqual({
    platformVersion: '0.20.3',
    schemaDigest,
  });
});

it('allows rollback to the 0.20.3 schema after adding direct member grants', () => {
  const root = resolve(import.meta.dirname, '../../drizzle');
  const journal = JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string; idx: number; when: number }>;
  };
  const compatibility = JSON.parse(readFileSync(resolve(root, 'compatibility.json'), 'utf8')) as {
    lineage: string;
    rollbackSafeFrom: Array<{ platformVersion: string; schemaDigest: string }>;
  };
  const previous = journal.entries.filter((entry) => entry.idx <= 49);
  expect(previous.at(-1)?.tag).toBe('0049_invitation_delivery_status');
  const schemaDigest = platformDatabaseSchemaDigest(
    compatibility.lineage,
    previous.map((entry) => ({
      index: entry.idx,
      tag: entry.tag,
      timestampMillis: entry.when,
      sha256: createHash('sha256')
        .update(readFileSync(resolve(root, `${entry.tag}.sql`)))
        .digest('hex'),
    })),
  );
  expect(schemaDigest).toBe('408364e61c4b7d83def4030a1c11e8b9b07fc21dd3bffe6529e1b7d3759979b6');
  expect(compatibility.rollbackSafeFrom).toContainEqual({
    platformVersion: '0.20.3',
    schemaDigest,
  });
});

it('allows upgrading the 0.21.2 schema after adding project cleanup jobs', () => {
  const root = resolve(import.meta.dirname, '../../drizzle');
  const journal = JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string; idx: number; when: number }>;
  };
  const compatibility = JSON.parse(readFileSync(resolve(root, 'compatibility.json'), 'utf8')) as {
    lineage: string;
    rollbackSafeFrom: Array<{ platformVersion: string; schemaDigest: string }>;
  };
  const previous = journal.entries.filter((entry) => entry.idx <= 50);
  expect(previous.at(-1)?.tag).toBe('0050_project_member_direct_grants');
  const schemaDigest = platformDatabaseSchemaDigest(
    compatibility.lineage,
    previous.map((entry) => ({
      index: entry.idx,
      tag: entry.tag,
      timestampMillis: entry.when,
      sha256: createHash('sha256')
        .update(readFileSync(resolve(root, `${entry.tag}.sql`)))
        .digest('hex'),
    })),
  );
  expect(schemaDigest).toBe('9a9ae6677b795debd4ffaa20a05f533727063c7a21366310a2fe4b17bd918edd');
  expect(compatibility.rollbackSafeFrom).toContainEqual({
    platformVersion: '0.21.2',
    schemaDigest,
  });
});

it('allows upgrading the 0.21.3 through 0.21.9 schema after adding project Zero Trust', () => {
  const root = resolve(import.meta.dirname, '../../drizzle');
  const journal = JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string; idx: number; when: number }>;
  };
  const compatibility = JSON.parse(readFileSync(resolve(root, 'compatibility.json'), 'utf8')) as {
    lineage: string;
    rollbackSafeFrom: Array<{ platformVersion: string; schemaDigest: string }>;
  };
  const previous = journal.entries.filter((entry) => entry.idx <= 51);
  expect(previous.at(-1)?.tag).toBe('0051_icy_psylocke');
  const schemaDigest = platformDatabaseSchemaDigest(
    compatibility.lineage,
    previous.map((entry) => ({
      index: entry.idx,
      tag: entry.tag,
      timestampMillis: entry.when,
      sha256: createHash('sha256')
        .update(readFileSync(resolve(root, `${entry.tag}.sql`)))
        .digest('hex'),
    })),
  );
  expect(schemaDigest).toBe('ac70deb5847c71ece9938edd27e5dbc50ce41e16771926c78e757850baf15bfa');
  for (const platformVersion of [
    '0.21.3',
    '0.21.4',
    '0.21.5',
    '0.21.6',
    '0.21.7',
    '0.21.8',
    '0.21.9',
  ]) {
    expect(compatibility.rollbackSafeFrom).toContainEqual({ platformVersion, schemaDigest });
  }
});

// 0.25.0 and 0.26.0 ignore projects.proxy_token_gen, so they can run on the 0058 schema.
it('allows upgrading the 0.25.0 and 0.26.0 schema after adding the proxy token generation', () => {
  const root = resolve(import.meta.dirname, '../../drizzle');
  const journal = JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string; idx: number; when: number }>;
  };
  const compatibility = JSON.parse(readFileSync(resolve(root, 'compatibility.json'), 'utf8')) as {
    lineage: string;
    rollbackSafeFrom: Array<{ platformVersion: string; schemaDigest: string }>;
  };
  expect(journal.entries.some((entry) => entry.tag === '0058_project_proxy_token_gen')).toBe(true);
  const previous = journal.entries.filter((entry) => entry.idx < 58);
  expect(previous.at(-1)?.tag).toBe('0057_github_authority_constraints');
  const schemaDigest = platformDatabaseSchemaDigest(
    compatibility.lineage,
    previous.map((entry) => ({
      index: entry.idx,
      tag: entry.tag,
      timestampMillis: entry.when,
      sha256: createHash('sha256')
        .update(readFileSync(resolve(root, `${entry.tag}.sql`)))
        .digest('hex'),
    })),
  );
  expect(schemaDigest).toBe('7581930465664b7c578518bea54f36a83d20fcc47d9528183419033930d7ff4a');
  expect(
    compatibility.rollbackSafeFrom.filter((entry) => entry.schemaDigest === schemaDigest),
  ).toEqual([
    { platformVersion: '0.25.0', schemaDigest },
    { platformVersion: '0.26.0', schemaDigest },
  ]);
});

// 0.27.0 ignores OAuth tables and rejects the new deployment token audience.
it('retains rollback to 0.27.0 after adding registered OAuth clients', () => {
  const root = resolve(import.meta.dirname, '../../drizzle');
  const journal = JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8'));
  const compatibility = JSON.parse(readFileSync(resolve(root, 'compatibility.json'), 'utf8'));
  expect(journal.entries.some((entry: { tag: string }) => entry.tag === '0059_oauth_clients')).toBe(
    true,
  );
  const schemaDigest = platformDatabaseSchemaDigest(
    compatibility.lineage,
    journal.entries
      .filter((entry: { idx: number }) => entry.idx < 59)
      .map((entry: { idx: number; tag: string; when: number }) => ({
        index: entry.idx,
        tag: entry.tag,
        timestampMillis: entry.when,
        sha256: createHash('sha256')
          .update(readFileSync(resolve(root, entry.tag + '.sql')))
          .digest('hex'),
      })),
  );
  expect(compatibility.rollbackSafeFrom).toContainEqual({
    platformVersion: '0.27.0',
    schemaDigest,
  });
});

// 1.1.11 through 1.2.1 ignore email_domain_routes.inbound_mode and insert managed routes.
it('upgrades the 1.1.11 through 1.2.1 schema to outbound-only email routes', async () => {
  const root = resolve(import.meta.dirname, '../../drizzle');
  const journal = JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  const compatibility = JSON.parse(readFileSync(resolve(root, 'compatibility.json'), 'utf8'));
  const previous = journal.entries.filter((entry) => entry.idx < 61);
  expect(previous.at(-1)?.tag).toBe('0060_private_previews');
  const schemaDigest = platformDatabaseSchemaDigest(
    compatibility.lineage,
    previous.map((entry) => ({
      index: entry.idx,
      tag: entry.tag,
      timestampMillis: entry.when,
      sha256: createHash('sha256')
        .update(readFileSync(resolve(root, entry.tag + '.sql')))
        .digest('hex'),
    })),
  );
  for (const platformVersion of ['1.1.11', '1.1.12', '1.2.0', '1.2.1']) {
    expect(compatibility.rollbackSafeFrom).toContainEqual({ platformVersion, schemaDigest });
  }
  const db = new PGlite();
  const route = (id: string, domain: string, addressing: string, project: string | null) =>
    `INSERT INTO email_domain_routes (id, domain, connection_id, project_id, addressing, managed_by) VALUES ('${id}', '${domain}', 'connection', ${project ? `'${project}'` : 'NULL'}, '${addressing}', 'admin');`;
  try {
    for (const entry of previous) {
      await db.exec(readFileSync(resolve(root, entry.tag + '.sql'), 'utf8'));
    }
    await db.exec(
      "INSERT INTO users (id, login) VALUES ('migration-user', 'migration-user'); INSERT INTO projects (id, user_id, slug) VALUES ('project', 'migration-user', 'project'); INSERT INTO email_zone_connections (id, installation_id, account_id, zone_id, zone_name, managed_by, ingress_worker_name, secret_ciphertext, secret_iv, secret_key_version) VALUES ('connection', 'installation', 'account', 'zone', 'example.com', 'admin', 'ingress', 'ciphertext', 'iv', 1);" +
        route('existing', 'example.com', 'custom', 'project'),
    );
    await db.exec(readFileSync(resolve(root, '0061_email_inbound_mode.sql'), 'utf8'));
    // The previous runtime can still insert routes; they stay managed.
    await db.exec(route('older-runtime', 'shared.example.com', 'shared', null));
    expect(
      (await db.query('SELECT id, inbound_mode FROM email_domain_routes ORDER BY id')).rows,
    ).toEqual([
      { id: 'existing', inbound_mode: 'managed' },
      { id: 'older-runtime', inbound_mode: 'managed' },
    ]);
    await db.exec("UPDATE email_domain_routes SET inbound_mode = 'none' WHERE id = 'existing'");
    // Only custom routes can be outbound-only, and the mode has two values.
    await expect(
      db.exec("UPDATE email_domain_routes SET inbound_mode = 'none' WHERE id = 'older-runtime'"),
    ).rejects.toThrow('email_domain_routes_inbound_mode_check');
    await expect(
      db.exec("UPDATE email_domain_routes SET inbound_mode = 'other' WHERE id = 'existing'"),
    ).rejects.toThrow('email_domain_routes_inbound_mode_check');
  } finally {
    await db.close();
  }
}, 30_000);

it('upgrades the 1.1.11 through 1.2.1 schema to project email aliases', async () => {
  const root = resolve(import.meta.dirname, '../../drizzle');
  const journal = JSON.parse(readFileSync(resolve(root, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const released = journal.entries.filter((entry) => entry.idx < 61);
  expect(journal.entries.find((entry) => entry.idx === 62)?.tag).toBe('0062_project_email_alias');
  const db = new PGlite();
  const project = (id: string, slug: string) =>
    `INSERT INTO projects (id, user_id, slug) VALUES ('${id}', 'migration-user', '${slug}');`;
  try {
    for (const entry of released) {
      await db.exec(readFileSync(resolve(root, entry.tag + '.sql'), 'utf8'));
    }
    await db.exec(
      "INSERT INTO users (id, login) VALUES ('migration-user', 'migration-user');" +
        project('brand', 'brand-feedback'),
    );
    await db.exec(readFileSync(resolve(root, '0061_email_inbound_mode.sql'), 'utf8'));
    await db.exec(readFileSync(resolve(root, '0062_project_email_alias.sql'), 'utf8'));
    expect((await db.query('SELECT slug, email_alias FROM projects')).rows).toEqual([
      { slug: 'brand-feedback', email_alias: null },
    ]);
    await db.exec("UPDATE projects SET email_alias = 'bfb' WHERE id = 'brand'");
    // The previous runtime still creates projects and previews without the column.
    await db.exec(project('older-runtime', 'older-runtime') + project('preview', 'preview-1'));
    // A slug and an alias may not share a name, in either direction or on one project.
    await expect(db.exec(project('taken', 'bfb'))).rejects.toThrow(
      'A project slug or email alias already uses this name',
    );
    await expect(
      db.exec("UPDATE projects SET email_alias = 'older-runtime' WHERE id = 'brand'"),
    ).rejects.toThrow('A project slug or email alias already uses this name');
    await expect(
      db.exec("UPDATE projects SET email_alias = 'older-runtime' WHERE id = 'older-runtime'"),
    ).rejects.toThrow('A project slug or email alias already uses this name');
    await expect(
      db.exec("UPDATE projects SET email_alias = 'bfb' WHERE id = 'older-runtime'"),
    ).rejects.toThrow('idx_projects_email_alias');
  } finally {
    await db.close();
  }
}, 30_000);
