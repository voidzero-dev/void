import { createHash } from 'node:crypto';
import { decodeHTML } from 'entities';
import MagicString, { type SourceMap } from 'magic-string';
import { parseSync } from 'oxc-parser';
import { escapeHtml, voidTags } from './shared.ts';
import { scopeStyles } from './styles.ts';

// Oxc's ESTree nodes have heterogeneous fields; all access is guarded by node kind.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- A structural ESTree cursor; fields are selected by node kind below.
export type AstNode = { type: string; start: number; end: number; [key: string]: any };
type Node = AstNode;
export interface ComponentInfo {
  name: string;
  id: string;
  node: Node;
  dynamic: boolean;
  scope?: string;
  dynamicStyles: boolean;
  styles: Array<string>;
  dependencies: Set<string>;
  callbacks: Set<string>;
  templates: Map<string, string>;
  defaultStatementStart?: number;
  callbackArguments: Array<{ tag: string; name: string; value?: string; known: boolean }>;
  callbackProps: Set<string>;
  propBindings: Map<string, string>;
}
export interface ModuleInfo {
  file: string;
  source: string;
  program: Node;
  components: Array<ComponentInfo>;
  imports: Map<string, { source: string; imported: string }>;
  exports: Map<string, string>;
  functions: Set<string>;
  stars: Array<string>;
}
function children(node: Node): Array<Node> {
  return Object.values(node)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value) => value && typeof value === 'object' && typeof value.type === 'string');
}
function walk(node: Node, visit: (node: Node) => boolean | void): void {
  if (visit(node) === false) {
    return;
  }
  for (const child of children(node)) {
    walk(child, visit);
  }
}
export function bindingNames(node: Node): Array<string> {
  if (node.type === 'Identifier') {
    return [node.name];
  }
  if (node.type === 'MemberExpression') {
    return bindingNames(node.object);
  }
  if (node.type === 'AssignmentPattern') {
    return bindingNames(node.left);
  }
  if (node.type === 'RestElement') {
    return bindingNames(node.argument);
  }
  if (node.type === 'ArrayPattern') {
    return node.elements.flatMap((item: Node | null) => (item ? bindingNames(item) : []));
  }
  if (node.type === 'ObjectPattern') {
    return node.properties.flatMap((item: Node) =>
      bindingNames(item.type === 'RestElement' ? item : item.value),
    );
  }
  return [];
}
function tagName(node: Node): string {
  if (node.type === 'JSXIdentifier') {
    return node.name;
  }
  if (node.type === 'JSXMemberExpression') {
    return `${tagName(node.object)}.${tagName(node.property)}`;
  }
  throw new Error('@void/view: JSX namespaces are not supported');
}
export function analyze(source: string, file: string, identity = file): ModuleInfo {
  const result = parseSync(file, source);
  if (result.errors.length) {
    throw new Error(`${file}: ${result.errors.map((error) => error.message).join('\n')}`);
  }
  const program = result.program as unknown as Node;
  const info: ModuleInfo = {
    file,
    source,
    program,
    components: [],
    imports: new Map(),
    exports: new Map(),
    functions: new Set(),
    stars: [],
  };
  for (const statement of program.body) {
    const declaration = statement.declaration ?? statement;
    if (declaration.type === 'FunctionDeclaration' && declaration.id) {
      info.functions.add(declaration.id.name);
    }
    if (declaration.type === 'VariableDeclaration') {
      for (const item of declaration.declarations) {
        if (['ArrowFunctionExpression', 'FunctionExpression'].includes(item.init?.type)) {
          info.functions.add(item.id.name);
        }
      }
    }
  }
  const add = (node: Node, name: string) => {
    let jsx = false;
    let styled = false;
    let dynamicStyles = false;
    walk(node.body, (child) => {
      if (child.type === 'JSXElement' || child.type === 'JSXFragment') {
        jsx = true;
      }
      if (child.type === 'JSXElement' && child.openingElement.name.name === 'style') {
        styled = true;
        dynamicStyles ||= child.children.some(
          (item: Node) =>
            item.type === 'JSXExpressionContainer' &&
            item.expression.type !== 'JSXEmptyExpression' &&
            !(item.expression.type === 'Literal' && typeof item.expression.value === 'string') &&
            !(
              item.expression.type === 'TemplateLiteral' && item.expression.expressions.length === 0
            ),
        );
      }
    });
    if (!jsx && !/^[A-Z]/.test(name)) {
      return;
    }
    if (node.async || node.generator) {
      throw new Error(`${file}: view components must be synchronous`);
    }
    if (node.params.length > 1) {
      throw new Error(`${file}: view components accept a single props argument`);
    }
    const id = `vv-${name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}-${createHash(
      'sha256',
    )
      .update(identity + ':' + name)
      .digest('hex')
      .slice(0, 8)}`;
    const component: ComponentInfo = {
      name,
      id,
      node,
      dynamic: dynamicStyles,
      dynamicStyles,
      styles: [],
      scope: styled ? `data-vv-cid-${id.slice(-8)}` : undefined,
      dependencies: new Set(),
      callbacks: new Set(),
      templates: new Map(),
      callbackArguments: [],
      callbackProps: new Set(),
      propBindings: new Map(),
    };
    const param =
      node.params[0]?.type === 'AssignmentPattern' ? node.params[0].left : node.params[0];
    if (param?.type === 'ObjectPattern') {
      for (const property of param.properties) {
        if (property.type === 'Property') {
          for (const binding of bindingNames(property.value)) {
            component.propBindings.set(binding, property.key.name ?? property.key.value);
          }
        }
      }
    }
    const functions = new Set(info.functions);
    walk(node.body, (child) => {
      if (child.type === 'FunctionDeclaration' && child.id) {
        functions.add(child.id.name);
      }
      if (
        child.type === 'VariableDeclarator' &&
        ['ArrowFunctionExpression', 'FunctionExpression'].includes(child.init?.type)
      ) {
        functions.add(child.id.name);
      }
    });
    walk(node.body, (child) => {
      if (child.type !== 'JSXOpeningElement') {
        return;
      }
      const tag = tagName(child.name);
      const native = child.name.type === 'JSXIdentifier' && /^[a-z]/.test(tag);
      if (!native) {
        component.dependencies.add(tag);
      }
      for (const attr of child.attributes) {
        if (attr.type === 'JSXSpreadAttribute') {
          component.dynamic = true;
          if (!native) {
            component.callbacks.add(tag);
            component.callbackArguments.push({ tag, name: '*', known: true });
          }
          continue;
        }
        const name = tagName(attr.name);
        const expression = attr.value?.expression;
        const callback =
          /^on/i.test(name) ||
          ['ArrowFunctionExpression', 'FunctionExpression'].includes(expression?.type) ||
          (expression?.type === 'Identifier' && functions.has(expression.name));
        if (!native) {
          let value = expression?.type === 'Identifier' ? expression.name : undefined;
          if (
            expression?.type === 'MemberExpression' &&
            expression.object.type === 'Identifier' &&
            expression.object.name === param?.name &&
            !expression.computed
          ) {
            value = source.slice(expression.start, expression.end);
            component.propBindings.set(value, expression.property.name);
          }
          component.callbackArguments.push({ tag, name, value, known: callback });
        }
        if (callback) {
          component.dynamic = true;
          if (!native) {
            component.callbacks.add(tag);
          }
        }
      }
    });
    info.components.push(component);
  };
  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration' && statement.importKind !== 'type') {
      for (const spec of statement.specifiers) {
        if (spec.importKind !== 'type') {
          info.imports.set(spec.local.name, {
            source: statement.source.value,
            imported:
              spec.type === 'ImportDefaultSpecifier' ? 'default' : (spec.imported?.name ?? '*'),
          });
        }
      }
    }
    const declaration = statement.declaration ?? statement;
    if (declaration.type === 'FunctionDeclaration') {
      const name = declaration.id?.name ?? 'DefaultView';
      add(declaration, name);
      if (statement.type.startsWith('Export')) {
        info.exports.set(statement.type === 'ExportDefaultDeclaration' ? 'default' : name, name);
      }
    } else if (declaration.type === 'VariableDeclaration') {
      for (const item of declaration.declarations) {
        if (
          ['ArrowFunctionExpression', 'FunctionExpression'].includes(item.init?.type) &&
          item.id.type === 'Identifier'
        ) {
          add(item.init, item.id.name);
        }
        if (statement.type === 'ExportNamedDeclaration') {
          info.exports.set(item.id.name, item.id.name);
        }
      }
    } else if (statement.type === 'ExportDefaultDeclaration' && declaration.type === 'Identifier') {
      info.exports.set('default', declaration.name);
    } else if (
      statement.type === 'ExportDefaultDeclaration' &&
      declaration.type === 'ArrowFunctionExpression'
    ) {
      add(declaration, 'DefaultView');
      info.components.at(-1)!.defaultStatementStart = statement.start;
      info.exports.set('default', 'DefaultView');
    }
    if (statement.type === 'ExportNamedDeclaration') {
      for (const spec of statement.specifiers ?? []) {
        info.exports.set(spec.exported.name, spec.local.name);
        if (statement.source && statement.exportKind !== 'type') {
          info.imports.set(spec.local.name, {
            source: statement.source.value,
            imported: spec.local.name,
          });
        }
      }
    }
    if (statement.type === 'ExportAllDeclaration' && statement.exportKind !== 'type') {
      info.stars.push(statement.source.value);
    }
  }
  return info;
}
function jsxText(value: string): string {
  const lines = decodeHTML(value).replace(/\r/g, '').split('\n');
  return lines
    .map((line, index) => {
      let text = line.replace(/\t/g, ' ');
      if (index > 0) {
        text = text.trimStart();
      }
      if (index < lines.length - 1) {
        text = text.trimEnd();
      }
      return text;
    })
    .filter(Boolean)
    .join(' ');
}
export function compile(
  info: ModuleInfo,
  client: boolean,
): { code: string; map: SourceMap | null } {
  const output = new MagicString(info.source);
  const source = info.source;
  const imports = `import { component as __vv_component, template as __vv_template, register as __vv_register } from '@void/view/${client ? 'client' : 'server'}';\n`;
  if (!info.components.length) {
    return { code: source, map: null };
  }
  if (/\b__vv_\w*/.test(source)) {
    throw new Error(`${info.file}: the __vv_ prefix is reserved by @void/view`);
  }
  for (const component of info.components) {
    component.templates.clear();
    component.styles = [];
    let styleIndex = 0;
    const fn = component.node;
    const state = new Set<string>();
    for (const statement of fn.body.body ?? []) {
      if (statement.type === 'VariableDeclaration' && statement.kind === 'let') {
        for (const item of statement.declarations) {
          for (const name of bindingNames(item.id)) {
            state.add(name);
          }
        }
      }
    }
    let templateIndex = 0;
    function expr(node: Node, shadow = new Set<string>(), rendering = true): string {
      if (node.type === 'JSXElement' || node.type === 'JSXFragment') {
        return jsx(node, shadow);
      }
      const edit = new MagicString(source.slice(node.start, node.end));
      function patch(current: Node, hidden: Set<string>, inRender: boolean) {
        if (current.type === 'JSXElement' || current.type === 'JSXFragment') {
          edit.overwrite(
            current.start - node.start,
            current.end - node.start,
            jsx(current, hidden),
          );
          return;
        }
        let scoped = hidden;
        if (
          ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(
            current.type,
          )
        ) {
          inRender = false;
        }
        if (
          [
            'ArrowFunctionExpression',
            'FunctionExpression',
            'FunctionDeclaration',
            'BlockStatement',
            'CatchClause',
            'ForStatement',
            'ForOfStatement',
            'ForInStatement',
          ].includes(current.type)
        ) {
          scoped = new Set(hidden);
          const bindings: Array<Node> = [
            ...(current.params ?? []),
            ...(current.param ? [current.param] : []),
          ];
          const loop = current.init ?? current.left;
          if (loop?.type === 'VariableDeclaration') {
            bindings.push(...loop.declarations.map((item: Node) => item.id));
          }
          if (current !== fn.body) {
            for (const statement of current.body?.body ??
              (Array.isArray(current.body) ? current.body : [])) {
              if (statement.type === 'VariableDeclaration') {
                bindings.push(...statement.declarations.map((item: Node) => item.id));
              }
            }
          }
          for (const binding of bindings) {
            for (const name of bindingNames(binding)) {
              scoped.add(name);
            }
          }
        }
        if (current.type === 'AssignmentExpression' || current.type === 'UpdateExpression') {
          const target = current.left ?? current.argument;
          const changed = bindingNames(target).some((name) => state.has(name) && !scoped.has(name));
          if (changed) {
            if (inRender) {
              throw new Error(
                `${info.file}: update view state inside callbacks, not while rendering`,
              );
            }
            // Recurse into operands before wrapping, retaining expression result and evaluation order.
            for (const child of children(current)) {
              patch(child, scoped, inRender);
            }
            edit.prependLeft(current.start - node.start, '__vv_change(');
            edit.appendRight(current.end - node.start, ')');
            return;
          }
        }
        for (const child of children(current)) {
          patch(child, scoped, inRender);
        }
      }
      patch(node, shadow, rendering);
      return edit.toString();
    }
    function jsx(node: Node, shadow: Set<string>): string {
      const id = component.id + (templateIndex++ ? `-${templateIndex - 1}` : '');
      let key = 0;
      const bindings: Array<string> = [];
      function slot(value: string, name = ''): string {
        const index = key++;
        bindings.push(`['child',${index},'',${value}]`);
        return name ? `<slot data-vv-slot="${index}" name="${name}"></slot>` : `<!--vv:${index}-->`;
      }
      function child(n: Node, parent = ''): string {
        if (n.type === 'JSXText') {
          return escapeHtml(jsxText(n.value));
        }
        if (n.type === 'JSXExpressionContainer') {
          if (n.expression.type === 'JSXEmptyExpression') {
            return '';
          }
          return slot(
            expr(n.expression, shadow),
            n.expression.type === 'Identifier' &&
              n.expression.name === 'children' &&
              ![
                'table',
                'thead',
                'tbody',
                'tfoot',
                'tr',
                'colgroup',
                'select',
                'optgroup',
              ].includes(parent)
              ? 'children'
              : '',
          );
        }
        if (n.type === 'JSXSpreadChild') {
          return slot(expr(n.expression, shadow));
        }
        return element(n);
      }
      function element(n: Node): string {
        if (n.type === 'JSXFragment') {
          return n.children.map((item: Node) => child(item)).join('');
        }
        const opening = n.openingElement;
        const tag = tagName(opening.name);
        if (opening.name.type !== 'JSXIdentifier' || !/^[a-z]/.test(tag)) {
          const props = opening.attributes.map((attr: Node) => {
            if (attr.type === 'JSXSpreadAttribute') {
              return `...(${expr(attr.argument, shadow)})`;
            }
            const name = tagName(attr.name);
            const value = !attr.value
              ? 'true'
              : attr.value.type === 'Literal'
                ? JSON.stringify(decodeHTML(attr.value.value))
                : expr(attr.value.expression, shadow);
            return `${JSON.stringify(name)}:${value}`;
          });
          if (n.children.length) {
            const values = n.children.flatMap((c: Node) => {
              if (c.type === 'JSXText') {
                const text = jsxText(c.value);
                return text ? [JSON.stringify(text)] : [];
              }
              if (c.type === 'JSXExpressionContainer') {
                return c.expression.type === 'JSXEmptyExpression'
                  ? []
                  : [expr(c.expression, shadow)];
              }
              return [expr(c, shadow)];
            });
            props.push(`children:${values.length === 1 ? values[0] : `[${values.join(',')}]`}`);
          }
          return slot(`${tag}({${props.join(',')}})`);
        }
        if (tag === 'style') {
          if (opening.attributes.length) {
            throw new Error(`${info.file}: component style blocks do not accept attributes`);
          }
          const expressions: Array<string> = [];
          const text = n.children
            .map((item: Node) => {
              if (item.type === 'JSXText') {
                return decodeHTML(item.value);
              }
              const value = item.expression;
              if (value?.type === 'JSXEmptyExpression') {
                return '';
              }
              if (value?.type === 'Literal' && typeof value.value === 'string') {
                return value.value;
              }
              if (value?.type === 'TemplateLiteral') {
                return value.quasis
                  .map((quasi: Node, index: number) => {
                    let text = quasi.value.cooked;
                    if (index < value.expressions.length) {
                      const marker = `__vv_expr${expressions.length}__`;
                      expressions.push(expr(value.expressions[index], shadow));
                      text += marker;
                    }
                    return text;
                  })
                  .join('');
              }
              throw new Error(`${info.file}: use a template literal inside <style>`);
            })
            .join('');
          const css = scopeStyles(text, component.scope!, info.file, expressions.length > 0);
          if (!expressions.length) {
            component.styles.push(css);
            return '';
          }
          // Preserve interpolation order and evaluate each expression exactly once.
          const parts = css.split(/(__vv_expr\d+__)/).map((part: string) => {
            const match = /^__vv_expr(\d+)__$/.exec(part);
            return match ? `String(__vv_values[${match[1]}])` : JSON.stringify(part);
          });
          const value = `((__vv_values) => ${parts.join('+')})([${expressions.join(',')}])`;
          return slot(`__vv_style(${styleIndex++},${value})`);
        }
        let rawText: string | undefined;
        if (['script', 'textarea', 'title'].includes(tag)) {
          const text: string = n.children
            .map((child: Node) => {
              if (child.type === 'JSXText') {
                return decodeHTML(child.value);
              }
              const value = child.expression;
              if (value?.type === 'JSXEmptyExpression') {
                return '';
              }
              if (value?.type === 'Literal' && typeof value.value === 'string') {
                return value.value;
              }
              if (value?.type === 'TemplateLiteral' && value.expressions.length === 0) {
                return value.quasis[0].value.cooked;
              }
              throw new Error(
                info.file +
                  ': use attributes/props rather than dynamic children inside <' +
                  tag +
                  '>',
              );
            })
            .join('');
          const content = text;
          rawText =
            tag === 'title' || tag === 'textarea'
              ? escapeHtml(content)
              : content.replace(new RegExp('</' + tag, 'gi'), '<\\/' + tag);
        }
        let attrs =
          (component.scope ? ` ${component.scope}` : '') +
          (component.dynamicStyles ? ' data-vv-i' : '');
        const hasSpread = opening.attributes.some(
          (attr: Node) => attr.type === 'JSXSpreadAttribute',
        );
        let marker: number | undefined;
        const getMarker = () => {
          if (marker === undefined) {
            marker = key++;
            attrs += ` data-vv-a="${marker}"`;
          }
          return marker;
        };
        for (const attr of opening.attributes) {
          if (attr.type === 'JSXSpreadAttribute') {
            bindings.push(`['spread',${getMarker()},'',${expr(attr.argument, shadow)}]`);
            continue;
          }
          const name = tagName(attr.name);
          if (name.startsWith('data-vv-') || name === 'dangerouslySetInnerHTML') {
            throw new Error(`${info.file}: unsupported view attribute ${name}`);
          }
          if (/^on/i.test(name)) {
            if (attr.value?.type !== 'JSXExpressionContainer') {
              throw new Error(`${info.file}: ${name} must be an event callback`);
            }
            bindings.push(
              `['event',${getMarker()},${JSON.stringify(name.slice(2).toLowerCase())},${expr(attr.value.expression, shadow)}]`,
            );
          } else if (!attr.value) {
            if (hasSpread) {
              bindings.push(`['attr',${getMarker()},${JSON.stringify(name)},true]`);
            } else {
              attrs += ` ${name}`;
            }
          } else if (attr.value.type === 'Literal') {
            if (hasSpread) {
              bindings.push(
                `['attr',${getMarker()},${JSON.stringify(name)},${JSON.stringify(decodeHTML(attr.value.value))}]`,
              );
            } else {
              attrs += ` ${name}="${escapeHtml(decodeHTML(attr.value.value))}"`;
            }
          } else {
            bindings.push(
              `['attr',${getMarker()},${JSON.stringify(name)},${expr(attr.value.expression, shadow)}]`,
            );
          }
        }
        return `<${tag}${attrs}>${voidTags.has(tag) ? '' : (rawText ?? n.children.map((item: Node) => child(item, tag)).join('')) + `</${tag}>`}`;
      }
      const html = element(node);
      component.templates.set(id, html);
      return `__vv_template(${JSON.stringify(id)},${client ? 'null' : JSON.stringify(html)},[${bindings.join(',')}]${component.dynamicStyles ? ',__vv_instance' : ''})`;
    }
    const parameter = fn.params[0];
    const binding = parameter?.type === 'AssignmentPattern' ? parameter.left : parameter;
    const params = binding ? source.slice(binding.start, binding.end) : '';
    const fallback =
      parameter?.type === 'AssignmentPattern'
        ? source.slice(parameter.right.start, parameter.right.end)
        : '{}';
    const setup = params ? `const ${params} = __vv_props;` : '';
    let body: string;
    if (fn.body.type !== 'BlockStatement') {
      body = `return () => ${expr(fn.body)};`;
    } else {
      const statements = fn.body.body as Array<Node>;
      const last = statements.at(-1);
      if (last?.type !== 'ReturnStatement' || !last.argument) {
        throw new Error(`${info.file}: ${component.name} needs a final return expression`);
      }
      // Initialization runs once. Rendering executes only the final return expression.
      for (const statement of statements.slice(0, -1)) {
        walk(statement, (n) => {
          if (
            ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(
              n.type,
            )
          ) {
            return false;
          }
          if (n.type === 'ReturnStatement') {
            throw new Error(
              `${info.file}: use conditional JSX in the final return instead of early component returns`,
            );
          }
        });
      }
      body =
        statements
          .slice(0, -1)
          .map((statement) => expr(statement, new Set(), false))
          .join('\n') + `\nreturn () => (${expr(last.argument)});`;
    }
    // Replace parameters too: destructuring belongs inside the persistent instance closure.
    if (fn.type === 'ArrowFunctionExpression') {
      if (component.defaultStatementStart !== undefined) {
        output.overwrite(component.defaultStatementStart, fn.start, `const ${component.name} = `);
        output.append(`\nexport default ${component.name};\n`);
      }
      output.overwrite(
        fn.start,
        fn.end,
        `(__vv_props = ${fallback}) => __vv_component(${JSON.stringify(component.id)},__vv_props,(__vv_change,__vv_style,__vv_instance)=>{${setup}\n${body}},${component.dynamic}${component.dynamicStyles ? ',true' : ''})`,
      );
    } else {
      output.overwrite(
        fn.start,
        fn.end,
        `function ${component.name}(__vv_props = ${fallback}) { return __vv_component(${JSON.stringify(component.id)},__vv_props,(__vv_change,__vv_style,__vv_instance)=>{${setup}\n${body}},${component.dynamic}${component.dynamicStyles ? ',true' : ''}); }`,
      );
    }
    if (component.dynamic) {
      output.append(`\n__vv_register(${JSON.stringify(component.id)},${component.name});\n`);
    }
  }
  output.prepend(imports);
  return {
    code: output.toString(),
    map: output.generateMap({ hires: true, source: info.file, includeContent: true }),
  };
}
