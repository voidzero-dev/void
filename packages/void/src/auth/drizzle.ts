import type { BetterAuthOptions } from 'better-auth';
import {
  getAuthTables,
  getSchema as getBetterAuthSchema,
  type BetterAuthDBSchema,
  type DBFieldAttribute,
} from 'better-auth/db';
import type { VoidAuthConfig } from '../runtime/auth.ts';
import type { VoidAuthRuntimeOptions } from '../runtime/better-auth-shared.ts';
import {
  VOID_EMAIL_AUTH_PROVIDER,
  isVoidSocialAuthProvider,
  type VoidAuthProvider,
} from './providers.ts';

type AuthIdStrategy = 'serial' | 'text' | 'uuid';
const DEFAULT_TABLE_ORDER = Number.MAX_SAFE_INTEGER;

function compareTableOrder(
  [, left]: [string, { order?: number }],
  [, right]: [string, { order?: number }],
): number {
  return (left.order ?? DEFAULT_TABLE_ORDER) - (right.order ?? DEFAULT_TABLE_ORDER);
}

export type VoidAuthMigrationField = {
  type: DBFieldAttribute['type'];
  required: boolean;
  unique: boolean;
  index: boolean;
  bigint: boolean;
  unbounded?: boolean;
  /** A fixed default of a required field. Adding the column fills rows that exist with it. */
  defaultValue?: string | number | boolean;
  references?: {
    table: string;
    field: string;
    onDelete?: 'no action' | 'restrict' | 'cascade' | 'set null' | 'set default';
  };
};

export type VoidAuthMigrationTable = {
  name: string;
  order: number;
  fields: Record<string, VoidAuthMigrationField>;
};

export type VoidAuthMigrationSchema = {
  dialect: 'sqlite' | 'postgresql' | 'mysql';
  idStrategy: AuthIdStrategy;
  tables: Array<VoidAuthMigrationTable>;
};

type GenerateVoidAuthDatabaseModuleOptions = {
  dialect: 'sqlite' | 'postgresql' | 'mysql';
  schemaImportPath: string;
  drizzleAdapterPath: string;
};

function resolveEmailAndPassword(
  configuredProviders: Array<VoidAuthProvider> | null,
): BetterAuthOptions['emailAndPassword'] | undefined {
  if (!configuredProviders || configuredProviders.includes(VOID_EMAIL_AUTH_PROVIDER)) {
    return { enabled: true };
  }
  return undefined;
}

function resolvePlaceholderSocialProviders(
  configuredProviders: Array<VoidAuthProvider> | null,
): BetterAuthOptions['socialProviders'] | undefined {
  if (!configuredProviders) {
    return undefined;
  }

  const providers: Record<string, { clientId: string; clientSecret: string }> = {};

  for (const provider of configuredProviders) {
    if (!isVoidSocialAuthProvider(provider)) {
      continue;
    }
    providers[provider] = {
      clientId: `void-${provider}-client-id`,
      clientSecret: `void-${provider}-client-secret`,
    };
  }

  return Object.keys(providers).length > 0 ? providers : undefined;
}

function resolveSchemaUserConfig(
  userConfig: VoidAuthConfig | undefined,
  defaults: BetterAuthOptions,
  dialect: 'sqlite' | 'postgresql' | 'mysql',
  env: Record<string, unknown>,
): BetterAuthOptions {
  if (!userConfig) {
    return defaults;
  }

  if (typeof userConfig === 'function') {
    return userConfig({
      defaults,
      request: new Request('http://localhost/api/auth'),
      env,
      dialect,
    });
  }

  return { ...defaults, ...userConfig };
}

function resolveSchemaOptions(
  runtime: VoidAuthRuntimeOptions,
  env: Record<string, unknown>,
): BetterAuthOptions {
  const origin = 'http://localhost';
  const emailAndPassword = resolveEmailAndPassword(runtime.providers);
  const socialProviders = resolvePlaceholderSocialProviders(runtime.providers);
  const defaults: BetterAuthOptions = {
    baseURL: origin,
    basePath: '/api/auth',
    secret: 'void-build-better-auth-secret',
    database: {} as NonNullable<BetterAuthOptions['database']>,
    trustedOrigins: [origin],
    ...(emailAndPassword ? { emailAndPassword } : {}),
    ...(socialProviders ? { socialProviders } : {}),
  };

  return resolveSchemaUserConfig(runtime.userConfig, defaults, runtime.dialect, env);
}

