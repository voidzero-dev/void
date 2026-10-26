---
outline: deep
---

# Disable and Uninstall

To pause a platform without removing its data:

```sh
void platform disable [id] --plan
void platform disable [id]
```

Disabled platforms reject application traffic while retaining domains and routes. The platform API also rejects requests, so CLI commands that use it, including login and deploy, fail until you enable the platform again. Only the administrator status page at `<api-url>/admin/status` and administrator sign-in stay available. Repair and upgrade preserve that state.

Enabling redeploys the platform Workers from the selected runtime, verifies them, and then restores traffic. Pass `--runtime <path>` to enable with a custom platform build:

```sh
void platform enable [id] --plan
void platform enable [id]
```

Add `--yes` to commands that make changes in a non-interactive shell.

While disabled, the platform retries queue batches after five minutes instead of delivering them to apps. Queue retention and retry limits still apply. For a long pause, plan a dead-letter queue or another way to recover messages.

## Uninstall

Preview removal before applying it:

```sh
void platform uninstall [id] --plan
void platform uninstall [id]
```

Uninstall blocks platform traffic, removes Queues that no remaining platform Worker uses, and lists the resources left for you to review. Use `--plan` to review deletions and retained resources before making changes. By default, Workers, the Queues they use, KV, R2, Hyperdrive, the dispatch namespace, and AI Gateway remain in your account. Adopted resources, external PostgreSQL, and zones are always retained. To install a platform again, use a new empty PostgreSQL database. Email Routing settings are retained; `--purge-resources` removes only the rules that send mail to the platform. DNS records, routes, custom domains, and Cloudflare Access resources are retained unless you use `--purge-resources`.

When uninstall finishes, the record of what was kept stays at `~/.void/platforms/<account-id>/<installation-id>.json`. Without `--purge-data`, the encrypted credentials file `<installation-id>.recovery.enc` next to it is kept too. Delete both once you have finished the manual cleanup below.

To also remove eligible data resources owned by the installer:

```sh
void platform uninstall [id] --purge-data
```

Even with `--purge-data`, Void retains Workers, the Queues they use, R2, AI Gateway, DNS records, routes, custom domains, Access resources, adopted resources, external PostgreSQL, and zones. Review those in the Cloudflare dashboard if you want to remove them, or use `--purge-resources`.

### Remove everything Void created

To delete every Cloudflare resource the installation created:

```sh
void platform uninstall [id] --purge-resources --plan
void platform uninstall [id] --purge-resources
```

`--purge-resources` includes `--purge-data`. It also deletes the platform Workers, Queues, the application Workers left in the dispatch namespace, the R2 bucket and its objects, the AI Gateway, the platform DNS record, Worker routes and custom domains, and the Access applications and service tokens the installer created. The plan lists each resource in deletion order, and everything that stays. If Cloudflare shows that the AI Gateway was created after installation, for example because it was deleted and created again under the same name, it is kept and listed.

If the platform sends email, it first deletes the Email Routing rules in the sender domain's zone that send mail to the platform email gateway Worker, and resets such a catch-all rule to drop mail. It leaves Email Routing enabled and keeps the sender domain's MX, SPF, and DKIM records.

It never removes zones, adopted resources, external PostgreSQL, other Email Routing settings, Analytics Engine datasets, Access policies or identity providers you chose, or API tokens. Revoke the API tokens you created for the platform afterward.

Before making changes, `--purge-resources` checks that no projects remain and that it can read the resources it plans to delete. Delete any projects with `void project delete <name>` first.

Set `CLOUDFLARE_API_TOKEN` to a token with the Edit permissions listed by `--plan`. Browser login cannot delete DNS records or Access resources. Access resources in a separate identity account need permissions in that account; email-enabled platforms also need **Zone → Email Routing Rules → Edit** for the sender domain's zone.

The read checks cannot verify Edit permissions. If a deletion is denied, uninstall may have already disabled traffic or removed resources. Update the token permissions and rerun the command to resume.

If a route, custom domain, DNS record, or Access resource no longer matches what the installation recorded, for example a route that now sends traffic to another Worker, it is kept and listed with the reason, and uninstall continues. Do not run `--purge-resources` while someone else is changing the platform's Workers, routes, or custom domains: a change made after Void checks a resource and before it deletes it is not detected.

If Cloudflare refuses a deletion, for example because a Worker you created yourself still sends logs to the platform tail Worker, uninstall stops and names the resource. Fix it, then rerun the same command to continue.

If a plain or `--purge-data` uninstall stopped before it finished, rerun it with `--purge-resources` to also delete what it kept. Once an uninstall finishes, use the manual steps below instead.

### Remove retained resources

After an uninstall without `--purge-resources`, Cloudflare refuses to delete a resource while a platform Worker still uses it. In the Cloudflare dashboard, remove what is left in this order, skipping anything already gone:

1. Delete the platform DNS record, Worker routes, and custom domains.
2. If the platform sends email, open **Email Routing** for the sender domain's zone. Delete the routing rules and any catch-all rule that send mail to the platform email gateway Worker. Then remove the sender subdomain from Email Routing, or disable Email Routing if you enabled it only for the platform.
3. Open each platform Queue and remove the platform API Worker from its consumers.
4. Delete the platform Workers, except the tail Worker (its name ends in `-tail`).
5. Delete the platform Queues.
6. Delete the application Workers in the dispatch namespace, then delete the namespace.
7. Delete the tail Worker. Cloudflare refuses while other Workers still send logs to it.
8. Delete the platform KV namespaces and Hyperdrive configuration.
9. Empty the R2 bucket, then delete it.
10. Delete the AI Gateway.

If installation configured Cloudflare Access, the uninstall plan lists its recorded applications and service tokens with their ownership and IDs. Review them in Zero Trust after uninstall. Remove installer-created resources only when nothing else uses them; resources connected from an existing company setup remain under their owner's control.

Uninstall does not remove the applications created for [project Zero Trust](/guide/platform/administration/zero-trust). While Zero Trust is enabled or still has Access applications, uninstall and `--plan` stop before any change and list those applications. Run `void platform zero-trust disable` first. Uninstall reads this from the installation database, so it also stops when the database cannot be reached.

If the installation database is permanently gone and cannot be restored, there is no uninstall command that can clear the local installation record or list its Cloudflare resources. Once you have decided not to recover that installation, delete `~/.void/platforms/<account-id>/<installation-id>.json` and any sibling `<installation-id>.recovery.enc` or `<installation-id>.secrets.enc` files. This removes only local state and encrypted credentials; it does not delete Cloudflare resources. Review and remove those resources manually using [Remove retained resources](#remove-retained-resources).

If no platform user exists yet, for example because first administrator setup did
not finish, nobody can run `zero-trust disable`. Uninstall then turns off project
Zero Trust and deletes its applications itself. Run it on the computer that installed
the platform. If the uninstall asks you to, update an older platform runtime first.

::: details Why some resources require manual cleanup

Resources that may have been shared or repurposed require manual review before deletion. Void verifies ownership, keeps those resources in place, and blocks platform traffic.

If removal is interrupted, rerun the command to continue. If a resource has changed ownership, resolve the reported conflict before retrying.

External PostgreSQL and its data always remain under your control.

:::
