---
title: GitHub Identity Linking and Shared Organization Installations
status: implemented
created: 2026-06-23
---

# GitHub identity linking and shared organization installations

Deploy-on-GitHub uses a GitHub identity independent of the provider used to
sign in to Void. An authenticated user can run `void github link` to attach a
GitHub account to their existing Void account. `void github install` starts that
flow automatically when the identity is missing. Linking does not rely on email
equality and does not create another Void user.

The GitHub App installation and repository connection are separate proofs.
Linking an identity proves control of a GitHub account; it does not grant access
to an App installation or its repositories. See the
[deployment guide](../../../docs/en/guide/deployment.md) and
[CLI reference](../../../docs/en/reference/cli.md) for the user workflow.

## Identity-linking boundary

`GET /github/link-url` starts a GitHub App user-OAuth flow with signed state, a
localhost redirect and PKCE. The public `/github/link-callback` exchanges the
GitHub code and returns a short-lived, signed link code to that localhost
callback. It does not change an account. The authenticated
`POST /github/link/complete` verifies the link code and PKCE verifier, then binds
the GitHub identity to the bearer of the Void token. A GitHub identity already
linked to another Void user is rejected; repeating a link for the same user is
idempotent. The transient GitHub user token is not stored.

The public installation callback retains its signed-state continuity check:
the GitHub account that completes installation must match the account that
started it. A personal installation can use the installation-account match when
GitHub App user-OAuth is unavailable. An organization installation requires a
successful GitHub user-token proof. This prevents someone from binding another
person's installation to their Void account merely by sending that person an
installation URL.

The GitHub App must register the API's `/github/link-callback` URL. Shared
organization installations also use `/github/join-callback` and
`/github/connect-authorize-callback` and require the App's user-OAuth
credentials. The organization webhook subscription and member-read
permission enable prompt removal handling. Source-built managed-build
installations configure these GitHub App capabilities explicitly; the core
self-hosted installer does not set up GitHub builds.

## Shared organization installations

An organization has one GitHub App installation, and multiple Void users can
connect their own projects through it. `void github join` uses a fresh GitHub
user-OAuth proof to discover installations visible to the caller. The platform
caches that visibility in `github_installation_members` with an expiry. The
cache does not contain a GitHub token or authorize repository access. The CLI
can join automatically during an interactive `void github connect`.

Every organization repository connection, including one made by the person who
installed the App, requires a separate browser proof that the connecting GitHub
user can access that specific repository. The signed connect grant carries the
repository's immutable GitHub ID and is redeemed under the connecting user's
Void identity. The platform records the authorizing Void user on the project
connection. Organization installations have no owner. Personal installations
retain their installation-owner path.

An installation membership permits a user to see and select an organization
installation; it does not disclose the installation's private repository list
or authorize another user's project. The project settings permission is checked
when a repository is connected.

## Revocation and missed webhooks

On `organization/member_removed`, the platform deletes the affected membership,
severs the repository connections that member authorized,
and cancels their active builds. A durable revocation mark keyed by the GitHub
account and installation rejects join or connect artifacts minted before the
removal, including artifacts created before a Void account was linked. The
installation and connection paths serialize with removal so an in-flight
connection cannot commit after the revocation without seeing it.

An hourly catch-up job asks GitHub for failed webhook deliveries and attempts
bounded redelivery. A GUID ledger prevents repeated automatic redelivery of
the same delivery. Cached membership expires even if a webhook is missed, but
the cache alone cannot sever a connection that was already authorized. The
`member_removed` handler and webhook replay provide that connection cleanup.
The remaining live-authority limit is GitHub's propagation delay: a new OAuth
proof can briefly succeed after an organization removes a user but before
GitHub's user-installation APIs reflect the change.

This design intentionally does not persist refreshable GitHub user tokens.
Repository access is established at connect time; later removal is handled by
the organization webhook and failed-delivery replay. Existing deployed sites
remain owned by their Void projects when a GitHub connection is severed.
