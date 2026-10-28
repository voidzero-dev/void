---
outline: deep
---

# Users and Projects

## Managing Users and Projects

Start by finding the user you want to inspect:

```sh
void platform user list --search teammate
void platform user show <user-id>
```

Use the ID from the list in the second command. The detail view shows the user's projects and usage. You can change their plan or list just their projects:

```sh
void platform user plan <user-id> pro
void platform project list --user <user-id>
void platform project show <project-id>
```

Project details include resources, domains, and recent builds and deployments. The [command reference](../../../reference/cli/platform.md#operator-commands) also covers suspending and restoring users, deleting projects, and removing accounts.

In the admin dashboard, open a project to view its team. Search for a platform user and choose a role to add them immediately; an email address is not required. You can also change or remove existing members. Pending invitations created through other project workflows remain visible until accepted or revoked. If email is unavailable for a pending invitation, share its ID so the user can accept it with `void project team accept <invitation-id>`. The owner cannot be removed from the team; transfer ownership first. Removing a collaborator or admin, changing one to reader, or suspending or deleting their account [replaces the project's platform credentials](../../project-collaboration.md#change-or-remove-access), the same as the CLI.

### Transferring Project Ownership

Only an installation administrator can change a project's owner. The new owner must already have an account on this platform. In the dashboard, search for the new owner on the project page and preview the transfer before applying it. The CLI accepts a user ID:

```sh
void platform project owner <project-id> <new-owner-user-id> --plan
void platform project owner <project-id> <new-owner-user-id> --yes
```

The preview shows both owners, their plans and suspension state, blockers, and the changes to routing and usage counters. Wait for active rollbacks and builds to finish. For an ordinary active deployment, wait or use `void platform deployment cancel <id>`; rollback deployments cannot be canceled. A managed Sandbox controller also blocks transfer until its cleanup completes, even if no Sandbox container is running; the preview identifies the deployment that owns it.

After the transfer, the former owner becomes a project administrator. Existing project-scoped CI deploy credentials are revoked; create replacements as the new owner. The new owner's plan and limits apply immediately. Usage before the transfer remains charged to the former owner; later usage is charged to the new owner. If an apply reports partial convergence, inspect the project and operator event log before repeating it.

By default, new users on a self-hosted installation start with the `custom` profile, which
does not cap application requests, AI usage, deployment frequency, or retained
Worker deployments. Named profiles such as `pro` apply the platform's quota and
retention policies; they do not purchase Cloudflare services or bill your users.
Storage figures are not a hard storage-quota boundary. Set an operating budget
and retention policy before opening signup beyond your invited team.

Use [Plans and Limits](/guide/platform/administration/plans) to define your own
plans, change limits, or choose a different default for new accounts.

The last active administrator cannot be deleted or suspended, including through
the browser admin UI. Another administrator must still have access. Automatic
usage limits do not remove administrator access and do not count as a manual
suspension.

When removing another administrator, Void revokes their administrator access
before changing application traffic or deleting resources. If cleanup fails,
access stays revoked and the error describes the partial result. A remaining
administrator can inspect it and retry cleanup.
