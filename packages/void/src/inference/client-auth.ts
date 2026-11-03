import type { parseSync } from 'vite';
import { bindingResolver } from '../shared/ast-bindings.ts';
import { isIdentifier, isMemberExpression, type AstNode, type AstProgram } from '../shared/ast.ts';
import { staticLiteral, unwrapStaticExpression } from '../shared/static-exports.ts';

export const CLIENT_MODULES: ReadonlySet<string> = new Set([
  'void/client',
  'void/client/react',
  'void/client/vue',
  'void/client/svelte',
  'void/client/solid',
]);

function name(node: AstNode | undefined): unknown {
  return isIdentifier(node) ? node.name : staticLiteral(node);
}

function propertyName(node: AstNode): unknown {
  const key = (node.property ?? node.key) as AstNode | undefined;
  return node.computed ? staticLiteral(key) : name(key);
}

/** Detect runtime auth imports and namespace reads without confusing aliases or type names. */
export function inferClientAuth(parsed: ReturnType<typeof parseSync>, code: string): boolean {
  let hasNamespace = false;
  for (const statement of parsed.module.staticImports) {
    if (!CLIENT_MODULES.has(statement.moduleRequest.value)) {
      continue;
    }
    for (const entry of statement.entries) {
      if (!entry.isType) {
        if (entry.importName.name === 'auth') {
          return true;
        }
        hasNamespace ||= entry.importName.kind === 'NamespaceObject';
      }
    }
  }
  for (const statement of parsed.module.staticExports) {
    for (const entry of statement.entries) {
      if (!entry.isType && entry.moduleRequest && CLIENT_MODULES.has(entry.moduleRequest.value)) {
        if (
          entry.importName.name === 'auth' ||
          entry.importName.kind === 'All' ||
          entry.importName.kind === 'AllButDefault'
        ) {
          return true;
        }
      }
    }
  }
  // Named imports/re-exports are fully described by module metadata. Keep the
  // parser's AST lazy unless a namespace or dynamic import could read auth.
  // Escaped names and string line continuations need the AST, but ordinary
  // regex escapes such as \\s must not materialize an otherwise unused namespace.
  if (
    (!hasNamespace && parsed.module.dynamicImports.length === 0) ||
    !/\bauth\b|\\(?:u|x|h|[0-7\r\n\u2028\u2029])/.test(code)
  ) {
    return false;
  }
  return inferNamespaceAuth(parsed.program as unknown as AstProgram);
}

function inferNamespaceAuth(program: AstProgram): boolean {
  const namespaces = new Set<AstNode>();
  for (const statement of program.body ?? []) {
    const source = staticLiteral(statement.source as AstNode | undefined);
    if (typeof source !== 'string' || !CLIENT_MODULES.has(source)) {
      continue;
    }
    if (statement.importKind === 'type' || statement.exportKind === 'type') {
      continue;
    }
    if (statement.type === 'ExportAllDeclaration') {
      return true;
    }
    for (const specifier of (statement.specifiers as Array<AstNode> | undefined) ?? []) {
      if (specifier.importKind === 'type' || specifier.exportKind === 'type') {
        continue;
      }
      if (statement.type === 'ImportDeclaration') {
        if (specifier.type === 'ImportNamespaceSpecifier') {
          namespaces.add(specifier);
        } else if (name(specifier.imported as AstNode) === 'auth') {
          return true;
        }
      } else if (
        statement.type === 'ExportNamedDeclaration' &&
        name(specifier.local as AstNode) === 'auth'
      ) {
        return true;
      }
    }
  }

  const reads: Array<AstNode | undefined> = [];
  const resolve = bindingResolver(program, {
    visit(node) {
      if (isMemberExpression(node) && propertyName(node) === 'auth') {
        reads.push(node.object);
      } else if (
        ['VariableDeclarator', 'AssignmentExpression', 'AssignmentPattern'].includes(node.type)
      ) {
        const pattern = (node.id ?? node.left) as AstNode | undefined;
        const value = (node.init ?? node.right) as AstNode | undefined;
        if (
          pattern?.type === 'ObjectPattern' &&
          ((pattern.properties as Array<AstNode> | undefined) ?? []).some(
            (property) => property.type === 'Property' && propertyName(property) === 'auth',
          )
        ) {
          reads.push(value);
        }
      }
      return isIdentifier(node);
    },
  });

  const namespaceValues = new Map<AstNode, boolean>();
  function isClientNamespace(node: AstNode | undefined): boolean {
    const aliases: Array<AstNode> = [];
    let found = false;
    while ((node = unwrapStaticExpression(node))) {
      if (node.type === 'AwaitExpression') {
        node = node.argument as AstNode;
        continue;
      }
      if (node.type === 'ImportExpression') {
        const source = staticLiteral(node.source as AstNode);
        found = typeof source === 'string' && CLIENT_MODULES.has(source);
        break;
      }
      if (!isIdentifier(node)) {
        break;
      }
      const binding = resolve(node, node.name);
      if (binding && namespaces.has(binding)) {
        found = true;
        break;
      }
      if (binding?.type !== 'VariableDeclarator' || !isIdentifier(binding.id as AstNode)) {
        break;
      }
      const cached = namespaceValues.get(binding);
      if (cached !== undefined) {
        found = cached;
        break;
      }
      // Mark before following the initializer to terminate cycles. Cache the
      // completed chain so repeated reads don't traverse every alias again.
      namespaceValues.set(binding, false);
      aliases.push(binding);
      node = binding.init as AstNode | undefined;
    }
    for (const alias of aliases) {
      namespaceValues.set(alias, found);
    }
    return found;
  }
  return reads.some(isClientNamespace);
}
