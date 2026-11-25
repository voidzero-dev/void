// Engine B: Void's own tool loop for `@cf/*` models. Chat-completions messages
// through the model proxy at `http://model.void.internal`, the four scan tools,
// at most `maxTurns` model calls per session, one repair turn (spec §8.1).

import { jsonFromText, validateFindingsLenient, validateFindingsTextLenient } from '../coerce.ts';
import { classifyProxyStop, PROXY_STOP_HEADER, readProxyStopReason } from '../status.ts';
import type { OutcomeBody } from '../status.ts';
import { scanToolDefinitions } from '../tools/definitions.ts';
import type { FsTools, ToolResult } from '../tools/fs.ts';
import { describeValidationError } from '../validate-findings.ts';
import { emptyStats } from './types.ts';
import type { Engine, SessionOutcome, SessionSpec, SessionTool } from './types.ts';

export const VOID_LOOP_VERSION = 'void-loop/1';
export const MODEL_BASE_URL = 'http://model.void.internal';
export const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';

export type VoidLoopOptions = {
  model: string;
  tools: FsTools;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Wait before the one retry of a failed call. */
  retryDelayMs?: number;
};

type ToolCall = { id: string; type?: string; function: { name: string; arguments: string } };
type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<ToolCall> }
  | { role: 'tool'; tool_call_id: string; content: string };

const NO_SUBMIT_NUDGE =
  'You answered without calling a tool. Call submit_findings now with your report, as the system prompt says.';
const LAST_TURN_NOTE =
  'This is your last turn. Call submit_findings now with what you have found so far; set run_status to incomplete if you did not finish.';

export function createVoidLoopEngine(options: VoidLoopOptions): Engine {
  const baseUrl = options.baseUrl ?? MODEL_BASE_URL;
  const doFetch = options.fetch ?? fetch;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  const toolSpecs = scanToolDefinitions().map((tool) => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));

  async function runTool(
    name: string,
    args: Record<string, unknown>,
    extra: ReadonlyArray<SessionTool>,
  ): Promise<ToolResult> {
    const tool = extra.find((candidate) => candidate.name === name);
    if (tool) {
      return tool.run(args);
    }
    switch (name) {
      case 'read_file':
        return options.tools.readFile(args);
      case 'list_files':
        return options.tools.listFiles(args);
      case 'grep':
        return options.tools.grep(args);
      default:
        return { ok: false, text: `error: unknown tool ${JSON.stringify(name.slice(0, 64))}` };
    }
  }

  type CallResult =
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; outcome: OutcomeBody };

  async function callModel(
    messages: Array<ChatMessage>,
    extra: ReadonlyArray<SessionTool>,
    signal?: AbortSignal,
  ): Promise<CallResult> {
    const request = JSON.stringify({
      model: options.model,
      messages,
      tools:
        extra.length === 0
          ? toolSpecs
          : [
              ...toolSpecs,
              ...extra.map((tool) => ({
                type: 'function' as const,
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
            ],
      tool_choice: 'auto',
    });
    // Any failure that is not a proxy stop is retried once (README "Model proxy stops").
    let failure: OutcomeBody | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await delay(retryDelayMs, signal);
      }
      if (signal?.aborted) {
        return { ok: false, outcome: { kind: 'aborted' } };
      }
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}${CHAT_COMPLETIONS_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: request,
          signal,
        });
      } catch {
        failure = {
          kind: 'infrastructure',
          errorClass: 'model_network',
          detail: 'model call failed twice',
        };
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const stop = classifyProxyStop(
          response.status,
          readProxyStopReason(response.headers.get(PROXY_STOP_HEADER)),
        );
        if (stop) {
          return { ok: false, outcome: stop };
        }
        failure = {
          kind: 'infrastructure',
          errorClass: `model_http_${response.status}`,
          detail: `model call answered ${response.status}`,
        };
        continue;
      }
      const body = await response.json().catch(() => null);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        failure = {
          kind: 'infrastructure',
          errorClass: 'model_bad_response',
          detail: 'model answer is not a JSON object',
        };
        continue;
      }
      return { ok: true, body: body as Record<string, unknown> };
    }
    // A stop that lands while a call or its body is in flight is a timeout, not a failure.
    if (signal?.aborted) {
      return { ok: false, outcome: { kind: 'aborted' } };
    }
    if (failure === null) {
      throw new Error('The model call loop ended with no outcome.');
    }
    return { ok: false, outcome: failure };
  }

  return {
    id: 'void_loop',
    version: VOID_LOOP_VERSION,
    sessionTools: true,
    async runSession(spec: SessionSpec): Promise<SessionOutcome> {
      const stats = emptyStats();
      const extra = spec.tools ?? [];
      const done = (outcome: OutcomeBody): SessionOutcome => ({ ...outcome, stats });
      const messages: Array<ChatMessage> = [
        { role: 'system', content: spec.system },
        { role: 'user', content: spec.prompt },
      ];
      // One nudge for an answer with no tool call, one repair for a report that failed the
      // check: a model that wandered once still gets its retry for the report itself.
      let nudgeUsed = false;
      let repairUsed = false;
      while (stats.turns < spec.maxTurns) {
        if (spec.signal?.aborted) {
          return done({ kind: 'aborted' });
        }
        // A session that runs out of turns loses its work, so warn on the last one.
        if (stats.turns > 0 && stats.turns === spec.maxTurns - 1) {
          addUserNote(messages, LAST_TURN_NOTE);
        }
        const call = await callModel(messages, extra, spec.signal);
        if (!call.ok) {
          return done(call.outcome);
        }
        stats.turns++;
        stats.modelCalls++;
        addUsage(stats, call.body.usage);
        const choice = firstChoice(call.body);
        if (choice === null) {
          return done({
            kind: 'infrastructure',
            errorClass: 'model_bad_response',
            detail: 'model answer has no choices',
          });
        }
        if (choice.finishReason === 'content_filter') {
          return done({ kind: 'refused', category: 'content_filter' });
        }
        messages.push({
          role: 'assistant',
          content: choice.content,
          ...(choice.toolCalls.length > 0 ? { tool_calls: choice.toolCalls } : {}),
        });
        if (choice.toolCalls.length === 0) {
          // The report sometimes arrives as JSON text instead of a tool call; take it if it holds.
          const inText = choice.content === null ? null : jsonFromText(choice.content);
          const textResult = inText === null ? null : validateFindingsLenient(inText);
          if (textResult?.ok && (spec.check?.(textResult.report) ?? null) === null) {
            return done({ kind: 'submitted', report: textResult.report, repaired: true });
          }
          if (nudgeUsed) {
            return done({
              kind: 'bad_output',
              errorKind: 'no_submit',
              message: 'session ended without submit_findings',
            });
          }
          nudgeUsed = true;
          messages.push({
            role: 'user',
            content:
              textResult?.ok === false
                ? `${NO_SUBMIT_NUDGE} Your last output was invalid: ${describeValidationError(textResult)}.`
                : NO_SUBMIT_NUDGE,
          });
          continue;
        }
        let repairOfferedThisTurn = false;
        for (const toolCall of choice.toolCalls) {
          const name = toolCall.function.name;
          if (name === 'submit_findings') {
            if (repairOfferedThisTurn) {
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: 'error: call submit_findings once per answer.',
              });
              continue;
            }
            const result = validateFindingsTextLenient(toolCall.function.arguments);
            let problem: SubmitProblem;
            if (!result.ok) {
              problem = { kind: result.kind, message: describeValidationError(result) };
            } else {
              const extra = spec.check?.(result.report) ?? null;
              if (extra === null) {
                return done({
                  kind: 'submitted',
                  report: result.report,
                  repaired: repairUsed || nudgeUsed,
                });
              }
              problem = { kind: 'shape', message: extra };
            }
            if (repairUsed) {
              return done({
                kind: 'bad_output',
                errorKind: problem.kind,
                message: problem.message,
              });
            }
            repairUsed = true;
            repairOfferedThisTurn = true;
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `error: your last output was invalid: ${problem.message}. Fix it and call submit_findings again. This is your only retry.`,
            });
            continue;
          }
          const args = parseArguments(toolCall.function.arguments);
          const result =
            args === null
              ? { ok: false, text: 'error: tool arguments must be a JSON object' }
              : await runTool(name, args, extra);
          // Only a read_file that returned code counts (FsTools sets `code`).
          if (
            'code' in result &&
            result.code === true &&
            name === 'read_file' &&
            !extra.some((tool) => tool.name === name)
          ) {
            stats.reads++;
          }
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result.text });
        }
      }
      return done({ kind: 'stopped', reason: 'turns' });
    },
  };
}