function resolveIdStrategy(options: BetterAuthOptions): AuthIdStrategy {
  const generateId = options.advanced?.database?.generateId;
  if (generateId === 'serial') {
    return 'serial';
  }
  if (generateId === 'uuid') {
    return 'uuid';
  }
  return 'text';
}

function sanitizeIdentifier(name: string): string {
  const value = name.replace(/[^A-Za-z0-9_$]/g, '_');
  return /^[A-Za-z_$]/.test(value) ? value : `_${value}`;
}

function isJsonField(field: DBFieldAttribute): boolean {
  return field.type === 'json' || field.type === 'string[]' || field.type === 'number[]';
}

function renderEnumValues(values: Array<string>): string {
  return `[${values.map((value) => JSON.stringify(value)).join(', ')}] as const`;
}

function resolveFieldName(defaultFieldName: string, field: DBFieldAttribute): string {
  return field.fieldName ?? defaultFieldName;
}

const UNBOUNDED_MYSQL_AUTH_FIELDS = new Set([
  'account.accessToken',
  'account.refreshToken',
  'account.idToken',
]);

function usesUnboundedMySqlText(
  defaultModelName: string,
  defaultFieldName: string,
  field: DBFieldAttribute,
): boolean {
  return (
    field.type === 'string' &&
    !field.unique &&
    !field.index &&
    !field.references &&
    !field.sortable &&
    UNBOUNDED_MYSQL_AUTH_FIELDS.has(`${defaultModelName}.${defaultFieldName}`)
  );
}

/**
 * The default of a field when it can be written as a literal.
 * Function, date and JSON defaults have none.
 */
function resolveLiteralDefault(field: DBFieldAttribute): string | number | boolean | undefined {
  if (field.type === 'date' || isJsonField(field)) {
    return undefined;
  }
  const value = field.defaultValue;
  return typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
    ? value
    : undefined;
}

/** The default of a required field when the database can store it as a literal. */
function resolveFixedDefault(
  field: DBFieldAttribute,
): Pick<VoidAuthMigrationField, 'defaultValue'> {
  const value = field.required === false ? undefined : resolveLiteralDefault(field);
  return value === undefined ? {} : { defaultValue: value };
}

function resolveReferenceFieldName(
  schema: BetterAuthDBSchema,
  model: string,
  field: string,
): string {
  if (field === 'id') {
    return 'id';
  }
  const referencedField = schema[model]?.fields[field];
  return referencedField ? resolveFieldName(field, referencedField) : field;
}

