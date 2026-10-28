---
outline: deep
---

# Project Collaboration

A project hosted on a Void platform can have one owner and additional readers, collaborators, and project administrators. Team access is a platform feature; it is not available for projects deployed directly to Cloudflare.

## Roles

| Role                  | Access                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Reader                | View the project, usage, resources, deployments, builds, logs, and member roster. Cannot deploy.                          |
| Collaborator          | Reader access plus deploy, rollback, cancellation, migrations, secrets, database configuration, and deploy prerequisites. |
| Project administrator | Collaborator access plus domains, email destinations, GitHub configuration, invitations, roles, and member removal.       |
| Owner                 | Project administrator access plus project deletion.                                                                       |

Only the owner can create, list, renew, or revoke the project's CI deploy
credentials. Those credentials run unattended deployments as the billing owner
and remain independent of a member's login session, so collaborators and
project administrators deploy with their own account instead of minting a
durable owner credential.

The owner's plan, limits, and suspension state govern the project. A member's
own plan does not change the project's available usage, and acting through a
collaborator does not bypass an owner suspension. A project administrator is
not an installation administrator and receives no platform-wide access.

## Invite a Registered User

An owner or project administrator can invite someone by the email address registered to their existing account on the same platform:

```sh
void project team invite teammate@example.com --role collaborator
```

Pass `--project <slug>` to manage a project other than the linked project. An unknown email is rejected. A project invitation neither creates an account nor adds the address to a restricted-signup allowlist.

Invitations expire after seven days. If the platform cannot send invitation
email, the CLI prints the invitation ID and connection and acceptance commands
to share with the invited user. The invitation also appears when that user runs
`void project team pending` on the same platform.

List the roster and sent invitations with:

```sh
void project team list
void project team invitations
```

## Respond to an Invitation

Connect to the platform from your invitation, then see invitations addressed to
your account and respond using the invitation ID:

```sh
void connect api.example.com
void project team pending
void project team accept <invitation-id>
# or
void project team decline <invitation-id>
```

An invitation is bound to the registered account. Forwarding its ID does not let another user accept it.

These three commands use the active platform connection selected by
`void connect`, even inside a directory linked to another project or deployed
directly to Cloudflare. `VOID_API_URL` takes precedence when set. If you use
`VOID_TOKEN`, also set `VOID_API_URL` to the matching platform. Each command
shows the platform it contacts.

Accepting an invitation grants access without linking your current directory.
Open the invited application's directory and run `void project link` if it is
not linked yet. If it is already linked to another project, use a separate
checkout without `.void/project.json`, connect to the invited platform there,
and run `void project link`.

If the invitation is missing, check the platform and signed-in account. To
switch accounts, set `VOID_API_URL` to the invitation's platform URL, unset
`VOID_TOKEN` if present, then run `void account logout` and `void account login` using
the invited email address. For an expired or revoked invitation, ask a project
administrator to invite you again.

## Change or Remove Access

Owners and project administrators can change any non-owner member or revoke a pending invitation:

```sh
void project team role <user-id> reader
void project team remove <user-id>
void project team revoke <invitation-id>
```

A non-owner member can leave with `void project team leave`. The owner cannot leave; an installation administrator must [transfer ownership](./platform/administration/projects.md#transferring-project-ownership) first.

When a collaborator or admin is removed, leaves, or is changed to reader, the platform replaces the credentials the project's Workers use to call platform services such as AI, email, and remote bindings. The old credentials stop working once every Worker of the project has the new ones, usually within about 10 minutes, later while a deploy is running. If the replacement cannot finish, the old credentials keep working until it does, and owners and admins see a warning in `void project status` and `void project team list`. WebSocket connections reconnect once. While a Worker is switched to the new credentials, its calls to platform services can fail for a moment, a scheduled run can be skipped, and queue messages are delivered again a couple of minutes later.

Code the removed person deployed keeps running until you replace it. If you no longer trust it, deploy code you trust; the platform replaces the credentials again after that deploy. Earlier deployments of theirs kept for rollback keep the old credentials, so after a rollback to one of them, AI, email, and ISR revalidation fail until you deploy again.
