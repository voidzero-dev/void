export type AiGatewayRequest = Readonly<{
  provider: string;
  endpoint: string;
  headers: Record<string, string>;
  query: unknown;
}>;

export type AiGateway = Readonly<{
  getUrl(provider?: string): string | Promise<string>;
  run(request: AiGatewayRequest): Promise<Response>;
}>;

export type AiBinding = Readonly<{
  run(
    model: string,
    inputs?: unknown,
    options?: Record<string, unknown>,
  ): Promise<ReadableStream | unknown>;
  gateway(id: string): AiGateway;
  models(inputs?: unknown): Promise<unknown>;
  toMarkdown(inputs?: unknown, options?: unknown): Promise<unknown>;
}>;

export type ProxyBody = Record<string, unknown>;

/**
 * Account-level Cloudflare `send_email` binding.
 *
 * CF returns a result object on success (currently `{ messageId?: string }`);
 * older workerd builds returned nothing. Both are handled at runtime — the
 * proxy reads `result?.messageId` optionally and falls back to `""`.
 */
export type SendEmailBinding = Readonly<{
  send(message: unknown): Promise<{ messageId?: string } | void>;
}>;
export type Env = Readonly<{
  AI: AiBinding;
  AI_GATEWAY_ID?: string;
  JWT_SECRET: string;
  EMAIL_SIGNING_SECRET: string;
  ROUTING: KVNamespace;

  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  API: Fetcher;
  DISPATCH: DispatchNamespace;
  PLATFORM_CAPABILITIES?: string;
  PLATFORM_HEALTH_PROBE_TOKEN?: string;
  PLATFORM_INSTALLATION_ID?: string;
  PLATFORM_TRAFFIC_STATE?: string;
  SEND_EMAIL: SendEmailBinding;

  /**
   * Platform mail zone for this environment — `mail.void.cloud` in
   * production, `mail.voidcloud.dev` in staging. Declared as a `vars`
   * entry in every `wrangler.jsonc` scope (wrangler does not inherit vars
   * into a named env) and mirrored into deployed user workers as the
   * `__VOID_EMAIL_DOMAIN` plain-text binding. Never defaulted in code: see
   * `readSenderDomain` in `email.ts`.
   */
  EMAIL_SENDER_DOMAIN: string;
}>;

export type JwtPayload = Readonly<{
  sub: string;
  login: string;
  aud: string;
  iat: number;
  exp: number;
  project?: string;
  build?: string;
  credential?: string;
}>;

export type ProxyEnv = Readonly<{
  Bindings: Env;
  Variables: { projectId: string; body: ProxyBody };
}>;
