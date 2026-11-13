# D1 bookmarks

React Pages demo comparing real D1 read-after-write behavior with and without bookmark propagation. Choose browser-cookie transport or an immediate server-side read through an independent session. The home page includes code snippets and VS Code source links, like `playground/http-errors`.

## Local development

From the repository root:

```sh
vp install
cd playground/d1-bookmarks
vp exec void db migrate
cd ../..
vp run --filter ./playground/d1-bookmarks dev
```

Open `/without-bookmark` and `/with-bookmark`. Choose the same **Read timing** and pressure settings in both variants:

Selections persist across reloads and deployments in browser storage and the page URL, and are shared between variants. Explicit URL parameters take precedence. The selected write/read experiment is labeled at the top; trial results themselves remain in page memory.

### Read-only routing baseline

Start with **Probe once** or choose a **Probes** count and click **Run probes** above the write experiments. The probe count is independent of the trial count; both are saved in browser storage and the URL. Each `GET /api/routing` performs one indexed SELECT through a fresh `first-unconstrained` session using `void/db .run()`, without saves, pressure, or bookmark propagation. Probes run sequentially and stop on an error.

Counters show primary, replica, unknown, and error totals. Each sample shows Worker colo, D1 region/colo, attempts, rows returned, wall time, and expandable complete D1 metadata, rows, bookmark, and errors. Missing `total_attempts` is shown as **not reported**, not assumed to mean one. The same complete metadata and timing are available for trial reads. Structured server logs use `d1-routing-probe` and `d1-routing-probe-error` events.

The probe reads the first profile by indexed ID; an empty database still measures routing. It does not measure read-after-write consistency or force replica selection. Avoid running write experiments in another tab while collecting a no-write baseline.

### Write/read experiments

- **Browser redirect (cookie)** (default): each trial performs an API POST followed by a 303 GET and displays the result in place. Only the fixed variant transports its bookmark in an HttpOnly cookie.
- **Immediate server read**: each trial performs one POST. Both variants write through a new unconstrained session, then read once through a separate new session without a browser round trip. The control starts the reader unconstrained; the fixed variant passes the completed write's bookmark directly to the reader's `createDb()`. Neither variant reads or updates the bookmark cookie in this mode. Use `?experiment=immediate` to open this mode directly.

Each trial shows its read target, revision, bookmarks, and D1 metadata. Counters separate primary reads, replica reads, stale replica reads, unknown targets (including local D1), and read errors. There is one read per trial, with no concurrent readers or writers.

Choose **20** (default), **50**, **100**, **200**, or **500** trials before clicking “Run trials”. It repeats the selected experiment sequentially, displaying expected/observed revisions, stale counts, D1 primary/replica metadata, and bookmarks. Immediate mode narrows the time available for replication to catch up; D1 can still route reads to the primary, and neither mode guarantees a stale read.

Failed requests appear as **errored**, separately from fresh/stale reads. A failed trial stops the run and stays in the history with an expandable error row. Error details include the failing phase, HTTP status, request ID when available, server error messages, stack traces, and nested causes. This diagnostic playground returns those details from its API. A failed save may have committed before its connection was interrupted; it is not automatically retried.

Local Miniflare does not reproduce distributed replica lag: both variants normally pass. No artificial delay, fake bookmark, or simulated stale data is used.

**Add replication pressure** is checked by default at **256 KiB per trial**. Choose **256 KiB**, **512 KiB**, **1 MiB**, or **2 MiB**. Each trial saves its revision and rewrites unrelated 256 KiB BLOB rows in one transaction, then reads the revision once through an independent session. No database operations are issued in parallel. The fixed variant's read bookmark comes from that completed write transaction.

Payload slots are shared across visitors and reused, using at most eight slots (2 MiB). Previously written data is not deleted when choosing smaller settings. At the defaults, 20 trials write 5 MiB of pressure data. The UI shows the selected total. API `pressure=0.25`, `pressure=0.5`, `pressure=1`, and `pressure=2` select these sizes; other values disable pressure. Uncheck the option for revision-only writes. Use a disposable database; pressure does not guarantee stale reads.

Click **Run trials** to write and read automatically using the selected timing. Every trial finishes before the next starts; there is no one-off Save button.

## Live demo

The Worker is named **`voidzero-void-d1-bookmarks`**, and its D1 database is **`voidzero-void-d1-bookmarks-weur`**. Their account, names, and database ID are saved in `cloudflare.config.ts` in this directory; `void.config.ts` reuses those settings for the Void build. The primary runs in Western Europe (`WEUR`), with read replication enabled (`auto`) and no jurisdiction restriction. Credentials come from the `cf` wrapper through `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

Deployed URL: <https://voidzero-void-d1-bookmarks.skoss-individual-account.workers.dev>. Sign in through the account's Cloudflare Access login to open the playground.

The Worker uses the Singapore placement hint `aws:ap-southeast-1`, while the D1 primary runs in WEUR. **Worker placement / colo** displays `cf-placement` when available (for example, `remote-SIN`), falling back to the request's Cloudflare colo. Placement influences where the Worker executes; it does not force D1 reads onto a replica. Check each read's primary/replica metadata separately.

Workers Observability is enabled with persisted invocation logs and 100% log sampling. Server errors also emit a structured `d1-demo-error` log.

To redeploy, run these commands from this directory. Build with Vite+ first, then pass the generated output to `cf`:

```sh
vp build
cf deploy --prebuilt --mode production --dry-run
cf d1 migrations apply f4a50d02-a225-47fe-8157-0622c0553fe9 --dir db/migrations
cf deploy --prebuilt --mode production --no-provision
```

The migration command applies only pending files and uses the `d1_migrations` tracking table. Keep using this sequence for this database. Both checked-in migrations have been applied. Local development uses an independent SQLite database; run `vp exec void db migrate` after adopting this configuration to initialize it.

Try the control repeatedly from a region far from the Western Europe primary, then compare the manual-bookmark variant. A stale read is timing-dependent and is not guaranteed: a replica may already be caught up, or the read may hit the primary. D1 metadata identifies where each read actually ran. [D1 automatically places replicas in every supported region](https://developers.cloudflare.com/d1/best-practices/read-replication/#read-replica-locations); individual replica locations cannot be selected.

The database was provisioned with `cf d1 create --name voidzero-void-d1-bookmarks-weur --primary-location-hint weur --read-replication-mode auto`. Check its current region and replication settings with `cf d1 get f4a50d02-a225-47fe-8157-0622c0553fe9`. When switching databases, clear the `d1-demo-bookmark` cookie before testing the bookmark variant so it starts a session on the new database.

The two variants and timing modes share implementation but have independent profile rows per browser. In redirect mode, only `/with-bookmark` and `/api/with-bookmark` read and update the HttpOnly bookmark cookie using `setSession()` and `getBookmark()`. The control ignores that cookie even after visiting the fixed page. `X-D1-Bookmark` exposes the outgoing read bookmark for inspection in DevTools in both experiments, but the control never sends it back.

ISR is disabled and responses use `private, no-store`. Run in a single tab without concurrent writes: concurrent cookies can overwrite newer bookmarks, and a later save can replace the exact revision being compared. This public demo writes one profile row per visitor per variant and timing mode; use a disposable D1 database and remove it when finished. It is not an authentication or production data-management example.
