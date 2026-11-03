---
outline: deep
---

# Domains and Resources

## Adding a Domain

When your domain is ready, run:

```sh
void platform domain set example.app --plan
void platform domain set example.app
```

The command selects your installed platform (or offers a picker), finds or creates its zone, sets up DNS and routing, and verifies HTTPS before publishing the new application URLs. Set the management token as described in [installation setup](/guide/platform/installation/setup) when creating DNS or a zone. Grant the existing runtime token **Cache Purge: Purge** on the new zone; Void checks that permission through the running platform without asking you to paste its token again.

If nameservers, certificates, or project Zero Trust protection are pending, follow the printed guidance and rerun the same command. Void preserves each project's public or protected setting before making the new URLs available. Your workers.dev app URLs continue working during and after setup. Projects, deployments, secrets, and the platform API URL stay the same, so developers do not reconnect and configured login callbacks do not change. DNS and configuration changes may take time to propagate.

Use `--installation <id>` to select an installation explicitly, `--zone example.com` for an app domain such as `apps.example.com`, or `--dedicated-zone` for catch-all routing on a dedicated zone. Nested domains still need the wildcard certificate described below. This command adds the first domain; replacing an existing application domain is not currently supported. It uses the installed runtime and does not require `--runtime` or an app redeploy.

Choose an application domain whose wildcard leaves existing Worker Custom Domains reachable. Existing more-specific routes covering all requests can preserve those hostnames. If Void reports a conflict, choose another application domain; for a new installation, you can start with `void platform install --workers-dev` and add a suitable domain later.

Browser login sessions are specific to each origin. Apps using their own OAuth providers may need to register their new callback URLs. Void's built-in auth uses the request origin automatically unless the app overrides that configuration.

Apps on one application domain can set cookies that the other apps there receive. With a nested domain such as `apps.example.com`, apps can also set cookies for `example.com` and its other subdomains. Apps on `workers.dev` testing URLs can set cookies that every Worker on your account's `workers.dev` subdomain receives. If people outside your team can deploy, use a domain that serves only Void apps. A platform that serves thousands of independent developers can also apply to list its application domain on the [Public Suffix List](https://github.com/publicsuffix/list/wiki/Guidelines).

### What Changes in Testing Mode?

In testing mode, each app gets a `workers.dev` URL. These URLs continue working after you add a domain; new apps then use the domain.

Testing URLs support WebSockets, SSE, and shared ISR storage, but skip the extra edge response cache. Their forwarding Workers remain for manual cleanup after uninstall. Platform disablement and project suspension still block their traffic.

## Other Domain Options

::: details Custom API hostname

Pass `--control-plane-domain platform.example.net` during installation. The hostname must belong to a zone the selected account and management token can manage. Omitting it keeps the API on `workers.dev`.

:::

### Using a Nested Application Domain

::: details Use apps.example.com within an existing company zone

An app at `my-app.apps.example.com` needs a certificate for `*.apps.example.com`. Universal SSL for `example.com` only covers first-level hostnames. Configure an active wildcard certificate with [Advanced Certificate Manager](https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/), a paid add-on, or use an existing custom wildcard certificate before installation:

```sh
void platform install --application-domain apps.example.com --zone example.com --plan
```

The management token needs **SSL and Certificates: Read** (or Edit) on that zone for the certificate check. Void does not order certificates or enable paid products automatically. Leave `--dedicated-zone` off: that flag is only for installations whose application domain is the entire zone and adds catch-all routes for otherwise unmatched traffic.

:::

## Project Custom Domains

Projects can serve their own domains, such as `www.example.com`, through Cloudflare for SaaS custom hostnames. This needs a dedicated application zone. Turn it on when installing, or later with an upgrade:

```sh
void platform install --application-domain example.app --zone example.app --dedicated-zone --custom-domains
void platform upgrade <installation-id> --custom-domains
```

