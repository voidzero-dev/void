/**
 * Login failures whose cause is known. A code is a short fixed name, never a
 * provider response body, token, or secret, so it is safe to log and to show
 * on the failure page.
 */
export type LoginFailureCode =
  | 'login_denied'
  | 'github_incorrect_client_credentials'
  | 'github_redirect_uri_mismatch'
  | 'github_bad_verification_code'
  | 'github_unverified_user_email'
  | 'github_failed'
  | 'oidc_discovery_failed'
  | 'oidc_token_failed'
  | 'google_domain_not_allowed'
  | 'oidc_group_not_allowed'
  | 'login_secret_unreadable';

export class LoginFailure extends Error {
  constructor(
    readonly code: LoginFailureCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'LoginFailure';
  }
}

const hints: Record<LoginFailureCode, Readonly<{ message: string; callback?: true }>> = {
  login_denied: {
    message: 'Sign-in was cancelled or denied at the provider. Start a new sign-in to try again.',
  },
  github_incorrect_client_credentials: {
    message: 'GitHub rejected this platform’s client ID or client secret.',
    callback: true,
  },
  github_redirect_uri_mismatch: {
    message:
      'GitHub rejected the callback URL. Register exactly the callback URL below in the OAuth app, then start a new sign-in.',
    callback: true,
  },
  github_bad_verification_code: {
    message: 'The GitHub sign-in code expired or was already used. Start a new sign-in.',
  },
  github_unverified_user_email: {
    message: 'Verify the primary email of this GitHub account, then start a new sign-in.',
  },
  github_failed: {
    message:
      'GitHub did not complete the sign-in. Start a new sign-in; if it fails again, check the client ID, client secret, and callback URL.',
    callback: true,
  },
  oidc_discovery_failed: {
    message:
      'The issuer URL did not return a matching OpenID configuration. Check it exactly, including any trailing slash.',
  },
  oidc_token_failed: {
    message:
      'The provider refused the token request. Check the client ID and client secret, and that the callback URL below is registered.',
    callback: true,
  },
  google_domain_not_allowed: {
    message: 'This Google account does not belong to an allowed Workspace domain.',
  },
  oidc_group_not_allowed: { message: 'This identity does not belong to an allowed group.' },
  login_secret_unreadable: {
    message: 'The saved client secret cannot be read with this installation’s encryption keys.',
  },
};

type LoginFailureHint = Readonly<{
  message: string;
  callback: boolean;
}>;

/** What to tell the user, and whether the provider's registered callback URL may be the cause. */
export function loginFailureHint(code: LoginFailureCode): LoginFailureHint {
  return { message: hints[code].message, callback: hints[code].callback === true };
}
