import { existsSync, readFileSync } from 'node:fs';
import { walk } from 'estree-walker';
import { join } from 'pathslash';
import { parseSync } from 'vite';
import {
  isCallExpression,
  isIdentifier,
  isMemberExpression,
  isObjectExpression,
  type AstNode,
} from '../shared/ast.ts';
import { staticLiteral, unwrapStaticExpression } from '../shared/static-exports.ts';

/** The module that exports vinext's Cloudflare Images optimizer factory. */
export const VINEXT_IMAGES_OPTIMIZER_MODULE = '@vinext/cloudflare/images/images-optimizer';

/** vinext's default `imagesOptimizer({ binding })`. */
const VINEXT_DEFAULT_IMAGES_BINDING = 'IMAGES';

/** Vite's `DEFAULT_CONFIG_FILES`, in the order Vite tries them. */
const VITE_CONFIG_FILES = [
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts',
  'vite.config.cjs',
  'vite.config.mts',
  'vite.config.cts',
];

/** Top-level `const NAME = '<literal>'` declarations of the config module. */
function topLevelStringConstants(program: AstNode): Map<string, string> {
  const constants = new Map<string, string>();
  for (const statement of (program.body ?? []) as Array<AstNode>) {
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') {
      continue;
    }
    for (const declaration of (statement.declarations ?? []) as Array<AstNode>) {
      const id = declaration.id as AstNode | undefined;
      const value = staticLiteral(declaration.init as AstNode | undefined);
      if (isIdentifier(id) && typeof value === 'string') {
        constants.set(id.name, value);
      }
    }
  }
  return constants;
}

/**
 * The `binding` of an `imagesOptimizer({ binding })` options object: a string
 * literal, or a same-file top-level `const` holding one.
 */
function literalBinding(
  options: AstNode | undefined,
  constants: Map<string, string>,
): string | undefined {
  const object = unwrapStaticExpression(options);
  if (!isObjectExpression(object)) {
    return undefined;
  }
  for (const property of object.properties ?? []) {
    if (property.type !== 'Property' || property.computed === true) {
      continue;
    }
    const key = property.key as AstNode | undefined;
    const name = isIdentifier(key) ? key.name : staticLiteral(key);
    if (name !== 'binding') {
      continue;
    }
    const valueNode = unwrapStaticExpression(property.value as AstNode | undefined);
    const value = isIdentifier(valueNode)
      ? constants.get(valueNode.name)
      : staticLiteral(valueNode);
    return typeof value === 'string' && value !== '' ? value : undefined;
  }
  return undefined;
}

/**
 * Find vinext's Cloudflare Images optimizer in a Vite config's source:
 * a call to `imagesOptimizer` imported from `@vinext/cloudflare/images/images-optimizer`
 * (aliases and namespace imports included). Returns the Images binding it reads,
 * from a `binding` option that is a string literal or a same-file `const`, or
 * vinext's default `IMAGES`.
 */
export function detectVinextImagesOptimizerInSource(
  code: string,
  filename: string,
): { binding: string } | undefined {
  if (!code.includes(VINEXT_IMAGES_OPTIMIZER_MODULE)) {
    return undefined;
  }
  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(filename, code);
    if (parsed.errors.length > 0) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const factories = new Set<string>();
  const namespaces = new Set<string>();
  for (const item of parsed.module.staticImports) {
    if (item.moduleRequest.value !== VINEXT_IMAGES_OPTIMIZER_MODULE) {
      continue;
    }
    for (const entry of item.entries) {
      if (entry.isType) {
        continue;
      }
      if (entry.importName.kind === 'Name' && entry.importName.name === 'imagesOptimizer') {
        factories.add(entry.localName.value);
      } else if (entry.importName.kind === 'NamespaceObject') {
        namespaces.add(entry.localName.value);
      }
    }
  }
  if (factories.size === 0 && namespaces.size === 0) {
    return undefined;
  }

  const constants = topLevelStringConstants(parsed.program as unknown as AstNode);
  let found: { binding: string } | undefined;
  walk(parsed.program as unknown as Parameters<typeof walk>[0], {
    enter(node) {
      const current = node as AstNode;
      if (found || !isCallExpression(current)) {
        return;
      }
      const callee = current.callee;
      const isFactory =
        (isIdentifier(callee) && factories.has(callee.name)) ||
        (isMemberExpression(callee) &&
          !callee.computed &&
          isIdentifier(callee.object) &&
          namespaces.has(callee.object.name) &&
          isIdentifier(callee.property) &&
          callee.property.name === 'imagesOptimizer');
      if (isFactory) {
        found = {
          binding:
            literalBinding(current.arguments?.[0], constants) ?? VINEXT_DEFAULT_IMAGES_BINDING,
        };
        this.skip();
      }
    },
  });
  return found;
}

/**
 * Detect vinext's Cloudflare Images optimizer in the project's Vite config.
 * vinext keeps its options private, so the config source is read statically.
 * A non-literal `binding` falls back to `IMAGES`; set `inference.bindings.images`
 * to the name in that case.
 */
export function detectVinextImagesOptimizer(root: string): { binding: string } | undefined {
  for (const file of VITE_CONFIG_FILES) {
    const path = join(root, file);
    if (!existsSync(path)) {
      continue;
    }
    let code: string;
    try {
      code = readFileSync(path, 'utf-8');
    } catch {
      return undefined;
    }
    return detectVinextImagesOptimizerInSource(code, file);
  }
  return undefined;
}
