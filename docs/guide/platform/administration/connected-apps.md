# Connected apps

A connected app is a separate application registered as an OAuth client on your Void installation. Users sign in on Void and decide whether to connect it. The application operator may be different from the platform administrator.

## Register an application

Open **Admin → Connected apps**. Enter the app name, its operator, and each exact HTTPS callback URL on a separate line. Wildcards and callback query strings are not supported. Enable individual publish approvals if the app builds and deploys projects. Enable private previews to run checkpoints before publishing. Existing clients have an **Enable private previews** button; users must connect again to consent to that permission.

Save the returned client ID and secret on the app's server. Void shows the secret once. The client secret authenticates that application; it does not grant access to users' accounts. Register a new client if you need replacement credentials, then disable the old one.

**Disable and revoke access** invalidates the client's grants, pending sign-ins, and publish approvals. Registration and disablement appear in the operator audit.

Local development permits exact HTTP callbacks on localhost when the platform's development authentication bypass is explicitly enabled. Production clients require HTTPS.

## Connect and disconnect

The app sends users to Void's authorization page, where Void displays its registered name, operator, callback origin, and requested permission. Sign-in permits reading the user's ID and username. It does not provide an account token or project management access.

Users can disconnect applications at `<platform API URL>/oauth/connections`. Identity access tokens expire after an hour; apps that received a refresh token can renew silently instead of asking the user to sign in again. Access also becomes invalid when the platform login session is revoked, the account is suspended, or the refresh token's own absolute lifetime (90 days) elapses. Applications must request a new sign-in when access expires and no valid refresh token remains.

## Private previews

Sign-in can request `scope=profile preview:deploy` when the administrator has enabled it. After user consent, the app can build private previews without approval for each checkpoint. Production publishing still requires individual approval.

Use the granted bearer token to:

1. POST `{ workspace: externalWorkspaceId }` to `/oauth/previews`. The response contains a stable `project_id` and preview `url` for that client, owner and workspace.
2. POST `{ project_id, checkpoint, artifact: prepared.artifact }` to `/oauth/preview-deployment-requests`. Use its `access_token` and `approval_id` with the same asset upload and deployment protocol as publishing.
3. Once deployment finishes, POST to `/oauth/previews/:id/launch` and open the returned URL. Launch URLs expire after one minute and can be used once. Reload the preview's origin after opening it.

Each workspace has a separate preview origin and resources, with no production secrets. Previews support HTTP apps with isolated D1, KV, R2, AI and native Durable Objects. Authentication, external databases, email, schedules, queues and containers require production publishing. Viewing requires the current user grant; disconnecting or disabling the app denies subsequent requests. Preview writes must originate from that preview's own origin.

Account Access policies must allow requests to generated preview origins to reach Void. A policy that blocks new Workers hostnames also blocks previews. Void still requires a valid preview grant when the hostname is reachable.

Each owner can have ten preview workspaces. Each workspace permits sixty builds per hour and shares the owner's platform resource and usage limits. Inactive previews expire after seven days and Void removes their resources. Opening the workspace through `/oauth/previews` renews that expiry. Disabling preview permission expires its previews.

## Approve a publish

The app builds first, then sends the user to Void with the prepared artifact. Void displays the project name, checkpoint label, resources, manifest, and artifact digest. The user must explicitly approve on Void.

Approval permits one deployment to that user's chosen project. Void creates a missing project during approval; existing projects require ownership. The app receives a credential valid for up to fifteen minutes, restricted to that artifact's asset uploads, deployment, and receipt. Retries use the same receipt.

Published code can use that project's existing secrets and resources. Review the app operator and deployment details before approving code for an existing project. Migrations and resource changes in the approved manifest take effect during deployment.

Disabling the app or disconnecting its grant stops authorization for subsequent actions and is checked again before a queued deployment publishes. Disconnecting does not remove an app that has already been published; manage that project through Void.

## Build an OAuth client

Discover endpoints at `/.well-known/oauth-authorization-server` on the platform API origin. Use authorization code flow with `scope=profile`, a random `state`, and S256 PKCE. Authenticate token exchanges using HTTP Basic client authentication. Send access tokens as Bearer credentials to `/oauth/userinfo`; its response contains `sub`, `preferred_username`, and the consented `scope`.

The authorization code exchange also returns a `refresh_token`. POST `grant_type=refresh_token` with the refresh token and client Basic auth to `/oauth/token` to mint a new access token without user interaction; the response includes a new `refresh_token` and the previous one stops working. A refresh token can only be redeemed once — rotate to the new one on every renewal, and store it as securely as the access token. Presenting an already-rotated refresh token is treated as a compromised credential and revokes the application's entire access to that account; reconnect through the authorization flow to recover. An optional space-separated `scope` parameter requests a narrower set of permissions than the original grant; once narrowed, a later refresh cannot widen it back. `deploy:approve` publish credentials never receive a refresh token: each publish still requires its own interactive approval.

For publishing, package the built app with [`prepareDeployArtifact`](/reference/api/deploy). POST to `/oauth/deployment-requests` using the profile token:

```ts
{
  redirect_uri: registeredCallback,
  state: publishState,
  code_challenge: publishChallenge,
  code_challenge_method: 'S256',
  slug: projectSlug,
  checkpoint: checkpointLabel,
  artifact: prepared.artifact
}
```

Redirect the browser to the returned `authorization_url`. Exchange its code with the publish verifier and the same registered callback. The response includes `project_id`, `approval_id`, and a `deploy:approve` access token. This publish flow is a Void extension; requesting that scope in an ordinary sign-in does not authorize deployment.

Use the token to request URLs from `POST /projects/:id/deploy/upload-urls`, upload the declared assets, and send the artifact to `POST /projects/:id/deploy`. Set `x-void-deploy-idempotency-key` to `approval_id`. Deployment uses Void's managed deployment protocol and requires the platform deployment Queue. The credential cannot read secrets, mint project tokens, delete projects, or deploy different bytes.

Revoke identity grants with `POST /oauth/revoke`, authenticated as the client; this also works with a refresh token and revokes the whole grant, including any other refresh token issued from it. Void does not issue an OpenID Connect ID token.

If the API is protected by Cloudflare Access, the application operator must also configure a service identity permitted by that Access application's policy. Server OAuth endpoints and approved deployment requests still validate their own client, grant, and project authority; browser consent requires the user's company identity.
