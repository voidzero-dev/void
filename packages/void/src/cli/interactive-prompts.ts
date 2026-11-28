import {
  confirm as clackConfirm,
  multiselect as clackMultiselect,
  password as clackPassword,
  select as clackSelect,
  text as clackText,
} from '@voidzero-dev/vite-plus-prompts';
import type {
  CommonOptions,
  ConfirmOptions,
  MultiSelectOptions,
  PasswordOptions,
  SelectOptions,
  TextOptions,
} from '@voidzero-dev/vite-plus-prompts';

export { cancel, isCancel, log, outro } from '@voidzero-dev/vite-plus-prompts';

export class PromptInputClosedError extends Error {
  constructor() {
    super('Standard input closed before the prompt was answered.');
  }
}

// Clack does not settle a pending prompt when readline reaches EOF.
async function withPromptInput<Options extends CommonOptions, Result>(
  prompt: (options: Options) => Promise<Result>,
  options: Options,
): Promise<Result> {
  const input = options.input ?? process.stdin;
  if (input.readableEnded || input.destroyed) {
    throw new PromptInputClosedError();
  }

  const closed = new AbortController();
  const onClose = () => closed.abort();
  const signal = options.signal ? AbortSignal.any([options.signal, closed.signal]) : closed.signal;
  input.once('end', onClose);
  input.once('close', onClose);
  try {
    const result = await prompt({ ...options, signal });
    if (closed.signal.aborted) {
      throw new PromptInputClosedError();
    }
    return result;
  } finally {
    input.off('end', onClose);
    input.off('close', onClose);
  }
}

export function confirm(options: ConfirmOptions): ReturnType<typeof clackConfirm> {
  return withPromptInput(clackConfirm, options);
}

export function multiselect<Value>(
  options: MultiSelectOptions<Value>,
): ReturnType<typeof clackMultiselect<Value>> {
  return withPromptInput(clackMultiselect<Value>, options);
}

export function password(options: PasswordOptions): ReturnType<typeof clackPassword> {
  return withPromptInput(clackPassword, options);
}

export function select<Value>(
  options: SelectOptions<Value>,
): ReturnType<typeof clackSelect<Value>> {
  return withPromptInput(clackSelect<Value>, options);
}

export function text(options: TextOptions): ReturnType<typeof clackText> {
  return withPromptInput(clackText, options);
}
