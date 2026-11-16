import { describe, expect, it } from 'vite-plus/test';
import { analyze, compile } from '../../src/compiler.ts';
import { component, template } from '../../src/server.ts';
import { scopeStyles } from '../../src/styles.ts';

const scope = 'data-vv-cid-test';
describe('component styles', () => {
  it('scopes selector lists, compounds, combinators, and pseudo-elements', () => {
    const css = scopeStyles('h2, .box > h2:hover::before { color: red }', scope, 'component.css');
    expect(css).toContain(`h2[${scope}]`);
    expect(css).toContain(`.box[${scope}]>h2:hover[${scope}]:before`);
    expect(css).not.toContain(`:before[${scope}]`);
  });
  it('treats both root forms as global and keeps adjacent rules local', () => {
    const css = scopeStyles(
      ':root { .nested { color: red } } :root .flat { color: blue } h2 { color: green }',
      scope,
      'component.css',
    );
    expect(css).toContain(':root .nested{');
    expect(css).toContain(':root .flat{');
    expect(css).not.toContain(`.nested[${scope}]`);
    expect(css).not.toContain(`.flat[${scope}]`);
    expect(css).toContain(`h2[${scope}]`);
  });
  it('handles nesting and media rules without modifying keyframe selectors', () => {
    const css = scopeStyles(
      '@media (min-width: 1px) { .box { & > h2 { color: red } } :root { .global { color: blue } } } @keyframes fade { from { opacity: 0 } to { opacity: 1 } }',
      scope,
      'component.css',
    );
    expect(css).toContain(`.box[${scope}]>h2[${scope}]`);
    expect(css).toContain(':root .global{');
    expect(css).toContain('@keyframes fade{');
    expect(css.slice(css.indexOf('@keyframes'))).not.toContain(scope);
  });
  it('uses stable, distinct scopes and the same templates on server and client', () => {
    const source =
      'export function Panel(){ return <><h2>Title</h2><style>{`h2 { color: red }`}</style></>; }';
    const a = analyze(source, '/one.tsx');
    const b = analyze(source, '/two.tsx');
    expect(a.components[0]!.scope).not.toBe(b.components[0]!.scope);
    compile(a, false);
    const html = [...a.components[0]!.templates.values()];
    expect(html.join('')).toContain(`<h2 ${a.components[0]!.scope}>`);
    const { code } = compile(a, true);
    expect([...a.components[0]!.templates.values()]).toEqual(html);
    expect(code).not.toContain('color:red');
    expect(analyze(source, '/one.tsx').components[0]!.scope).toBe(a.components[0]!.scope);
  });
  it('extracts static blocks while marking interpolated styles dynamic without event bindings', () => {
    const info = analyze(
      'export function Color({color}) { return <><h2>Color</h2><style>{`h2 { margin: 0; }`}</style><style>{`h2 { color: ${color}; width: ${20}px; }`}</style></>; }',
      '/Color.tsx',
    );
    const owner = info.components[0]!;
    expect(owner.dynamic).toBe(true);
    expect(owner.dynamicStyles).toBe(true);
    const server = compile(info, false).code;
    const styles = [...owner.styles];
    expect(styles).toEqual([`h2[${owner.scope}]{margin:0}`]);
    expect([...owner.templates.values()].join('')).not.toContain('<style');
    expect(server).toContain('__vv_style(0,');
    expect(server).toContain('data-vv-rid-vvINSTANCE');
    expect(server).toContain('data-vv-cid-vvINSTANCE');
    const client = compile(info, true).code;
    expect(owner.styles).toEqual(styles);
    expect(client).not.toContain('margin:0');
    expect(client).toContain('__vv_style(0,');
  });
  it('renders independent instance scopes on the server and escapes style end tags', () => {
    const render = () =>
      component(
        'vv-color',
        {},
        (_change, style, instance) => () =>
          template(
            'color',
            '<h2 data-vv-i>Color</h2><!--vv:0--><!--vv:1-->',
            [
              [
                'child',
                0,
                '',
                style!(
                  0,
                  '[data-vv-rid-vvINSTANCE] h2[data-vv-cid-vvINSTANCE]{color:red;content:"</style><script>bad</script>"}',
                ),
              ],
              ['child', 1, '', 'literal data-vv-i'],
            ],
            instance,
          ),
        true,
        true,
      );
    const a = render().value;
    const b = render().value;
    const id = /data-vv-rid-([a-f0-9-]+)/.exec(a)![1]!;
    expect(b).not.toContain(id);
    expect(a).toContain(`<h2 data-vv-cid-${id}>`);
    expect(a).toContain(`[data-vv-rid-${id}] h2[data-vv-cid-${id}]`);
    expect(a).toContain('literal data-vv-i');
    expect(a.match(/<\/style>/g)).toHaveLength(1);
    expect(a).not.toContain('vvINSTANCE');
  });
  it('leaves components without style blocks unchanged and rejects malformed CSS', () => {
    const plain = analyze('export function Plain(){ return <h2>Plain</h2>; }', '/plain.tsx');
    compile(plain, false);
    expect(plain.components[0]!.scope).toBeUndefined();
    expect([...plain.components[0]!.templates.values()]).toEqual(['<h2>Plain</h2>']);
    expect(() => scopeStyles('h2[ { color: red }', scope, 'broken.css')).toThrow();
  });
});
