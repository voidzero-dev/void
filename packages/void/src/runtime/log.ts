/**
 * Structured logger that emits each entry as a single stringified-JSON line
 * to `console.error/warn/info`. The shape `{ msg, ...fields }` is a stable
 * contract: Cloudflare Tail captures each call as one `logs[]` entry with
 * the right `level`, and platform-side log filtering can match on `msg` or
 * any custom field.
 *
 * @example
 * ```ts
 * import { logger } from "void/log";
 *
 * logger.error("websocket failed", { jobId, attempt: 3 });
 * logger.info("user signed in", { userId });
 * ```
 */

type Fields = Record<string, unknown>;

type Logger = {
  error(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  child(fields: Fields): Logger;
};

// `name`, `message`, `stack` and `cause` are non-enumerable on `Error`, so plain
// `JSON.stringify` turns an error into `{}`. Copy them next to the error's own
// enumerable fields. An error seen again (for example a `cause` cycle) keeps only
// its name and message so serialization always terminates.
function errorReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<Error>();
  return (_key, value) => {
    if (!(value instanceof Error)) {
      return value;
    }
    if (seen.has(value)) {
      return { name: value.name, message: value.message };
    }
    seen.add(value);
    return {
      ...value,
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: value.cause,
    };
  };
}

function format(message: string, boundFields: ReadonlyArray<Fields> = [], fields?: Fields): string {
  try {
    const payload: Record<string, unknown> = Object.create(null);
    payload.msg = message;

    for (const source of [...boundFields, fields]) {
      if (!source) {
        continue;
      }

      for (const [key, value] of Object.entries(source)) {
        if (key === 'msg' || key === 'toJSON' || key === '__proto__' || key === 'constructor') {
          continue;
        }

        if (typeof value === 'function') {
          continue;
        }

        payload[key] = value;
      }
    }

    return JSON.stringify(payload, errorReplacer());
  } catch {
    return JSON.stringify({
      msg: message,
      error: 'log: fields not serializable',
    });
  }
}

function createLogger(boundFields: ReadonlyArray<Fields> = []): Logger {
  return {
    error(message, fields) {
      console.error(format(message, boundFields, fields));
    },

    warn(message, fields) {
      console.warn(format(message, boundFields, fields));
    },

    info(message, fields) {
      console.info(format(message, boundFields, fields));
    },

    child(fields) {
      return createLogger([...boundFields, fields]);
    },
  };
}

export const logger: Logger = createLogger();