function createColumnBuilder(
  dialect: 'sqlite' | 'postgresql' | 'mysql',
  idStrategy: AuthIdStrategy,
  defaultModelName: string,
  defaultFieldName: string,
  fieldName: string,
  field: DBFieldAttribute,
): string {
  const useIdType = fieldName === 'id' || field.references?.field === 'id';

  if (dialect === 'mysql') {
    if (useIdType) {
      return idStrategy === 'serial'
        ? `int(${JSON.stringify(fieldName)})`
        : `varchar(${JSON.stringify(fieldName)}, { length: ${idStrategy === 'uuid' ? 36 : 255} })`;
    }
    if (Array.isArray(field.type)) {
      return `varchar(${JSON.stringify(fieldName)}, { length: 255, enum: ${renderEnumValues(field.type)} })`;
    }
    if (isJsonField(field)) {
      return `json(${JSON.stringify(fieldName)})`;
    }
    switch (field.type) {
      case 'boolean':
        return `boolean(${JSON.stringify(fieldName)})`;
      case 'date':
        return `timestamp(${JSON.stringify(fieldName)}, { mode: "date", fsp: 3 })`;
      case 'number':
        return field.bigint
          ? `bigint(${JSON.stringify(fieldName)}, { mode: "number" })`
          : `int(${JSON.stringify(fieldName)})`;
      default:
        return usesUnboundedMySqlText(defaultModelName, defaultFieldName, field)
          ? `text(${JSON.stringify(fieldName)})`
          : `varchar(${JSON.stringify(fieldName)}, { length: 255 })`;
    }
  }

  if (dialect === 'postgresql') {
    if (useIdType) {
      if (idStrategy === 'serial') {
        return `integer(${JSON.stringify(fieldName)})`;
      }
      if (idStrategy === 'uuid') {
        return `uuid(${JSON.stringify(fieldName)})`;
      }
      return `text(${JSON.stringify(fieldName)})`;
    }
    if (Array.isArray(field.type)) {
      return `text(${JSON.stringify(fieldName)}, { enum: ${renderEnumValues(field.type)} })`;
    }
    if (isJsonField(field)) {
      return `jsonb(${JSON.stringify(fieldName)})`;
    }
    switch (field.type) {
      case 'boolean':
        return `boolean(${JSON.stringify(fieldName)})`;
      case 'date':
        return `timestamp(${JSON.stringify(fieldName)}, { mode: "date", withTimezone: true })`;
      case 'number':
        return field.bigint
          ? `bigint(${JSON.stringify(fieldName)}, { mode: "number" })`
          : `integer(${JSON.stringify(fieldName)})`;
      default:
        return `text(${JSON.stringify(fieldName)})`;
    }
  }

  if (useIdType) {
    if (idStrategy === 'serial') {
      return `integer(${JSON.stringify(fieldName)})`;
    }
    return `text(${JSON.stringify(fieldName)})`;
  }
  if (Array.isArray(field.type)) {
    return `text(${JSON.stringify(fieldName)}, { enum: ${renderEnumValues(field.type)} })`;
  }
  if (isJsonField(field)) {
    return `text(${JSON.stringify(fieldName)}, { mode: "json" })`;
  }
  switch (field.type) {
    case 'boolean':
      return `integer(${JSON.stringify(fieldName)}, { mode: "boolean" })`;
    case 'date':
      return `integer(${JSON.stringify(fieldName)}, { mode: "timestamp_ms" })`;
    case 'number':
      return `integer(${JSON.stringify(fieldName)})`;
    default:
      return `text(${JSON.stringify(fieldName)})`;
  }
}

function createColumnDefinition(
  dialect: 'sqlite' | 'postgresql' | 'mysql',
  schema: BetterAuthDBSchema,
  idStrategy: AuthIdStrategy,
  defaultToVariable: Map<string, string>,
  defaultModelName: string,
  defaultFieldName: string,
  field: DBFieldAttribute,
): string {
  const actualFieldName = resolveFieldName(defaultFieldName, field);
  const parts = [
    createColumnBuilder(
      dialect,
      idStrategy,
      defaultModelName,
      defaultFieldName,
      actualFieldName,
      field,
    ),
  ];

  if (actualFieldName === 'id') {
    parts.push('.primaryKey()');
    if (dialect === 'mysql' && idStrategy === 'serial') {
      parts.push('.autoincrement()');
    }
    // Better Auth leaves these ids out of inserts on PostgreSQL, so the database makes them.
    if (dialect === 'postgresql' && idStrategy === 'serial') {
      parts.push('.generatedByDefaultAsIdentity()');
    }
    if (dialect === 'postgresql' && idStrategy === 'uuid') {
      parts.push('.defaultRandom()');
    }
  }
  if (field.required !== false || actualFieldName === 'id') {
    parts.push('.notNull()');
  }
  if (field.references) {
    const referencedModel = Object.entries(schema).find(
      ([_, value]) => value.modelName === field.references?.model,
    )?.[0];
    const referenceModel = referencedModel ?? field.references.model;
    const referenceVariable = defaultToVariable.get(referenceModel);
    if (referenceVariable) {
      const referenceFieldName = resolveReferenceFieldName(
        schema,
        referenceModel,
        field.references.field,
      );
      parts.push(
        `.references(() => ${referenceVariable}[${JSON.stringify(referenceFieldName)}], { onDelete: ${JSON.stringify(
          field.references.onDelete ?? 'cascade',
        )} })`,
      );
    }
  }
  if (field.unique && actualFieldName !== 'id') {
    parts.push('.unique()');
  }
  // Better Auth applies these on its own writes. Direct Drizzle writes need them on the column,
  // and these runtime-only modifiers leave the DDL, and so existing migrations, unchanged.
  const literalDefault = resolveLiteralDefault(field);
  if (literalDefault !== undefined) {
    parts.push(`.$defaultFn(() => ${JSON.stringify(literalDefault)})`);
  }
  if (field.onUpdate && field.type === 'date') {
    parts.push('.$onUpdate(() => new Date())');
  }

  return parts.join('');
}

