import { readPlatformCapability, type PlatformCapabilities } from '@void/platform';
import type { MiddlewareHandler } from 'hono';
import type { ApiEnv } from './env.ts';

const HOSTED_CAPABILITIES: PlatformCapabilities = {
  ai: true,
  customDomains: true,
  email: true,
  githubActions: true,
  githubOAuth: true,
  googleOAuth: true,
  managedBuilds: true,
  sandbox: true,
  // Off until hosted turns it on in wrangler.jsonc (AI binding) and here.
  securityAudits: false,
};

const CAPABILITY_NAMES = Object.keys(HOSTED_CAPABILITIES) as Array<keyof PlatformCapabilities>;

export function getPlatformCapabilities(
  env: Pick<ApiEnv['Bindings'], 'PLATFORM_CAPABILITIES'>,
): PlatformCapabilities {
  if (!env.PLATFORM_CAPABILITIES) {
    return HOSTED_CAPABILITIES;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.PLATFORM_CAPABILITIES) as unknown;
  } catch {
    throw new Error('PLATFORM_CAPABILITIES must be valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('PLATFORM_CAPABILITIES must be an object.');
  }
  const record = parsed as Record<string, unknown>;
  const capabilities: Partial<Record<keyof PlatformCapabilities, boolean>> = {};
  for (const name of CAPABILITY_NAMES) {
    // Older installers leave optional capabilities out; missing means off.
    const value = readPlatformCapability(record, name);
    if (typeof value !== 'boolean') {
      throw new Error(`PLATFORM_CAPABILITIES.${name} must be a boolean.`);
    }
    capabilities[name] = value;
  }
  return capabilities as PlatformCapabilities;
}

export function capabilityMiddleware(
  capability: keyof PlatformCapabilities,
): MiddlewareHandler<ApiEnv> {
  return async (context, next) => {
    if (!getPlatformCapabilities(context.env)[capability]) {
      return context.json(
        {
          error: 'platform capability unavailable',
          capability,
          message: `This Void platform does not enable ${capability}.`,
        },
        501,
      );
    }
    await next();
  };
}
