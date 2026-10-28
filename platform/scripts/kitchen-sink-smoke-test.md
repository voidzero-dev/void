# Kitchen Sink Smoke Tests

Use `playground/kitchen-sink` to verify a platform with a disposable app. The automated suite resets the app's database, KV, and storage, then exercises navigation, mutations, authentication, queues, and caching.
The reset must return a successful response with `ok: true`; otherwise the suite stops before acceptance checks. It deletes the heartbeat and revalidation keys with the rest of the fixture KV state.

Queue submission must also produce its consumer result within 60 seconds. A
consumer timeout fails acceptance with queue/dispatch and D1 diagnostics.

Prepare with `--runtime` to add an isolated queue retry consumer, authenticated
version/log/AI routes, and typed WebSocket echo. Set `SMOKE_RUNTIME=1` and supply
the app's existing secret privately through `SMOKE_E2E_TOKEN` to enable browser
test 14, which requires a fresh message round trip within 30 seconds. The
WebSocket handshake carries the secret as a header. These fixtures require a
configured nonempty secret and remain separate from the default hosted CI app.

Prepare the hosted fixture with `oxnode platform/scripts/kitchen-sink-platform-fixture.ts`, then deploy the isolated app directory it prints to the platform you want to test. The basic fixture omits Sandbox so it works on platforms without Containers access. For Sandbox acceptance, pass `--sandbox` when preparing the fixture and set `SMOKE_SANDBOX=1` when running the tests. The platform must enable Sandbox and have Workers Paid, Containers access, and the required runtime-token permissions described in the [Sandbox guide](../../docs/en/guide/sandboxes.md). Pass the deployed URL explicitly from the repository root:

```sh
vp exec playwright install chromium
SMOKE_URL=https://kitchen-sink.apps.example.com oxnode platform/scripts/kitchen-sink-smoke-test.ts
```

Use an app whose data can be deleted. The script has no default destination. If Cloudflare Access protects the app, supply that application's `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` from your secret manager.

The hosted staging CI workflow initializes missing server values before deploying its existing `kitchen-sink` project at `https://api.staging.void.cloud`. This is CI fixture setup: it sets `APP_NAME` to `Kitchen Sink`, `API_URL` to `https://api.example.com`, and generates a random `SECRET_KEY` only when absent. It validates new values against `env.ts`, preserves configured secrets, and uses the workflow's existing staging credentials. It never reads a local `.env` or prints values. Smoke jobs are serialized; avoid editing these fixture secrets manually during setup because the secret API uses an upsert after listing names.

Setup failures report the operation and HTTP status when available, without printing API response bodies or secret values.
If the API confirms a value was stored but updating the old worker failed, setup verifies the stored name and continues without retrying the write. The following deployment applies all stored values and must pass the smoke tests. Other errors, or a missing stored name, still fail setup.

The checklist below can also be run manually or with browser automation. Use unique values for created records, wait for each mutation to appear, and remove test records afterward. KV listings are eventually consistent; poll them instead of relying on a fixed delay. Record each result and report failures after completing the remaining cases.

## Email acceptance fixture

Pass `--email` when preparing the fixture to add inbound handlers and `/api/acceptance/email`. Deploy it only to a disposable project on an email-enabled platform. Both `GET` and `POST` require `x-void-e2e-token` to match the app's `SECRET_KEY`; the fixture never copies local `.env` values. Set the required `APP_NAME`, `API_URL`, and random `SECRET_KEY` through the linked project's secret commands before deployment.

- `POST /api/acceptance/email` accepts `sendEmail()` options as JSON. Send a unique subject to a verified test mailbox and confirm both provider acceptance and actual mailbox delivery. Repeat the identical body and `idempotencyKey` to confirm one delivery; change the body with the same key to confirm `IDEMPOTENCY_CONFLICT`. Check partial recipients, sender restrictions, and administrator-configured quotas separately.
- Send inbound mail to `<slug>+support@<shared-mail-domain>` and confirm `GET /api/acceptance/email?subject=<encoded-subject>` returns the `support` route, original text/HTML, and attachment metadata. For a registered custom domain, use `support@<domain>` instead. The KV receipt expires after one hour; poll because KV reads can be eventually consistent.
- Verify tag precedence with `<slug>+support+ticket-42@<shared-mail-domain>` (`support-ticket`, `params.ticket= ticket-42`) and `<slug>+support+vip@<shared-mail-domain>` (`support-vip`). An unmatched recipient reaches `default`.
- Subjects beginning with `REPLY ` send a threaded reply. Verify its arrival and `In-Reply-To`/`References`, and inspect `void email logs` for the action outcome.
- Subjects beginning with `FORWARD ` forward to the verified address in the original message's `x-void-e2e-forward` header. Shared-domain native events support forwarding; customer-zone relayed mail records `UNSUPPORTED_ACTION` without sending. Confirm that recorded distinction.
- Subjects beginning with `REJECT ` reject with `Void email acceptance reject`. Verify the sender's non-delivery outcome and the platform's inbound log.

