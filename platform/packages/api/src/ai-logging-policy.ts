export const AI_LOGGING_MODES = ['inherit', 'off', 'metadata', 'full'] as const;
export type AiLoggingMode = (typeof AI_LOGGING_MODES)[number];

export function isAiLoggingMode(value: unknown): value is AiLoggingMode {
  return AI_LOGGING_MODES.some((mode) => mode === value);
}