The runtime token needs **SSL and Certificates: Edit** on the application zone. Void includes it in the runtime token's creation link and checks it before deploying; a token created before custom domains were on needs it added. Before adding the first domain, set up Cloudflare for SaaS on that zone once:

1. Create a proxied DNS record for `cname.<application domain>`, for example an `AAAA` record pointing to `100::`.
2. Open **SSL/TLS > Custom Hostnames**, enable Cloudflare for SaaS, and set `cname.<application domain>` as the fallback origin.

A project owner then runs `void domain add <hostname>`. Void prints the CNAME target, `cname.<application domain>`, and the TXT records that prove ownership. Once the records resolve and the certificate is issued, the dedicated zone's catch-all routes send the hostname to the project.

## Optional Dashboard

The API's `/admin/` pages are included in the core installation. You can deploy
the optional user dashboard separately and configure its HTTPS origin during
installation with `--dashboard-url https://dash.example.com`.

For an existing installation, preview and apply the configuration with:

```sh
void platform repair <installation-id> --dashboard-url https://dash.example.com --plan
void platform repair <installation-id> --dashboard-url https://dash.example.com --yes
```

The origin must contain no credentials, path, query, or fragment. Void saves it
for login callbacks and keeps it across upgrades and repairs. The command does
not create a dashboard Worker or DNS records. Follow the source app’s
[standalone dashboard preparation](https://github.com/voidzero-dev/void/tree/main/platform/packages/dashboard#standalone-deployment)
to deploy your own copy with an unused Worker name, your dashboard hostname,
and the installed API Worker’s service binding. Set its `API_URL` to the public
API origin, `DASHBOARD_URL` to the dashboard origin, and `SITE_DOMAIN` to the
installation’s application domain. Omit the option to keep the saved origin.
The dashboard provides sign-in, linked login methods, and sign-out; use the CLI
for user project and team management.

If Access protects the platform, its application must cover this dashboard
origin too. Configure the origin when installing protection. To change it on an
already protected platform, deliberately remove protection through authentication
configuration, apply the origin, then enable protection again. Choose a separate
admission rule first if signup depends on the Access gate. Maintenance stops if
the configured origin is outside the active coverage.

## Cloudflare footprint

New platform resources use deterministic `void-<installation-name>-<role>` names where Cloudflare allows them, such as `void-team-api`. Choose an unused installation name in the account; Void stops on an unowned name conflict instead of replacing that resource. Existing installations keep their recorded names, including older names with suffixes.

| Resource                                  |                                 Count | Purpose                                                                                       |
| ----------------------------------------- | ------------------------------------: | --------------------------------------------------------------------------------------------- |
| Workers                                   | 5, plus one per app using workers.dev | API/control plane, proxy, tail ingestion, dispatch, email gateway, and test-origin forwarders |
| KV namespaces                             |                                     3 | Routing, ISR cache, and static asset storage                                                  |
| R2 buckets                                |                                     1 | Static and deployment assets                                                                  |
| Queues                                    |                                     3 | Usage events, cron firing, and deployments                                                    |
| Workers for Platforms dispatch namespaces |                                     1 | User application Workers                                                                      |
| Hyperdrive configurations                 |                                     1 | External platform PostgreSQL                                                                  |
| AI Gateways                               |                                     1 | Installation-isolated AI routing and metering                                                 |
| Proxied wildcard DNS records              |                                0 or 1 | Created only when an application domain is configured                                         |
| Zones                                     |                                0 or 1 | Created only when the requested application zone is absent                                    |

The API Worker uses four Durable Object classes for usage, cron scheduling, error monitoring, and concurrency. Worker bindings create the request and log datasets in Analytics Engine, which must be [enabled for the account](/guide/platform/installation/prerequisites#if-cloudflare-rejects-analytics-engine). The core installation doesn't create Container applications, a GitHub App, a dashboard Worker, or build Workers.