Use `void email usage`, `destinations`, and `logs` to compare API outcomes with recorded provider outcomes. Test admin email policy/caps and custom-domain readiness, secret rotation, and removal through the operator UI or CLI. A provider acceptance result alone does not prove mailbox delivery.

## Sandbox runtime acceptance fixture

`--sandbox` also adds `POST /api/acceptance/sandbox`, authenticated by `x-void-e2e-token` matching the app's `SECRET_KEY`. The endpoint runs through lazy startup; text, binary, Blob, streaming and relative file operations; metadata, rename, listing and removal; process cwd/env/stdout/stderr; piped stdin; PTY/resize/kill; cancellation; HTTP port access; disabled and enabled Internet access; isolation between IDs; and destroy/restart with ephemeral files. It uses unique IDs, limits idle time to 30 seconds, and stops its containers after the checks.

Set `SMOKE_SANDBOX=1` and `SMOKE_E2E_TOKEN` to the fixture's secret when running the smoke script to include this test. Select a test user plan with enough runtime and at least two concurrent Sandbox instances, such as `solo`; the platform's `free` user tier has only one runtime second per month. The result includes the checks completed before any failure. The test allows up to three minutes for cold starts, and makes one permitted GET to Cloudflare's trace endpoint while testing Internet access.

## Test Cases

### 1. Home page SSR + asset caching

