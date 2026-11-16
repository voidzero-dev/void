import { parseSync } from 'vite';
import { bindingNames } from './ast-bindings.ts';
import {
  isIdentifier,
  moduleExportName,
  type AstExportAllDeclaration,
  type AstExportNamedDeclaration,
  type AstNode,
  type AstProgram,
  type AstVariableDeclaration,
} from './ast.ts';

/** How a module exports some names, as far as its source shows without running it. */
export type StaticExports = {
  /** Initializers of `export const name = value` declarations. */
  initializers: Map<string, AstNode>;
  /**
   * Names exported in a form whose value only running the module reveals: export
   * lists and re-exports, `let` and `var`, destructuring, functions, classes and enums.
   */
  unreadable: Set<string>;
  /** `export * from` may export any of the names. */
  exportsAll: boolean;
};

const LINE_TERMINATORS = new Set(['\n', '\r', '\u2028', '\u2029']);

/**
 * Whether `export` is followed by `*` once whitespace and comments are skipped,
 * so a comment between the two still counts. True only means the source needs
 * parsing: the text may sit in a string or comment. This is a scan because a
 * regular expression that skips repeated comments can backtrack exponentially.
 */
export function mayExportAll(source: string): boolean {
  for (
    let index = source.indexOf('export');
    index !== -1;
    index = source.indexOf('export', index + 1)
  ) {
    let cursor = index + 'export'.length;
    while (cursor < source.length) {
      if (/\s/.test(source[cursor]!)) {
        cursor += 1;
      } else if (source.startsWith('/*', cursor)) {
        const end = source.indexOf('*/', cursor + 2);
        cursor = end === -1 ? source.length : end + 2;
      } else if (source.startsWith('//', cursor)) {
        cursor += 2;
        while (cursor < source.length && !LINE_TERMINATORS.has(source[cursor]!)) {
          cursor += 1;
        }
      } else {
        break;
      }
    }
    if (source[cursor] === '*') {
      return true;
    }
  }
  return false;
}

const VALUE_DECLARATIONS = new Set([
  'FunctionDeclaration',
  'ClassDeclaration',
  'TSEnumDeclaration',
]);

/** Read how a parsed module exports `names` without evaluating user code. Type-only exports are skipped. */
export function staticExports(program: AstProgram, names: ReadonlySet<string>): StaticExports {
  const result: StaticExports = {
    initializers: new Map(),
    unreadable: new Set(),
    exportsAll: false,
  };
  const markUnreadable = (name: string | undefined): void => {
    if (name !== undefined && names.has(name)) {
      result.unreadable.add(name);
    }
  };
  for (const statement of program.body ?? []) {
    if (statement.type === 'ExportAllDeclaration') {
      const exported = statement as AstExportAllDeclaration;
      if (exported.exportKind === 'type') {
        continue;
      }
      if (exported.exported) {
        markUnreadable(moduleExportName(exported.exported));
      } else {
        result.exportsAll = true;
      }
      continue;
    }
    if (statement.type !== 'ExportNamedDeclaration') {
      continue;
    }
    const exported = statement as AstExportNamedDeclaration;
    if (exported.exportKind === 'type') {
      continue;
    }
    for (const specifier of exported.specifiers ?? []) {
      if (specifier.exportKind !== 'type') {
        markUnreadable(moduleExportName(specifier.exported));
      }
    }
    const declaration = exported.declaration;
    if (declaration?.type === 'VariableDeclaration') {
      const variables = declaration as AstVariableDeclaration;
      for (const variable of variables.declarations ?? []) {
        if (variables.kind === 'const' && isIdentifier(variable.id) && variable.init) {
          if (names.has(variable.id.name)) {
            result.initializers.set(variable.id.name, variable.init);
          }
          continue;
        }
        for (const name of bindingNames(variable.id)) {
          markUnreadable(name);
        }
      }
    } else if (declaration && VALUE_DECLARATIONS.has(declaration.type)) {
      const id = declaration.id as AstNode | undefined;
      markUnreadable(isIdentifier(id) ? id.name : undefined);
    }
  }
  return result;
}

/** Parse a module and read how it exports `names` without evaluating user code. */
export function readStaticExports(
  filename: string,
  source: string,
  names: ReadonlySet<string>,
): StaticExports {
  return staticExports(parseSync(filename, source).program as unknown as AstProgram, names);
}

export function unwrapStaticExpression(node: AstNode | undefined): AstNode | undefined {
  while (
    node &&
    [
      'ParenthesizedExpression',
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSTypeAssertion',
    ].includes(node.type)
  ) {
    node = node.expression as AstNode | undefined;
  }
  return node;
}

export function staticLiteral(node: AstNode | undefined): unknown {
  node = unwrapStaticExpression(node);
  if (node?.type === 'Literal') {
    return node.value;
  }
  if (node?.type === 'TemplateLiteral') {
    const expressions = node.expressions as Array<AstNode> | undefined;
    const quasis = node.quasis as Array<{ value?: { cooked?: string } }> | undefined;
    if (expressions?.length === 0 && quasis?.length === 1) {
      return quasis[0]?.value?.cooked;
    }
  }
  return undefined;
}
