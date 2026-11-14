import type { AstNode } from './compiler.ts';

export interface Reference {
  node: AstNode;
  name: string;
  member?: string;
  shorthand?: boolean;
}
function names(node: AstNode | null | undefined): Array<string> {
  if (!node) {
    return [];
  }
  if (node.type === 'Identifier') {
    return [node.name];
  }
  if (node.type === 'RestElement') {
    return names(node.argument);
  }
  if (node.type === 'AssignmentPattern') {
    return names(node.left);
  }
  if (node.type === 'ArrayPattern') {
    return node.elements.flatMap(names);
  }
  if (node.type === 'ObjectPattern') {
    return node.properties.flatMap((property: AstNode) =>
      names(property.type === 'RestElement' ? property.argument : property.value),
    );
  }
  return [];
}
function nodes(node: AstNode): Array<AstNode> {
  return Object.values(node)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value) => value && typeof value === 'object' && typeof value.type === 'string');
}
/** Free references, retaining ranges for rewriting imported bindings without touching shadowed locals. */
export function references(node: AstNode): Array<Reference> {
  const result: Array<Reference> = [];
  const root = node;
  function pattern(node: AstNode | null, scope: Set<string>) {
    if (!node) {
      return;
    }
    if (node.type === 'AssignmentPattern') {
      pattern(node.left, scope);
      visit(node.right, scope);
    } else if (node.type === 'ObjectPattern') {
      for (const property of node.properties) {
        if (property.computed) {
          visit(property.key, scope);
        }
        pattern(property.type === 'RestElement' ? property.argument : property.value, scope);
      }
    } else if (node.type === 'ArrayPattern') {
      for (const item of node.elements) {
        pattern(item, scope);
      }
    } else if (node.type === 'RestElement') {
      pattern(node.argument, scope);
    }
  }
  function visit(node: AstNode | null | undefined, scope: Set<string>, shorthand = false) {
    if (!node) {
      return;
    }
    if (node.type === 'Identifier') {
      if (!scope.has(node.name)) {
        result.push({ node, name: node.name, shorthand });
      }
      return;
    }
    if (
      ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)
    ) {
      const inner = new Set([
        ...scope,
        ...(node === root && node.type === 'FunctionDeclaration' ? [] : names(node.id)),
        ...node.params.flatMap(names),
      ]);
      // var is function-scoped even when declared inside a nested block.
      function vars(current: AstNode) {
        if (
          current !== node &&
          ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(
            current.type,
          )
        ) {
          return;
        }
        if (current.type === 'VariableDeclaration' && current.kind === 'var') {
          for (const item of current.declarations) {
            for (const name of names(item.id)) {
              inner.add(name);
            }
          }
        }
        for (const child of nodes(current)) {
          vars(child);
        }
      }
      vars(node);
      for (const param of node.params) {
        pattern(param, inner);
      }
      visit(node.body, inner);
      return;
    }
    if (node.type === 'BlockStatement' || node.type === 'Program') {
      const inner = new Set(scope);
      for (const statement of node.body) {
        if (statement.type === 'VariableDeclaration') {
          for (const item of statement.declarations) {
            for (const name of names(item.id)) {
              inner.add(name);
            }
          }
        }
        if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') {
          for (const name of names(statement.id)) {
            inner.add(name);
          }
        }
      }
      for (const statement of node.body) {
        visit(statement, inner);
      }
      return;
    }
    if (node.type === 'VariableDeclaration') {
      for (const item of node.declarations) {
        pattern(item.id, scope);
        visit(item.init, scope);
      }
      return;
    }
    if (
      node.type === 'MemberExpression' &&
      !node.computed &&
      node.object.type === 'Identifier' &&
      !scope.has(node.object.name)
    ) {
      result.push({ node, name: node.object.name, member: node.property.name });
      return;
    }
    if (node.type === 'MemberExpression') {
      visit(node.object, scope);
      if (node.computed) {
        visit(node.property, scope);
      }
      return;
    }
    if (
      node.type === 'Property' ||
      node.type === 'MethodDefinition' ||
      node.type === 'PropertyDefinition'
    ) {
      if (node.computed) {
        visit(node.key, scope);
      }
      visit(node.value, scope, node.shorthand);
      return;
    }
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      visit(node.superClass, scope);
      visit(
        node.body,
        new Set([
          ...scope,
          ...(node === root && node.type === 'ClassDeclaration' ? [] : names(node.id)),
        ]),
      );
      return;
    }
    if (node.type === 'CatchClause') {
      visit(node.body, new Set([...scope, ...names(node.param)]));
      return;
    }
    if (['ForStatement', 'ForInStatement', 'ForOfStatement'].includes(node.type)) {
      const binding = node.init ?? node.left;
      const inner = new Set(scope);
      if (binding?.type === 'VariableDeclaration') {
        for (const item of binding.declarations) {
          for (const name of names(item.id)) {
            inner.add(name);
          }
        }
      }
      for (const child of nodes(node)) {
        visit(child, inner);
      }
      return;
    }
    if (['BreakStatement', 'ContinueStatement', 'MetaProperty'].includes(node.type)) {
      return;
    }
    if (node.type === 'LabeledStatement') {
      visit(node.body, scope);
      return;
    }
    for (const child of nodes(node)) {
      visit(child, scope);
    }
  }
  visit(node, new Set());
  return result;
}
