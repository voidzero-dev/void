export type AstNode = {
  type: string;
  start?: number;
  end?: number;
  [key: string]: unknown;
};

export type AstProgram = AstNode & {
  body?: Array<AstNode>;
};

export type AstIdentifier = AstNode & {
  type: 'Identifier';
  name: string;
};

export type AstLiteral = AstNode & {
  type: 'Literal';
  value: unknown;
};

export type AstMemberExpression = AstNode & {
  type: 'MemberExpression';
  computed: boolean;
  object?: AstNode;
  property?: AstNode;
};

export type AstImportSpecifier = AstNode & {
  type: 'ImportSpecifier';
  imported: AstNode;
  local: AstIdentifier;
};

export type AstImportNamespaceSpecifier = AstNode & {
  type: 'ImportNamespaceSpecifier';
  local: AstIdentifier;
};

export type AstImportDeclaration = AstNode & {
  type: 'ImportDeclaration';
  source: AstLiteral;
  specifiers?: Array<AstNode>;
};

export type AstVariableDeclarator = AstNode & {
  id?: AstNode;
  init?: AstNode;
};

export type AstVariableDeclaration = AstNode & {
  type: 'VariableDeclaration';
  kind?: string;
  declarations?: Array<AstVariableDeclarator>;
};

export type AstFunctionDeclaration = AstNode & {
  type: 'FunctionDeclaration';
  id?: AstNode;
};

export type AstExportSpecifier = AstNode & {
  exported?: AstNode;
  local?: AstNode;
  /** "type" for `export { type X }`, "value" (or undefined) otherwise. */
  exportKind?: string;
};

export type AstExportNamedDeclaration = AstNode & {
  type: 'ExportNamedDeclaration';
  declaration?: AstNode;
  specifiers?: Array<AstExportSpecifier>;
  /** "type" for `export type { X }`, "value" (or undefined) otherwise. */
  exportKind?: string;
};

export type AstExportDefaultDeclaration = AstNode & {
  type: 'ExportDefaultDeclaration';
  declaration?: AstNode;
};

export type AstCallExpression = AstNode & {
  type: 'CallExpression';
  callee?: AstNode;
  arguments?: Array<AstNode>;
};

export type AstObjectExpression = AstNode & {
  type: 'ObjectExpression';
  properties?: Array<AstNode>;
};

export type AstProperty = AstNode & {
  type: 'Property';
  key?: AstNode;
};

export function isIdentifier(node: AstNode | null | undefined): node is AstIdentifier {
  return node?.type === 'Identifier' && typeof node.name === 'string';
}

export function isLiteral(node: AstNode | null | undefined): node is AstLiteral {
  return node?.type === 'Literal';
}

/** Module export names may be identifiers or string literals, independently of the local name. */
export function moduleExportName(node: AstNode | undefined): string | undefined {
  if (isIdentifier(node)) {
    return node.name;
  }
  return isLiteral(node) && typeof node.value === 'string' ? node.value : undefined;
}

export function isMemberExpression(node: AstNode | null | undefined): node is AstMemberExpression {
  return node?.type === 'MemberExpression';
}

export function isCallExpression(node: AstNode | null | undefined): node is AstCallExpression {
  return node?.type === 'CallExpression';
}

export function isObjectExpression(node: AstNode | null | undefined): node is AstObjectExpression {
  return node?.type === 'ObjectExpression';
}
