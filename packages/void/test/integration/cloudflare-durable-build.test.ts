import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRootWranglerConfig } from '@void/deploy-cloudflare';
import spawn from 'cross-spawn';
import { describe, expect, it } from 'vite-plus/test';
import { createIsolatedPlayground } from '../../../../test/integration-helpers.ts';
import { analyzeApplicationSync } from '../../src/application-analysis.ts';
import { verifyGeneratedDeployConfig } from '../../src/cli/deploy-artifact-validation.ts';
import {
  reconstructExpectedContainers,
  reconstructExpectedDurableObjectState,
  reconstructExpectedWorkflows,
  snapshotBindingIdentities,
  snapshotPassthroughIdentities,
  snapshotPassthroughRawFields,
} from '../../src/cli/deploy-binding-snapshot.ts';
import { computeDesiredCloudflareResources } from '../../src/cli/deploy-resources.ts';
import { syncWranglerBindings } from '../../src/cli/wrangler.ts';
import { materializeCloudflareConfig } from '../../src/cloudflare-config.ts';
import { renderVoidConfig } from '../../src/config-write.ts';
import { readConfig } from '../../src/config.ts';
import {
  CLOUDFLARE_DEPLOY_BUILD_ENV,
  CLOUDFLARE_WORKER_NAME_BUILD_ENV,
} from '../../src/shared/env.ts';

const repository = join(import.meta.dirname, '..', '..', '..', '..');
const accountId = '0123456789abcdef0123456789abcdef';
const external = {
  name: 'FOREIGN',
  class_name: 'Remote',
  script_name: 'external-owner',
  environment: 'production',
};
const history = [{ tag: 'custom-v1', new_sqlite_classes: ['HistoryDurableObject'] }];

