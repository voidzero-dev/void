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
  /**
   * The Cloudflare Images binding is required. Source inference sets it for an
   * `env.IMAGES` read; project inference also sets it for `usesImageOptimizer`
   * while the default `/_void/image` optimizer is configured.
   */
  needsImages?: boolean;
  /**
   * `Image` or `getImageProps` from a Void adapter, an image subpath, or
   * `next/image`. Only Void apps act on it (`isImageOptimizerEnabled`), so
   * framework apps such as vinext, which own `next/image`, are unaffected.
   */
  usesImageOptimizer?: boolean;
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
  /\b(?:DB\b|KV\b|STORAGE\b|AI\b|SANDBOX\b|IMAGES\b|QUEUE_)|\\(?:u|x|[0-7A-Z_\r\n\u2028\u2029])/;

/** Adapter entries whose `Image` and `getImageProps` exports render through the optimizer. */
const IMAGE_ADAPTER_SOURCES = new Set(['@void/react', '@void/vue', '@void/svelte', '@void/solid']);
const IMAGE_EXPORT_NAMES = new Set(['Image', 'getImageProps']);
const REACT_IMAGE_EXPORTS: ReadonlySet<string> = new Set(['default', 'Image', 'getImageProps']);
/** Exports that render through the optimizer, per image subpath. */
const IMAGE_SUBPATH_EXPORTS: Record<string, ReadonlySet<string>> = {
  '@void/react/image': REACT_IMAGE_EXPORTS,
  // Void apps migrating from Next.js alias it to `@void/react/image`.
  'next/image': REACT_IMAGE_EXPORTS,
  // The other `void/image` exports are loader and config helpers.
  'void/image': new Set(['getImageProps']),
};

function imageExportNames(source: string): ReadonlySet<string> | undefined {
  return IMAGE_ADAPTER_SOURCES.has(source) ? IMAGE_EXPORT_NAMES : IMAGE_SUBPATH_EXPORTS[source];
}

/**
 * Whether the module imports or re-exports an image export by name, or reads
 * one from a namespace import. Type-only specifiers never count, and neither
 * does a bare side-effect import or a star re-export of a whole adapter.
 */
function usesImageExports(parsed: ReturnType<typeof parseSync>, code: string): boolean {
  for (const item of parsed.module.staticImports) {
    const names = imageExportNames(item.moduleRequest.value);
    if (!names) {
      continue;
    }
    for (const entry of item.entries) {
      if (entry.isType) {
        continue;
      }
      const { kind, name } = entry.importName;
      if (kind === 'Name' && name !== null && names.has(name)) {
        return true;
      }
      if (kind === 'Default' && names.has('default')) {
        return true;
      }
      if (kind === 'NamespaceObject') {
        // `ns.Image`, `<ns.Image />`, `ns.getImageProps(...)`.
        // Identifiers need only `$` escaped.
        const members = [...names].join('|');
        const local = entry.localName.value.replaceAll('$', '\\$');
        if (new RegExp(`(?<![\\w$.])${local}\\s*\\.\\s*(?:${members})(?![\\w$])`).test(code)) {
          return true;
        }
      }
    }
  }
  for (const item of parsed.module.staticExports) {
    for (const entry of item.entries) {
      const names = entry.moduleRequest ? imageExportNames(entry.moduleRequest.value) : undefined;
      if (!names || entry.isType) {
        continue;
      }
      const { kind, name } = entry.importName;
      if (kind === 'Name' && name !== null && names.has(name)) {
        return true;
      }
      // `export * from '@void/react/image'` re-exports only image APIs.
      if (
        (kind === 'All' || kind === 'AllButDefault') &&
        !IMAGE_ADAPTER_SOURCES.has(entry.moduleRequest!.value)
      ) {
        return true;
      }
    }
  }
  return false;
}

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
    needsImages: false,
    usesImageOptimizer: false,
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
  function recordModuleReference(source: string, dynamic = false): void {
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
      case 'void/image':
      case '@void/react/image':
      case 'next/image':
        // Static references are checked per specifier in `usesImageExports`;
        // a literal dynamic import may read any export.
        if (dynamic) {
          result.usesImageOptimizer = true;
        }
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
      recordModuleReference(source, true);
    }
  }

  if (hasClientModule) {
    result.needsAuth ||= inferClientAuth(parsed, code);
  }

  if (usesImageExports(parsed, code)) {
    result.usesImageOptimizer = true;
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
      case 'IMAGES':
        result.needsImages = true;
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
    needsImages: bindings.some((b) => b.needsImages),
    usesImageOptimizer: bindings.some((b) => b.usesImageOptimizer),
  };
}
