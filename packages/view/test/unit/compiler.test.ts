import { parseSync } from 'oxc-parser';
import { describe, expect, it } from 'vite-plus/test';
import { analyze, compile } from '../../src/compiler.ts';
import { component, Html, render, template } from '../../src/server.ts';

describe('view compiler', () => {
  it('keeps scoped style text in HTML rather than creating a binding', () => {
    const info = analyze(
      'export function Styled(){ return <div><style>{`h1 { color: red; }`}</style></div>; }',
      '/Styled.tsx',
    );
    compile(info, false);
    const scope = info.components[0]!.scope;
    expect([...info.components[0]!.templates.values()]).toEqual([
      `<div ${scope}><style ${scope}>h1[${scope}]{color:red}</style></div>`,
    ]);
  });
  it.each([
    'export default function({ label } = { label: "default" }) { return <p>{label}</p>; }',
    'export default ({ label }: { label: string }) => <p>{label}</p>;',
    'export function Generic<T extends () => string>({ read }: { read: T }) { return <p>{read()}</p>; }',
  ])('emits valid code for default, anonymous, and generic components: %s', (source) => {
    const { code } = compile(analyze(source, '/Component.tsx'), false);
    expect(parseSync('/compiled.ts', code).errors).toEqual([]);
  });
  it('decodes authored HTML entities once', () => {
    const info = analyze(
      'export function Label(){ return <span title="&quot;">Tom &amp; Jerry &#x1f600;</span>; }',
      '/Label.tsx',
    );
    compile(info, false);
    expect([...info.components[0]!.templates.values()]).toEqual([
      '<span title="&quot;">Tom &amp; Jerry 😀</span>',
    ]);
  });
  it('tracks destructuring and respects destructured aliases and loop scopes', () => {
    const info = analyze(
      'export function Counter(){ let {n}= {n:0}; return <button onclick={() => { for(let n=0;n<2;n++){}; [{n:1}].map(({n:other}) => n += other); }}>{n}</button>; }',
      '/Counter.tsx',
    );
    const { code } = compile(info, false);
    expect(code).toContain('for(let n=0;n<2;n++)');
    expect(code).toContain('__vv_change(n += other)');
  });
  it('rejects render-time writes instead of scheduling an endless rerender loop', () => {
    expect(() =>
      compile(
        analyze('export function Counter(){ let n=0; return <p>{n++}</p>; }', '/Counter.tsx'),
        false,
      ),
    ).toThrow('not while rendering');
  });
  it('compiles the Button example into persistent state and HTML templates', () => {
    const info = analyze(
      `import { Label } from './Label.tsx'; export function Button({label}: {label:string}) { let pressed = false; return <button onclick={() => { pressed = true }}><Label>{pressed ? 'Pressed!' : label}</Label></button> }`,
      '/Button.tsx',
    );
    const result = compile(info, false);
    expect(info.components[0]!.dynamic).toBe(true);
    expect(result.code).toContain('__vv_change(pressed = true)');
    expect(result.code).toContain('return () =>');
    expect(result.code).not.toContain('<Label>');
    expect(result.code).not.toContain('onclick=');
    expect([...info.components[0]!.templates.values()].join('')).toContain(
      '<button data-vv-a="0">',
    );
    expect(compile(info, true).code).toContain(',null,');
  });
  it('records static descendant and callback dependencies', () => {
    const info = analyze(
      `export function Parent() { let n=0; return <Action invoke={() => n++}><Label>{n}</Label></Action> }`,
      '/Parent.tsx',
    );
    expect([...info.components[0]!.dependencies]).toEqual(['Action', 'Label']);
    expect([...info.components[0]!.callbacks]).toEqual(['Action']);
    expect(compile(info, false).code).toContain('__vv_change(n++)');
  });
  it('keeps shadowed locals independent and instruments async assignments', () => {
    const info = analyze(
      `export function Counter() { let n=0; return <button onclick={async () => { [1].map(n => n++); await Promise.resolve(); n += 1; }}>{n}</button> }`,
      '/Counter.tsx',
    );
    const code = compile(info, false).code;
    expect(code).toContain('n => n++');
    expect(code).toContain('__vv_change(n += 1)');
  });
  it('handles Unicode offsets, fragments, nested expressions, and arrow components', () => {
    const info = analyze(
      `const emoji = '🌎'; export const Label = ({children}: {children:string}) => <><span title={emoji}>{children}</span>{true ? <b>世界</b> : null}</>;`,
      '/Label.tsx',
    );
    const result = compile(info, false);
    expect(result.code).toContain("const emoji = '🌎'");
    expect(result.code).toContain('世界');
    expect(info.components[0]!.templates.size).toBe(2);
  });
  it('rejects unsafe inline event strings and ambiguous lifecycle returns', () => {
    expect(() =>
      compile(
        analyze(`export function X(){ return <button onclick="alert(1)"/> }`, '/X.tsx'),
        false,
      ),
    ).toThrow('event callback');
    expect(() =>
      compile(analyze(`export function X(){ if(true) return <b/>; return <i/> }`, '/X.tsx'), false),
    ).toThrow('early component returns');
  });
});

describe('view server', () => {
  it('escapes text, attributes, and serialized props, omitting inline handlers', () => {
    const result = component(
      'vv-test',
      { label: '</script>"' },
      () => () =>
        template('vv-test', '<button data-vv-a="0"><slot data-vv-slot="1"></slot></button>', [
          ['event', 0, 'click', () => {}],
          ['attr', 0, 'title', '"<>'],
          ['child', 1, '', '<script>'],
        ]),
      true,
    );
    const html = render(result);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('title="&quot;&lt;&gt;"');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('</script>');
  });
  it('renders static children inline and lets a dynamic parent own callbacks', () => {
    const html = component(
      'vv-parent',
      {},
      () => () => component('vv-child', { invoke() {} }, () => () => new Html('<b>Hi</b>'), true),
      true,
    );
    expect(render(html)).toContain('<vv-child><b>Hi</b></vv-child>');
    expect(() => component('vv-child', { invoke() {} }, () => () => '', true)).toThrow(
      'serializable',
    );
    expect(render(component('vv-static', {}, () => () => '<unsafe>', false))).toBe(
      '&lt;unsafe&gt;',
    );
  });
  it('matches HTML boolean and ARIA attribute semantics', () => {
    expect(
      render(
        template('x', '<input data-vv-a="0">', [
          ['attr', 0, 'disabled', false],
          ['attr', 0, 'aria-pressed', false],
        ]),
      ),
    ).toBe('<input aria-pressed="false">');
    expect(() =>
      render(template('x', '<div data-vv-a="0"></div>', [['attr', 0, 'onclick', 'alert(1)']])),
    ).toThrow('Unsafe');
  });
  it('uses the final spread/attribute value consistently with browser rendering', () => {
    expect(
      render(
        template('x', '<input data-vv-a="0">', [
          ['attr', 0, 'title', 'first'],
          ['spread', 0, '', { title: 'second', disabled: true }],
          ['attr', 0, 'disabled', false],
        ]),
      ),
    ).toBe('<input title="second">');
  });
});
