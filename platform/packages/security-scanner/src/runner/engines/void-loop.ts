// Engine B: Void's own tool loop for `@cf/*` models. Chat-completions messages
// through the model proxy at `http://model.void.internal`, the four scan tools,
// at most `maxTurns` model calls per session, one repair turn (spec §8.1).

import { jsonFromText, validateFindingsLenient, validateFindingsTextLenient } from '../coerce.ts';
import { classifyProxyStop, PROXY_STOP_HEADER, readProxyStopReason } from '../status.ts';
import type { OutcomeBody } from '../status.ts';
import { scanToolDefinitions } from '../tools/definitions.ts';
import { readToolsByName } from '../tools/fs.ts';
import type { FsTools, ToolResult } from '../tools/fs.ts';
import { count, delay } from '../util.ts';
import { describeValidationError } from '../validate-findings.ts';
import { emptyStats } from './types.ts';
import type { Engine, SessionOutcome, SessionSpec } from './types.ts';

export const VOID_LOOP_VERSION = 'void-loop/1';
export const MODEL_BASE_URL = 'http://model.void.internal';

export type VoidLoopOptions = {
  model: string;
  tools: FsTools;
  baseUrl: string;
  fetch?: typeof fetch;
  /** Wait before the one retry of a failed call. */
  retryDelayMs?: number;
};

type ToolCall = { id: string; type?: string; function: { name: string; arguments: string } };
type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<ToolCall> }
  | { role: 'tool'; tool_call_id: string; content: string };
type Json = Record<string, unknown>;
type CallResult = { ok: true; body: Json } | { ok: false; outcome: OutcomeBody; retry?: boolean };

const NO_SUBMIT_NUDGE =
  'You answered without calling a tool. Call submit_findings now with your report, as the system prompt says.';
const LAST_TURN_NOTE =
  'This is your last turn. Call submit_findings now with what you have found so far; set run_status to incomplete if you did not finish.';
const ABORTED: CallResult = { ok: false, outcome: { kind: 'aborted' } };

const asFunction = (tool: { name: string; description: string; parameters: Json }) => ({
  type: 'function' as const,
  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
});

const infrastructure = (errorClass: string, detail: string): CallResult => ({
  ok: false,
  outcome: { kind: 'infrastructure', errorClass, detail },
  retry: true,
});

