import { getApiUrl, getProxyUrl, getToken } from './cli/auth.ts';
import { ensurePlatformProxyAccess } from './cli/cf-access.ts';
import { readProjectConfig } from './cli/project.ts';
import { voidWarn, voidError } from './log.ts';
import { scopedAccessCredentials } from './shared/cf-access.ts';

/**
 * Decide whether to inject a Workers AI binding into the built wrangler config.
 *
 * Builds use the production binding. During dev, a project explicitly saved
 * with the direct Cloudflare destination uses Cloudflare's remote binding;
 * managed and unsaved projects keep using the Void HTTPS proxy.
 *
 * `!resolvedAi` is load-bearing: mergeBindings' return is defu-merged over the
 * resolved root-wrangler config and wins, so skipping when the user already
 * declared an `ai` binding avoids clobbering theirs. `!resultAi` is harmless
 * defense-in-depth (nothing else in mergeBindings sets `result.ai`).
 */
export function shouldBindWorkersAi(
  command: string,
  needsAI: boolean,
  resolvedAi: unknown,
  resultAi: unknown,
  directCloudflareDev: boolean = false,
): boolean {
  return (
    needsAI &&
    (command === 'build' || (command === 'serve' && directCloudflareDev)) &&
    !resultAi &&
    !resolvedAi
  );
}

/** Resolve the runtime Workers AI binding, preserving a root Wrangler declaration. */
export function resolveWorkersAiBindingName(resolvedAi: unknown, configuredName?: string): string {
  if (typeof resolvedAi === 'object' && resolvedAi !== null) {
    const binding = (resolvedAi as { binding?: unknown }).binding;
    if (typeof binding === 'string') {
      return binding;
    }
  }
  return configuredName ?? 'AI';
}

type CredentialStatus =
  | {
      status: 'ok';
      token: string;
      projectId: string;
      proxyUrl: string;
      accessCredentials?: string;
    }
  | { status: 'no-token' }
  | { status: 'no-project'; apiUrl: string; token: string };

/**
 * Read Void auth credentials for local dev AI proxy access.
 * Returns a discriminated union so callers can distinguish
 * "no token" from "no project" for targeted onboarding guidance.
 */
export function readVoidDevCredentials(root: string): CredentialStatus {
  const token = getToken(root);
  if (!token) {
    return { status: 'no-token' };
  }
  const apiUrl = getApiUrl(root);

  const project = readProjectConfig(root);
  if (!project) {
    return { status: 'no-project', apiUrl, token };
  }

  const proxyUrl = getProxyUrl(root);
  ensurePlatformProxyAccess(apiUrl, proxyUrl);
  return {
    status: 'ok',
    token,
    projectId: project.projectId,
    proxyUrl,
    accessCredentials: scopedAccessCredentials(process.env, proxyUrl),
  };
}

/**
 * Interactive AI setup prompt shown during dev server startup when the user
 * has a token but no linked project. Runs as fire-and-forget so it doesn't
 * block the server. On completion, writes project.json and restarts the server.
 */
export async function runAiSetupPrompt(
  root: string,
  token: string,
  apiUrl: string,
  server: import('vite').ViteDevServer,
): Promise<void> {
  const { select, text, isCancel, log } = await import('@voidzero-dev/vite-plus-prompts');
  const { PlatformClient } = await import('./cli/client.ts');
  const { attachSelectedPlatform, writeProjectConfig } = await import('./cli/project.ts');
  const { inferDefaultSlug } = await import('./cli/resolve-project.ts');
  const { printSuccess } = await import('./cli/output.ts');

  const client = new PlatformClient(token, { apiUrl });

  let projects: Array<import('./cli/client.ts').ProjectResponse>;
  try {
    projects = await client.listProjects();
  } catch {
    voidWarn('Failed to fetch projects. Run `void project link` to link a project manually.');
    return;
  }

  const options = [
    { value: '__create__' as const, label: 'Create new project' },
    ...projects.map((p) => ({
      value: p.id,
      label: p.slug,
    })),
  ];

  console.log();
  log.info("[void] AI requires a linked project. Let's set one up:");

  const result = await select({ message: 'Select a project:', options });
  if (isCancel(result)) {
    return;
  }

  let projectId: string;
  let slug: string;

  if (result === '__create__') {
    const { validateProjectSlug } = await import('./cli/project-slug.ts');
    const { createProjectWithSlugRetry } = await import('./cli/create-project.ts');
    let created;
    try {
      // Share the slug-retry loop with deploy/link paths so server-side plan
      // rejections (e.g. free-plan short-slug 403) re-prompt consistently.
      // The prompt callback returns `undefined` on Ctrl+C so the helper can
      // exit cleanly instead of calling process.exit().
      created = await createProjectWithSlugRetry(
        client,
        inferDefaultSlug(root),
        async (defaultSlug) => {
          const slugResult = await text({
            message: 'Choose a slug for your new Void project:',
            placeholder: 'my-app',
            initialValue: defaultSlug,
            validate: validateProjectSlug,
          });
          if (isCancel(slugResult) || typeof slugResult === 'symbol') {
            return undefined;
          }
          return slugResult.trim();
        },
      );
    } catch (err: unknown) {
      voidError(
        `project: Failed to create project: '${err instanceof Error ? err.message : String(err)}'.`,
      );
      return;
    }
    if (!created) {
      return;
    }
    projectId = created.id;
    slug = created.slug;
  } else {
    const project = projects.find((p) => p.id === result)!;
    projectId = project.id;
    slug = project.slug;
  }

  writeProjectConfig(root, attachSelectedPlatform({ projectId, slug }, client.apiUrl));
  // Restart the dev server so mergeBindings picks up fresh credentials
  await server.restart();
  printSuccess(`Linked to ${slug}.`);
}
