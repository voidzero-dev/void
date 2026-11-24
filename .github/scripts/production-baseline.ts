import { appendFileSync } from 'node:fs';

async function productionBaseline(options: {
  configuredSha?: string;
  repository: string;
  token?: string;
  environment: string;
}): Promise<string> {
  if (options.configuredSha) {
    if (options.configuredSha.length !== 40 || !/^[0-9a-f]{40}$/i.test(options.configuredSha)) {
      throw new Error(
        'VOID_PLATFORM_PRODUCTION_REF must be the immutable 40-character SHA of the deployed runtime.',
      );
    }
    return options.configuredSha.toLowerCase();
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repository) || !options.token) {
    throw new Error(
      'Provide a GitHub repository and read token, or set VOID_PLATFORM_PRODUCTION_REF to the deployed SHA.',
    );
  }
  const signal = AbortSignal.timeout(60_000);
  const { environment } = options;
  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(`https://api.github.com/repos/${options.repository}/${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${options.token}`,
        'X-GitHub-Api-Version': '2026-03-10',
      },
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      throw new Error(`Reading production deployment history failed (${response.status}).`);
    }
    return response.json();
  };
  // The branch can already point at the candidate. GitHub's last successful
  // environment deployment identifies the runtime that actually finished rollout.
  const deployments = await get(
    `deployments?environment=${encodeURIComponent(environment)}&per_page=100`,
  );
  if (!Array.isArray(deployments)) {
    throw new Error('Invalid production deployment history.');
  }
  for (const deployment of deployments as Array<unknown>) {
    if (
      !deployment ||
      typeof deployment !== 'object' ||
      !('id' in deployment) ||
      !('environment' in deployment) ||
      !('sha' in deployment) ||
      !Number.isSafeInteger(deployment.id) ||
      deployment.environment !== environment ||
      typeof deployment.sha !== 'string' ||
      deployment.sha.length !== 40 ||
      !/^[0-9a-f]{40}$/i.test(deployment.sha)
    ) {
      continue;
    }
    const statuses = await get(`deployments/${deployment.id}/statuses?per_page=1`);
    if (!Array.isArray(statuses)) {
      throw new Error('Invalid production deployment status.');
    }
    if ((statuses[0] as { state?: unknown } | undefined)?.state === 'success') {
      return deployment.sha.toLowerCase();
    }
  }
  throw new Error(
    'No successful production deployment was found. Set VOID_PLATFORM_PRODUCTION_REF to the immutable deployed SHA before running the compatibility check.',
  );
}

const sha = await productionBaseline({
  configuredSha: process.env.PRODUCTION_REF,
  repository: process.env.GITHUB_REPOSITORY ?? '',
  token: process.env.GITHUB_TOKEN,
  environment: process.env.PRODUCTION_ENVIRONMENT || 'Prod',
});
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\n`);
}
console.log(`Previous production runtime: ${sha}`);
