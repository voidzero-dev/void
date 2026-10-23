export type FormResetOptions = { initial?: boolean };

export function isFormResetOptions(value: unknown): value is FormResetOptions {
  return typeof value === 'object' && value !== null && 'initial' in value;
}

export function parseFormResetArgs(
  args: ReadonlyArray<string | FormResetOptions>,
): { initial: boolean; fields: ReadonlyArray<string> } {
  if (args.length > 0 && isFormResetOptions(args[0])) {
    return {
      initial: args[0].initial === true,
      fields: args.slice(1) as ReadonlyArray<string>,
    };
  }
  return { initial: false, fields: args as ReadonlyArray<string> };
}
