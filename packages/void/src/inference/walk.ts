import { walk } from 'estree-walker';
import { parseSync } from 'vite';
import { isIdentifier, isMemberExpression, type AstNode } from '../shared/ast.ts';
import { staticModuleReferences } from '../shared/module-references.ts';
import { staticLiteral, unwrapStaticExpression } from '../shared/static-exports.ts';
import { CLIENT_MODULES, inferClientAuth } from './client-auth.ts';

export type InferredBindings = {
  needsD1: boolean;
  needsKV: boolean;
  needsR2: boolean;
  needsAuth: boolean;
  needsQueues: boolean;
  needsAI: boolean;
  needsSandbox: boolean;
  needsLive?: boolean;
  needsEmail?: boolean;
};

// SEND_EMAIL is intentionally absent from inferred bindings: Void owns that binding
// (managed sends go through __VOID_PROXY/email/send; native Cloudflare deploys
// add SEND_EMAIL themselves), so the `void/email` import (below) is the
// sole driver of `needsEmail`.
// Comments, bracket access and destructuring can separate env from a binding name.
// Unicode/hex/octal escapes and string line continuations can also spell these names.
// Resource keys additionally allow identity escapes such as "D\\B". Ordinary
// regex escapes like \\s should not force otherwise unrelated files through the AST.
const ENV_BINDING_RE = /\benv\b|\\(?:u|x|[0-7\r\n\u2028\u2029])/;
const RESOURCE_BINDING_RE =
  /\b(?:DB\b|KV\b|STORAGE\b|AI\b|SANDBOX\b|QUEUE_)|\\(?:u|x|[0-7A-Z_\r\n\u2028\u2029])/;

/**
 * Infer which Cloudflare bindings a source file uses.
 *
 * Read Vite's module metadata, then walk the AST only for potential env bindings.
 */
export function inferBindingsFromSource(code: string, filename: string): InferredBindings {
  const result: InferredBindings = {
    needsD1: false,
    needsKV: false,
    needsR2: false,
    needsAuth: false,
    needsQueues: false,
    needsAI: false,
    needsSandbox: false,
    needsLive: false,
    needsEmail: false,
  };

  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(filename, code);
    if (parsed.errors.length > 0) {
      return result;
    }
  } catch {
    return result;
  }

  let hasClientModule = false;
  function recordModuleReference(source: string): void {
    if (CLIENT_MODULES.has(source)) {
      hasClientModule = true;
    }
    switch (source) {
      case 'void/db':
        result.needsD1 = true;
        break;
      case 'void/kv':
        result.needsKV = true;
        break;
      case 'void/storage':
        result.needsR2 = true;
        break;
      case 'void/auth':
        result.needsAuth = true;
        break;
      case 'void/queues':
        result.needsQueues = true;
        break;
      case 'void/ai':
        result.needsAI = true;
        break;
      case 'void/sandbox':
        result.needsSandbox = true;
        break;
      case 'void/email':
        result.needsEmail = true;
        break;
      case 'void/live':
        result.needsLive = true;
        break;
    }
  }

  for (const reference of staticModuleReferences(parsed, code)) {
    recordModuleReference(reference.source);
  }

  for (const reference of parsed.module.dynamicImports) {
    // Parse just the argument so literal decoding does not materialize the whole file's AST.
    const argument = code.slice(reference.moduleRequest.start, reference.moduleRequest.end);
    const expression = parseSync(filename, `(${argument})`).program.body[0];
    const source =
      expression?.type === 'ExpressionStatement'
        ? staticLiteral(expression.expression as AstNode)
        : undefined;
    if (typeof source === 'string') {
      recordModuleReference(source);
    }
  }

  if (hasClientModule) {
    result.needsAuth ||= inferClientAuth(parsed, code);
  }

  if (!ENV_BINDING_RE.test(code) || !RESOURCE_BINDING_RE.test(code)) {
    return result;
  }

  function propertyName(node: AstNode): string | undefined {
    const key = (node.property ?? node.key) as AstNode | undefined;
    const name = !node.computed && isIdentifier(key) ? key.name : staticLiteral(key);
    return typeof name === 'string' ? name : undefined;
  }

  function isEnv(node: AstNode | undefined): boolean {
    node = unwrapStaticExpression(node);
    return (
      (isIdentifier(node) && node.name === 'env') ||
      (isMemberExpression(node) && propertyName(node) === 'env')
    );
  }

  function recordBinding(name: string | undefined): void {
    switch (name) {
      case 'DB':
        result.needsD1 = true;
        break;
      case 'KV':
        result.needsKV = true;
        break;
      case 'STORAGE':
        result.needsR2 = true;
        break;
      case 'AI':
        result.needsAI = true;
        break;
      case 'SANDBOX':
        result.needsSandbox = true;
        break;
      default:
        if (name?.startsWith('QUEUE_')) {
          result.needsQueues = true;
        }
    }
  }

  function inspectPattern(pattern: AstNode | undefined, fromEnv = false): void {
    if (pattern?.type === 'AssignmentPattern') {
      inspectPattern(pattern.left as AstNode, fromEnv || isEnv(pattern.right as AstNode));
    } else if (pattern?.type === 'ObjectPattern') {
      for (const property of (pattern.properties as Array<AstNode> | undefined) ?? []) {
        if (property.type !== 'Property') {
          continue;
        }
        const name = propertyName(property);
        if (fromEnv) {
          recordBinding(name);
        }
        inspectPattern(property.value as AstNode, name === 'env');
      }
    } else if (pattern?.type === 'ArrayPattern') {
      for (const element of (pattern.elements as Array<AstNode | undefined> | undefined) ?? []) {
        inspectPattern(element);
      }
    }
  }

  walk(parsed.program as unknown as Parameters<typeof walk>[0], {
    enter(node) {
      const current = node as AstNode;
      if (isMemberExpression(current) && isEnv(current.object)) {
        recordBinding(propertyName(current));
      } else if (current.type === 'VariableDeclarator' || current.type === 'AssignmentExpression') {
        inspectPattern(
          (current.id ?? current.left) as AstNode,
          isEnv((current.init ?? current.right) as AstNode),
        );
      } else if (
        ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(
          current.type,
        )
      ) {
        for (const parameter of (current.params as Array<AstNode> | undefined) ?? []) {
          inspectPattern(parameter);
        }
      }
    },
  });

  return result;
}

/**
 * Merge multiple InferredBindings into a single result (union).
 */
export function mergeBindings(bindings: Array<InferredBindings>): InferredBindings {
  return {
    needsD1: bindings.some((b) => b.needsD1),
    needsKV: bindings.some((b) => b.needsKV),
    needsR2: bindings.some((b) => b.needsR2),
    needsAuth: bindings.some((b) => b.needsAuth),
    needsQueues: bindings.some((b) => b.needsQueues),
    needsAI: bindings.some((b) => b.needsAI),
    needsSandbox: bindings.some((b) => b.needsSandbox),
    needsLive: bindings.some((b) => b.needsLive),
    needsEmail: bindings.some((b) => b.needsEmail),
  };
}
