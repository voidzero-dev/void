import { readFileSync } from 'node:fs';
import MagicString from 'magic-string';
import { parseSync } from 'oxc-parser';
import { transformWithOxc } from 'vite';
import { bindingNames, compile, type AstNode, type ModuleInfo } from './compiler.ts';
import { references } from './references.ts';
import type { ClientUnit, ViewResources } from './resources.ts';

interface SourceModule {
  id: number;
  file: string;
  code: string;
  declarations: Map<string, { node: AstNode; code: string; order: number; names: Array<string> }>;
  imports: Map<string, { source: string; imported: string }>;
  exports: Map<string, string | { source: string; imported: string }>;
  stars: Array<string>;
  effects: Array<{ node: AstNode; code: string; order: number; names: Array<string> }>;
  sideEffects: Array<string>;
}
/** Compile source fragments once. SSR later selects and concatenates only the required declarations. */
export async function prepareClient(
  views: Map<string, ModuleInfo>,
  eligible: Set<string>,
  resolve: (id: string, importer: string) => Promise<string | undefined>,
): Promise<Pick<ViewResources, 'units' | 'componentUnits' | 'register'>> {
  if (!eligible.size) {
    return { units: {}, componentUnits: {}, register: '' };
  }
  const modules = new Map<string, SourceModule>();
  const units: Record<string, ClientUnit> = {};
  const componentUnits: Record<string, string> = {};
  async function load(file: string): Promise<SourceModule> {
    const cached = modules.get(file);
    if (cached) {
      return cached;
    }
    const view = views.get(file);
    const input = view ? compile(view, true).code : readFileSync(file, 'utf8');
    const transformed = await transformWithOxc(input, file, { target: 'esnext', sourcemap: false });
    const code = transformed.code;
    const ast = parseSync(file + '.js', code).program as unknown as AstNode;
    const mod: SourceModule = {
      id: modules.size,
      file,
      code,
      declarations: new Map(),
      imports: new Map(),
      exports: new Map(),
      stars: [],
      effects: [],
      sideEffects: [],
    };
    modules.set(file, mod);
    function declaration(node: AstNode, order: number) {
      if (node.type === 'VariableDeclaration') {
        for (const [index, item] of node.declarations.entries()) {
          const names = bindingNames(item.id);
          const entry = {
            node: { ...node, declarations: [item], start: item.start, end: item.end },
            code: node.kind + ' ' + code.slice(item.start, item.end) + ';',
            order: order + index / (node.declarations.length + 1),
            names,
          };
          for (const name of names) {
            mod.declarations.set(name, entry);
          }
        }
      } else if (
        (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') &&
        node.id
      ) {
        mod.declarations.set(node.id.name, {
          node,
          code: code.slice(node.start, node.end),
          order,
          names: [node.id.name],
        });
      } else {
        mod.effects.push({ node, code: code.slice(node.start, node.end), order, names: [] });
      }
    }
    for (const [order, statement] of ast.body.entries()) {
      if (statement.type === 'ImportDeclaration') {
        if (
          !statement.specifiers.length &&
          !/\.(css|scss|sass|less)(?:\?|$)/.test(statement.source.value)
        ) {
          mod.sideEffects.push(statement.source.value);
        }
        for (const spec of statement.specifiers) {
          mod.imports.set(spec.local.name, {
            source: statement.source.value,
            imported:
              spec.type === 'ImportDefaultSpecifier'
                ? 'default'
                : spec.type === 'ImportNamespaceSpecifier'
                  ? '*'
                  : (spec.imported.name ?? spec.imported.value),
          });
        }
      } else if (statement.type === 'ExportNamedDeclaration') {
        if (statement.declaration) {
          declaration(statement.declaration, order);
          const names =
            statement.declaration.type === 'VariableDeclaration'
              ? statement.declaration.declarations.flatMap((item: AstNode) => bindingNames(item.id))
              : [statement.declaration.id.name];
          for (const name of names) {
            mod.exports.set(name, name);
          }
        }
        for (const spec of statement.specifiers) {
          mod.exports.set(
            spec.exported.name ?? spec.exported.value,
            statement.source
              ? { source: statement.source.value, imported: spec.local.name }
              : spec.local.name,
          );
        }
      } else if (statement.type === 'ExportAllDeclaration') {
        mod.stars.push(statement.source.value);
      } else if (statement.type === 'ExportDefaultDeclaration') {
        const value = statement.declaration;
        if (value.type === 'Identifier') {
          mod.exports.set('default', value.name);
        } else if (value.id && ['FunctionDeclaration', 'ClassDeclaration'].includes(value.type)) {
          declaration(value, order);
          mod.exports.set('default', value.id.name);
        } else {
          const name = '__vv_default';
          mod.exports.set('default', name);
          mod.declarations.set(name, {
            node: value,
            code: `const ${name} = ${code.slice(value.start, value.end)};`,
            order,
            names: [name],
          });
        }
      } else if (
        statement.type === 'ExpressionStatement' &&
        statement.expression.type === 'CallExpression' &&
        statement.expression.callee.name === '__vv_register'
      ) {
        // Registration is emitted by SSR only for the selected dynamic components.
      } else {
        declaration(statement, order);
      }
    }
    return mod;
  }
  async function imported(source: string, mod: SourceModule) {
    const id = await resolve(source, mod.file);
    if (!id || id.startsWith('\0') || id.startsWith('node:')) {
      throw new Error(`${mod.file}: cannot inline client import ${source}`);
    }
    return load(id.split('?')[0]!);
  }
  async function exported(
    mod: SourceModule,
    name: string,
    seen = new Set<string>(),
  ): Promise<{ mod: SourceModule; name: string } | undefined> {
    const key = `${mod.id}:${name}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const entry = mod.exports.get(name);
    if (typeof entry === 'string') {
      if (mod.declarations.has(entry)) {
        return { mod, name: entry };
      }
      const importedEntry = mod.imports.get(entry);
      if (importedEntry) {
        return exported(await imported(importedEntry.source, mod), importedEntry.imported, seen);
      }
    } else if (entry) {
      return exported(await imported(entry.source, mod), entry.imported, seen);
    }
    for (const source of mod.stars) {
      const found = await exported(await imported(source, mod), name, seen);
      if (found) {
        return found;
      }
    }
  }
  function symbol(mod: SourceModule, name: string): string {
    return '__vv_m' + mod.id + '_' + name;
  }
  async function unit(mod: SourceModule, name: string): Promise<string> {
    const declaration = name.startsWith('#')
      ? mod.effects[Number(name.slice(1))]
      : mod.declarations.get(name);
    if (!declaration) {
      throw new Error(`${mod.file}: cannot inline client binding ${name}; use ESM exports`);
    }
    const id = `${mod.id}:${declaration.names[0] ?? name}`;
    if (units[id]) {
      return id;
    }
    const record: ClientUnit = {
      module: mod.id,
      order: declaration.order,
      names: declaration.names.map((name) => symbol(mod, name)),
      code: '',
      dependencies: [],
    };
    units[id] = record;
    const component = views.get(mod.file)?.components.find((component) => component.name === name);
    if (component) {
      componentUnits[component.id] = id;
    }
    const node = declaration.node;
    const edits = new MagicString(mod.code.slice(node.start, node.end));
    function replace(target: AstNode, text: string) {
      edits.overwrite(target.start - node.start, target.end - node.start, text);
    }
    function binding(target: AstNode | null, shorthand = false) {
      if (!target) {
        return;
      }
      if (target.type === 'Identifier') {
        replace(target, (shorthand ? target.name + ':' : '') + symbol(mod, target.name));
      } else if (target.type === 'AssignmentPattern') {
        binding(target.left, shorthand);
      } else if (target.type === 'RestElement') {
        binding(target.argument);
      } else if (target.type === 'ArrayPattern') {
        for (const item of target.elements) {
          binding(item);
        }
      } else if (target.type === 'ObjectPattern') {
        for (const property of target.properties) {
          binding(
            property.type === 'RestElement' ? property.argument : property.value,
            property.shorthand,
          );
        }
      }
    }
    if (node.type === 'VariableDeclaration') {
      for (const item of node.declarations) {
        binding(item.id);
      }
    } else if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
      binding(node.id);
    }
    for (const ref of references(node)) {
      let target: { mod: SourceModule; name: string } | undefined;
      let namespace = false;
      if (mod.declarations.has(ref.name)) {
        target = { mod, name: ref.name };
      } else {
        const entry = mod.imports.get(ref.name);
        if (!entry) {
          continue;
        }
        namespace = entry.imported === '*';
        if (namespace && !ref.member) {
          throw new Error(mod.file + ': use static namespace members in inline client code');
        }
        target = await exported(
          await imported(entry.source, mod),
          namespace ? ref.member! : entry.imported,
        );
        if (!target) {
          throw new Error(mod.file + ': cannot resolve client import ' + ref.name);
        }
      }
      record.dependencies.push(await unit(target.mod, target.name));
      let replacement = symbol(target.mod, target.name);
      if (!namespace && ref.member) {
        replacement += (ref.node.optional ? '?.' : '.') + ref.member;
      }
      if (ref.shorthand) {
        replacement = ref.name + ':' + replacement;
      }
      replace(ref.node, replacement);
    }
    const rewritten = edits.toString();
    record.code =
      node.type === 'VariableDeclaration'
        ? node.kind + ' ' + rewritten + ';'
        : declaration.names.length && !node.id
          ? 'const ' + record.names[0] + '=' + rewritten + ';'
          : rewritten;
    // Preserve explicit module side effects, but never retain unused component declarations.
    for (let index = 0; index < mod.effects.length; index++) {
      const effect = '#' + index;
      if (effect !== name) {
        record.dependencies.push(await unit(mod, effect));
      }
    }
    for (const source of mod.sideEffects) {
      const target = await imported(source, mod);
      for (let index = 0; index < target.effects.length; index++) {
        record.dependencies.push(await unit(target, '#' + index));
      }
    }
    return id;
  }
  for (const view of views.values()) {
    for (const component of view.components) {
      if (eligible.has(component.id)) {
        componentUnits[component.id] = await unit(await load(view.file), component.name);
      }
    }
  }
  const runtimeFile = await resolve(
    '@void/view/client',
    [...views.keys()][0] ?? process.cwd() + '/index.ts',
  );
  if (!runtimeFile) {
    throw new Error('Cannot resolve @void/view/client');
  }
  const runtime = await load(runtimeFile);
  const register = await exported(runtime, 'register');
  if (!register) {
    throw new Error('Missing view client registration');
  }
  return { units, componentUnits, register: await unit(register.mod, register.name) };
}