describe('real Cloudflare Durable Object configuration merge', () => {
  it.each([
    { name: 'combined', websocket: true, live: true, sandbox: true, authoredHistory: true },
    { name: 'sandbox-only', websocket: false, live: false, sandbox: true, authoredHistory: false },
    {
      name: 'native',
      native: true,
      websocket: false,
      live: false,
      sandbox: false,
      authoredHistory: true,
    },
    { name: 'free', websocket: true, live: true, sandbox: false, authoredHistory: false },
  ])(
    'emits $name identities and ordered migrations exactly once through the actual provider plugin',
    async (options) => {
      const fixture = createIsolatedPlayground(repository, 'playground/ssr');
      const root = fixture.root;
      const write = (path: string, source: string) => {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), source);
      };
      try {
        if (options.websocket) {
          write(
            'routes/chat.ws.ts',
            `import { defineWebSocket } from 'void/ws';
export default defineWebSocket({ onConnect({ connection }) { connection.send('connected'); } });\n`,
          );
        }
        if (options.live) {
          write(
            'routes/api/live.ts',
            `import { defineHandler } from 'void';
import { defineLiveStream } from 'void/live';
const stream = defineLiveStream({ id: 'build-regression' });
export const GET = defineHandler(c => stream.connect(c, { owner: 'local', user: null }));\n`,
          );
        }
        if (options.authoredHistory) {
          write(
            'durable-objects/history.ts',
            'native' in options && options.native
              ? `import { DurableObject } from 'cloudflare:workers';
import { defineDurableObject } from 'void/durable';
class History extends DurableObject { increment() { return 1; } }
export default defineDurableObject({ class: History });\n`
              : `import { defineDurableState } from 'void/durable';
export default defineDurableState({ initialState: { count: 0 }, methods: { increment(c) { return ++c.state.count; } } });\n`,
          );
        }
        write(
          'void.config.ts',
          renderVoidConfig({
            ...readConfig(root),
            ...(options.sandbox ? { sandbox: true } : {}),
            ...(options.name === 'native'
              ? { worker: { compatibility_flags: ['nodejs_als', 'url_standard'] } }
              : {}),
            cloudflare: {
              name: `durable-merge-${options.name}`,
              account_id: accountId,
              ...(options.name === 'native'
                ? {
                    compatibility_date: '2026-02-24',
                    compatibility_flags: [
                      'nodejs_als',
                      'global_fetch_strictly_public',
                      'nodejs_als',
                    ],
                  }
                : {}),
              ...(options.authoredHistory
                ? {
                    durable_objects: {
                      bindings: [{ name: 'HISTORY', class_name: 'HistoryDurableObject' }, external],
                    },
                    migrations: history,
                  }
                : {}),
            },
          }),
        );
        const authored = readFileSync(join(root, 'void.config.ts'), 'utf8');
        const config = readConfig(root);
        const analysis = analyzeApplicationSync(root, { config });
        const configPath = materializeCloudflareConfig(root);
        // Native classification retains pre-existing WebSocket/class history; the build appends
        // Sandbox and Live.
        syncWranglerBindings(
          root,
          { ...analysis.bindings, needsSandbox: false, needsLive: false },
          {
            websockets: analysis.allWebsockets,
          },
        );
        const rootConfig = parseRootWranglerConfig(configPath);
        const signals = await computeDesiredCloudflareResources(root, config, configPath);
        const durable = reconstructExpectedDurableObjectState(config, root, rootConfig, {
          needsSandbox: options.sandbox,
          needsLive: options.live,
          analysis,
        });
        const expected = {
          accountId,
          workerName: `durable-merge-${options.name}`,
          desired: signals.desired,
          bindingIdentitySnapshot: snapshotBindingIdentities(rootConfig),
          passthroughIdentitySnapshot: snapshotPassthroughIdentities(rootConfig),
          passthroughRawFields: snapshotPassthroughRawFields(rootConfig),
          needsAI: false,
          expectedContainers: reconstructExpectedContainers(
            config,
            root,
            rootConfig,
            options.sandbox,
          ),
          expectedCrons: signals.expectedCrons,
          expectedDurableObjectBindings: durable.bindings,
          expectedWorkflows: reconstructExpectedWorkflows(
            config,
            root,
            rootConfig,
            `durable-merge-${options.name}`,
            analysis,
          ),
          expectedMigrations: durable.migrations,
        };
        const build = () => {
          const result = spawn.sync('vp', ['build'], {
            cwd: root,
            encoding: 'utf8',
            timeout: 60_000,
            maxBuffer: 10 * 1024 * 1024,
            env: {
              ...process.env,
              [CLOUDFLARE_DEPLOY_BUILD_ENV]: '1',
              CLOUDFLARE_API_TOKEN: '',
              CLOUDFLARE_API_KEY: '',
            },
          });
          expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);
          return JSON.parse(readFileSync(join(root, 'dist/ssr/wrangler.json'), 'utf8')) as {
            compatibility_flags?: Array<string>;
            durable_objects: { bindings: Array<{ name: string }> };
            migrations: Array<unknown>;
            containers?: Array<unknown>;
            hyperdrive?: Array<unknown>;
            ai?: unknown;
            workflows?: Array<unknown>;
          };
        };
        const emitted = build();
        // Workflows are opt-in: an app without workflows/ emits no Workflow config.
        expect(emitted.workflows).toBeUndefined();
        // Exercise worker/cloudflare overlap through the actual provider plugin,
        // alongside the existing native build rather than booting another one.
        if (options.name === 'native') {
          expect(emitted.compatibility_flags).toEqual([
            'nodejs_als',
            'url_standard',
            'global_fetch_strictly_public',
          ]);
        }
        expect(emitted.durable_objects.bindings).toHaveLength(
          (options.websocket ? 1 : 0) +
            (options.live ? 1 : 0) +
            (options.sandbox ? 1 : 0) +
            (options.authoredHistory ? 2 : 0),
        );
        expect(
          new Set(emitted.durable_objects.bindings.map((binding: { name: string }) => binding.name))
            .size,
        ).toBe(emitted.durable_objects.bindings.length);
        expect(emitted.migrations).toEqual(durable.migrations);
        expect(verifyGeneratedDeployConfig(root, expected)).toEqual({ ok: true });
        expect(readFileSync(join(root, 'void.config.ts'), 'utf8')).toBe(authored);
        if (options.authoredHistory) {
          expect(emitted.durable_objects.bindings).toContainEqual(external);
          expect(emitted.migrations.slice(0, history.length)).toEqual(history);
          const repeated = build();
          expect(repeated.durable_objects).toEqual(emitted.durable_objects);
          expect(repeated.migrations).toEqual(emitted.migrations);
          expect(repeated.compatibility_flags).toEqual(emitted.compatibility_flags);
        }
        if (!options.sandbox) {
          expect(emitted.containers ?? []).toEqual([]);
          expect(emitted.ai).toBeUndefined();
          expect(emitted.hyperdrive ?? []).toEqual([]);
        }
      } finally {
        fixture.cleanup();
      }
    },
  );

  it('emits Workflow entries named after the deployed Worker and keeps authored ones', () => {
    const fixture = createIsolatedPlayground(repository, 'playground/ssr');
    const root = fixture.root;
    try {
      mkdirSync(join(root, 'workflows'), { recursive: true });
      writeFileSync(
        join(root, 'workflows/welcome.ts'),
        `import { defineWorkflow } from 'void/workflows';
export default defineWorkflow({ async run(event, step) { return step.do('greet', async () => 'hi'); } });\n`,
      );
      writeFileSync(
        join(root, 'workflows/nightly-import.ts'),
        `import { WorkflowEntrypoint } from 'cloudflare:workers';
import { defineWorkflowEntrypoint } from 'void/workflows';
class Importer extends WorkflowEntrypoint { async run() { return 'imported'; } }
export default defineWorkflowEntrypoint({ class: Importer });\n`,
      );
      const pinned = {
        name: 'legacy-import',
        binding: 'WORKFLOW_NIGHTLY_IMPORT',
        class_name: 'NightlyImportWorkflow',
      };
      writeFileSync(
        join(root, 'void.config.ts'),
        renderVoidConfig({
          ...readConfig(root),
          cloudflare: { name: 'workflow-merge', account_id: accountId, workflows: [pinned] },
        }),
      );
      const config = readConfig(root);
      const analysis = analyzeApplicationSync(root, { config });
      const configPath = materializeCloudflareConfig(root);
      const rootConfig = parseRootWranglerConfig(configPath);
      const expectedWorkflows = reconstructExpectedWorkflows(
        config,
        root,
        rootConfig,
        'deployed-app',
        analysis,
      );
      expect(expectedWorkflows).toEqual([
        pinned,
        {
          name: 'deployed-app-welcome',
          binding: 'WORKFLOW_WELCOME',
          class_name: 'WelcomeWorkflow',
        },
      ]);
      const result = spawn.sync('vp', ['build'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          [CLOUDFLARE_DEPLOY_BUILD_ENV]: '1',
          [CLOUDFLARE_WORKER_NAME_BUILD_ENV]: 'deployed-app',
          CLOUDFLARE_API_TOKEN: '',
          CLOUDFLARE_API_KEY: '',
        },
      });
      expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);
      const emitted = JSON.parse(readFileSync(join(root, 'dist/ssr/wrangler.json'), 'utf8')) as {
        workflows?: Array<Record<string, unknown>>;
      };
      expect(emitted.workflows).toEqual(expect.arrayContaining(expectedWorkflows));
      expect(emitted.workflows).toHaveLength(expectedWorkflows.length);
      const worker = readFileSync(join(root, 'dist/ssr/index.js'), 'utf8');
      expect(worker).toMatch(/WelcomeWorkflow/);
      expect(worker).toMatch(/NightlyImportWorkflow/);
      expect(
        verifyGeneratedDeployConfig(root, {
          accountId,
          workerName: 'workflow-merge',
          passthroughIdentitySnapshot: snapshotPassthroughIdentities(rootConfig),
          expectedWorkflows,
        }),
      ).toEqual({ ok: true });
      expect(
        verifyGeneratedDeployConfig(root, {
          accountId,
          workerName: 'workflow-merge',
          expectedWorkflows: [pinned],
        }),
      ).toMatchObject({ ok: false, reason: expect.stringContaining('workflows differ') });
    } finally {
      fixture.cleanup();
    }
  }, 120_000);
});