function collectCoreImports(
  dialect: 'sqlite' | 'postgresql' | 'mysql',
  schema: BetterAuthDBSchema,
  idStrategy: AuthIdStrategy,
): Array<string> {
  const imports = new Set<string>([
    dialect === 'postgresql' ? 'pgTable' : dialect === 'mysql' ? 'mysqlTable' : 'sqliteTable',
    dialect === 'mysql' ? 'varchar' : 'text',
  ]);

  if (idStrategy === 'serial') {
    imports.add(dialect === 'mysql' ? 'int' : 'integer');
  }
  if (idStrategy === 'uuid' && dialect === 'postgresql') {
    imports.add('uuid');
  }

  for (const [defaultModelName, table] of Object.entries(schema)) {
    for (const [defaultFieldName, field] of Object.entries(table.fields)) {
      const actualFieldName = resolveFieldName(defaultFieldName, field);
      if (actualFieldName === 'id' || field.references?.field === 'id') {
        if (idStrategy === 'uuid' && dialect === 'postgresql') {
          imports.add('uuid');
        }
        continue;
      }

      if (field.index) {
        imports.add('index');
      }

      if (Array.isArray(field.type) || field.type === 'string') {
        imports.add(
          dialect === 'mysql' && !usesUnboundedMySqlText(defaultModelName, defaultFieldName, field)
            ? 'varchar'
            : 'text',
        );
        continue;
      }
      if (isJsonField(field)) {
        imports.add(dialect === 'postgresql' ? 'jsonb' : dialect === 'mysql' ? 'json' : 'text');
        continue;
      }
      if (field.type === 'boolean') {
        imports.add(dialect === 'sqlite' ? 'integer' : 'boolean');
        continue;
      }
      if (field.type === 'date') {
        imports.add(dialect === 'sqlite' ? 'integer' : 'timestamp');
        continue;
      }
      if (field.type === 'number') {
        imports.add(dialect === 'mysql' ? 'int' : 'integer');
        if (field.bigint && dialect !== 'sqlite') {
          imports.add('bigint');
        }
      }
    }
  }

  return [...imports].sort();
}

export function generateVoidAuthDrizzleSchema(
  runtime: VoidAuthRuntimeOptions,
  env: Record<string, unknown> = {},
): string {
  const options = resolveSchemaOptions(runtime, env);
  const schema = getAuthTables(options);
  const migrationSchema = resolveVoidAuthMigrationSchema(runtime, env);
  const idStrategy = resolveIdStrategy(options);
  const defaultToVariable = new Map<string, string>();
  const entries = Object.entries(schema).sort(compareTableOrder);

  for (const [defaultModelName] of entries) {
    defaultToVariable.set(defaultModelName, `${sanitizeIdentifier(defaultModelName)}Table`);
  }

  const tableFactory =
    runtime.dialect === 'postgresql'
      ? 'pgTable'
      : runtime.dialect === 'mysql'
        ? 'mysqlTable'
        : 'sqliteTable';
  const importPath =
    runtime.dialect === 'postgresql'
      ? 'void/schema-pg'
      : runtime.dialect === 'mysql'
        ? 'void/schema-mysql'
        : 'void/schema-d1';
  const imports = collectCoreImports(runtime.dialect, schema, idStrategy);
  const lines = [
    '// Auto-generated by void — do not edit',
    `import { ${imports.join(', ')} } from ${JSON.stringify(importPath)};`,
    '',
  ];

  for (const [defaultModelName, table] of entries) {
    const variableName = defaultToVariable.get(defaultModelName)!;
    const fieldEntries = Object.entries(table.fields);
    const renderedFields = [
      `  "id": ${createColumnDefinition(
        runtime.dialect,
        schema,
        idStrategy,
        defaultToVariable,
        defaultModelName,
        'id',
        { type: idStrategy === 'serial' ? 'number' : 'string', required: true },
      )},`,
      ...fieldEntries.map(([defaultFieldName, field]) => {
        const actualFieldName = resolveFieldName(defaultFieldName, field);
        return `  ${JSON.stringify(actualFieldName)}: ${createColumnDefinition(
          runtime.dialect,
          schema,
          idStrategy,
          defaultToVariable,
          defaultModelName,
          defaultFieldName,
          field,
        )},`;
      }),
    ];
    const indexedFields = fieldEntries.filter(([, field]) => field.index && !field.unique);

    lines.push(
      `export const ${variableName} = ${tableFactory}(${JSON.stringify(table.modelName)}, {`,
      ...renderedFields,
      ...(indexedFields.length > 0
        ? [
            `}, (table) => [`,
            ...indexedFields.map(([defaultFieldName, field]) => {
              const actualFieldName = resolveFieldName(defaultFieldName, field);
              return `  index(${JSON.stringify(`${table.modelName}_${actualFieldName}_idx`)}).on(table[${JSON.stringify(actualFieldName)}]),`;
            }),
            `]);`,
          ]
        : [`});`]),
      '',
    );
  }

  lines.push('export const schema = {');
  for (const [defaultModelName] of entries) {
    lines.push(
      `  ${JSON.stringify(defaultModelName)}: ${defaultToVariable.get(defaultModelName)},`,
    );
  }
  lines.push('} as const;');
  lines.push(
    `export const migrationSchema = ${JSON.stringify(migrationSchema, null, 2)} as const;`,
  );
  lines.push('');

  return lines.join('\n') + '\n';
}

