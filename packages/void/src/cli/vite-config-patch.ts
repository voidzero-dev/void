import MagicString from 'magic-string';
import { parseSync } from 'vite';

type Node = {
  type: string;
  start: number;
  end: number;
  name?: string;
  value?: unknown;
  body?: Array<Node>;
  declaration?: Node;
  callee?: Node;
  arguments?: Array<Node>;
  properties?: Array<Node>;
  elements?: Array<Node>;
  key?: Node;
  computed?: boolean;
  kind?: string;
  source?: Node;
  specifiers?: Array<Node>;
  imported?: Node;
  local?: Node;
  expression?: Node;
};

function unwrap(node: Node | undefined): Node | undefined {
  while (
    node &&
    [
      'TSAsExpression',
      'TSSatisfiesExpression',
      'ParenthesizedExpression',
      'TSTypeAssertion',
    ].includes(node.type)
  ) {
    node = node.expression;
  }
  return node;
}

function configObject(program: Node): Node | undefined {
  const declaration = program.body?.find(
    (node) => node.type === 'ExportDefaultDeclaration',
  )?.declaration;
  const exported = unwrap(declaration);
  if (exported?.type === 'ObjectExpression') {
    return exported;
  }
  if (exported?.type === 'CallExpression' && exported.callee?.name === 'defineConfig') {
    const firstArgument = unwrap(exported.arguments?.[0]);
    if (firstArgument?.type === 'ObjectExpression') {
      return firstArgument;
    }
  }
  return undefined;
}

function propertyName(property: Node): string | undefined {
  if (property.type !== 'Property' || property.computed || property.kind !== 'init') {
    return undefined;
  }
  return (
    property.key?.name ?? (typeof property.key?.value === 'string' ? property.key.value : undefined)
  );
}

function nodeValue(node: Node | undefined): Node | undefined {
  const value = node?.value;
  return value !== null && typeof value === 'object' && 'type' in value
    ? (value as Node)
    : undefined;
}

function lineIndent(code: string, index: number): string {
  const lineStart = code.lastIndexOf('\n', index) + 1;
  return code.slice(lineStart, index).match(/^\s*/)?.[0] ?? '';
}

/** Add the plugin only when the exported Vite configuration has an editable object and array. */
export function patchViteConfigWithVoidPlugin(filePath: string, code: string): string | undefined {
  if (filePath.endsWith('.cjs') || filePath.endsWith('.cts')) {
    return undefined;
  }

  let program: Node;
  try {
    program = parseSync(filePath, code).program as unknown as Node;
  } catch {
    return undefined;
  }

  const object = configObject(program);
  if (!object) {
    return undefined;
  }

  const pluginProperties =
    object.properties?.filter((property) => propertyName(property) === 'plugins') ?? [];
  if (pluginProperties.length > 1 || nodeValue(pluginProperties[0])?.type !== 'ArrayExpression') {
    if (pluginProperties.length > 0) {
      return undefined;
    }
  }

  const imports = program.body?.filter((node) => node.type === 'ImportDeclaration') ?? [];
  const importedName = imports
    .filter((node) => node.source?.value === 'void')
    .flatMap((node) => node.specifiers ?? [])
    .find((node) => node.type === 'ImportSpecifier' && node.imported?.name === 'voidPlugin')
    ?.local?.name;
  const pluginName = importedName ?? 'voidPlugin';
  const plugins = nodeValue(pluginProperties[0]);
  if (
    plugins?.elements?.some(
      (element) => element?.type === 'CallExpression' && element.callee?.name === pluginName,
    )
  ) {
    return code;
  }

  const ms = new MagicString(code);
  if (plugins) {
    const insertAt = plugins.start + 1;
    const content = code.slice(insertAt, plugins.end - 1);
    if (content.trim() === '') {
      if (insertAt === plugins.end - 1) {
        ms.appendLeft(insertAt, `${pluginName}()`);
      } else {
        ms.overwrite(insertAt, plugins.end - 1, `${pluginName}()`);
      }
    } else {
      const indent = lineIndent(code, pluginProperties[0]!.start);
      const next = code[insertAt];
      ms.appendLeft(
        insertAt,
        next === '\n' || next === '\r' ? `\n${indent}  ${pluginName}(),` : `${pluginName}(), `,
      );
    }
  } else {
    if (object.properties?.some((property) => property.type === 'SpreadElement')) {
      return undefined;
    }
    const content = code.slice(object.start + 1, object.end - 1);
    if (content.trim() === '') {
      const replacement = ` plugins: [${pluginName}()] `;
      if (object.start + 1 === object.end - 1) {
        ms.appendLeft(object.start + 1, replacement);
      } else {
        ms.overwrite(object.start + 1, object.end - 1, replacement);
      }
    } else {
      const indent = lineIndent(code, object.start);
      const next = code[object.start + 1];
      ms.appendLeft(
        object.start + 1,
        next === '\n' || next === '\r'
          ? `\n${indent}  plugins: [${pluginName}()],`
          : ` plugins: [${pluginName}()],`,
      );
    }
  }

  if (!importedName) {
    const insertAt =
      imports.length > 0 ? imports.at(-1)!.end : code.startsWith('#!') ? code.indexOf('\n') + 1 : 0;
    const prefix = insertAt > 0 && code[insertAt - 1] !== '\n' ? '\n' : '';
    ms.appendLeft(insertAt, `${prefix}import { voidPlugin } from "void";\n`);
  }
  return ms.toString();
}
