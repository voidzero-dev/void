---
outline: deep
---

# PostgreSQL

Connect your PostgreSQL database through [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/), then use the same Drizzle schema and query workflow as D1.

## What is Hyperdrive?

Hyperdrive pools connections between your Worker and PostgreSQL. Requests reuse an existing connection instead of opening a new TCP and TLS connection each time.

Void can provision the Hyperdrive configuration from your connection string. Direct Cloudflare deploys also need an API token for first-time provisioning; see the [Cloudflare guide](../../integrations/cloudflare.md#databases-and-secrets).

## Configuration

### 1. Set the database

Add to your `void.config.ts`:

```json
{
  "database": "pg"
}
```

### 2. Add your connection string

For local development, add `DATABASE_URL` to `.env`:

```dotenv
DATABASE_URL=postgresql://user:password@host:5432/mydb?sslmode=require
```

This connects directly to your Postgres database during local Vite development.

### 3. Deploy

For a Void platform, deploy prompts for the connection string if needed. You can also set it with `void db set-url`. For direct Cloudflare deploys, export the production `DATABASE_URL` in your shell.

Void provisions Hyperdrive without saving the connection string in project config. Both `postgres://` and `postgresql://` URLs are supported, including provider query strings such as `?sslmode=require`.

The Hyperdrive that Void creates connects with TLS in Cloudflare's default `require` mode. Hyperdrive does not use the `sslmode=verify-ca`, `sslmode=verify-full`, or `sslrootcert` settings from your connection string. To have Hyperdrive verify your database against a specific certificate authority on a direct Cloudflare deploy, [create the Hyperdrive in Cloudflare with that certificate](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/) and add its ID to [`cloudflare.hyperdrive`](../../integrations/cloudflare.md#databases-and-secrets).

## Schema Definition

Import schema helpers from `void/schema-pg`:

```ts
// db/schema.ts
import { pgTable, serial, text, timestamp, boolean } from 'void/schema-pg';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  role: text('role').notNull().default('user'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
```

`void gen model` generates PostgreSQL-appropriate code when `database` is set to `"pg"`.

## Migrations

The migration workflow is the same as D1:

```bash
# Generate migration files from schema changes
void db generate

# Apply pending migrations locally
void db migrate

# Check migration status
void db status
```

The main difference is that PostgreSQL supports **transactional DDL**. Each migration is wrapped in `BEGIN` and `COMMIT`, so a failure rolls back the whole migration instead of leaving the database half-updated.

`void deploy` applies pending migrations before making the new version live. See [Deployment](../deployment.md).

## Updating the Connection String

To update a linked Void project's connection, for example after moving the database to another host:

```bash
void db set-url
```

This prompts for the new connection string and updates the Hyperdrive configuration.