/** Why a `submit_findings` call was not taken, for the repair turn. */
type SubmitProblem = { kind: string; message: string };

type Choice = { content: string | null; toolCalls: Array<ToolCall>; finishReason: string | null };

function firstChoice(body: Record<string, unknown>): Choice | null {
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const choice = choices[0] as Record<string, unknown> | null;
  const message = (choice?.message ?? null) as Record<string, unknown> | null;
  if (message === null || typeof message !== 'object') {
    return null;
  }
  const toolCalls: Array<ToolCall> = [];
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((raw: unknown, index: number) => {
      const call = raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      if (typeof call?.function?.name !== 'string') {
        return;
      }
      toolCalls.push({
        id: typeof call.id === 'string' && call.id.length > 0 ? call.id : `call_${index}`,
        type: 'function',
        // Some models return arguments as an object; the API expects them back as a string.
        function: {
          name: call.function.name,
          arguments:
            typeof call.function.arguments === 'string'
              ? call.function.arguments
              : JSON.stringify(call.function.arguments ?? {}),
        },
      });
    });
  }
  return {
    content: typeof message.content === 'string' ? message.content : null,
    toolCalls,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
  };
}

/** Adds a user note, joined to a user message that is already last. */
function addUserNote(messages: Array<ChatMessage>, note: string): void {
  const last = messages.at(-1);
  if (last?.role === 'user') {
    last.content = `${last.content}\n\n${note}`;
    return;
  }
  messages.push({ role: 'user', content: note });
}

function parseArguments(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof value === 'string') {
    if (value.trim() === '') {
      return {};
    }
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function addUsage(stats: SessionOutcome['stats'], usage: unknown): void {
  if (typeof usage !== 'object' || usage === null) {
    return;
  }
  const { prompt_tokens: input, completion_tokens: output } = usage as Record<string, unknown>;
  if (typeof input === 'number' && Number.isFinite(input) && input > 0) {
    stats.inputTokens += Math.floor(input);
  }
  if (typeof output === 'number' && Number.isFinite(output) && output > 0) {
    stats.outputTokens += Math.floor(output);
  }
}

/** Waits `ms`, or less when the signal stops first. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
