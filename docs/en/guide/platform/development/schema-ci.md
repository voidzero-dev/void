---
outline: deep
---

# Schema and CI

## Changing the Platform Schema

The schema lives in `platform/packages/api/src/schema.ts`. Generate a migration after changing it:

```sh
vp run --filter @voidcloud/api db:generate
```

Review the generated SQL and migration journal before committing them. Released migrations are append-only. An upgrade applies new migrations while the previous Workers may still serve requests, so schema changes must remain compatible with that code.

`platform/packages/api/drizzle/compatibility.json` records which earlier runtimes have been verified against the new schema. Add an edge only after testing that compatibility. The runtime build checks that the migration files and recorded schema history agree.

## Runtime artifact contract

`@void/platform` contains installation manifests, resource naming, discovery contracts, Worker configuration, and deployable bundles under the `./installer` export. Platform source lives in `platform/packages/`.

Runtime artifacts include migration SQL, its journal, and a rollback compatibility manifest. Drizzle authoring snapshots remain in the source tree.

## CI in a Fork

The uncredentialed test workflows use GitHub-hosted runners in forks. They build and test the workspace without requiring Void Cloud accounts, tokens, or deployment access.

If your fork has a released platform version, set the repository variable
`VOID_PLATFORM_PRODUCTION_REF` to its immutable 40-character commit SHA. Platform
pull requests then create that version's database, seed representative user,
project, and encrypted-secret records, and apply the proposed migrations. The
check verifies existing data and runs the previous runtime against the upgraded
schema. Mutable branch or tag names are rejected.

Without an explicit SHA, required compatibility checks use the latest successful
GitHub deployment to `Prod` (or `VOID_PLATFORM_PRODUCTION_ENV`). They require
read access to deployment history and stop if no completed deployment is found.
Advancing the production branch does not change the selected baseline. Fork
workflows that call platform CI must grant `deployments: read` alongside
`contents: read`.

The upstream repository also contains workflows for deploying Void Cloud and publishing the official npm packages. Forks should configure their own release workflow around the built CLI and `platform upgrade --runtime`; the [source-build CI example](/guide/platform/development/runtime#deploying-source-builds-from-ci) shows the required inputs. Keep production credentials in protected environments restricted to the appropriate release refs.
