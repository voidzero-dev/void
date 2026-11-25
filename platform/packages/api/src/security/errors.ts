import { SECURITY_ERRORS } from '@void/platform/security-policy';
import type { SecurityErrorName } from '@void/platform/security-policy';

/**
 * A refused security audit request. `code` is the `error` string the CLI matches
 * (`SECURITY_ERRORS` in `@void/platform/security-policy`); `details` holds the extra
 * fields the spec names for that code (for example `missing` for an entitlement miss).
 */
export class SecurityApiError extends Error {
  readonly status: 400 | 404 | 409 | 413 | 422 | 503;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: SecurityApiError['status'],
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SecurityApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** An error from the shared `SECURITY_ERRORS` list. */
  static of(
    name: SecurityErrorName,
    message: string,
    details?: Record<string, unknown>,
  ): SecurityApiError {
    const { code, status } = SECURITY_ERRORS[name];
    return new SecurityApiError(status, code, message, details);
  }

  /** A malformed request: wrong field, value out of range. */
  static invalid(message: string): SecurityApiError {
    return new SecurityApiError(400, 'invalid_argument', message);
  }
}

/**
 * The stored policy row cannot be read. Paths that must fail closed (the public gate,
 * its Zero Trust refusals) read the policy strictly and answer 503 with this error.
 */
export class SecurityPolicyUnreadableError extends SecurityApiError {
  constructor(reason: string) {
    super(
      SECURITY_ERRORS.policyUnreadable.status,
      SECURITY_ERRORS.policyUnreadable.code,
      `The saved security audit policy cannot be read (${reason}). Save the policy again: void platform security policy <disabled|public|all>`,
    );
    this.name = 'SecurityPolicyUnreadableError';
  }
}