1. Visit `/`.
2. Assert the page contains "Kitchen Sink" and "Auth" in its text.
3. Inspect the page's HTML source for hashed asset URLs (e.g. `.js` or `.css` files with hash in the filename).
4. Use the browser to GET one of those asset URLs with a unique query parameter and `credentials: 'omit'`. For a public target, assert `Cache-Control` contains `immutable` without a private/no-cache/no-store directive. For an Access-protected target, keep the service-token headers configured on the browser context and assert `private` and `immutable` without public/no-cache/no-store directives: the authenticated staging request permits browser reuse while excluding shared caching, even when browser cookies are omitted. A unique URL bypasses the browser's stored response without sending cache-bypass directives to the origin. Inspect a fresh `GET` response rather than a browser-cached response or `HEAD`.

   ```js
   const el =
     document.querySelector('script[src*="/assets/"]') ||
     document.querySelector('link[href*="/assets/"]');
   const url = el.src || el.href;
   const response = await fetch(url + '?smoke=' + Date.now(), { credentials: 'omit' });
   response.status + ' ' + response.headers.get('cache-control');
   ```

   Expect `200 public, max-age=31536000, immutable` for a public target or `200 private, max-age=31536000, immutable` for the Access-protected staging target. Cloudflare also documents that its [Cache API is unavailable for Workers fronted by Access](https://developers.cloudflare.com/workers/runtime-apis/cache/#background); this authenticated check does not assert an edge-cache hit.

### 2. SPA navigation (no full reload)

1. Visit `/`.
2. Run JS to set a marker on window: `window.__SPA_MARKER = true`.
3. Click the "DB" link (navigates to `/db`).
4. Wait for the h1 to contain "DB".
5. Assert the URL is now `/db`.
6. Run JS to check `window.__SPA_MARKER` — assert it is still `true` (proves no full page reload).
7. Click the "KV" link (navigates to `/kv`).
8. Wait for the h1 to contain "KV".
9. Assert the URL is now `/kv`.

### 3. Layout persistence across navigation

1. Visit `/`.
2. Run JS to stamp the nav element: `document.querySelector("nav").__stamp = 1`.
3. Click the "Env" link (navigates to `/env`).
4. Wait for the h1 to contain "Env".
5. Run JS to read `document.querySelector("nav").__stamp` — assert it equals `1` (proves layout DOM was not recreated).

### 4. DB — create and delete a note

1. Visit `/db`.
2. Fill the title input (placeholder "Note title") with a unique value like `smoke-<timestamp>`.
3. Fill the body input (placeholder "Note body") with `test body`.
4. Click the "Add Note" button.
5. Wait for the unique title to appear in the page text.
6. Assert the page contains both the title and "test body".
7. Find the table row containing the title and click its "Delete" button.
8. Wait for the title to disappear from the page.

### 5. KV — set and delete a key

1. Visit `/kv`.
2. Fill the key input (placeholder "my-key") with a unique value like `smoke-kv-<timestamp>`.
3. Fill the value input (placeholder "my-value") with `hello`.
4. Click the "Set" button.
5. Fill the `lookup` input with our key, confirm `<key> = <value>` appears on page.
6. Reload page to check if the key appears in the table. **This will take a while as kv.list() is eventually consistent, not instant**
7. Find the table row containing the key and click its "Delete" button.
8. Wait for the key to disappear from the page.

### 6. Storage — upload and delete a file

1. Visit `/storage`.
2. Upload a file named `smoke-test.txt` with content `hello world` via the file input.
3. Click the "Upload" button.
4. Wait for "smoke-test.txt" to appear in the page.
5. Find the table row containing "smoke-test.txt" and click its "Delete" button.
6. Wait for "smoke-test.txt" to disappear from the page.

### 7. Env — displays bindings

1. Visit `/env`.
2. Assert the page text contains "DB" and "KV".

### 8. Queues — send message and see consumer result

1. Visit `/queues`.
2. Fill the key input (placeholder "my-key") with a unique value like `smoke-q-<timestamp>`.
3. Fill the value input (placeholder "my-value") with `queued`.
4. Click the "Send to Queue" button.
5. Poll for up to 60 seconds: reload `/queues` every 2-3 seconds and check if the unique key appears in the "Processed Results" table. Results are written to D1 (strongly consistent), so they appear immediately once the consumer processes the message.
6. Assert the key was found within the timeout.
7. Delete the test row from the table.

### 9. Auth — register, login, protected route, logout

1. Visit `/auth`.
2. Assert the page shows "Not logged in".
3. Click the "Register" tab button.
4. In the "Email Register" section:
   - Fill the email input with a unique email like `smoke-<timestamp>@example.com`.
   - Fill the password input with `s3cureP@ss!`.
   - Fill the name input (placeholder "Name") with `Smoke User`.
   - Click the "Register" submit button.
5. Wait for "Not logged in" to disappear — assert the page now shows the email address (user is logged in).
6. Click the "GET /api/profile" button.
7. Wait for a `<pre>` element to appear containing `"user"`.
8. Assert the `<pre>` response contains the email address.
9. Click the "Logout" button.
10. Wait for "Not logged in" to reappear.
11. Click the "Login" tab button.
12. In the "Email Login" section:
    - Fill the email input with the same email used above.
    - Fill the password input with `s3cureP@ss!`.
    - Click the "Login" submit button.
13. Wait for "Not logged in" to disappear — assert the user is logged in again.

### 10. Cron — heartbeat is running

1. Visit `/cron`.
2. Poll for up to 150 seconds for the heartbeat timestamp, allowing the next scheduled invocation and KV propagation.
3. Assert it is a valid date recorded after the fixture reset, within the last 5 minutes, and no more than one second in the future. An old heartbeat cannot satisfy the check.
4. If no fresh heartbeat arrives, fail the test. Check cron registration and dispatch logs, then verify the fixture's KV binding and `cron:last-heartbeat` key.

### 11. ISR Revalidation

1. Visit `/revalidate`.
2. For a public target, poll for up to 15 seconds for an actual `x-isr-cache: HIT` response before continuing. Access-authenticated targets bypass the shared cache.
3. Note the valid date in the **Rendered at** field.
4. Click **Revalidate /revalidate** and assert the POST response succeeds. The app displays a failed purge as an error and does not record a success timestamp.
5. Wait for the button to return to its non-disabled state.
6. Poll reloads for up to 15 seconds until **Rendered at** is a different valid date. A nonempty **Last revalidation** field alone does not establish that the cached page was purged.

### 12. Sandbox — files, command execution, and output

Prepare and deploy the fixture with `--sandbox`, then run with `SMOKE_SANDBOX=1`.

1. Visit `/sandbox` and replace the analyzer with a function that returns a unique marker and the request count, and writes a marker to stderr.
2. Click **Run in Sandbox** and allow up to 90 seconds for the first container start.
3. Assert the API returns `ok: true`, exit code `0`, the unique marker and a positive request count. This exercises writing input and executable files, running Node, and reading the output file.
4. Assert stdout contains the result and stderr contains the marker, then confirm the result appears in the page.
