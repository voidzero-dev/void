import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, it, expect } from 'vite-plus/test';
import { analyze, compile } from '../../src/compiler.ts';
import { prepareClient } from '../../src/inline.ts';
import { renderResources, type ViewResources } from '../../src/resources.ts';
import { component, template } from '../../src/server.ts';

describe('request-specific resources', () => {
  it('propagates rendered dynamic instances through static parents without global request state', () => {
    const first = component(
      'vv-static',
      {},
      () => () =>
        template('static', '<!--vv:0-->', [
          ['child', 0, '', component('vv-button', {}, () => () => 'Button', true)],
        ]),
      false,
    );
    expect([...first.components]).toEqual(['vv-button']);
    const second = component('vv-static', {}, () => () => 'Static', false);
    expect([...second.components]).toEqual([]);
  });
  it('emits nothing for a fully static response, even with prepared resources', () => {
    const resources: ViewResources = {
      components: {
        static: { dynamic: false, dependencies: [], templates: [['static', '<b>Static</b>']] },
      },
      units: {},
      componentUnits: {},
      register: '',
    };
    expect(renderResources([], resources)).toBe('');
  });
  it('selects declarations precisely, preserving helper initialization, live imports, shadowing, and string escaping', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'void-view-sources-'));
    try {
      const source = `import { increment as step, count, label } from './helper.ts';
export function Counter() { let n = count; return <button onclick={() => { [1].map(step => step + 1); step(); n = count; }}>{n}{label}</button>; }
export function Unused() { return <button onclick={() => {}}>unused-source-sentinel</button>; }`;
      const file = resolve(root, 'Counter.tsx');
      writeFileSync(file, source);
      writeFileSync(
        resolve(root, 'helper.ts'),
        `const first = 1, second = first + 1; export let count = 0; export const {label} = { label: '</script><b>literal</b>' }; export function increment() { count += second; } export function neverUsed() { throw new Error('unused-helper-sentinel'); }`,
      );
      writeFileSync(
        resolve(root, 'runtime.ts'),
        `export function component(id, props, initialize) { return initialize(value => value); }
export function template(id, html, bindings) { return bindings; }
export function register(id, factory) { globalThis.factories[id] = factory; }`,
      );
      const info = analyze(source, file);
      compile(info, false);
      const target = info.components[0]!;
      const prepared = await prepareClient(
        new Map([[file, info]]),
        new Set(info.components.map((component) => component.id)),
        async (id, importer) =>
          id === '@void/view/client' ? resolve(root, 'runtime.ts') : resolve(dirname(importer), id),
      );
      const resources: ViewResources = {
        ...prepared,
        components: Object.fromEntries(
          info.components.map((component) => [
            component.id,
            { dynamic: component.dynamic, dependencies: [], templates: [...component.templates] },
          ]),
        ),
      };
      const html = renderResources([target.id, target.id], resources);
      expect(html.match(/<script /g)).toHaveLength(1);
      expect(html.match(/<template /g)).toHaveLength(target.templates.size);
      expect(html).not.toContain('unused-source-sentinel');
      expect(html).not.toContain('unused-helper-sentinel');
      expect(html.match(/<\/script>/g)).toHaveLength(1);
      const code = html.match(/<script type="module" data-void-view>([\s\S]*)<\/script>/)![1]!;
      const factories: Record<
        string,
        (props: object) => () => Array<[string, number, string, unknown]>
      > = {};
      runInNewContext(code, { factories });
      const draw = factories[target.id]!({});
      const initial = draw();
      expect(
        initial.filter((binding) => binding[0] === 'child').map((binding) => binding[3]),
      ).toEqual([0, '</script><b>literal</b>']);
      (initial.find((binding) => binding[0] === 'event')![3] as () => void)();
      expect(draw().find((binding) => binding[0] === 'child')![3]).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
