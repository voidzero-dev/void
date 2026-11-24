import type { Plugin } from 'vite';
import { scanJobsSync } from './crons/scan.ts';
import { voidLog } from './log.ts';
import { afterServerReady } from './plugin-dev-config.ts';
import { readProjectPaths } from './project-paths.ts';
import { scanQueuesSync } from './queues/scan.ts';

/**
 * Prints a one-shot hint on dev server start when the project has crons
 * or queues, explaining how to trigger them locally. Both default Void mode
 * and framework mode (SvelteKit, Nuxt, Analog, Astro, TanStack Start, React
 * Router, vinext) expose `/__void/scheduled` and `/__void/queue`.
 */
export function devTriggersHintPlugin(root: string, devTriggerToken: string): Plugin {
  return {
    name: 'void:dev-triggers-hint',
    apply: 'serve',
    configureServer(server) {
      const paths = readProjectPaths(root);
      const jobs = scanJobsSync(paths.cronsDir);
      const queues = scanQueuesSync(paths.queuesDir);
      if (jobs.length === 0 && queues.length === 0) {
        return;
      }

      afterServerReady(server, () => {
        const address = server.httpServer?.address();
        const port = typeof address === 'object' && address ? address.port : null;
        if (port === null || port === undefined) {
          return;
        }
        const baseUrl = `http://localhost:${port}`;

        const summary: Array<string> = [];
        if (jobs.length > 0) {
          summary.push(`${jobs.length} cron${jobs.length === 1 ? '' : 's'}`);
        }
        if (queues.length > 0) {
          summary.push(`${queues.length} queue${queues.length === 1 ? '' : 's'}`);
        }

        console.log();
        voidLog(`Detected ${summary.join(' and ')}. Trigger locally:`);
        // Dev dispatchers accept only this header (see the serve branch in
        // router/compile.ts and the framework triggers dispatcher).
        const authHeader = `x-void-dev-trigger: ${devTriggerToken}`;

        if (jobs.length > 0) {
          const sample = jobs[0].crons[0];
          console.log(
            `         \x1b[2mcurl -X POST ${baseUrl}/__void/scheduled \\\n           -H "${authHeader}" \\\n           -d '{"cron":"${sample}","scheduledTime":'"$(date +%s000)"'}'\x1b[22m`,
          );
        }
        if (queues.length > 0) {
          const sample = queues[0].name;
          console.log(
            `         \x1b[2mcurl -X POST ${baseUrl}/__void/queue \\\n           -H "${authHeader}" \\\n           -d '{"queue":"${sample}","messages":[{"id":"1","timestamp":'"$(date +%s000)"',"body":{},"attempts":1}]}'\x1b[22m`,
          );
        }
      });
    },
  };
}
