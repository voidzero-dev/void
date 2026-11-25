import { parseSync } from 'vite';
import {
  asAstProgram,
  isCallExpression,
  isIdentifier,
  isMemberExpression,
  isObjectExpression,
} from './ast.ts';
import type {
  AstImportDeclaration,
  AstImportNamespaceSpecifier,
  AstImportSpecifier,
  AstNode,
  AstProgram,
  AstVariableDeclaration,
} from './ast.ts';
import { isResourceName } from './resource-name.ts';
import { staticLiteral, unwrapStaticExpression } from './static-exports.ts';

/** Inspect default helper definitions without running application code. */
export function readResourceDefinition(
  filename: string,
  source: string,
  helpers: ReadonlySet<string>,
): { helper: string; options?: AstNode; name?: string } | null {
  let program: AstProgram;
  try {
    program = asAstProgram(parseSync(filename, source).program);
  } catch {
    return null;
  }

  const constants = new Map<string, AstNode>();
  const definitions = new Map<string, AstNode>();
  const importedHelpers = new Map<string, string>();
  const namespaces = new Map<string, ReadonlySet<string>>();
  const bindings = new Set<string>();
  function recordBindings(node: AstNode | undefined): void {
    if (isIdentifier(node)) {
      bindings.add(node.name);
    } else if (node?.type === 'ObjectPattern') {
      for (const property of (node.properties as Array<AstNode> | undefined) ?? []) {
        recordBindings(
          (property.type === 'RestElement' ? property.argument : property.value) as
            | AstNode
            | undefined,
        );
      }
    } else if (node?.type === 'ArrayPattern') {
      for (const element of (node.elements as Array<AstNode> | undefined) ?? []) {
        recordBindings(element);
      }
    } else if (node?.type === 'AssignmentPattern' || node?.type === 'RestElement') {
      recordBindings((node.left ?? node.argument) as AstNode | undefined);
    }
  }
  for (const statement of program.body ?? []) {
    if (statement.type === 'ImportDeclaration') {
      const declaration = statement as AstImportDeclaration;
      const source = declaration.source.value;
      const supported =
        source === 'void/ws'
          ? new Set(['defineRoom', 'defineWebSocket'])
          : source === 'void/durable'
            ? new Set(['defineDurableState', 'defineDurableObject'])
            : source === 'void/workflows'
              ? new Set(['defineWorkflow', 'defineWorkflowEntrypoint'])
              : new Set<string>();
      for (const specifier of declaration.specifiers ?? []) {
        const local = specifier.local as AstNode | undefined;
        recordBindings(local);
        if (specifier.type === 'ImportNamespaceSpecifier') {
          namespaces.set((specifier as AstImportNamespaceSpecifier).local.name, supported);
        } else if (specifier.type === 'ImportSpecifier') {
          const named = specifier as AstImportSpecifier;
          const imported = isIdentifier(named.imported)
            ? named.imported.name
            : staticLiteral(named.imported);
          if (typeof imported === 'string' && supported.has(imported) && helpers.has(imported)) {
            importedHelpers.set(named.local.name, imported);
          }
        }
      }
      continue;
    }
    const declaration =
      statement.type === 'ExportNamedDeclaration'
        ? (statement.declaration as AstNode | undefined)
        : statement;
    recordBindings(declaration?.id as AstNode | undefined);
    if (declaration?.type !== 'VariableDeclaration') {
      continue;
    }
    for (const variable of (declaration as AstVariableDeclaration).declarations ?? []) {
      recordBindings(variable.id);
      if (isIdentifier(variable.id) && variable.init) {
        definitions.set(variable.id.name, variable.init);
        if (declaration.kind === 'const') {
          constants.set(variable.id.name, variable.init);
        }
      }
    }
  }

  function resolve(node: AstNode | undefined, seen = new Set<string>()): AstNode | undefined {
    node = unwrapStaticExpression(node);
    if (!isIdentifier(node) || !constants.has(node.name) || seen.has(node.name)) {
      return node;
    }
    seen.add(node.name);
    return resolve(constants.get(node.name), seen);
  }

  type StaticName = { present: boolean; value?: string };

  function isStaticUndefined(node: AstNode | undefined): boolean {
    node = resolve(node);
    return isIdentifier(node) && node.name === 'undefined' && !bindings.has(node.name);
  }

  function readName(options: AstNode | undefined, seen = new Set<AstNode>()): StaticName {
    options = resolve(options);
    if (!isObjectExpression(options) || seen.has(options)) {
      return { present: false };
    }
    seen.add(options);
    let name: StaticName = { present: false };
    for (const property of options.properties ?? []) {
      if (property.type === 'SpreadElement') {
        const spread = resolve(property.argument as AstNode | undefined);
        if (isObjectExpression(spread)) {
          const spreadName = readName(spread, seen);
          if (spreadName.present) {
            name = spreadName;
          }
        } else if (name.value !== undefined) {
          throw new Error(`${filename}: resource name cannot be overridden by a dynamic spread.`);
        }
        continue;
      }
      if (property.type !== 'Property') {
        continue;
      }
      const key = property.key as AstNode | undefined;
      const keyName = !property.computed && isIdentifier(key) ? key.name : staticLiteral(key);
      if (keyName !== 'name') {
        if (property.computed && keyName === undefined && name.value !== undefined) {
          throw new Error(`${filename}: resource name cannot be overridden by a dynamic key.`);
        }
        continue;
      }
      const valueNode = property.value as AstNode | undefined;
      if (isStaticUndefined(valueNode)) {
        name = { present: true };
        continue;
      }
      const value = staticLiteral(resolve(valueNode));
      if (!isResourceName(value)) {
        throw new Error(
          `${filename}: resource name must be a static string containing a word starting with a letter.`,
        );
      }
      name = { present: true, value };
    }
    seen.delete(options);
    return name;
  }

  const statement = program.body?.find((node) => node.type === 'ExportDefaultDeclaration');
  const declaration = unwrapStaticExpression(statement?.declaration as AstNode | undefined);
  const call = resolve(isIdentifier(declaration) ? definitions.get(declaration.name) : declaration);
  if (!isCallExpression(call)) {
    return null;
  }
  const callee = resolve(call.callee);
  let helper: string | undefined;
  if (isIdentifier(callee)) {
    helper =
      importedHelpers.get(callee.name) ?? (helpers.has(callee.name) ? callee.name : undefined);
  } else if (isMemberExpression(callee) && isIdentifier(callee.object)) {
    const property =
      !callee.computed && isIdentifier(callee.property)
        ? callee.property.name
        : staticLiteral(callee.property);
    if (
      typeof property === 'string' &&
      helpers.has(property) &&
      namespaces.get(callee.object.name)?.has(property)
    ) {
      helper = property;
    }
  }
  if (!helper) {
    return null;
  }
  const options = resolve(call.arguments?.[0]);
  const name = readName(options).value;
  return { helper, options, ...(name === undefined ? {} : { name }) };
}
