import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

const scripts: Record<string, string> = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../../package.json'), 'utf8'),
).scripts;

// The API's confirmation page posts back through the gateway, so the gateway
// must relay that POST before the new API serves the page.
describe('hosted deploy order', () => {
  it.each([
    ['deploy', 'deploy:email-gateway', 'deploy:api'],
    ['deploy:staging', 'deploy:staging:email-gateway', 'deploy:staging:api'],
  ])('%s deploys the email gateway before the API', (script, gateway, api) => {
    const steps = scripts[script]!.split('&&').map((step) => step.trim());
    const gatewayStep = steps.indexOf(`vp run ${gateway}`);
    const apiStep = steps.indexOf(`vp run ${api}`);
    expect(gatewayStep).toBeGreaterThan(-1);
    expect(apiStep).toBeGreaterThan(gatewayStep);
  });
});
