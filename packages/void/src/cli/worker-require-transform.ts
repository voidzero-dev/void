import MagicString from 'magic-string';
import { parseSync } from 'vite';
import { asAstProgram, isIdentifier, isLiteral } from '../shared/ast.ts';
import type { AstNode } from '../shared/ast.ts';

type Edit = { start: number; end: number; replacement: string };

function nodes(root: AstNode): Array<AstNode> {
  const found: Array<AstNode> = [];
  const pending: Array<AstNode> = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    found.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === 'object' && typeof child.type === 'string') {
            pending.push(child as AstNode);
          }
        }
      } else if (
        value &&
        typeof value === 'object' &&
        typeof (value as AstNode).type === 'string'
      ) {
        pending.push(value as AstNode);
      }
    }
  }
  return found;
}

/**
 * Replace the `createRequire(import.meta.url)` binding that the bundler emits for CommonJS
 * database drivers with `requireShim`, which serves Node built-ins from static imports.
 * workerd gives modules no `import.meta.url`, so the original binding fails at startup.
 * PostgreSQL bundles also replace `pgpass`, which reads the filesystem.
 */
export function transformWorkerRequireBundle(
  code: string,
  filename: string,
  requireShim: string,
  database: 'PostgreSQL' | 'MySQL',
): string {
  if (!code.includes('createRequire') && !code.includes('pgpass')) {
    return code;
  }
  const program = asAstProgram(parseSync(filename, code).program);
  const edits: Array<Edit> = [];
  let hasRequireBinding = false;
  let pgpassCalls = 0;
  for (const statement of program.body ?? []) {
    if (
      statement.type === 'ImportDeclaration' &&
      (statement.source as { value?: unknown } | undefined)?.value === 'node:module'
    ) {
      const specifiers = statement.specifiers as Array<AstNode> | undefined;
      if (
        specifiers?.length !== 1 ||
        !isIdentifier(specifiers[0]?.imported as AstNode | undefined) ||
        (specifiers[0]!.imported as { name: string }).name !== 'createRequire'
      ) {
        throw new Error(
          `deploy: Unsupported node:module import in ${database} bundle ${filename}.`,
        );
      }
      edits.push({ start: statement.start!, end: statement.end!, replacement: '' });
    }
    if (statement.type === 'VariableDeclaration') {
      const declarations = statement.declarations as Array<AstNode> | undefined;
      if (
        declarations?.some(
          (declaration) =>
            isIdentifier(declaration.id as AstNode | undefined) &&
            (declaration.id as { name: string }).name === '__require',
        )
      ) {
        if (declarations.length !== 1 || hasRequireBinding) {
          throw new Error(`deploy: Unsupported require binding in ${database} bundle ${filename}.`);
        }
        hasRequireBinding = true;
        edits.push({ start: statement.start!, end: statement.end!, replacement: requireShim });
      }
    }
  }
  for (const node of nodes(program)) {
    if (
      node.type !== 'CallExpression' ||
      !isIdentifier(node.callee as AstNode | undefined) ||
      (node.callee as { name: string }).name !== '__require'
    ) {
      continue;
    }
    const args = node.arguments as Array<AstNode> | undefined;
    if (args?.length !== 1 || !isLiteral(args[0]) || args[0].value !== 'pgpass') {
      continue;
    }
    pgpassCalls++;
    edits.push({ start: node.start!, end: node.end!, replacement: '__voidPgpassNoop' });
  }
  if (code.includes('createRequire') && !hasRequireBinding) {
    throw new Error(
      `deploy: Could not locate the generated require binding in ${database} bundle ${filename}.`,
    );
  }
  if (code.includes('pgpass') && pgpassCalls === 0 && code.includes('__require')) {
    throw new Error(
      `deploy: Could not locate the pgpass require in ${database} bundle ${filename}.`,
    );
  }
  const ms = new MagicString(code);
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    ms.overwrite(edit.start, edit.end, edit.replacement);
  }
  const transformed = ms.toString();
  if (transformed.includes('createRequire') || transformed.includes('__require("pgpass")')) {
    throw new Error(
      `deploy: ${database} bundle ${filename} still contains an unsupported require.`,
    );
  }
  return pgpassCalls > 0
    ? `const __voidPgpassNoop = Object.assign(function pgpass(_connectionInfo, callback) { callback(undefined); }, { warnTo() {} });\n${transformed}`
    : transformed;
}
