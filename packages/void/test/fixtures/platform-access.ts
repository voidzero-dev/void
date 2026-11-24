import { PlatformAccessClient } from '../../src/cli/platform-access-provision.ts';

type RecordValue = Record<string, unknown>;
export function platformAccessFixture(): {
  client: PlatformAccessClient;
  transport: { request: <T>(path: string, init?: RequestInit) => Promise<T> };
  calls: Array<{ method: string; path: string; body?: RecordValue }>;
  apps: Map<string, RecordValue>;
  tokens: Map<string, RecordValue>;
  identityProviders: Array<RecordValue>;
  policy: RecordValue;
  loseNextApplicationResponse: () => void;
} {
  const apps = new Map<string, RecordValue>();
  const tokens = new Map<string, RecordValue>();
  const identityProviders: Array<RecordValue> = [
    { id: 'company-idp', type: 'okta', name: 'Company SSO' },
  ];
  const policy: RecordValue = {
    id: 'employees',
    name: 'Employees and managed devices',
    decision: 'allow',
    include: [{ email_domain: { domain: 'example.com' } }],
    require: [{ device_posture: { integration_uid: 'managed-devices' } }],
  };
  const calls: Array<{ method: string; path: string; body?: RecordValue }> = [];
  let loseApplicationResponse = false;
  let sequence = 0;
  const transport = {
    request: async <T>(path: string, init?: RequestInit): Promise<T> => {
      const target = path.split('?')[0].replace('/accounts/account/access/', '');
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as RecordValue) : undefined;
      calls.push({ method, path: target, body });
      let result: unknown;
      if (target === 'organizations') {
        result = { auth_domain: 'company.cloudflareaccess.com' };
      } else if (target === 'identity_providers') {
        result = identityProviders;
      } else if (target === 'policies') {
        result = [policy];
      } else if (target === 'policies/employees') {
        result = policy;
      } else if (target === 'apps' && method === 'GET') {
        result = [...apps.values()];
      } else if (target === 'service_tokens' && method === 'GET') {
        result = [...tokens.values()];
      } else if (target === 'service_tokens' && method === 'POST') {
        const token = {
          ...body,
          id: `token-${++sequence}`,
          client_id: 'ci.access',
          client_secret: 'service-secret',
        };
        tokens.set(token.id, token);
        result = token;
      } else if (target === 'apps' && method === 'POST') {
        const id = `app-${++sequence}`;
        const app: RecordValue = { ...body, id, aud: `${id}-audience` };
        const oidc = app.saas_app as RecordValue | undefined;
        if (oidc) {
          app.saas_app = { ...oidc, client_id: `${id}-client`, client_secret: 'oidc-secret' };
        }
        apps.set(id, app);
        if (loseApplicationResponse) {
          loseApplicationResponse = false;
          throw new Error('response lost');
        }
        result = app;
      } else if (target.startsWith('apps/') && target.endsWith('/policies')) {
        const app = apps.get(target.split('/')[1])!;
        result = (app.policies as Array<RecordValue>).map((entry, index) =>
          entry.id === 'employees' ? policy : { id: `inline-${index}`, ...entry },
        );
      } else if (target.startsWith('apps/')) {
        const app = structuredClone(apps.get(target.slice(5))!);
        if (app.saas_app) {
          delete (app.saas_app as RecordValue).client_secret;
        }
        result = app;
      } else {
        throw new Error(`Unexpected request ${method} ${target}`);
      }
      return structuredClone(result) as T;
    },
  };
  const client = new PlatformAccessClient(transport, 'account');
  return {
    client,
    transport,
    calls,
    apps,
    tokens,
    identityProviders,
    policy,
    loseNextApplicationResponse() {
      loseApplicationResponse = true;
    },
  };
}
