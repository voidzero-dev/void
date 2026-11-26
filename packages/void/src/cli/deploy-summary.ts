import { intro } from '@voidzero-dev/vite-plus-prompts';
import { formatCount, pc, printSuccess, sanitizeTerminalText } from './output.ts';

export function printDeployContext(project: string, destination: string): void {
  intro(
    `${pc.dim(sanitizeTerminalText(project))} ${pc.dim('→')} ${pc.blue(sanitizeTerminalText(destination))}`,
  );
}

export function printDeploySuccess(published = true): void {
  if (published) {
    printSuccess('Successfully deployed!');
  }
}

/** Only include counts confirmed by the deployment target. */
export function formatDeploySummary(details: {
  workerName?: string;
  workers?: number;
  assets?: number;
  unchangedAssets?: number;
  typeLabel?: string;
  migrations?: number;
  d1MigrationsCurrent?: boolean;
  cronJobs?: number;
  queues?: number;
  prerenderedPages?: number;
  ssr?: boolean;
  revalidate?: number | Record<string, number>;
  framework?: string | true;
}): string {
  const lines: Array<string> = [];
  if (details.workerName) {
    lines.push(`Worker: ${details.workerName}`);
  }

  const output: Array<string> = [];
  if (details.workers !== undefined) {
    output.push(formatCount(details.workers, 'worker module'));
  }
  if (details.assets !== undefined) {
    let assets = formatCount(details.assets, 'static asset');
    if (details.unchangedAssets) {
      assets += ` (${details.unchangedAssets} unchanged, ${details.assets - details.unchangedAssets} uploaded)`;
    }
    output.push(assets);
  }
  if (details.typeLabel) {
    lines.push([details.typeLabel, output.join(', ')].filter(Boolean).join(' — '));
  } else if (output.length) {
    lines.push(output.join(', '));
  }

  if (details.migrations) {
    lines.push(`${formatCount(details.migrations, 'migration')} applied`);
  }
  if (details.d1MigrationsCurrent) {
    lines.push('D1 migrations up to date');
  }
  if (details.cronJobs) {
    lines.push(`${formatCount(details.cronJobs, 'cron job')} scheduled`);
  }
  if (details.queues) {
    lines.push(`${formatCount(details.queues, 'queue')} configured`);
  }
  if (details.prerenderedPages) {
    lines.push(`${formatCount(details.prerenderedPages, 'page')} prerendered`);
  }
  if (details.ssr) {
    lines.push('SSR enabled');
  }
  if (details.revalidate) {
    lines.push(
      typeof details.revalidate === 'number'
        ? `ISR revalidate: ${details.revalidate}s`
        : `ISR revalidate: ${formatCount(Object.keys(details.revalidate).length, 'path rule')}`,
    );
  }
  if (details.framework) {
    lines.push(details.framework === true ? 'Framework mode' : `Framework: ${details.framework}`);
  }
  return lines.join('\n');
}