export function createVoidLoopEngine(options: VoidLoopOptions): Engine {
  const doFetch = options.fetch ?? fetch;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  const toolSpecs = scanToolDefinitions().map(asFunction);
  const readTools = readToolsByName(options.tools);

  /** One model call. A failure that is not a proxy stop may be retried. */
  async function callOnce(request: string, signal?: AbortSignal): Promise<CallResult> {
    let response: Response;
    try {
      response = await doFetch(`${options.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: request,
        signal,
      });
    } catch {
      return infrastructure('model_network', 'model call failed twice');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const stop = classifyProxyStop(
        response.status,
        readProxyStopReason(response.headers.get(PROXY_STOP_HEADER)),
      );
      return stop
        ? { ok: false, outcome: stop }
        : infrastructure(`model_http_${response.status}`, `model call answered ${response.status}`);
    }
    const body: unknown = await response.json().catch(() => null);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return infrastructure('model_bad_response', 'model answer is not a JSON object');
    }
    return { ok: true, body: body as Json };
  }

  /** Any failure that is not a proxy stop is retried once (README "Model proxy stops"). */
  async function callModel(messages: Array<ChatMessage>, spec: SessionSpec): Promise<CallResult> {
    const request = JSON.stringify({
      model: options.model,
      messages,
      tools: [...toolSpecs, ...(spec.tools ?? []).map(asFunction)],
      tool_choice: 'auto',
    });
    for (let attempt = 1; ; attempt++) {
      if (spec.signal?.aborted) {
        return ABORTED;
      }
      const result = await callOnce(request, spec.signal);
      if (result.ok || result.retry !== true) {
        return result;
      }
      if (attempt === 2) {
        // A stop that lands while a call or its body is in flight is a timeout, not a failure.
        return spec.signal?.aborted ? ABORTED : result;
      }
      await delay(retryDelayMs, spec.signal);
    }
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
        const call = await callModel(messages, spec);
        if (!call.ok) {
          return done(call.outcome);
        }
        stats.turns++;
        stats.modelCalls++;
        const usage = (call.body.usage ?? {}) as Json;
        stats.inputTokens += count(usage.prompt_tokens);
        stats.outputTokens += count(usage.completion_tokens);
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
          const reply = (content: string) =>
            messages.push({ role: 'tool', tool_call_id: toolCall.id, content });
          if (name === 'submit_findings') {
            if (repairOfferedThisTurn) {
              reply('error: call submit_findings once per answer.');
              continue;
            }
            const result = validateFindingsTextLenient(toolCall.function.arguments);
            const problem = result.ok
              ? (spec.check?.(result.report) ?? null)
              : describeValidationError(result);
            if (result.ok && problem === null) {
              return done({
                kind: 'submitted',
                report: result.report,
                repaired: repairUsed || nudgeUsed,
              });
            }
            if (repairUsed) {
              return done({
                kind: 'bad_output',
                errorKind: result.ok ? 'shape' : result.kind,
                message: problem ?? '',
              });
            }
            repairUsed = true;
            repairOfferedThisTurn = true;
            reply(
              `error: your last output was invalid: ${problem}. Fix it and call submit_findings again. This is your only retry.`,
            );
            continue;
          }
          const args = parseArguments(toolCall.function.arguments);
          const sessionTool = extra.find((tool) => tool.name === name);
          const readTool = readTools.get(name);
          let result: ToolResult;
          if (args === null) {
            result = { ok: false, text: 'error: tool arguments must be a JSON object' };
          } else if (sessionTool) {
            result = await sessionTool.run(args);
          } else if (readTool) {
            result = await readTool(args);
            // Only a read_file that returned code counts (FsTools sets `code`).
            if (result.code === true && name === 'read_file') {
              stats.reads++;
            }
          } else {
            result = {
              ok: false,
              text: `error: unknown tool ${JSON.stringify(name.slice(0, 64))}`,
            };
          }
          reply(result.text);
        }
      }
      return done({ kind: 'stopped', reason: 'turns' });
    },
  };
}

type Choice = { content: string | null; toolCalls: Array<ToolCall>; finishReason: string | null };

function firstChoice(body: Json): Choice | null {
  const choice = (Array.isArray(body.choices) ? body.choices[0] : null) as Json | null | undefined;
  const message = choice?.message;
  if (typeof message !== 'object' || message === null) {
    return null;
  }
  const { content, tool_calls: rawCalls } = message as Json;
  const toolCalls: Array<ToolCall> = [];
  for (const [index, raw] of (Array.isArray(rawCalls) ? rawCalls : []).entries()) {
    const call = raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    if (typeof call?.function?.name !== 'string') {
      continue;
    }
    const args = call.function.arguments;
    toolCalls.push({
      id: typeof call.id === 'string' && call.id.length > 0 ? call.id : `call_${index}`,
      type: 'function',
      // Some models return arguments as an object; the API expects them back as a string.
      function: {
        name: call.function.name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
      },
    });
  }
  return {
    content: typeof content === 'string' ? content : null,
    toolCalls,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
  };
}

/** Adds a user note, joined to a user message that is already last. */
function addUserNote(messages: Array<ChatMessage>, note: string): void {
  const last = messages.at(-1);
  if (last?.role === 'user') {
    last.content = `${last.content}\n\n${note}`;
  } else {
    messages.push({ role: 'user', content: note });
  }
}

function parseArguments(value: string): Json | null {
  if (value.trim() === '') {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Json)
      : null;
  } catch {
    return null;
  }
}
