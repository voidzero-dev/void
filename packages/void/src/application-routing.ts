import { analyzeApplicationSync, type ApplicationAnalysis } from './application-analysis.ts';
import { scanRoutes, type ScanResult } from './router/scan.ts';

export type CompleteApplicationAnalysis = ApplicationAnalysis & { scan: ScanResult };

/** Complete route/page analysis using the same resource and handler inventories. */
export async function completeApplicationAnalysis(
  analysis: ApplicationAnalysis,
): Promise<CompleteApplicationAnalysis> {
  const scan = await scanRoutes(analysis.root, {
    output: analysis.config.output,
    paths: analysis.paths,
    // A framework app's pages/ follows that framework's rules, not Void Pages.
    checkPageRoutes: !analysis.framework,
    environment: analysis.framework ? undefined : analysis.environment,
    inventory: {
      routes: analysis.routes,
      middleware: analysis.middleware,
      jobs: analysis.jobs,
      queues: analysis.queues,
      websockets: analysis.websockets,
      email: analysis.email,
    },
  });
  return { ...analysis, scan };
}

export async function analyzeApplication(
  root: string,
  options: Parameters<typeof analyzeApplicationSync>[1],
): Promise<CompleteApplicationAnalysis> {
  return completeApplicationAnalysis(analyzeApplicationSync(root, options));
}
