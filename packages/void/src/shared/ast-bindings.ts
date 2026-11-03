import { walk } from 'estree-walker';
import { isIdentifier, type AstNode, type AstProgram } from './ast.ts';

/** Names introduced by a binding pattern, excluding keys and default expressions. */
export function bindingNames(node: AstNode | null | undefined): Array<string> {
  if (isIdentifier(node)) {
    return [node.name];
  }
  if (node?.type === 'ObjectPattern') {
    return ((node.properties as Array<AstNode> | undefined) ?? []).flatMap((property) =>
      bindingNames(
        (property.type === 'RestElement' ? property.argument : property.value) as AstNode,
      ),
    );
  }
  if (node?.type === 'ArrayPattern') {
    return ((node.elements as Array<AstNode | null> | undefined) ?? []).flatMap(bindingNames);
  }
  if (node?.type === 'AssignmentPattern' || node?.type === 'RestElement') {
    return bindingNames((node.left ?? node.argument) as AstNode | undefined);
  }
  if (node?.type === 'TSParameterProperty') {
    return bindingNames(node.parameter as AstNode | undefined);
  }
  return [];
}

type Scope = {
  parent?: Scope;
  bindings?: Map<string, AstNode>;
  varScope: boolean;
};

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/**
 * Resolve lexical bindings after collecting declarations, including hoisted and later bindings.
 * A visitor can collect references in the same pass; return true to retain a node's scope.
 * Names can limit binding collection when only specific imports need resolution.
 */
export function bindingResolver(
  program: AstProgram,
  options?: { visit?: (node: AstNode) => boolean; names?: ReadonlySet<string> },
): (node: AstNode, name: string) => AstNode | undefined {
  const scopes = new WeakMap<AstNode, Scope>();
  const outerScopes = new WeakMap<AstNode, Scope>();
  let scope: Scope = { varScope: true };
  const declare = (pattern: AstNode | undefined, declaration: AstNode, target = scope) => {
    for (const name of bindingNames(pattern)) {
      if (!options?.names || options.names.has(name)) {
        (target.bindings ??= new Map()).set(name, declaration);
      }
    }
  };
  walk(program as unknown as Parameters<typeof walk>[0], {
    enter(raw, rawParent, key) {
      const node = raw as AstNode;
      const parent = rawParent as AstNode | null;
      const outerScope = scope;
      // The discriminant and all its descendants precede the case block's scope.
      if (parent?.type === 'SwitchStatement' && key === 'discriminant') {
        scope = scope.parent!;
      }
      if (
        [
          'FunctionDeclaration',
          'ClassDeclaration',
          'TSEnumDeclaration',
          'TSModuleDeclaration',
        ].includes(node.type)
      ) {
        declare(node.id as AstNode | undefined, node);
      }
      const isFunction = FUNCTIONS.has(node.type);
      if (
        isFunction ||
        node.type === 'BlockStatement' ||
        node.type === 'StaticBlock' ||
        node.type === 'CatchClause' ||
        node.type === 'ForStatement' ||
        node.type === 'ForInStatement' ||
        node.type === 'ForOfStatement' ||
        node.type === 'SwitchStatement' ||
        node.type === 'ClassDeclaration' ||
        node.type === 'ClassExpression' ||
        node.type === 'TSModuleDeclaration'
      ) {
        scope = {
          parent: scope,
          varScope:
            isFunction ||
            node.type === 'StaticBlock' ||
            node.type === 'TSModuleDeclaration' ||
            (node.type === 'BlockStatement' && !!parent && FUNCTIONS.has(parent.type)),
        };
      }
      if (scope !== outerScope) {
        outerScopes.set(node, outerScope);
      }
      if (!options?.visit || options.visit(node)) {
        scopes.set(node, scope);
      }
      if (isFunction) {
        if (node.type === 'FunctionExpression') {
          declare(node.id as AstNode | undefined, node);
        }
        for (const parameter of (node.params as Array<AstNode> | undefined) ?? []) {
          declare(parameter, parameter);
        }
      } else if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
        declare(node.id as AstNode | undefined, node);
      } else if (node.type === 'CatchClause') {
        declare(node.param as AstNode | undefined, node);
      } else if (node.type === 'ImportDeclaration' && node.importKind !== 'type') {
        for (const specifier of (node.specifiers as Array<AstNode> | undefined) ?? []) {
          if (specifier.importKind !== 'type') {
            declare(specifier.local as AstNode | undefined, specifier);
          }
        }
      } else if (node.type === 'VariableDeclaration') {
        let target = scope;
        if (node.kind === 'var') {
          while (!target.varScope && target.parent) {
            target = target.parent;
          }
        }
        for (const declaration of (node.declarations as Array<AstNode> | undefined) ?? []) {
          declare(declaration.id as AstNode | undefined, declaration, target);
        }
      }
    },
    leave(raw) {
      const outer = outerScopes.get(raw as AstNode);
      if (outer) {
        scope = outer;
      }
    },
  });
  return (node, name) => {
    let current = scopes.get(node);
    while (current) {
      const binding = current.bindings?.get(name);
      if (binding) {
        return binding;
      }
      current = current.parent;
    }
    return undefined;
  };
}
