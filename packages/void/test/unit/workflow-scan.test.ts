import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { toSlash } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { planWorkflowAdditions } from '../../src/workflows/config.ts';
import { assertNoWorkflowsForPlatform } from '../../src/workflows/platform.ts';
import {
  cloudflareWorkflowName,
  deriveWorkflowResourceIdentity,
  scanWorkflowModules,
} from '../../src/workflows/scan.ts';

const roots: Array<string> = [];

function createRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'void-workflow-scan-'));
  roots.push(root);
  mkdirSync(join(root, 'workflows'));
  for (const [filename, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, 'workflows', filename)), { recursive: true });
    writeFileSync(join(root, 'workflows', filename), source);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('scanWorkflowModules', () => {
  it('returns nothing without a workflows directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-workflow-scan-'));
    roots.push(root);
    expect(scanWorkflowModules(root)).toEqual([]);
    expect(() => assertNoWorkflowsForPlatform(root)).not.toThrow();
  });

  it('derives binding, class, and resource names from filenames', () => {
    const root = createRoot({ 'send-welcome.ts': 'export default {}', 'types.d.ts': '' });
    expect(scanWorkflowModules(root)).toEqual([
      {
        filePath: toSlash(join(root, 'workflows', 'send-welcome.ts')),
        relativePath: 'send-welcome.ts',
        bindingName: 'WORKFLOW_SEND_WELCOME',
        className: 'SendWelcomeWorkflow',
        resourceName: 'send-welcome',
      },
    ]);
  });

  it('joins nested directories into the name, as queues do', () => {
    const root = createRoot({ 'order/notifications.ts': 'export default {}' });
    expect(scanWorkflowModules(root)).toEqual([
      {
        filePath: toSlash(join(root, 'workflows', 'order', 'notifications.ts')),
        relativePath: 'order/notifications.ts',
        bindingName: 'WORKFLOW_ORDER_NOTIFICATIONS',
        className: 'OrderNotificationsWorkflow',
        resourceName: 'order-notifications',
      },
    ]);
  });

  it('ignores files and directories starting with an underscore', () => {
    const root = createRoot({
      'welcome.ts': 'export default {}',
      '_steps.ts': 'export const send = () => {};',
      '_lib/email.ts': 'export const send = () => {};',
      'order/_shared.ts': 'export const total = 0;',
    });
    expect(scanWorkflowModules(root).map((module) => module.relativePath)).toEqual(['welcome.ts']);
  });

  it('rejects a nested path and a file that produce the same name', () => {
    const root = createRoot({
      'order/notifications.ts': 'export default {}',
      'order-notifications.ts': 'export default {}',
    });
    expect(() => scanWorkflowModules(root)).toThrow('duplicate generated name');
  });

  it('reads a static name through aliased imports without evaluating the module', () => {
    const root = createRoot({
      'renamed.ts': `import { defineWorkflowEntrypoint as workflow } from 'void/workflows';
        const name = 'nightly-import';
        export default workflow({ name, class: Importer });`,
    });
    expect(scanWorkflowModules(root)[0]).toMatchObject({
      name: 'nightly-import',
      ...deriveWorkflowResourceIdentity('nightly-import'),
    });
  });

  it('rejects files that normalize to the same generated names', () => {
    const root = createRoot({
      'send-welcome.ts': 'export default {}',
      'send_welcome.ts': 'export default {}',
    });
    expect(() => scanWorkflowModules(root)).toThrow('duplicate generated name');
  });

  it('rejects Void platform deploys while workflows exist', () => {
    const root = createRoot({ 'welcome.ts': 'export default {}' });
    expect(() => assertNoWorkflowsForPlatform(root)).toThrow('void deploy --platform cloudflare');
  });
});

describe('Cloudflare Workflow names', () => {
  it('prefixes the account-scoped name with the Worker name', () => {
    expect(cloudflareWorkflowName('welcome', 'My_App')).toBe('my-app-welcome');
    expect(cloudflareWorkflowName('welcome')).toBe('welcome');
    expect(cloudflareWorkflowName('w'.repeat(80), 'app')).toHaveLength(64);
  });

  it('adds only unconfigured modules and keeps an authored entry for the same class', () => {
    const modules = [
      deriveWorkflowResourceIdentity('welcome'),
      deriveWorkflowResourceIdentity('import'),
    ];
    const authored = {
      name: 'pinned-welcome',
      binding: 'WORKFLOW_WELCOME',
      class_name: 'WelcomeWorkflow',
    };
    expect(planWorkflowAdditions([authored], modules, 'app')).toEqual([
      { name: 'app-import', binding: 'WORKFLOW_IMPORT', class_name: 'ImportWorkflow' },
    ]);
    expect(planWorkflowAdditions([], [], 'app')).toEqual([]);
  });

  it('rejects a binding retargeted to another class or Worker, and a taken name', () => {
    const modules = [deriveWorkflowResourceIdentity('welcome')];
    expect(() =>
      planWorkflowAdditions(
        [{ name: 'x', binding: 'WORKFLOW_WELCOME', class_name: 'Other' }],
        modules,
        'app',
      ),
    ).toThrow("binding 'WORKFLOW_WELCOME' is already configured");
    expect(() =>
      planWorkflowAdditions(
        [
          {
            name: 'x',
            binding: 'WORKFLOW_WELCOME',
            class_name: 'WelcomeWorkflow',
            script_name: 'other-worker',
          },
        ],
        modules,
        'app',
      ),
    ).toThrow("binding 'WORKFLOW_WELCOME' is already configured");
    expect(() =>
      planWorkflowAdditions(
        [{ name: 'app-welcome', binding: 'MINE', class_name: 'Mine' }],
        modules,
        'app',
      ),
    ).toThrow("Workflow name 'app-welcome' is already configured for binding 'MINE'");
  });
});