export function resolveVoidAuthMigrationSchema(
  runtime: VoidAuthRuntimeOptions,
  env: Record<string, unknown> = {},
): VoidAuthMigrationSchema {
  const options = resolveSchemaOptions(runtime, env);
  const logicalSchema = getAuthTables(options);
  const schema = getBetterAuthSchema(options);
  const unboundedMySqlFields = new Set<string>();

  if (runtime.dialect === 'mysql') {
    for (const [defaultModelName, table] of Object.entries(logicalSchema)) {
      for (const [defaultFieldName, field] of Object.entries(table.fields)) {
        if (usesUnboundedMySqlText(defaultModelName, defaultFieldName, field)) {
          unboundedMySqlFields.add(
            `${table.modelName}\0${resolveFieldName(defaultFieldName, field)}`,
          );
        }
      }
    }
  }

  return {
    dialect: runtime.dialect,
    idStrategy: resolveIdStrategy(options),
    tables: Object.entries(schema)
      .sort(compareTableOrder)
      .map(([name, table]) => ({
        name,
        order: table.order ?? DEFAULT_TABLE_ORDER,
        fields: Object.fromEntries(
          Object.entries(table.fields).map(([fieldName, field]) => [
            fieldName,
            {
              type: field.type,
              required: field.required !== false,
              unique: field.unique === true,
              index: field.index === true,
              bigint: field.bigint === true,
              ...(unboundedMySqlFields.has(`${name}\0${fieldName}`) ? { unbounded: true } : {}),
              ...resolveFixedDefault(field),
              ...(field.references
                ? {
                    references: {
                      table: field.references.model,
                      field: field.references.field,
                      ...(field.references.onDelete ? { onDelete: field.references.onDelete } : {}),
                    },
                  }
                : {}),
            } satisfies VoidAuthMigrationField,
          ]),
        ),
      })),
  };
}

export function generateVoidAuthDatabaseModule(
  options: GenerateVoidAuthDatabaseModuleOptions,
): string {
  const schemaImport = JSON.stringify(options.schemaImportPath);
  const provider =
    options.dialect === 'postgresql' ? 'pg' : options.dialect === 'mysql' ? 'mysql' : 'sqlite';

  return [
    '// Auto-generated by void — do not edit',
    `import { drizzleAdapter } from ${JSON.stringify(options.drizzleAdapterPath)};`,
    `import { db as __voidDb } from "void/db";`,
    `import { schema as __voidAuthSchema } from ${schemaImport};`,
    '',
    '// Better Auth reads Drizzle metadata while creating the adapter.',
    '// Defer that work until request handling, when runtime bindings are available.',
    'let __voidAuthDatabaseInstance: ReturnType<typeof drizzleAdapter> | undefined;',
    '',
    'export const __voidAuthDatabase: ReturnType<typeof drizzleAdapter> = (options) => {',
    `  __voidAuthDatabaseInstance ??= drizzleAdapter(__voidDb, { provider: ${JSON.stringify(
      provider,
    )}, schema: __voidAuthSchema });`,
    '  return __voidAuthDatabaseInstance(options);',
    '};',
    '',
  ].join('\n');
}
