export type FormResetOptions = { initial?: boolean };

export function isFormResetOptions(value: unknown): value is FormResetOptions {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Snapshot editable records and arrays without cloning opaque values such as
// File/Blob, or passing framework proxies to structuredClone.
export function cloneFormValue<T>(value: T): T {
  return clone(value, new WeakMap()) as T;
}

function clone(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return value;
  }
  if (seen.has(value)) {
    return seen.get(value);
  }

  const result: object = Array.isArray(value) ? new Array(value.length) : Object.create(prototype);
  seen.set(value, result);
  for (const key of Object.keys(value)) {
    Object.defineProperty(result, key, {
      value: clone((value as Record<string, unknown>)[key], seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

export function parseFormResetArgs(args: ReadonlyArray<string | FormResetOptions>): {
  initial: boolean;
  fields: ReadonlyArray<string>;
} {
  if (args.length > 0 && isFormResetOptions(args[0])) {
    return {
      initial: args[0].initial === true,
      fields: args.slice(1) as ReadonlyArray<string>,
    };
  }
  return { initial: false, fields: args as ReadonlyArray<string> };
}
