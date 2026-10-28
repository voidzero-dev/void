---
title: Configurable Platform Login Methods
status: implemented
created: 2026-09-18
---

# Configurable platform login methods

A Void platform can use GitHub, Google, generic OpenID Connect (OIDC), or
Cloudflare Access for human login. The installer accepts more than one method.
The API-hosted administrator UI and `void platform config auth` manage methods
after installation without redeploying. The current setup and command syntax
are in the [self-hosting guide](../../../docs/en/guide/self-hosted-platform.md)
and [administration guide](../../../docs/en/guide/platform-administration.md).

## Installation and authority

GitHub login is optional. A new installation chooses at least one method;
existing installations keep their configured methods and signup policy during
upgrade. The installer enables the method used to confirm the first
administrator. Additional selected methods stay pending until an administrator
tests and enables them.

The first administrator completes an installation-bound, single-use setup
ceremony. A person who simply visits the platform first cannot gain the role.
The browser shows the identity being promoted before confirmation. Recovery
targets an existing administrator and requires installation ownership, the
original encrypted recovery credentials, a real provider test, and explicit
identity confirmation. It cannot create a new administrator or reopen signup.

Runtime support is separate from administrator enablement. The deployment
manifest and discovery contract announce supported methods; PostgreSQL holds
the active configuration, connection revisions, tests, and human sessions.
Live settings take precedence over saved setup files during upgrades and
repair. Provider secrets are encrypted, write-only in management APIs, and
included in keyring rotation and recovery.

The platform authentication database path uses uncached PostgreSQL reads.
Immediate provider disable and session revocation depend on authoritative
read-after-write behavior; Hyperdrive result caching on that path would break
the guarantee. Application database settings remain independent.

## Login and identity

Google, generic OIDC, and Cloudflare Access login share the OIDC path; GitHub
keeps its OAuth adapter. OIDC login validates issuer, audience, signature,
expiry, subject, nonce, state, and PKCE. A Google Workspace restriction uses
the signed hosted-domain claim, not an email suffix or request hint. The
Cloudflare Access login method is a distinct configuration of the OIDC path.
An Access service token remains a machine credential and cannot log in as a
person.

An external identity is scoped by its login connection and stable provider
subject. The same email address at two providers does not automatically merge
accounts. An existing user links another identity through an explicit
authenticated flow, with a fresh provider proof. This keeps project ownership
on the same Void user and prevents an email match from granting administrator
access. Existing provider identities are preserved during migration.

Login eligibility and account creation are separate choices. Administrators
can select company-approved users, invitation or allowlist admission, or
public signup. Company admission requires an enforceable company rule; an
unrestricted social login alone does not prove employment. A colleague who
passes a configured Cloudflare Access company gate may then sign in with
GitHub, even when their GitHub email differs from their company email.
Accounts created this way have the ordinary user role. A provider without a
verified email can be admitted through its exact connection and subject.

## Cloudflare Access boundaries

Cloudflare Access login and Access protection of the platform are independent
settings. An installation can use login alone, protection with another login
method, or both. Enabling or disabling an Access login connection does not
silently change the outer protection gate.

The installer supports creating dedicated Access applications or connecting
existing ones, including applications in another Cloudflare account. Managed
protection covers the platform UI and API origins. Company policy is checked
for human access; scoped service credentials serve protected machine paths
without turning into human sessions. A disabled or missing company gate does
not silently turn company admission into public signup.

Cloudflare management authority is used for setup and protection changes.
The platform does not keep a general Cloudflare management token to operate
its login UI. Installations that do not select Access make no Access
provisioning request.

## Live changes and revocation

An administrator can add, configure, test, enable, and disable connections.
Tests bind to a particular configuration revision and authenticated identity;
changing credentials or policy requires a new test. Disabling a method keeps
its configuration and linked identities but rejects new login and revokes
human sessions established through it, including derived operator sessions.
Re-enabling does not restore those sessions.

Disabling preserves at least one usable administrator path and at least one
enabled login method. Every human-token consumer checks the authoritative
session and connection state, including proxy access and long-lived streams.
A human `VOID_TOKEN` used in CI is still a human session. Separate project
deployment, build, and app-runtime credentials retain their own scope and
are not revoked merely because a login method is disabled.

Access protection changes have their own coverage and company-proof checks.
Changing protection ends current human sessions. An incompatible older
runtime cannot be used to roll back an installation with active authentication
configuration that it cannot enforce.

The core implementation is verified by repository tests and packed-runtime
checks. Real identity-provider sign-in and live Cloudflare provisioning require
separate acceptance on the selected installation; this source design record
does not claim those provider checks occurred.
