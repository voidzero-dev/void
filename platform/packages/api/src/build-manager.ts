import { Container } from '@cloudflare/containers';
import { Terminal } from '@xterm/headless';
import voidPackageJson from '../../../../packages/void/package.json' with { type: 'json' };
import {
  DEPLOY_TOKEN_HARD_MAX_MINUTES,
  deployTokenTtlSecondsForBuildMinutes,
  signDeployToken,
} from './auth/deploy-token.ts';
import { constantTimeEqual } from './auth/hmac.ts';
import { TERMINAL_STATUSES, isTerminalBuildStatus } from './build-status.ts';
import { type BuildConfig, type BuildLogLine, isContainerCapacityError } from './build-types.ts';
import { SITE_DOMAIN } from './constants.ts';
import {
  createDb,
  getBuild,
  getDeploymentByProjectAndCommit,
  installationCoversRepo,
  markBuildBuildingIfStarting,
  markBuildProgressIfActive,
  markBuildTerminalIfActive,
  requeueBuildIfStarting,
  setBuildCheckRunId,
  type Db,
} from './db.ts';
import type { ApiEnv } from './env.ts';
import {
  type CheckRunConclusion,
  VOID_BUILD_CHECK_RUN_NAME,
  completeCheckRun,
  createCheckRun,
} from './github/check-run.ts';
import {
  generateSourceTarballUrl,
  getBranchHeadComparisonStatus,
  getInstallationToken,
} from './github/installation-token.ts';
import type { Build } from './types.ts';

/** DO storage keys for the build config captured at `startBuild()`. */
const STORAGE_KEY_CONFIG = 'buildConfig';
/** DO storage key for the per-build agent secret minted at `startBuild()`. */
const STORAGE_KEY_AGENT_TOKEN = 'agentToken';
/** DO storage key for the GitHub Check Run id created at `startBuild()`. */
const STORAGE_KEY_CHECK_RUN = 'checkRunId';
/** DO storage key proving whether the container can still produce log lines. */
const STORAGE_KEY_LOG_DRAIN = 'logDrainState';

// Hard cap on rows retained in the DO SQLite `logs` table. A verbose/chatty build
// (huge installer/compiler output) would otherwise grow the table without bound
// for the build's lifetime — risking DO storage pressure and an O(rows) WebSocket
// replay on connect. `ingestLines` evicts the oldest rows past this cap, keeping
// the most-recent window (a tail is what a live log view wants). Mirrors the
// container agent's in-memory ring bound (build-agent.mjs MAX_BUFFERED_LOG_LINES).
export const MAX_STORED_LOG_LINES = 10000;

// Bounds for the log tail embedded in the completed check-run's `output.text`.
// Both caps are UTF-8 BYTE caps, because that is what GitHub validates (its
// 422 reads "maximum bytesize of 65535") — a UTF-16 `.length` cap would let
// CJK (~3 bytes per code unit) or emoji (4 bytes per 2 units) content pass our
// limit while far exceeding GitHub's. The 60000 content cap normally leaves
// fence/header/marker headroom under GitHub's 65535 cap, but the fence is
// sized past the content's backtick runs (see below), so the hard cap is
// enforced on the whole rendered string too.
export const CHECK_RUN_LOG_TAIL_LINES = 100;
export const CHECK_RUN_LOG_TAIL_MAX_BYTES = 60000;

// GitHub's hard cap on a check run's output.text: 65535 UTF-8 BYTES (GitHub
// validates bytesize, not character count). A longer string makes GitHub
// reject the entire PATCH — stranding the run with no text at all — so the
// WHOLE rendered string (header + marker + fence delimiters + content) must
// honor it, not just the content: the fence delimiters grow past the longest
// backtick run in the content, so a pathological all-backtick line can blow
// far past the fixed small overhead the 60000 content cap budgeted for.
export const CHECK_RUN_OUTPUT_TEXT_MAX_BYTES = 65535;

// Cadence of the DO→container log pull-loop. The agent buffers stdout/stderr and
// serves `GET /logs?since=N`; the DO polls on this interval, ingesting any new
// lines into the SQLite `logs` table + WS fan-out. ~1–2s keeps a live log view
// near-real-time without hammering the container. The loop is armed in `onStart`
// (first tick at 1s) and re-armed by `pollLogs` until the build is terminal.
const POLL_SECONDS = 1;

// Hard ceiling on a single `GET /logs?since=N` pull. The pull runs from a
// scheduled callback AND from `forceStopContainer`,
// i.e. directly in front of the SIGTERM/SIGKILL that a cancel/timeout depends on.
// A wedged agent that accepts the TCP connection but never responds would
// otherwise stall the alarm chain, or (far worse) stall cancellation itself and
// pin one of the fleet's global `max_instances` slots — exactly the capacity
// starvation the `destroy()` escalation exists to prevent. Bound it: 2s is far
// more than a healthy in-container buffer read needs, and an abort just means one
// tick's lines are lost instead of the whole teardown.
export const LOG_PULL_TIMEOUT_MS = 2000;

/**
 * Requests per pull callback, including the final empty request that acknowledges
 * the last ingested page back to the agent. Bounds the work one scheduled callback
 * can do while still letting a deep backlog clear inside the exit barrier. The
 * agent resets its idle deadline whenever this puller acknowledges progress, but
 * still has a non-resettable absolute cap.
 */
export const MAX_LOG_PULL_PAGES = 32;

/**
 * Wall-clock ceiling on ONE pull callback, however many pages it drains. The
 * page cap bounds WORK; this bounds LATENCY, and they are not the same bound —
 * Without this deadline, MAX_LOG_PULL_PAGES pages that each answer just under
 * LOG_PULL_TIMEOUT_MS could hold one callback for 64s and put ~128s of work in
 * front of a teardown that joins an in-flight drain then takes a fresh snapshot.
 * `pollLogs` and `enforceTimeout` are both base-scheduler callbacks and run one at
 * a time, so that also postpones token revocation. Keep the deadline at 2x
 * LOG_PULL_TIMEOUT_MS; a drain cut short resumes from the advanced cursor next
 * tick.
 */
export const LOG_DRAIN_BUDGET_MS = LOG_PULL_TIMEOUT_MS * 2;

/**
 * Payload bytes charged as one sink operation. A row's cost is at least 1 (the
 * fixed per-row insert/serialize/send overhead) and grows with its length,
 * because every byte is copied into a SQLite row, into a JSON payload, and into
 * each subscriber's send buffer. Measured in UTF-16 code units — deterministic,
 * and within a small constant factor of the real byte count. This is a WORK
 * budget, not a storage bound; it does not need byte-exactness, it needs to be
 * impossible to game.
 */
export const LOG_SINK_OP_PAYLOAD_BYTES = 1024;

/**
 * Deterministic ceiling on the SINK work one pull callback may do, in sink
 * operations: for each ingested row, one SQLite insert plus one `ws.send` per
 * live subscriber, weighted by the row's payload (`LOG_SINK_OP_PAYLOAD_BYTES`).
 * A page of `n` rows with `s` subscribers therefore costs
 * `(1 + s) * sum(max(1, ceil(len / LOG_SINK_OP_PAYLOAD_BYTES)))`.
 *
 * `LOG_DRAIN_BUDGET_MS` cannot bound this, and neither can any other clock. A
 * deployed Worker's clock does not advance during CPU work — it moves on I/O —
 * so `Date.now()` here measures the agent's response latency and scores every
 * parse, insert and fan-out between the fetches as free. MAX_LOG_PULL_PAGES
 * bounds the RESPONSE SIZE a callback may take (32 x MAX_LOG_RESPONSE_BYTES),
 * but bounding the size of the data does not bound the work done on it: 64 MiB
 * of rows fanned out to `s` subscribers is `(1 + s)` copies of it, and that
 * whole cost sits in front of the SIGTERM/SIGKILL a cancel or timeout depends
 * on, against the invocation's CPU allowance. The wall-clock deadline still
 * bounds LATENCY (how long a teardown waits on a slow agent); this bounds WORK.
 *
 * Sized at MAX_STORED_LOG_LINES because that is the DO's retained window: rows
 * ingested past it within the same callback are deleted by that same batch's
 * eviction statement, so a larger budget could only buy work whose result is
 * immediately discarded. An unsubscribed build of short lines therefore drains
 * a full agent ring in one callback; a subscribed or
 * chatty one spends the same budget proportionally faster, which is exactly the
 * cost it imposes.
 *
 * Checked BETWEEN pages, never inside one. A response page is ingested
 * atomically — the cursor may not advance past rows that were not ingested — so
 * one maximum page may overshoot the cap. The callback then returns without the
 * final acknowledgement request; the next one resumes from the advanced cursor,
 * and its `since=<advanced>` IS that acknowledgement.
 */
export const MAX_LOG_SINK_OPS_PER_DRAIN = MAX_STORED_LOG_LINES;

/**
 * How long `onError` keeps retrying a live agent after a failed terminal pull.
 * The agent holds its HTTP server open for an 8s idle window while waiting for
 * the DO cursor acknowledgement. Leave one polling interval of margin so the
 * final successful response can be observed before that server closes.
 */
export const LOG_TERMINAL_DRAIN_RETRY_WINDOW_MS = 7000;

// Wall-clock granted to the container PAST its build budget, covering the agent's
// exit-time drain barrier (`waitForLogDrain` in container/build-agent.mjs) plus
// the final flush and server close that follow it.
//
// The budget must bound build EXECUTION only. After `runBuild` returns, the agent
// deliberately holds the process open so the pull-loop can collect the tail — the
// container is still `running`, and the DO status is still `deploying` because the
// agent cannot report a terminal status by design (`handleStatus` rejects them). So
// an `enforceTimeout` that comes due INSIDE that barrier wins its CAS and overwrites
// a successful, already-live deploy with `failed` / 'build timed out', completing the
// check run as a failure with `void deploy exited with code 0` sitting in its own log
// tail. Routing KV and the `deployments` row are already committed by then and are
// never rolled back, so the deployment stays live — only the report is wrong, which
// is worse than it sounds for anyone reading it.
//
// 125s covers the agent's 120s absolute barrier with shutdown slack. The agent also
// has an 8s no-progress deadline, so a dead DO still releases its container quickly;
// the longer window is available only while acknowledged-cursor progress continues.
// This remains inside the deploy token's 5-minute margin. Two copies of the timing
// relation live in separate processes (the agent is plain JS copied into the image
// and cannot import from `src/`), so build-manager.test.ts asserts it.
//
// Deliberately UNCONDITIONAL. Nothing tells
// the DO whether the agent has entered its drain phase, so a build still installing
// at its deadline gets this grace too. Gating it on an explicit "draining"
// signal from the agent would need a new agent->DO protocol message on the exact
// path that is already failing, and a lost or late signal would kill the container
// mid-drain — which is precisely the tail-loss bug this exists to prevent. Trading a
// bounded overshoot, still inside the deploy token, for a new
// silent-log-loss failure mode is the wrong direction. Revisit only if the agent
// grows a status channel reliable enough to gate a kill on.
export const LOG_DRAIN_GRACE_SECONDS = 125;

// Hard ceiling on the pre-teardown Postgres revocation (`markBuildTerminalIfActive`
// at the three teardown sites: enforceTimeout / cancelBuild / the startBuild catch).
//
// Those sites deliberately write `builds.status` BEFORE signalling the container,
// because that row is the deploy token's authority and the drain now sits between
// the decision and the kill. That ordering is right, but it put a Postgres round
// trip in FRONT of the only thing that stops a runaway container — and
// `createDb()` builds a bare `drizzle(connectionString)` over a `pg.Pool` with no
// `connectionTimeoutMillis` and no `query_timeout` (all of pg's deadline defaults
// are `false`/`0`). A query that PENDS rather than rejects therefore never reaches
// the `catch`, and `forceStopContainer()` + `pokeScheduler()` are never reached at
// all: the timed-out build keeps running with a still-honored token on a pinned
// fleet slot.
//
// Nothing recovers that cheaply. The base scheduler runs callbacks serially inside
// one `alarm()` and only deletes the schedule row after the callback returns, so
// `syncPendingStoppedEvents`, the `sleepAfter` idle net and the `pollLogs` re-arm
// all sit behind the hang. Worse, the retry after the runtime kills the invocation
// is a NO-OP: `setStatus('failed')` has already run, so the entry guard
// (`TERMINAL_STATUSES.includes(config.status)`) returns immediately. Teardown then
// waits on the hourly stale reaper at STALE_CONTAINER_BUILD_MAX_AGE_MINUTES — long
// past the deploy token's own expiry.
//
// So bound it and let a non-settling write fall into the SAME path a throw already
// takes: capture, tear down, rethrow after. That trade is already made and
// documented here — a revocation that fails leaves the row ACTIVE for the reaper,
// which is strictly better than leaving the container alive to use it.
//
// 5s is ~3 orders above a warm Hyperdrive UPDATE and still covers a cold pool
// connect, while staying well inside the SIGTERM grace that follows it.
export const TERMINAL_WRITE_TIMEOUT_MS = 5000;

// How long `reconcileTerminalWrite` waits before looking again when the row is still
// ACTIVE. Deliberately coarse: by the time it re-arms, the write has ALREADY missed a
// 5s deadline, so the interesting distribution is minutes, not milliseconds, and the
// worst case (a write that never lands) polls until the hourly stale reaper flips the
// row — capped by that, not by this. Nothing waits on the result, so a slow
// convergence costs a late check-run PATCH and nothing else.
export const RECONCILE_RETRY_SECONDS = 300;

/**
 * Reject with `reason` if `work` has not settled within `ms`.
 *
 * The loser is not cancelled — a `pg` query has no abort handle here — but both
 * outcomes stay handled: the two-argument `then` attaches permanent handlers, so a
 * late rejection resolves into a no-op `reject()` on an already-settled promise
 * rather than an unhandled rejection.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, reason: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(reason)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// Bundled from the release's SDK manifest. Used only when the application has
// no local Void dependency; never resolve the moving npm "latest" channel.
export const PINNED_VOID_CLI_VERSION = voidPackageJson.version;

// Ceiling on how long a queued build may wait for the just-in-time branch-head
// freshness recheck to succeed. While the GitHub compare API is unreachable
// (returns null) we requeue and retry on the next alarm; but no container is
// started on that path, so nothing would ever reap a persistently-null build —
// past this age we fail it rather than loop forever.
const FRESHNESS_VERIFY_MAX_AGE_MS = 30 * 60 * 1000;

// Idle safety-net for a stuck/orphaned container, expressed as the build's
// wall-clock hard max plus a margin so it can never cut a legitimately busy
// build short. `sleepAfter` is an IDLE timeout (not a wall-clock cap) and nothing
// renews it after start — the per-build wall-clock cap is `enforceTimeout`. Kept
// in lockstep with `DEPLOY_TOKEN_HARD_MAX_MINUTES` so the idle net always sits
// above the longest a build can legitimately run. The +15m margin matches the
// STALE reaper margin.
const SLEEP_AFTER_MINUTES = DEPLOY_TOKEN_HARD_MAX_MINUTES + 15;

// GitHub's output.text caps are UTF-8 bytesize caps — measure with one shared
// encoder (available in both Workers and the Node/Miniflare test env).
const utf8 = new TextEncoder();

function utf8Length(text: string): number {
  return utf8.encode(text).length;
}

/**
 * Drop `cut` leading UTF-16 code units from `line`, advancing one further when
 * the cut would land on a low surrogate (0xDC00–0xDFFF): slicing there strands
 * the low half of a split pair at the front of the kept tail, which re-encodes
 * as a 3-byte U+FFFD — garbage in the output (and bytes the caller's byte
 * accounting never budgeted for).
 */
function sliceTailAtUnit(line: string, cut: number): string {
  const code = line.charCodeAt(cut);
  return line.slice(code >= 0xdc00 && code <= 0xdfff ? cut + 1 : cut);
}

/** Longest run of consecutive backticks in `text` (0 when there are none). */
function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) {
    if (match[0].length > longest) {
      longest = match[0].length;
    }
  }
  return longest;
}

/**
 * Fixed width shared with the xterm oracle. A width derived from raw input bytes
 * makes non-painting SGR sequences change the right margin and therefore the
 * visible output. 32K columns comfortably covers real build diagnostics while
 * keeping one headless grid to a few MiB.
 */
export const TERMINAL_RENDER_COLUMNS = 32 * 1024;

/**
 * Deterministic outer bounds around xterm. Worker clocks do not advance during
 * CPU work, so a `performance.now()` deadline cannot interrupt a hostile CSI.
 * Controlled rows larger than half the grid, or whose work-amplifying controls
 * exceed this aggregate budget, are omitted fail-closed before a grid is
 * allocated. The tail budget limits cumulative parser work across 100 rows.
 */
export const TERMINAL_RENDER_MAX_INPUT_CODE_UNITS = TERMINAL_RENDER_COLUMNS / 2;
export const TERMINAL_RENDER_MAX_PARAMETER_WORK = 8 * 1024;
export const TERMINAL_RENDER_MAX_REPEAT_CODE_UNITS = 1024 * 1024;
export const TERMINAL_TAIL_MAX_INPUT_CODE_UNITS = TERMINAL_RENDER_COLUMNS;
const TERMINAL_FULL_GRID_WORK = TERMINAL_RENDER_MAX_PARAMETER_WORK / 4;
const TERMINAL_ROW_MUTATION_WORK = 32;

function hasTerminalControl(raw: string): boolean {
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

interface TerminalPreflight {
  safe: boolean;
  controlledCodeUnits: number;
  parameterWork: number;
  repeatCodeUnits: number;
}

/**
 * Bound parameter-driven terminal work before it reaches xterm's handlers.
 * This is deliberately only a resource preflight, not another terminal model:
 * xterm remains authoritative for parsing and screen state. It recognizes CSI
 * framing well enough to charge work-amplifying commands and rejects insert
 * mode, whose printable path shifts the full row once per character.
 */
function preflightTerminalInput(
  raw: string,
  maxInputCodeUnits = TERMINAL_RENDER_MAX_INPUT_CODE_UNITS,
): TerminalPreflight {
  if (!hasTerminalControl(raw)) {
    return { safe: true, controlledCodeUnits: 0, parameterWork: 0, repeatCodeUnits: 0 };
  }
  if (raw.length > maxInputCodeUnits) {
    return {
      safe: false,
      controlledCodeUnits: raw.length,
      parameterWork: 0,
      repeatCodeUnits: 0,
    };
  }

  let state: 'ground' | 'escape' | 'escapeIntermediate' | 'csi' | 'csiIgnore' = 'ground';
  let parameterWork = 0;
  let repeatCodeUnits = 0;
  let precedingGraphicRun = 0;
  let parameterValue = 0;
  let parameterHasDigits = false;
  let csiHasParameterBytes = false;
  let csiPrefix = '';
  let csiIntermediates = '';
  let escapeIntermediates = '';
  let defaultTabStopsCleared = false;
  const csiParameters: Array<number> = [];

  const resetCsi = (): void => {
    parameterValue = 0;
    parameterHasDigits = false;
    csiHasParameterBytes = false;
    csiPrefix = '';
    csiIntermediates = '';
    csiParameters.length = 0;
  };
  const finishParameter = (): void => {
    if (!parameterHasDigits) {
      return;
    }
    csiParameters.push(parameterValue);
    parameterValue = 0;
    parameterHasDigits = false;
  };
  const spendWork = (units: number): boolean => {
    parameterWork += Math.max(1, units);
    return parameterWork <= TERMINAL_RENDER_MAX_PARAMETER_WORK;
  };
  const enterCsi = (): void => {
    resetCsi();
    state = 'csi';
  };

  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index);
    // Executed C0/C1 controls clear xterm's preceding-graphic state. ESC and
    // CSI introducers preserve it just long enough for an immediately following
    // REP; executed controls and successfully dispatched sequences reset it.
    if ((code <= 0x1f && code !== 0x1b) || (code >= 0x80 && code <= 0x9f && code !== 0x9b)) {
      precedingGraphicRun = 0;
    }
    // After TBC 3 clears every stop, xterm's HT search can scan the full fixed
    // grid. Keep custom-tab semantics in xterm, but conservatively charge that
    // worst case until RIS restores the default stops.
    if (code === 0x09 && defaultTabStopsCleared && !spendWork(TERMINAL_FULL_GRID_WORK)) {
      return { safe: false, controlledCodeUnits: raw.length, parameterWork, repeatCodeUnits };
    }
    // These controls scroll the sole row and make xterm allocate/fill a fresh
    // 32K-column buffer line. Permit an isolated real control, but reject a
    // reset/scroll flood before constructing the terminal grid.
    if (
      (code === 0x0a ||
        code === 0x0b ||
        code === 0x0c ||
        code === 0x84 ||
        code === 0x85 ||
        code === 0x8d) &&
      !spendWork(TERMINAL_FULL_GRID_WORK)
    ) {
      return { safe: false, controlledCodeUnits: raw.length, parameterWork, repeatCodeUnits };
    }
    // C1 CSI is an anywhere transition in xterm, including string controls.
    if (code === 0x9b) {
      enterCsi();
      continue;
    }

    if (state === 'ground') {
      if (code === 0x1b) {
        escapeIntermediates = '';
        state = 'escape';
      } else if (code >= 0x20 && code <= 0x7e) {
        // Every printable ASCII byte starts a new xterm cell/grapheme. Keep the
        // conservative run bound only for non-ASCII code units, where combining
        // and joiner behavior can make one grapheme span many source units.
        precedingGraphicRun = 1;
      } else if (code > 0x1f && !(code >= 0x7f && code <= 0x9f)) {
        // Treat the whole printable run as one possible grapheme. This is
        // conservative for Unicode and exact for the hostile combining case.
        precedingGraphicRun += 1;
      }
      continue;
    }
    if (state === 'escape' || state === 'escapeIntermediate') {
      if (code === 0x18 || code === 0x1a) {
        state = 'ground';
      } else if (code === 0x1b) {
        escapeIntermediates = '';
        state = 'escape';
      } else if (code <= 0x1f || code === 0x7f) {
        // Ordinary C0 controls execute without leaving the escape state; DEL is
        // ignored. This matters for ESC BEL [ CSI routing.
      } else if (state === 'escape' && code === 0x5b) {
        enterCsi();
      } else if (code >= 0x20 && code <= 0x2f) {
        state = 'escapeIntermediate';
        escapeIntermediates += String.fromCharCode(code);
      } else if (code >= 0x30 && code <= 0x7e) {
        const fullGridEscape =
          (escapeIntermediates === '' &&
            (code === 0x44 || code === 0x45 || code === 0x4d || code === 0x63)) ||
          (escapeIntermediates === '#' && code === 0x38);
        if (fullGridEscape && !spendWork(TERMINAL_FULL_GRID_WORK)) {
          return { safe: false, controlledCodeUnits: raw.length, parameterWork, repeatCodeUnits };
        }
        if (escapeIntermediates === '' && code === 0x63) {
          defaultTabStopsCleared = false;
        }
        state = 'ground';
        precedingGraphicRun = 0;
      }
      continue;
    }
    if (state === 'csiIgnore') {
      if (code === 0x18 || code === 0x1a) {
        state = 'ground';
      } else if (code === 0x1b) {
        escapeIntermediates = '';
        state = 'escape';
      } else if (code >= 0x40 && code <= 0x7e) {
        state = 'ground';
      }
      continue;
    }

    // CSI entry/parameter/intermediate states. Embedded C0 controls execute and
    // stay in CSI; CAN/SUB abort; ESC restarts escape parsing.
    if (code === 0x18 || code === 0x1a) {
      state = 'ground';
      resetCsi();
      precedingGraphicRun = 0;
    } else if (code === 0x1b) {
      escapeIntermediates = '';
      state = 'escape';
      resetCsi();
    } else if (code <= 0x1f || code === 0x7f) {
      continue;
    } else if (code >= 0x30 && code <= 0x39 && csiIntermediates === '') {
      csiHasParameterBytes = true;
      parameterHasDigits = true;
      parameterValue = Math.min(
        TERMINAL_RENDER_MAX_PARAMETER_WORK + 1,
        parameterValue * 10 + code - 0x30,
      );
      if (parameterValue > TERMINAL_RENDER_MAX_PARAMETER_WORK) {
        return { safe: false, controlledCodeUnits: raw.length, parameterWork, repeatCodeUnits };
      }
    } else if ((code === 0x3a || code === 0x3b) && csiIntermediates === '') {
      csiHasParameterBytes = true;
      finishParameter();
    } else if (code >= 0x3c && code <= 0x3f && csiIntermediates === '') {
      if (csiPrefix !== '' || csiHasParameterBytes) {
        // xterm enters CSI_IGNORE when a second private marker appears or a
        // marker follows parameters. An ignored sequence does not dispatch and
        // therefore does not clear REP's preceding-graphic source.
        state = 'csiIgnore';
        resetCsi();
      } else {
        csiPrefix = String.fromCharCode(code);
      }
    } else if (code >= 0x20 && code <= 0x2f) {
      finishParameter();
      csiIntermediates += String.fromCharCode(code);
    } else if (code >= 0x40 && code <= 0x7e) {
      finishParameter();
      const firstParameter = csiParameters[0] || 1;
      if (csiPrefix === '' && csiIntermediates === '' && code === 0x67 && firstParameter === 3) {
        defaultTabStopsCleared = true;
      }
      // REP allocates `precedingGrapheme.length * Ps` code points before it
      // paints. A grapheme can contain most of the input as combining marks, so
      // the generic Ps sum alone is not a memory bound.
      if (code === 0x62 && csiPrefix === '' && csiIntermediates === '') {
        repeatCodeUnits += precedingGraphicRun * (csiParameters[0] || 1);
        if (repeatCodeUnits > TERMINAL_RENDER_MAX_REPEAT_CODE_UNITS) {
          return { safe: false, controlledCodeUnits: raw.length, parameterWork, repeatCodeUnits };
        }
      }
      // ANSI insert mode makes every subsequent printable character shift the
      // entire row. It is irrelevant to build output and unsafe to hand to a
      // dense terminal grid under attacker-controlled input.
      if (
        code === 0x68 &&
        csiPrefix === '' &&
        csiIntermediates === '' &&
        csiParameters.includes(4)
      ) {
        return { safe: false, controlledCodeUnits: raw.length, parameterWork, repeatCodeUnits };
      }
      let commandWork = 1;
      if (csiPrefix === '' && csiIntermediates === '') {
        switch (String.fromCharCode(code)) {
          case 'S':
          case 'T':
          case 'L':
          case 'M':
            commandWork += TERMINAL_FULL_GRID_WORK + firstParameter;
            break;
          case 'J':
          case 'K':
            commandWork += TERMINAL_ROW_MUTATION_WORK;
            break;
          case '@':
          case 'P':
            commandWork += TERMINAL_ROW_MUTATION_WORK + firstParameter;
            break;
          case 'I':
          case 'Z':
            commandWork += firstParameter * (defaultTabStopsCleared ? TERMINAL_FULL_GRID_WORK : 1);
            break;
          case 'X':
          case 'b':
            commandWork += firstParameter;
            break;
        }
      } else if (
        csiPrefix === '' &&
        ((csiIntermediates === ' ' && (code === 0x40 || code === 0x41)) ||
          (csiIntermediates === "'" && (code === 0x7d || code === 0x7e)))
      ) {
        commandWork += TERMINAL_ROW_MUTATION_WORK + firstParameter;
      } else if (csiPrefix === '?' && csiIntermediates === '' && (code === 0x4a || code === 0x4b)) {
        // DECSED/DECSEL inspect protection metadata across the dense row even
        // when few cells change, unlike the ordinary erase fast path.
        commandWork += TERMINAL_ROW_MUTATION_WORK;
      } else if (csiPrefix === '?' && csiIntermediates === '' && (code === 0x68 || code === 0x6c)) {
        // DECSET/DECRST alternate-buffer switches clear/allocate a dense row.
        commandWork +=
          csiParameters.filter(
            (parameter) => parameter === 47 || parameter === 1047 || parameter === 1049,
          ).length * TERMINAL_FULL_GRID_WORK;
      }
      if (!spendWork(commandWork)) {
        return { safe: false, controlledCodeUnits: raw.length, parameterWork, repeatCodeUnits };
      }
      state = 'ground';
      resetCsi();
      precedingGraphicRun = 0;
    } else {
      state = 'csiIgnore';
      resetCsi();
    }
  }
  return { safe: true, controlledCodeUnits: raw.length, parameterWork, repeatCodeUnits };
}

type TerminalParserBoundaryState =
  | 'ground'
  | 'escape'
  | 'escapeIntermediate'
  | 'csi'
  | 'osc'
  | 'dcs'
  | 'sosPmApc';

interface TerminalRenderGroup {
  lines: Array<TerminalRenderLine>;
  inputCodeUnits: number;
  requiresTerminal: boolean;
}

type TerminalLineEnding = NonNullable<BuildLogLine['lineEnding']>;

interface TerminalRenderLine {
  raw: string;
  lineEnding: TerminalLineEnding;
}

const LINE_ENDING_TEXT: Record<TerminalLineEnding, string> = {
  cr: '\r',
  // Build children write to pipes, which do not perform a terminal's LF → CRLF
  // output processing. Start each captured newline at column zero when rendering;
  // raw stored delimiters and bare-CR progress rewrites remain unchanged.
  lf: '\r\n',
  crlf: '\r\n',
  none: '',
};

type TerminalLogInput = string | { line: string; lineEnding?: TerminalLineEnding | null };

function normalizeTerminalLogLines(lines: Array<TerminalLogInput>): Array<TerminalRenderLine> {
  return lines.map((entry, index) => {
    const capturedEnding = typeof entry === 'string' ? undefined : entry.lineEnding;
    const validCapturedEnding =
      capturedEnding === 'cr' ||
      capturedEnding === 'lf' ||
      capturedEnding === 'crlf' ||
      capturedEnding === 'none'
        ? capturedEnding
        : undefined;
    return {
      raw: typeof entry === 'string' ? entry : entry.line,
      // Old agents/rows did not preserve delimiters. Retain the previous CRLF
      // reconstruction between records while avoiding a fabricated trailing EOL.
      lineEnding: validCapturedEnding ?? (index + 1 < lines.length ? 'crlf' : 'none'),
    };
  });
}

/**
 * Track only VT parser framing across captured-row boundaries. Rendering stays
 * xterm's job; this state exists so the tail budget never cuts into the middle
 * of OSC/DCS/SOS/PM/APC, ESC, or CSI and then feeds its payload to a fresh
 * terminal as printable text.
 *
 * The transitions mirror xterm 6's VT500 table. DCS's entry/parameter/
 * passthrough states are deliberately collapsed: they all remain non-ground
 * until an anywhere transition or terminator, which is the only distinction
 * grouping needs. Invalid bytes may therefore keep a group open longer than
 * xterm would, but never close one early and expose hidden payload.
 */
function advanceTerminalParserBoundary(
  initialState: TerminalParserBoundaryState,
  raw: string,
): TerminalParserBoundaryState {
  let state = initialState;
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index);

    // VT500 anywhere transitions. The named C1 introducers override the
    // generic C1 execute-to-ground ranges below.
    if (code === 0x18 || code === 0x1a || code === 0x9c) {
      state = 'ground';
      continue;
    }
    if (code === 0x1b) {
      state = 'escape';
      continue;
    }
    if (code === 0x90) {
      state = 'dcs';
      continue;
    }
    if (code === 0x98 || code === 0x9e || code === 0x9f) {
      state = 'sosPmApc';
      continue;
    }
    if (code === 0x9b) {
      state = 'csi';
      continue;
    }
    if (code === 0x9d) {
      state = 'osc';
      continue;
    }
    if ((code >= 0x80 && code <= 0x97) || code === 0x99 || code === 0x9a) {
      state = 'ground';
      continue;
    }

    switch (state) {
      case 'ground':
        break;
      case 'escape':
        if (code <= 0x1f || code === 0x7f) {
          break;
        }
        if (code === 0x5b) {
          state = 'csi';
        } else if (code === 0x5d) {
          state = 'osc';
        } else if (code === 0x50) {
          state = 'dcs';
        } else if (code === 0x58 || code === 0x5e || code === 0x5f) {
          state = 'sosPmApc';
        } else if (code >= 0x20 && code <= 0x2f) {
          state = 'escapeIntermediate';
        } else if (code >= 0x30 && code <= 0x7e) {
          state = 'ground';
        }
        break;
      case 'escapeIntermediate':
        if (code <= 0x1f || code === 0x7f || (code >= 0x20 && code <= 0x2f)) {
          break;
        }
        if (code >= 0x30 && code <= 0x7e) {
          state = 'ground';
        }
        break;
      case 'csi':
        // C0 controls execute without ending CSI; parameters/intermediates and
        // DEL remain inside it. A final byte returns to ground.
        if (code >= 0x40 && code <= 0x7e) {
          state = 'ground';
        }
        break;
      case 'osc':
        // OSC alone accepts BEL as a terminator. ESC/CAN/SUB/ST were handled by
        // the anywhere transitions above.
        if (code === 0x07) {
          state = 'ground';
        }
        break;
      case 'dcs':
      case 'sosPmApc':
        // Their payload, including BEL and CR/LF, remains hidden until an
        // anywhere transition above aborts or terminates the string.
        break;
    }
  }
  return state;
}

/** Partition chronological rows without cutting VT state or a bare-CR rewrite. */
function groupTerminalLogLines(lines: Array<TerminalLogInput>): Array<TerminalRenderGroup> {
  const groups: Array<TerminalRenderGroup> = [];
  let state: TerminalParserBoundaryState = 'ground';
  let current: TerminalRenderGroup | null = null;
  const normalized = normalizeTerminalLogLines(lines);

  for (let index = 0; index < normalized.length; index++) {
    const line = normalized[index];
    if (current === null) {
      current = { lines: [], inputCodeUnits: 0, requiresTerminal: false };
    }
    current.lines.push(line);
    current.inputCodeUnits += line.raw.length + LINE_ENDING_TEXT[line.lineEnding].length;
    current.requiresTerminal ||=
      hasTerminalControl(line.raw) ||
      line.lineEnding === 'cr' ||
      (line.lineEnding === 'none' && index + 1 < normalized.length);

    state = advanceTerminalParserBoundary(state, line.raw);
    state = advanceTerminalParserBoundary(state, LINE_ENDING_TEXT[line.lineEnding]);

    // A bare CR rewrites the same terminal row, so it remains in this atomic
    // group even at parser ground. LF/CRLF and EOF complete a logical row only
    // once every spanning parser sequence has returned to ground.
    if (
      state === 'ground' &&
      line.lineEnding !== 'cr' &&
      (line.lineEnding !== 'none' || index + 1 === normalized.length)
    ) {
      groups.push(current);
      current = null;
    }
  }

  if (current !== null) {
    groups.push(current);
  }
  return groups;
}

function preflightTerminalGroup(group: TerminalRenderGroup): TerminalPreflight {
  if (!group.requiresTerminal) {
    return { safe: true, controlledCodeUnits: 0, parameterWork: 0, repeatCodeUnits: 0 };
  }
  const controlledCodeUnits = group.inputCodeUnits;
  if (controlledCodeUnits > TERMINAL_RENDER_MAX_INPUT_CODE_UNITS) {
    return {
      safe: false,
      controlledCodeUnits,
      parameterWork: 0,
      repeatCodeUnits: 0,
    };
  }
  // Captured endings participate in parser state (notably resetting REP's
  // preceding grapheme), but their count is independently capped at 100. The
  // preflight serializer represents them as CR so raw in-record LF/VT/FF/C1
  // scroll controls still spend the hostile grid-work budget.
  const preflight = preflightTerminalInput(
    serializeTerminalGroupsForPreflight([group]),
    TERMINAL_RENDER_MAX_INPUT_CODE_UNITS,
  );
  return {
    safe: preflight.safe,
    controlledCodeUnits,
    parameterWork: preflight.parameterWork,
    repeatCodeUnits: preflight.repeatCodeUnits,
  };
}

/**
 * Preserve parser/REP boundaries without treating the at-most-100 captured
 * delimiters as hostile full-grid controls. A CR executes in the same ESC/CSI
 * states and resets REP's preceding graphic, but does not scroll xterm's row.
 */
function serializeTerminalGroupsForPreflight(groups: Array<TerminalRenderGroup>): string {
  return groups
    .flatMap((group) =>
      group.lines.map((line) => `${line.raw}${line.lineEnding === 'none' ? '' : '\r'}`),
    )
    .join('');
}

async function renderTerminalGroups(groups: Array<TerminalRenderGroup>): Promise<Array<string>> {
  if (groups.every((group) => !group.requiresTerminal)) {
    return groups.flatMap((group) =>
      group.lines.flatMap((line) => {
        const visible = line.raw.trimEnd();
        return visible === '' ? [] : [visible];
      }),
    );
  }

  const normalLines: Array<string> = [];
  const alternateLines: Array<string> = [];
  const term = new Terminal({
    cols: TERMINAL_RENDER_COLUMNS,
    rows: 1,
    allowProposedApi: true,
    // One scrollback row lets onLineFeed copy a completed row without retaining
    // the whole 32K x 100 tail grid. Memory remains constant.
    scrollback: 1,
  });
  let captureRecordedLineFeed = false;
  const lineFeed = term.onLineFeed(() => {
    // Line-motion controls inside one captured record keep the single-row
    // sanitizer semantics. Only an exact captured LF/CRLF completes a log row.
    if (!captureRecordedLineFeed) {
      return;
    }
    const buffer = term.buffer.active;
    const visible = (
      buffer.getLine(Math.max(0, buffer.baseY - 1))?.translateToString(false) ?? ''
    ).trimEnd();
    if (visible !== '') {
      if (buffer.type === 'alternate') {
        // The alternate buffer has no scrollback. With the one-row model, a
        // completed alternate row is gone after the scroll; only the final
        // active row can be visible when formatting finishes in this buffer.
        alternateLines.length = 0;
      } else {
        normalLines.push(visible);
      }
    }
  });
  // External row capture must follow xterm history clears. Returning false lets
  // xterm's built-in handler run after this observation hook.
  const clearCapturedHistory = (): boolean => {
    normalLines.length = 0;
    alternateLines.length = 0;
    return false;
  };
  const ris = term.parser.registerEscHandler({ final: 'c' }, clearCapturedHistory);
  // ED 3 / DECSED 3 erase the active buffer's scrollback.
  const clearActiveHistoryOnErase3 = (params: ReadonlyArray<number | Array<number>>): boolean => {
    if (params[0] === 3) {
      if (term.buffer.active.type === 'alternate') {
        alternateLines.length = 0;
      } else {
        normalLines.length = 0;
      }
    }
    return false;
  };
  const ed3 = term.parser.registerCsiHandler({ final: 'J' }, clearActiveHistoryOnErase3);
  const decsed3 = term.parser.registerCsiHandler(
    { prefix: '?', final: 'J' },
    clearActiveHistoryOnErase3,
  );
  try {
    for (const group of groups) {
      for (const line of group.lines) {
        await new Promise<void>((resolve) => term.write(line.raw, resolve));
        const ending = LINE_ENDING_TEXT[line.lineEnding];
        if (ending !== '') {
          captureRecordedLineFeed = line.lineEnding === 'lf' || line.lineEnding === 'crlf';
          try {
            await new Promise<void>((resolve) => term.write(ending, resolve));
          } finally {
            captureRecordedLineFeed = false;
          }
        }
      }
    }
    const buffer = term.buffer.active;
    const active = (buffer.getLine(buffer.baseY)?.translateToString(false) ?? '').trimEnd();
    const visibleLines = buffer.type === 'alternate' ? alternateLines : normalLines;
    if (active !== '') {
      visibleLines.push(active);
    }
    return visibleLines;
  } finally {
    decsed3.dispose();
    ed3.dispose();
    ris.dispose();
    lineFeed.dispose();
    term.dispose();
  }
}

/**
 * Render the check-run `output.text` log tail: `lines` (already chronological —
 * the newest CHECK_RUN_LOG_TAIL_LINES captured) in a `text` fence under a
 * `**Last {M} log lines:**` header, with an `_…earlier lines omitted._` marker
 * whenever fewer lines are rendered than `totalCaptured`. The fence delimiters
 * are max(6, longest backtick run in the kept content + 1) — a log line can
 * never close the fence, so raw (attacker-influenced) build output cannot
 * escape the code block into check-run markdown. Byte-capped at
 * CHECK_RUN_LOG_TAIL_MAX_BYTES (UTF-8 — GitHub validates bytesize): the
 * OLDEST remaining line is dropped while the joined content exceeds the cap;
 * a single still-over-cap line keeps its LAST bytes (the tail is what a
 * failure diagnosis wants), never cutting a surrogate pair in half. The WHOLE
 * rendered string is then forced under CHECK_RUN_OUTPUT_TEXT_MAX_BYTES the
 * same way (oldest-drop, then lone-line tail-truncation), because the dynamic
 * fence can outgrow the headroom the content cap budgeted for. Returns null
 * when nothing was captured (`text` is then omitted from the PATCH).
 *
 * Captured rows are first grouped at VT parser ground-state boundaries and each
 * group is reduced to terminal-visible text through one persistent xterm
 * parser. Lines that were pure control output drop out entirely. Rendering runs
 * BEFORE the byte accounting below, so every cap is measured against the bytes
 * actually sent to GitHub — a spinner line holding hundreds of erased frames
 * must not spend the tail's budget on output no reader will ever see.
 * The stored newest-100-row window is the explicit terminal reset boundary:
 * state older than that bounded capture is unavailable. Within the window we
 * never restart after an omitted state-mutating group; that case fails closed.
 */
export async function formatLogTailMarkdown(
  lines: Array<TerminalLogInput>,
  totalCaptured: number,
): Promise<string | null> {
  // Joined UTF-8 byte length = sum(line byte lengths) + (n - 1) one-byte '\n'
  // separators; dropping the oldest removes its bytes + one separator. Tracked
  // incrementally (no O(n²) joins).
  //
  // Select one contiguous suffix newest-first, then render it chronologically
  // through one xterm. Parser ground ends sequence framing, not persistent
  // terminal modes (tab stops, protection, charsets, saved cursor), so restarting
  // xterm per group is incorrect. Once an unsafe/over-budget group is reached,
  // stop: hopping across it would invent terminal state for the later suffix.
  const groups = groupTerminalLogLines(lines.slice(-CHECK_RUN_LOG_TAIL_LINES));
  const selectedNewestFirst: Array<TerminalRenderGroup> = [];
  let renderInputCodeUnits = 0;
  let requiresTerminal = false;
  let selectedStart = groups.length;
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index];
    const preflight = preflightTerminalGroup(group);
    if (!preflight.safe) {
      break;
    }
    const nextRequiresTerminal: boolean = requiresTerminal || group.requiresTerminal;
    const nextRenderInputCodeUnits = renderInputCodeUnits + group.inputCodeUnits;
    if (nextRequiresTerminal) {
      if (nextRenderInputCodeUnits > TERMINAL_TAIL_MAX_INPUT_CODE_UNITS) {
        break;
      }
      // Re-preflight the candidate suffix as one chronological xterm session.
      // This carries tab-stop and mode state across parser-ground groups and
      // accumulates REP/handler work across the same lifetime that will render.
      const candidateGroups = [group, ...selectedNewestFirst.slice().reverse()];
      if (
        !preflightTerminalInput(
          serializeTerminalGroupsForPreflight(candidateGroups),
          TERMINAL_TAIL_MAX_INPUT_CODE_UNITS,
        ).safe
      ) {
        break;
      }
    }
    selectedNewestFirst.push(group);
    selectedStart = index;
    renderInputCodeUnits = nextRenderInputCodeUnits;
    requiresTerminal = nextRequiresTerminal;
  }
  if (selectedNewestFirst.length === 0) {
    return null;
  }
  // Starting a fresh terminal after an omitted state-mutating group can expose
  // text that the full session erased (custom tab stops, charset, protection,
  // insert mode, etc.). Plain omitted rows are harmless; an omitted controlled
  // prefix makes the later screen state unknowable, so fail closed.
  if (groups.slice(0, selectedStart).some((group) => group.requiresTerminal)) {
    return null;
  }
  // A tool can leave the virtual terminal cursor thousands of columns to the
  // right. GitHub preserves those spaces in its code block, making the useful
  // text appear blank until the reader scrolls horizontally. Keep ordinary
  // indentation, but bound excessive left padding after terminal rendering.
  const visibleLines = (await renderTerminalGroups(selectedNewestFirst.reverse())).map((line) =>
    line.replace(/^ {257,}/, ' '.repeat(32)),
  );

  // Apply the user-visible byte cap newest-first after terminal rendering. This
  // keeps at most the final 60KB plus one currently considered row live.
  const keptNewestFirst: Array<string> = [];
  let joinedBytes = 0;
  for (let lineIndex = visibleLines.length - 1; lineIndex >= 0; lineIndex--) {
    let visible = visibleLines[lineIndex];
    let visibleBytes = utf8Length(visible);
    if (keptNewestFirst.length === 0 && visibleBytes > CHECK_RUN_LOG_TAIL_MAX_BYTES) {
      while (visibleBytes > CHECK_RUN_LOG_TAIL_MAX_BYTES) {
        visible = sliceTailAtUnit(
          visible,
          Math.ceil((visibleBytes - CHECK_RUN_LOG_TAIL_MAX_BYTES) / 3),
        );
        visibleBytes = utf8Length(visible);
      }
      keptNewestFirst.push(visible);
      joinedBytes = visibleBytes;
      break;
    }
    const separatorBytes = keptNewestFirst.length > 0 ? 1 : 0;
    if (joinedBytes + separatorBytes + visibleBytes > CHECK_RUN_LOG_TAIL_MAX_BYTES) {
      break;
    }
    keptNewestFirst.push(visible);
    joinedBytes += separatorBytes + visibleBytes;
  }

  const kept = keptNewestFirst.reverse();
  if (kept.length === 0) {
    return null;
  }
  // Lone still-over-cap line: keep its LAST <= cap bytes. Bytes don't map 1:1
  // to code units, so converge: one dropped unit removes at most 3 bytes (the
  // largest UTF-8 encoding of a single UTF-16 code unit — a surrogate PAIR is
  // 4 bytes but 2 units), so a step of ceil(overflow / 3) never drops more
  // units than could possibly be needed; each dropped unit removes at least
  // 1 byte and the loop re-measures, so it terminates.
  while (kept.length === 1 && joinedBytes > CHECK_RUN_LOG_TAIL_MAX_BYTES) {
    kept[0] = sliceTailAtUnit(kept[0], Math.ceil((joinedBytes - CHECK_RUN_LOG_TAIL_MAX_BYTES) / 3));
    joinedBytes = utf8Length(kept[0]);
  }
  const render = (): string => {
    const fence = '`'.repeat(Math.max(6, Math.max(...kept.map(longestBacktickRun)) + 1));
    const parts = [`**Last ${kept.length} log lines:**`, ''];
    if (totalCaptured > kept.length) {
      parts.push('_…earlier lines omitted._', '');
    }
    parts.push(`${fence}text`, kept.join('\n'), fence);
    return parts.join('\n');
  };
  // Whole-string invariant (see CHECK_RUN_OUTPUT_TEXT_MAX_BYTES): shrink the
  // content — same rules as the content cap above — and re-derive the fence
  // until the fully-rendered string fits GitHub's bytesize cap. Content
  // shrinks every pass, so this terminates.
  let rendered = render();
  let renderedBytes = utf8Length(rendered);
  while (renderedBytes > CHECK_RUN_OUTPUT_TEXT_MAX_BYTES) {
    if (kept.length > 1) {
      kept.shift();
    } else {
      // One front code unit dropped shrinks the render by at most 5 BYTES:
      // at most 3 content bytes (the largest UTF-8 encoding of one code unit)
      // plus at most 2 fence bytes (the longest backtick run shrinks by at
      // most 1, taking one one-byte backtick off each of the two delimiters).
      // So a step of ceil(overflowBytes / 5) never drops more units than
      // could possibly be needed — never over-truncates the tail — while each
      // dropped unit still removes at least 1 byte (and the fence can only
      // shrink), so the re-measuring loop converges without a per-unit pass.
      const overflow = renderedBytes - CHECK_RUN_OUTPUT_TEXT_MAX_BYTES;
      kept[0] = sliceTailAtUnit(kept[0], Math.ceil(overflow / 5));
    }
    rendered = render();
    renderedBytes = utf8Length(rendered);
  }
  return rendered;
}

type StoredBuildStatus = Build['status'];

/** Stored build config plus the live status we track inside the DO. */
type ManagerState = BuildConfig & { status: StoredBuildStatus };

type LogDrainState = { state: 'open' } | { state: 'complete'; finalSeq: number };

type BuildLaunch = {
  controller: AbortController;
  containerStartPending: boolean;
};

/**
 * The narrow slice of `ctx.container` the log pull needs (the base class copies it
 * into a private field, so we read it back through a cast): `running` for the
 * cheap early-out and `getTcpPort` for the NON-starting fetch. `getTcpPort`
 * returns a real `Fetcher`, so the init — specifically `signal` — is honored.
 */
type ContainerPortSurface = {
  running: boolean;
  getTcpPort(port: number): { fetch(url: string, init?: RequestInit): Promise<Response> };
};

/**
 * Per-build DO (keyed by build id) that runs one build inside a Cloudflare
 * Container, streams the container's logs to attached WebSocket consumers,
 * enforces a wall-clock timeout, and writes every status transition back to
 * Postgres via Hyperdrive.
 *
 * The container runs the real `void deploy` CLI (see container/build-agent.mjs) with a
 * short-lived project-scoped `VOID_TOKEN`, so the platform's deploy endpoint is
 * unchanged. This DO never dispatches to user workers — DO→container,
 * DO→Hyperdrive, and DO→`api.github.com` are all allowed here.
 */
export class BuildManager extends Container<ApiEnv['Bindings']> {
  // Container config — the agent listens on 4000 and needs egress (tarball
  // download, npm install, deploy upload). `sleepAfter` is an IDLE timeout (a
  // safety-net that stops a stuck/orphaned container with no activity), NOT a
  // wall-clock cap and NOT renewed after start. The per-build wall-clock cap is
  // `enforceTimeout` (armed in startBuild). sleepAfter is sized above the hard
  // max (see SLEEP_AFTER_MINUTES) so it can never stop a legitimately running
  // build before enforceTimeout fires.
  override defaultPort = 4000;
  override enableInternet = true;
  override sleepAfter = `${SLEEP_AFTER_MINUTES}m`;

  // In-memory fallback for the just-created check-run id, set in startBuild right
  // after createCheckRun. The durable sources are DO storage + `builds.check_run_id`,
  // but if BOTH best-effort persists fail the id lives only here — and the terminal
  // finalizers (onStop/onError/enforceTimeout) are SEPARATE invocations with no
  // access to startBuild's local variable. This field survives create→terminal within
  // the build's lifetime (the DO is actively running the container), so finalize can
  // still PATCH the run. Consulted only behind explicitId/DO/PG, and losing it on
  // eviction is a no-op. The DO is keyed per build, so there is no cross-build
  // staleness.
  private activeCheckRunId: string | null = null;

  // Cursor for the DO→container log pull-loop: the highest agent `seq` already
  // ingested. `pollLogs` requests `GET /logs?since=logCursor` and advances it to
  // the response's `lastSeq`. In-memory ONLY (NOT persisted to ctx.storage):
  // exactly one build runs per DO and there is no restart-resume — a fresh DO
  // starts at 0 and replays from the agent's buffer, and the agent's own ring is
  // the source of truth, so a persisted cursor would add no correctness and only
  // risk skipping unbuffered lines after an eviction.
  private logCursor = 0;
  private logTableReady = false;

  // In-flight `GET /logs` pull, or null when idle. See `pullLogsOnce`: the pull
  // READS `logCursor` to build the URL and WRITES it three awaits later, so two
  // overlapping pulls both start from the stale cursor and ingest the same lines
  // twice. Concurrency here is real — a `fetch()` is NOT storage I/O, so it does
  // not hold the DO input gate, and `forceStopContainer` (cancelBuild RPC, the
  // agent's POST /cancel, the startBuild catch) can run while a scheduled
  // `pollLogs` sits mid-fetch.
  private pullInFlight: Promise<boolean> | null = null;

  /**
   * Whether some teardown has already claimed the right to ingest the
   * `container terminated: …` marker. See `claimTerminationMarker`.
   */
  private terminationMarkerClaimed = false;

  /**
   * Whether a teardown in this DO instance has actually signalled a LIVE container.
   * Distinguishes the two ways `forceStopContainer` can find `running === false`:
   * the container exited on its own (its agent already drained the tail through
   * `waitForLogDrain`, so the log ends where the agent ended it and owes no
   * explanation), or a peer teardown killed it out from under this caller (which
   * very much does). Only the second may emit a marker.
   */
  private containerTornDown = false;

  /**
   * Shared SIGTERM+SIGKILL attempt for overlapping teardowns. The marker owner
   * must wait for the same attempt as its peers: otherwise it can observe both
   * of its own calls fail just before a non-owner successfully signals, and
   * either emit falsely or miss the only truthful marker.
   */
  private teardownInFlight: Promise<boolean> | null = null;

  /**
   * The launch attempt currently preparing or starting this container. External
   * cancellation aborts it synchronously before awaiting Postgres, so every
   * later startup continuation can tell that its authority was revoked. The
   * object identity is the generation fence: cleanup from an older attempt must
   * never stop a newer attempt using the same per-build Durable Object.
   */
  private activeLaunch: BuildLaunch | null = null;
  private buildLaunchInFlight: Promise<void> | null = null;
  // A cancellation can stop before the base class has issued container.start().
  // Keep its marker reservation until that start settles and the last teardown
  // proves no late producer remains. This preserves first-caller-wins ownership.
  private deferredLaunchTermination: string | null = null;

  private launchIsCurrent(launch: BuildLaunch): boolean {
    return this.activeLaunch === launch && !launch.controller.signal.aborted;
  }

  private abortActiveLaunch(): void {
    this.activeLaunch?.controller.abort();
  }

  /**
   * First-caller-wins claim on the termination marker, so overlapping teardowns
   * leave the reader ONE authoritative explanation instead of several
   * contradictory ones.
   *
   * Synchronous on purpose. The obvious spellings both fail:
   *   - the Postgres CAS (`revokeBuildRow`) is a true global arbiter, but the
   *     ordinary external cancel path (`cancelContainerBuildDos`) commits the
   *     terminal row BEFORE calling in, so EVERY caller loses it and no marker
   *     is ever emitted;
   *   - reading the local status and then writing it is two awaits, and only
   *     `ctx.storage` holds the input gate — a concurrent teardown interleaves
   *     between them, both observe a non-terminal status, and both emit.
   *
   * A plain field read+write cannot be interleaved: a DO runs single-threaded
   * and there is no await between the test and the set. Scoped to this DO
   * instance, which is the scope that matters — a teardown after an eviction
   * has no in-flight peer to duplicate.
   */
  private claimTerminationMarker(): boolean {
    if (this.terminationMarkerClaimed) {
      return false;
    }
    this.terminationMarkerClaimed = true;
    return true;
  }

  private db(): Db {
    return createDb(this.env.HYPERDRIVE.connectionString);
  }

  /**
   * `markBuildTerminalIfActive` on a deadline — the ONLY form the three teardown
   * sites may use, because there the write sits in front of the container kill.
   * See TERMINAL_WRITE_TIMEOUT_MS. Reads elsewhere are not bounded: they do not
   * gate a teardown, so a slow one costs latency, not a pinned fleet slot.
   */
  private revokeBuildRow(
    buildId: string,
    status: 'failed' | 'cancelled',
    opts: { error: string; completedAt: string },
  ): Promise<boolean> {
    return withDeadline(
      markBuildTerminalIfActive(this.db(), buildId, status, opts),
      TERMINAL_WRITE_TIMEOUT_MS,
      `build ${buildId}: terminal status write did not settle within ${TERMINAL_WRITE_TIMEOUT_MS}ms`,
    );
  }

  private async getConfig(): Promise<ManagerState | null> {
    return (await this.ctx.storage.get<ManagerState>(STORAGE_KEY_CONFIG)) ?? null;
  }

  private async setStatus(status: StoredBuildStatus): Promise<void> {
    const state = await this.getConfig();
    if (state) {
      await this.ctx.storage.put<ManagerState>(STORAGE_KEY_CONFIG, { ...state, status });
    }
  }

  private async markLogDrainComplete(): Promise<void> {
    try {
      this.ensureLogTable();
      const maxRow = this.ctx.storage.sql
        .exec<{ max: number | null }>('SELECT MAX(seq) AS max FROM logs')
        .toArray()[0];
      await this.ctx.storage.put<LogDrainState>(STORAGE_KEY_LOG_DRAIN, {
        state: 'complete',
        finalSeq: maxRow?.max ?? 0,
      });
    } catch (err) {
      // Completion metadata is a reader hint. It must never bypass the existing
      // Postgres terminalization or scheduler release guarantees.
      console.warn('build-manager: log drain completion persist failed', err);
    }
  }

  private async completeNaturalLogDrain(): Promise<void> {
    await this.pullInFlight?.catch(() => false);
    // A forced teardown's marker owner publishes completion after its marker
    // attempt. onStop may interleave while that owner is still awaiting
    // Postgres, so an already-stopped container alone is not enough here.
    if (!this.terminationMarkerClaimed && !this.teardownInFlight) {
      await this.markLogDrainComplete();
    }
  }

  /**
   * Entry point invoked over RPC by the BuildScheduler. Persists the config,
   * mints the scoped deploy + installation tokens, starts the container with
   * the build env vars, and arms the timeout alarm.
   *
   * The DB row is already `starting` — the scheduler's `claimBuildForStartWithinLimit`
   * flipped it `queued -> starting` before calling us, so there is NO post-start
   * `starting` write here: a delayed `onStart` (which the base `start()` runs
   * inside `blockConcurrencyWhile` before resolving) or a fast-exit `onStop`
   * could already have moved the row to `building`/terminal, and re-writing
   * `starting` afterward would clobber it. `onStart` lands the `instance_type`
   * (the only place it is persisted) via a `starting`-guarded CAS.
   */
  async startBuild(config: BuildConfig): Promise<void> {
    // One DO is keyed to one build. Coalesce duplicate scheduler RPCs onto the
    // same attempt so a stale continuation can never share the base container's
    // internal start promise with a newer generation and mistake its onStart for
    // the new attempt. Capacity retries arrive only after this promise rejects
    // and the scheduler requeues the row, so they create a fresh generation.
    if (this.buildLaunchInFlight) {
      return this.buildLaunchInFlight;
    }
    const attempt = this.runStartBuild(config);
    this.buildLaunchInFlight = attempt;
    try {
      await attempt;
    } finally {
      if (this.buildLaunchInFlight === attempt) {
        this.buildLaunchInFlight = null;
      }
    }
  }

  /**
   * Terminalize a build that a pre-launch recheck rejected. Nothing has been
   * started, so there is no container to tear down.
   *
   * Finalizes a check run created on a PRIOR attempt (a capacity requeue re-runs
   * startBuild on the same build id; the persisted `builds.check_run_id` survives
   * the requeue) and no-ops on a first attempt. CAS-aware: the awaits before this
   * release the DO input gate, so a concurrent terminalizer
   * (terminateBuildsForProject commits an out-of-band terminal status, then the
   * cancelBuild RPC) can win the row with a DIFFERENT status. PATCH `status` only
   * when THIS site won the CAS; on a loss finalize to the recorded outcome so
   * GitHub never contradicts the authoritative DB row.
   */
  private async terminateBeforeLaunch(
    config: BuildConfig,
    status: 'failed' | 'cancelled',
    error: string,
  ): Promise<void> {
    const won = await markBuildTerminalIfActive(this.db(), config.buildId, status, {
      error,
      completedAt: new Date().toISOString(),
    });
    await this.setStatus(status);
    await this.markLogDrainComplete();
    await this.broadcast({ type: 'status', status });
    if (won) {
      await this.finalizeCheckRunToStatus(config, status);
    } else {
      await this.finalizeCheckRunToRecordedOutcome(config);
    }
  }

  private async runStartBuild(config: BuildConfig): Promise<void> {
    const launch: BuildLaunch = {
      controller: new AbortController(),
      containerStartPending: false,
    };
    // A duplicate scheduler delivery cannot legitimately own two concurrent
    // launches for one build. Invalidate any older continuation; identity checks
    // below keep its eventual cleanup from touching this newer generation.
    this.abortActiveLaunch();
    this.activeLaunch = launch;

    // Written before the config becomes visible so every new build is explicitly
    // incomplete until a producer barrier publishes its final SQLite sequence.
    await this.ctx.storage.put<LogDrainState>(STORAGE_KEY_LOG_DRAIN, { state: 'open' });
    await this.ctx.storage.put<ManagerState>(STORAGE_KEY_CONFIG, {
      ...config,
      status: 'starting',
    });

    // Token mint + container start can throw *before* the timeout alarm is
    // armed. At that point neither onError nor onStop will ever fire (those only
    // run after the container is live), so without this catch the row would be
    // stuck `starting` with no alarm and no reaper — permanently consuming one
    // of the user's concurrency slots. Fail it the same way onError does so the
    // slot is freed and the queue scan is re-armed, then re-throw.
    //
    // The catch also covers the step AFTER a successful `this.start()` (arming
    // the timeout schedule). That runs before onStop's reaper is reliably
    // wired, so a throw there would mark the row failed +
    // free the slot while the container keeps running the real `void deploy`
    // CLI with a live token — publishing a deployment for a build Postgres calls
    // `failed`. Track whether start() succeeded so the catch can best-effort
    // stop() the container before finalizing. A pre-start throw (token mint)
    // must NOT stop() — nothing was started.
    let containerStarted = false;
    try {
      // Just-in-time branch-head freshness recheck BEFORE any token mint / start.
      // The push webhook checks freshness at ENQUEUE, but a missed/delayed
      // newer-push webhook can leave a stale queued build that the scheduler runs
      // and publishes. Mirror the OIDC path's gate: prove the commit is still the
      // branch head before minting VOID_TOKEN. `getBranchHeadComparisonStatus`
      // returns null (never throws) on API failure, so a transient outage drives
      // the requeue/age-fail path below rather than the catch's fail.
      const headComparison = await getBranchHeadComparisonStatus(
        this.env,
        config.installationId,
        config.repoFullName,
        config.commitSha,
        config.branch,
      );
      if (headComparison === null) {
        // Can't verify (GitHub API down / repo inaccessible). Do NOT mint or start.
        // Bounce the row back to 'queued' (guarded, so a concurrent cancel wins) and
        // let the next alarm retry — UNLESS the build has been waiting too long, in
        // which case fail it so a persistent-null can't loop forever (no container is
        // started here, so nothing would ever reap it).
        const row = await getBuild(this.db(), config.buildId);
        const ageMs = row?.created_at ? Date.now() - new Date(row.created_at).getTime() : 0;
        if (ageMs > FRESHNESS_VERIFY_MAX_AGE_MS) {
          await this.terminateBeforeLaunch(
            config,
            'failed',
            'could not verify branch head is current before timeout',
          );
        } else {
          await requeueBuildIfStarting(this.db(), config.buildId);
        }
        await this.pokeScheduler();
        return;
      }
      if (headComparison !== 'identical') {
        // ahead/behind/diverged → the commit is no longer the branch head (superseded
        // or rolled back / force-pushed away). Cancel; do NOT mint or start.
        await this.terminateBeforeLaunch(
          config,
          'cancelled',
          'commit is no longer the branch head',
        );
        await this.pokeScheduler();
        return;
      }
      // else 'identical' → proceed to the coverage recheck + signDeployToken + start.

      // Just-in-time GitHub App installation coverage recheck BEFORE any token
      // mint / start. The enqueue path (`installationCoversRepoInTx`) verified
      // coverage at build CREATE, but this DO mints the deploy + source tokens
      // LATER — after a queue wait that can be seconds to ~30min under capacity
      // backoff. If an uninstall / App-suspension / repo-removal webhook is
      // delivered in that window, the `github_installations` row is updated but
      // the enqueue-time check is stale. A fresh plain (non-locking) Postgres
      // read here observes the committed revocation and fails closed before we
      // mint a live deploy token, rather than relying solely on the installation
      // token mint failing once its ~55-min cache expires. Treat an
      // uncovered build like the non-identical freshness branch: cancel (not a
      // build failure), don't mint or start. Nothing is started yet, so there is
      // no container to tear down.
      const covered = await installationCoversRepo(
        this.db(),
        config.connectionId,
        config.projectId,
        config.installationId,
        config.repositoryId,
      );
      if (!covered) {
        await this.terminateBeforeLaunch(
          config,
          'cancelled',
          'github repository authorization is no longer valid; reconnect the repository',
        );
        await this.pokeScheduler();
        return;
      }

      // Just-in-time cancellation recheck BEFORE any token mint / start. The
      // scheduler claimed this row (`queued -> starting`) potentially seconds to
      // ~30min ago (capacity backoff); in that window a disconnect or a
      // branch/executor change could have cancelled the build out-of-band
      // (`terminateBuildsForProject` commits a terminal status, then the
      // cancelBuild RPC). The branch-head + coverage rechecks above don't catch a
      // direct cancellation, so without this we'd mint a live deploy token and
      // start the container for an already-cancelled build, burning capacity until
      // enforceTimeout. A plain READ COMMITTED read suffices — the canceller
      // commits before its RPC. Do NOT re-terminalize (the canceller already wrote
      // the terminal row); just sync the local status, poke, and return —
      // mirroring the non-identical freshness branch above.
      const row = await getBuild(this.db(), config.buildId);
      if (!row || row.status !== 'starting') {
        if (row && TERMINAL_STATUSES.includes(row.status)) {
          await this.setStatus(row.status);
          await this.markLogDrainComplete();
          // Finalize a run created on a PRIOR attempt that this requeue is now
          // abandoning (out-of-band cancel during the queue wait). No-ops on a first
          // attempt (no run yet); on a requeue the id is in DO storage / builds row.
          await this.finalizeCheckRunToStatus(config, row.status);
        } else if (!row) {
          await this.markLogDrainComplete();
        }
        await this.pokeScheduler();
        return;
      }

      // Create the GitHub Check Run now that EVERY pre-start recheck passed — this
      // build WILL start, so the run begins `in_progress`. BEST-EFFORT: a create
      // failure (returns null) must never fail or perturb the build. Two guards:
      //   (a) Idempotent reuse across requeue — a capacity-to-start error re-throws
      //       WITHOUT terminalizing, the scheduler re-queues, and startBuild re-runs
      //       on the SAME DO. We reuse the id from DO storage, or — if that best-effort
      //       cache write was lost — from the persisted `builds.check_run_id` on the
      //       `row` already read above, so a requeue never POSTs a SECOND `Void Build`
      //       run (which would orphan the first one `in_progress`).
      //   (b) SHA guard — config.commitSha is `build.commit_sha ?? ''`; a check-run
      //       POST with head_sha:'' is a guaranteed GitHub 422, so skip creation when
      //       the SHA is empty (no run to orphan; finalizers no-op on the absent id).
      // The DO-storage write is the input-gated source of truth for finalizers; the
      // Postgres write is best-effort (DO KV/DB awaits aren't input-gated). A transient
      // create failure returns null and is NOT stored, so a later requeue retries it.
      let checkRunId: string | null =
        (await this.ctx.storage.get<string>(STORAGE_KEY_CHECK_RUN)) ??
        this.activeCheckRunId ??
        row.check_run_id ??
        null;
      if (!checkRunId && config.commitSha) {
        checkRunId = await createCheckRun(this.env, config.installationId, config.repoFullName, {
          name: VOID_BUILD_CHECK_RUN_NAME,
          headSha: config.commitSha,
          externalId: config.buildId,
          detailsUrl: this.projectUrl(config),
          title: 'Void build in progress',
          summary: `Building \`${config.branch}\` @ ${config.commitSha.slice(0, 7)}`,
        });
        if (checkRunId) {
          // Record the id in-memory FIRST — before the best-effort persists below — so
          // even if BOTH the DO put and the Postgres persist fail, a later terminal
          // finalizer (a separate invocation) can still recover it for this build.
          this.activeCheckRunId = checkRunId;
          // BEST-EFFORT cache of the run id. This put + the Postgres persist below
          // must NOT enter the outer build-start catch: a failure to cache check-run
          // metadata is not a build failure. If the DO-storage put rejects, the id is
          // lost for finalizers (they no-op on the absent id) but the build proceeds;
          // a later requeue re-runs createCheckRun (the idempotent reuse only kicks in
          // once the put succeeds), so this self-heals. Swallow + log, never rethrow.
          let cached = false;
          try {
            await this.ctx.storage.put<string>(STORAGE_KEY_CHECK_RUN, checkRunId);
            cached = true;
          } catch (err) {
            console.warn('startBuild: caching check_run_id in DO storage failed', err);
          }
          try {
            await setBuildCheckRunId(this.db(), config.buildId, checkRunId);
          } catch (err) {
            console.warn(
              cached
                ? 'startBuild: persisting check_run_id failed (DO cache retains it)'
                : 'startBuild: persisting check_run_id failed (DO cache also failed)',
              err,
            );
          }
        }

        // The createCheckRun fetch above yielded the DO input gate, so a cancelBuild
        // RPC could have terminalized this build mid-POST (its finalizeCheckRun ran
        // BEFORE the id was stored → no-op). Re-read the authoritative row: if it is no
        // longer 'starting', sync local status, finalize the just-created run to the
        // recorded outcome, and do NOT mint tokens / start a container. Mirrors the
        // pre-create cancel recheck above; runs only when a create POST happened.
        const recheck = await getBuild(this.db(), config.buildId);
        if (!recheck || recheck.status !== 'starting') {
          if (recheck && TERMINAL_STATUSES.includes(recheck.status)) {
            await this.setStatus(recheck.status);
            await this.markLogDrainComplete();
            // Pass the in-hand `checkRunId`: the run was just created this invocation,
            // so this finalizes it even if both the DO put and the PG persist failed.
            await this.finalizeCheckRunToStatus(config, recheck.status, checkRunId);
          } else if (!recheck) {
            await this.markLogDrainComplete();
          }
          await this.pokeScheduler();
          return;
        }
      }

      // Fail fast on a staging platform misconfiguration. Staging API hosts sit
      // behind CF Access and the container can't do the interactive cloudflared
      // flow, so it relies on the service-token pair being forwarded (below). If
      // staging is missing EITHER secret, the build would otherwise run all the
      // way through download/install/build and only fail at the Access edge when
      // `void deploy` calls the API — a confusing late failure that wastes a
      // container slot. Reject up front as a build failure with a clear message;
      // the catch finalizes it (failed + pokeScheduler) so the slot frees. The
      // pair is all-or-nothing: a half-configured pair is as broken as none.
      // Production isn't Access-gated, so this only applies on staging.
      if (
        this.env.PLATFORM_ENV === 'staging' &&
        !(this.env.CF_ACCESS_CLIENT_ID_STAGING && this.env.CF_ACCESS_CLIENT_SECRET_STAGING)
      ) {
        throw new Error(
          'staging build misconfigured: CF_ACCESS_CLIENT_ID_STAGING and CF_ACCESS_CLIENT_SECRET_STAGING must both be set on the staging API worker so the build can reach the Access-gated staging API',
        );
      }

      // Size the deploy token to cover the whole build (mint happens *before*
      // download + install + deploy). `timeoutMinutes: 0` means unlimited
      // wall-clock, so the shared helper falls back to the hard max; otherwise
      // it uses the plan timeout. Either way the minutes are capped at the hard
      // max so even an "unlimited" custom plan can't mint an unbounded-life
      // token, then padded with a fixed margin so the token outlives the build.
      const ttlSeconds = deployTokenTtlSecondsForBuildMinutes(config.timeoutMinutes);
      const voidToken = await signDeployToken(
        {
          projectId: config.projectId,
          userId: config.userId,
          login: config.login,
          buildId: config.buildId,
        },
        this.env.JWT_SECRET,
        { ttlSeconds },
      );
      // signDeployToken is asynchronous. A cancellation can commit the terminal
      // row and finish its pre-launch teardown while signing is in flight; never
      // continue from that revoked generation into source-token minting.
      if (!this.launchIsCurrent(launch)) {
        await this.pokeScheduler();
        return;
      }
      // Repo-scope the source token to the ONE repo being built, read-only. The
      // build agent uses it solely as the Bearer to download this repo's tarball,
      // but it's injected into the container env where an untrusted dependency
      // `postinstall` could read it — a repo-scoped `{ contents: 'read' }` token
      // caps that blast radius to this single repo instead of every repo the
      // install covers.
      const sourceToken = await getInstallationToken(this.env, config.installationId, {
        repositoryIds: [config.repositoryId],
        permissions: { contents: 'read' },
      });
      // The installation-token fetch is the longest pre-launch await: a cancellation
      // can observe no live container and return while it is pending. The generation
      // fence keeps this continuation from launching afterward.
      if (!this.launchIsCurrent(launch)) {
        await this.pokeScheduler();
        return;
      }
      const sourceTarballUrl = generateSourceTarballUrl(config.repoFullName, config.commitSha);
      const voidApiUrl =
        this.env.PLATFORM_ENV === 'staging'
          ? 'https://api.staging.void.cloud'
          : 'https://api.void.cloud';

      // Staging API hosts sit behind CF Access; the `void deploy` child can't do
      // the interactive `cloudflared` flow (no TTY/binary in the container), so
      // forward the staging service-token pair under the names the CLI reads
      // (`CF_ACCESS_CLIENT_ID`/`SECRET`). Production isn't Access-gated, so this
      // only applies on staging and only when the secrets are configured. These
      // are scrubbed from untrusted install children and re-injected only into
      // the trusted deploy child by the build-agent (see `SCRUBBED_ENV_VARS`).
      const stagingAccess: Record<string, string> =
        this.env.PLATFORM_ENV === 'staging' &&
        this.env.CF_ACCESS_CLIENT_ID_STAGING &&
        this.env.CF_ACCESS_CLIENT_SECRET_STAGING
          ? {
              CF_ACCESS_CLIENT_ID: this.env.CF_ACCESS_CLIENT_ID_STAGING,
              CF_ACCESS_CLIENT_SECRET: this.env.CF_ACCESS_CLIENT_SECRET_STAGING,
            }
          : {};

      // Per-build, unguessable agent secret. The agent (parent process) presents
      // it on its control POSTs (/logs, /status, /cancel); the DO rejects any
      // request without it. The build-agent scrubs AGENT_TOKEN (along with
      // DO_LOG_URL/SOURCE_TOKEN) out of the env handed to untrusted repo
      // install/build child processes, so a malicious postinstall can't forge
      // build status even if it discovers the DO endpoint.
      const agentToken = crypto.randomUUID();
      await this.ctx.storage.put<string>(STORAGE_KEY_AGENT_TOKEN, agentToken);

      if (!this.launchIsCurrent(launch)) {
        await this.pokeScheduler();
        return;
      }

      // Real Container env-var mechanism: set `this.envVars` then start(). The
      // base class forwards these into the container's `start({ env })` call.
      this.envVars = {
        BUILD_ID: config.buildId,
        PROJECT_ID: config.projectId,
        PROJECT_SLUG: config.projectSlug,
        SOURCE_TARBALL_URL: sourceTarballUrl,
        SOURCE_TOKEN: sourceToken,
        VOID_TOKEN: voidToken,
        VOID_API_URL: voidApiUrl,
        ...(this.env.PROXY_URL ? { VOID_PROXY_URL: this.env.PROXY_URL } : {}),
        VOID_PROJECT: config.projectSlug,
        VOID_CLI_VERSION: PINNED_VOID_CLI_VERSION,
        DO_LOG_URL: 'https://manager/logs',
        AGENT_TOKEN: agentToken,
        // Commit/source metadata for `void deploy`. The extracted tarball has no
        // `.git`, so the CLI's `getGitCommit` would record a NULL commit — leaving
        // the deployment unlinked (onStop's getDeploymentByProjectAndCommit can't
        // match) and breaking same-SHA redelivery dedup. The CLI reads GITHUB_SHA
        // FIRST (before any git inspection — this is exactly how the GitHub Actions
        // executor stamps it), and GITHUB_REPOSITORY/GITHUB_REF feed the source
        // links, so forwarding these stamps the deployment correctly. They're the
        // build's own commit/repo/branch (non-secret), and NOT scrubbed from the
        // untrusted child env — the repo already knows its own identity.
        GITHUB_SHA: config.commitSha,
        GITHUB_REPOSITORY: config.repoFullName,
        GITHUB_REF: `refs/heads/${config.branch}`,
        ...stagingAccess,
      };

      // Flip the marker BEFORE awaiting start(): the base `start()` launches the
      // container (`startContainerIfNotRunning`) and THEN runs
      // `blockConcurrencyWhile(() => this.onStart())` before it resolves, so a
      // throw from our `onStart` (its `markBuildBuildingIfStarting` is a
      // Hyperdrive/Postgres write that can throw transiently) rejects start()
      // AFTER the container is already live. If the marker only flipped on the
      // line after a resolved start(), that onStart-reject would be treated as a
      // pre-launch failure and the catch would skip teardown, leaving the
      // container running the real `void deploy` CLI with a live token while
      // Postgres records the build `failed` — pinning a global fleet slot until
      // the idle net. A genuine pre-launch throw still can't stop a non-existent
      // container: the capacity error originates in `startContainerIfNotRunning`
      // BEFORE any launch and the catch re-throws it before the stop block, and
      // token-mint throws happen above this line with the marker still false.
      containerStarted = true;
      launch.containerStartPending = true;
      try {
        await this.start(undefined, {
          signal: launch.controller.signal,
          portToCheck: this.defaultPort,
        });
      } finally {
        launch.containerStartPending = false;
      }

      // The base launches before awaiting onStart. A cancellation can therefore
      // stop the container while start() is still resolving, or onStart can reject
      // its starting->building claim after a terminal write. Do not arm a timeout
      // for either abandoned generation, and ensure a producer that appeared after
      // the canceller's early no-container teardown is gone.
      if (!this.launchIsCurrent(launch)) {
        await this.forceStopContainer(
          'build cancelled during startup',
          this.claimTerminationMarker(),
          false,
        );
        await this.pokeScheduler();
        return;
      }

      // Wall-clock timeout. Use the base Container's public scheduler instead of
      // writing the DO alarm directly: a DO has a SINGLE alarm and the base
      // Container OWNS it to drive its monitor loop (polling container state and
      // dispatching onStop on exit). Overwriting that alarm with our own wake
      // time would starve the base loop, so onStop might never fire and a
      // healthy build could never finalize. `schedule()` stores a row the base
      // alarm loop invokes when due, calling our `enforceTimeout` callback
      // without disturbing the base cadence.
      //
      // A timeout is ALWAYS armed, even for a custom "unlimited" plan
      // (`timeoutMinutes: 0`): the base `sleepAfter` idle-stop never fires for a
      // busy container, so without this an orphaned build could run far past any
      // sane ceiling. 0 falls back to the hard max; a positive plan timeout is
      // capped at it.
      //
      // Armed at budget + LOG_DRAIN_GRACE_SECONDS: the plan budget bounds build
      // EXECUTION, and the agent's exit-time drain barrier runs after that with the
      // container still `running` and the status still `deploying`. Without the grace
      // a build that finishes in the final seconds of its budget has its SUCCESSFUL,
      // already-live deploy overwritten with 'build timed out'. Still mirrors
      // `deployTokenTtlSecondsForBuildMinutes` with room to spare (the token carries a
      // 5-minute margin), so the build can never outlive its deploy token.
      const effectiveTimeout =
        config.timeoutMinutes > 0
          ? Math.min(config.timeoutMinutes, DEPLOY_TOKEN_HARD_MAX_MINUTES)
          : DEPLOY_TOKEN_HARD_MAX_MINUTES;
      await this.schedule(effectiveTimeout * 60 + LOG_DRAIN_GRACE_SECONDS, 'enforceTimeout');
    } catch (error) {
      // Cancellation is an authoritative terminal path handled by cancelBuild,
      // not a startup failure. The base start() may reject its abort signal only
      // after launching, so teardown remains mandatory when launch was attempted.
      // Identity fencing prevents a stale continuation from stopping a later
      // generation in the same Durable Object.
      if (!this.launchIsCurrent(launch)) {
        if (containerStarted && this.activeLaunch === launch) {
          await this.forceStopContainer(
            'build cancelled during startup',
            this.claimTerminationMarker(),
            false,
          );
        }
        await this.pokeScheduler();
        return;
      }
      if (isContainerCapacityError(error)) {
        // Capacity-to-start (fleet full), not a build failure. Nothing was started
        // (containerStarted is false here), so there's nothing to stop. Leave the row
        // as the scheduler claimed it and re-throw so the scheduler catch requeues it.
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      // Mirror enforceTimeout / cancelBuild: set the LOCAL terminal status FIRST
      // (DO storage — can't fail on Hyperdrive) so the onStop that the teardown
      // below triggers sees the terminal status and won't clobber it, THEN tear
      // the container down. If the container already launched, a throw here (the
      // onStart-reject inside start(), or schedule arming) must force it down
      // before we finalize as failed — otherwise it keeps running the real
      // `void deploy` CLI with a live token while Postgres says `failed`, pinning
      // a fleet slot until the idle net. `forceStopContainer` SIGTERMs THEN
      // SIGKILLs (idempotent / TERMINAL-safe) so a SIGTERM-ignoring build agent
      // can't outlive the failure; `stop()` alone is SIGTERM-only. Best-effort so
      // a teardown failure doesn't mask the original error.
      const ownsMarker = this.claimTerminationMarker();
      await this.setStatus('failed');
      // CAS terminal-if-active (NOT an unconditional write): a concurrent cancel
      // (terminateBuildsForProject commits 'cancelled' out-of-band, then the
      // cancelBuild RPC) can have already driven this row terminal. An
      // unconditional updateBuildStatus('failed') would clobber that 'cancelled'
      // to 'failed'; the CAS no-ops on an already-terminal row (the slot is
      // already freed).
      //
      // Runs BEFORE the teardown, like enforceTimeout/cancelBuild: `builds.status`
      // is the deploy token's authority, and `forceStopContainer` drains logs
      // for up to 2x LOG_DRAIN_BUDGET_MS before it signals (it joins an in-flight
      // drain, then takes its own). While the row is still
      // `starting`/`building` a runner already at final publish passes both
      // `middleware/auth.ts` and the go-live transaction's re-check and ships,
      // even though this manager has already decided startup failed. The write is
      // captured rather than awaited inline so it still cannot GATE the teardown —
      // rethrown below only after forceStopContainer and pokeScheduler, or a
      // Hyperdrive blip would leave the container running the real `void deploy`
      // CLI with a live token while Postgres says `failed`, pinning a fleet slot
      // until the idle net. `revokeBuildRow`, not the bare helper: a write that
      // PENDS never reaches the catch at all, and putting Postgres in front of the
      // kill is what made that fatal (TERMINAL_WRITE_TIMEOUT_MS).
      let terminal: { won: boolean } | null = null;
      let terminalError: unknown;
      try {
        terminal = {
          won: await this.revokeBuildRow(config.buildId, 'failed', {
            error: message,
            completedAt: new Date().toISOString(),
          }),
        };
      } catch (err) {
        terminalError = err;
      }
      // If the container already launched, a throw here (the onStart-reject inside
      // start(), or schedule arming) must force it down. `forceStopContainer`
      // SIGTERMs THEN SIGKILLs (idempotent / TERMINAL-safe) so a SIGTERM-ignoring
      // build agent can't outlive the failure; `stop()` alone is SIGTERM-only.
      // Best-effort so a teardown failure doesn't mask the original error.
      //
      // The broadcast + check-run finalize run inside a try whose `finally` ALWAYS
      // pokes the scheduler — mirroring onStop/onError/enforceTimeout — so a
      // transient throw can't skip the queue re-arm and strand the slot until the
      // stale reaper.
      try {
        if (containerStarted) {
          // `ownsMarker` from the transition above — NOT a second claim. The claim is
          // first-caller-wins, so re-calling it here always returns false and would
          // suppress the very marker this site reserved.
          await this.forceStopContainer(
            // Same rule as enforceTimeout/cancelBuild: unless this site WON the
            // CAS, another outcome may already be authoritative, so this site's
            // local reason is not safe to assert. It reads worse here, because
            // the marker is the ONLY explanation emitted — this catch claims the
            // marker synchronously, before any await, so an external cancel
            // arriving after it finds the claim taken and stays silent. The check
            // run below finalizes from the RECORDED outcome; asserting the local
            // reason could put a "cancelled" check over a log tail that says the
            // build failed to start.
            terminal?.won === true ? `build failed: ${message}` : 'build terminated out of band',
            ownsMarker,
            terminalError === undefined,
          );
        } else {
          await this.markLogDrainComplete();
        }
        // Skipped when the terminal write threw (`terminal` null): we don't know the
        // recorded outcome, so finalizing the check run would be a guess. NOT an
        // early `return` — that would run the `finally` and then skip the rethrow
        // below, swallowing the error the callers assert on.
        if (terminal) {
          const won = terminal.won;
          await this.broadcast({ type: 'status', status: 'failed' });
          // Finalize the check-run here too: the run is created BEFORE signDeployToken /
          // this.start() / the staging-misconfig check, so a throw in that window marks
          // the build `failed` HERE and no onStop ever finalizes it (force-stop →
          // onStop's terminal-status guard no-op). Without this the run is stranded
          // `in_progress` forever. The capacity-error branch re-throws above and never
          // reaches here, so the requeued build correctly keeps its run `in_progress`.
          // CAS-aware: only PATCH 'failure' when THIS site won the terminal transition.
          // On a lost CAS (the row was terminalized out-of-band, e.g. a concurrent
          // cancel) read the authoritative row and finalize to ITS outcome, so GitHub
          // never contradicts the DB.
          if (won) {
            await this.finalizeCheckRun(config, 'failure', {
              detailsUrl: this.projectUrl(config),
              title: 'Void build failed',
              summary: message,
            });
          } else {
            await this.finalizeCheckRunToRecordedOutcome(config);
          }
        } else if (terminalError !== undefined) {
          // A terminal write that MISSED ITS DEADLINE may still commit afterwards, and
          // the rejection left `terminal` null so nothing above finalizes. Reconcile
          // once now — which catches a commit that beat this line — and let the
          // reconciler re-arm itself for one that lands after it. Nothing else ever
          // completes this check run; see `reconcileTerminalWrite`.
          await this.reconcileTerminalWrite();
        }
      } finally {
        await this.pokeScheduler();
      }
      if (terminalError) {
        throw terminalError;
      }
      throw error;
    } finally {
      if (this.activeLaunch === launch) {
        this.activeLaunch = null;
      }
    }
  }

  /**
   * The project's public traffic URL — used as the check-run `details_url`. Staging
   * and production serve user traffic on different base domains (`staging.void.app`
   * vs `void.app`), so the link must be env-aware: read the per-environment
   * `SITE_DOMAIN` binding (the same source the deploy-URL output uses), falling back
   * to the production constant when unset.
   */
  private projectUrl(config: BuildConfig): string {
    return `https://${config.projectSlug}.${this.env.SITE_DOMAIN ?? SITE_DOMAIN}`;
  }

  /**
   * Finalize this build's GitHub Check Run with a terminal conclusion. BEST-EFFORT:
   * resolves the run id from, in order, an explicit in-hand id → the in-memory
   * `activeCheckRunId` → input-gated DO storage → the persisted `builds.check_run_id`,
   * so a DO-storage miss (eviction, a rejected cache put, a transient loss) OR a dual
   * persist failure cannot strand an already-created run `in_progress`. No-ops when no
   * source has an id (no run was created, or create failed), and never throws so the
   * caller's `finally { pokeScheduler() }` always runs. `completeCheckRun` already
   * swallows internally; the extra try/catch is belt-and-suspenders.
   */
  private async finalizeCheckRun(
    config: BuildConfig,
    conclusion: CheckRunConclusion,
    opts: { detailsUrl?: string; title: string; summary: string },
    explicitId?: string | null,
  ): Promise<void> {
    if (this.activeLaunch?.containerStartPending && this.deferredLaunchTermination !== null) {
      // Startup still owns a possible late producer. Its continuation publishes
      // the reserved marker and reconciles the recorded outcome after teardown;
      // also arm recovery in case this invocation is lost before it gets there.
      try {
        await this.schedule(RECONCILE_RETRY_SECONDS, 'reconcileTerminalWrite');
      } catch (err) {
        console.warn('finalizeCheckRun: scheduling startup finalization failed', err);
      }
      return;
    }
    // Prefer the in-hand id, then the in-memory field (survives create→terminal within
    // the build's lifetime), then the durable sources. The first two are authoritative
    // even when BOTH the DO-storage put and the Postgres persist failed.
    let checkRunId =
      explicitId ??
      this.activeCheckRunId ??
      (await this.ctx.storage.get<string>(STORAGE_KEY_CHECK_RUN));
    if (!checkRunId && explicitId === undefined) {
      // DO storage missed — recover the id from Postgres (written by
      // `setBuildCheckRunId` at create). Best-effort: a read failure leaves the id
      // unknown and the run unfinalized (cosmetic), never throwing out of finalize.
      // An explicit null means the caller already holds an authoritative row whose
      // check_run_id is absent: still honor an in-memory/storage id above (the DB
      // persist may have failed), but never issue a redundant row read.
      try {
        checkRunId = (await getBuild(this.db(), config.buildId))?.check_run_id ?? undefined;
      } catch (err) {
        console.warn('finalizeCheckRun: builds.check_run_id fallback read failed', err);
      }
    }
    if (!checkRunId) {
      return;
    }
    // Embed the stored log tail as the run's `output.text` — BEST-EFFORT: a
    // SQLite read failure must not block the completion PATCH (the run
    // completes without `text`).
    let text: string | undefined;
    try {
      text = (await this.readLogTailMarkdown()) ?? undefined;
    } catch (err) {
      console.warn('finalizeCheckRun: log tail read failed (best-effort)', err);
    }
    try {
      await completeCheckRun(this.env, config.installationId, config.repoFullName, checkRunId, {
        conclusion,
        ...opts,
        ...(text ? { text } : {}),
      });
    } catch (err) {
      console.warn('finalizeCheckRun: best-effort PATCH failed', err);
    }
  }

  /**
   * Finalize the check-run to the AUTHORITATIVE build status — used on the rare
   * lost-CAS path (the row was terminalized out-of-band, e.g. an admin/disconnect
   * cancel) and the post-create cancellation recheck. Maps the DB's terminal
   * status to its check-run conclusion so GitHub always matches the recorded
   * outcome instead of this site's assumed one. No-ops (returns) for a non-terminal
   * status; delegates to `finalizeCheckRun`, which itself no-ops on an absent id
   * and never throws.
   */
  private async finalizeCheckRunToStatus(
    config: BuildConfig,
    status: string,
    explicitId?: string | null,
  ): Promise<void> {
    const conclusion =
      status === 'complete'
        ? 'success'
        : status === 'cancelled'
          ? 'cancelled'
          : status === 'failed'
            ? 'failure'
            : null;
    if (!conclusion) {
      return;
    }
    await this.finalizeCheckRun(
      config,
      conclusion as CheckRunConclusion,
      {
        detailsUrl: this.projectUrl(config),
        title: `Void build ${conclusion === 'success' ? 'succeeded' : conclusion}`,
        summary: `Build ${status}.`,
      },
      explicitId,
    );
  }

  /**
   * Lost-CAS finalize: read the AUTHORITATIVE build status and finalize the check-run
   * to it. Used at every terminal site when `markBuildTerminalIfActive` lost (the row
   * was terminalized out-of-band). BEST-EFFORT — the `getBuild` is wrapped so a
   * transient read failure logs and returns instead of throwing out of the terminal
   * handler (which would skip the PATCH AND propagate); the slot is freed regardless
   * by the caller's `finally { pokeScheduler() }`.
   */
  private async finalizeCheckRunToRecordedOutcome(config: BuildConfig): Promise<void> {
    let row: Awaited<ReturnType<typeof getBuild>>;
    try {
      row = await getBuild(this.db(), config.buildId);
    } catch (err) {
      console.warn('finalizeCheckRunToRecordedOutcome: getBuild failed (best-effort)', err);
      return;
    }
    if (row) {
      await this.finalizeCheckRunToStatus(config, row.status, row.check_run_id);
    }
  }

  /**
   * Complete the check run from the AUTHORITATIVE row after a terminal write missed
   * its deadline — now, and again later if the answer isn't in yet.
   *
   * `withDeadline` rejects the WAIT, not the query: `markBuildTerminalIfActive` keeps
   * running and commonly commits afterwards. Re-reading once at the teardown site only
   * helps when that commit beat the read. When it lands after, the row turns terminal
   * with nobody left to notice it — the DO-local status is already terminal, so
   * `enforceTimeout`/`cancelBuild` retries and `onStop` early-out; the stale reaper
   * scans ACTIVE rows only; and the container executor has no webhook completer
   * (`routes/webhooks.ts` completes `github_actions` builds precisely BECAUSE they
   * have no DO). The check run then sits `in_progress` forever, which under branch
   * protection is a PR that can never merge.
   *
   * Public + named so the base scheduler can resolve it as a callback.
   *
   * The re-arm terminates in BOTH directions, which is what makes an unbounded-looking
   * loop safe:
   *   - the write commits late  -> row terminal -> finalize, no re-arm
   *   - the write genuinely died -> row stays ACTIVE -> the hourly stale reaper marks
   *     it `failed` (STALE_CONTAINER_BUILD_MAX_AGE_MINUTES) -> the next pass finalizes
   * The reaper terminalizes the ROW but never completes a CHECK RUN — it calls
   * `cancelBuild`, which early-outs on the terminal status — so this pass is that
   * check run's only completer.
   */
  async reconcileTerminalWrite(): Promise<void> {
    const config = await this.getConfig();
    if (!config) {
      return; // build state gone (deleted) — nothing left to report against
    }
    let row: Awaited<ReturnType<typeof getBuild>>;
    try {
      // BOUNDED, for the same reason the write it is chasing is bounded: this
      // runs precisely when Hyperdrive/Postgres is already stalling, and an
      // unbounded SELECT that PENDS never reaches either `schedule()` below. The
      // invocation would then be killed with no retry armed, which is the exact
      // permanent orphan this method exists to prevent — reintroduced one layer up.
      row = await withDeadline(
        getBuild(this.db(), config.buildId),
        TERMINAL_WRITE_TIMEOUT_MS,
        `build ${config.buildId}: reconciliation read did not settle within ${TERMINAL_WRITE_TIMEOUT_MS}ms`,
      );
    } catch (err) {
      // A failed or timed-out read says nothing about the write. Not yet known.
      console.warn('reconcileTerminalWrite: getBuild failed (best-effort)', err);
      await this.schedule(RECONCILE_RETRY_SECONDS, 'reconcileTerminalWrite');
      return;
    }
    if (row === null) {
      // `getBuild` returns null (never undefined) for a missing row.
      // The row is GONE, not pending — `deleteProjectCascade` deletes build rows
      // during project teardown. Re-arming here would poll a row that can never
      // come back and can never be terminalized by the reaper, i.e. an alarm every
      // RECONCILE_RETRY_SECONDS forever. Nothing is left to report against.
      return;
    }
    if (TERMINAL_STATUSES.includes(row.status)) {
      // Reuse BOTH authoritative fields from the bounded read. Omitting the id
      // makes finalizeCheckRun issue a second, unbounded getBuild after an eviction
      // or cache miss — exactly where a stalled Hyperdrive read would orphan the
      // check with no retry armed. Explicit null suppresses that redundant read.
      await this.finalizeCheckRunToStatus(config, row.status, row.check_run_id);
      return;
    }
    await this.schedule(RECONCILE_RETRY_SECONDS, 'reconcileTerminalWrite');
  }

  override async onStart(): Promise<void> {
    const config = await this.getConfig();
    if (!config) {
      return;
    }
    const launchAtEntry = this.activeLaunch;
    if (launchAtEntry && !this.launchIsCurrent(launchAtEntry)) {
      // The base callback is post-launch. If cancellation invalidated this
      // generation while start() was waiting, do not even attempt the
      // starting->building CAS: a failed cancellation write could otherwise be
      // followed by this stale callback restoring active token authority.
      await this.forceStopContainer(
        'build cancelled during startup',
        this.claimTerminationMarker(),
        false,
      );
      await this.pokeScheduler();
      return;
    }
    // CAS `starting -> building` and land the `instance_type` (its only persist
    // point — the scheduler's claim set `starting` without it). The base
    // `start()` runs onStart inside `blockConcurrencyWhile` before resolving, so
    // a fast-exit `onStop` can have already driven the row terminal; this guard
    // is the authoritative protection against resurrecting it. Only sync the
    // in-memory status (used by the other lifecycle guards) when the CAS won, so
    // a no-op onStart can't downgrade an already-terminal in-memory status.
    // A callback after startBuild settled (or after eviction) can describe an
    // already-active producer, but only the current startBuild attempt may claim
    // a row that is still starting.
    const moved =
      launchAtEntry !== null &&
      (await withDeadline(
        markBuildBuildingIfStarting(this.db(), config.buildId, {
          instanceType: config.instanceType,
        }),
        TERMINAL_WRITE_TIMEOUT_MS,
        `build ${config.buildId}: startup claim did not settle within ${TERMINAL_WRITE_TIMEOUT_MS}ms`,
      ));
    if (!moved) {
      // The container is already live when the base class invokes onStart. A
      // missed claim therefore cannot be a passive return: an out-of-band cancel
      // may have terminalized the row while token/source preparation or start()
      // was awaiting, and leaving this producer alive pins fleet capacity and
      // lets it keep attempting deployment until the long idle timeout.
      //
      // Read the winner before deciding. `building`/`deploying` can be a
      // legitimate duplicate/late lifecycle callback for the current generation;
      // never kill that producer. Terminal, missing, queued, or otherwise
      // unclaimed rows cannot authorize this launch and are torn down. A read
      // failure throws into startBuild's startup catch, which revokes first and
      // still performs the same teardown.
      const row = await withDeadline(
        getBuild(this.db(), config.buildId),
        TERMINAL_WRITE_TIMEOUT_MS,
        `build ${config.buildId}: startup recovery read did not settle within ${TERMINAL_WRITE_TIMEOUT_MS}ms`,
      );
      const currentConfig = await this.getConfig();
      if (
        row &&
        (row.status === 'building' || row.status === 'deploying') &&
        currentConfig &&
        !TERMINAL_STATUSES.includes(currentConfig.status) &&
        (launchAtEntry === null || this.launchIsCurrent(launchAtEntry))
      ) {
        await this.setStatus(row.status);
        await this.schedule(1, 'pollLogs');
        return;
      }
      this.abortActiveLaunch();
      if (row && TERMINAL_STATUSES.includes(row.status)) {
        await this.setStatus(row.status);
      }
      await this.forceStopContainer(
        'build lost its startup claim',
        this.claimTerminationMarker(),
        row === null || TERMINAL_STATUSES.includes(row.status),
      );
      if (row && TERMINAL_STATUSES.includes(row.status)) {
        await this.finalizeCheckRunToStatus(config, row.status, row.check_run_id);
      }
      await this.pokeScheduler();
      return;
    }
    if (launchAtEntry === null || !this.launchIsCurrent(launchAtEntry)) {
      // Cancellation can interleave while the CAS itself is awaiting Postgres.
      // Even if this invocation briefly won `starting -> building`, the cancel
      // path owns the terminal outcome; do not overwrite its local status or arm
      // producers. Kill immediately while its authoritative DB write proceeds.
      await this.forceStopContainer(
        'build cancelled during startup',
        this.claimTerminationMarker(),
        false,
      );
      await this.pokeScheduler();
      return;
    }
    await this.setStatus('building');
    await this.broadcast({ type: 'status', status: 'building' });
    // Start the DO→container log pull-loop once the container is live and the row
    // is `building`. First tick fires soon (1s); `pollLogs` re-arms itself on the
    // POLL_SECONDS cadence and self-terminates when the build goes terminal. Armed
    // via the SAME base scheduler as `enforceTimeout` (never a raw setAlarm — the
    // base Container owns the single DO alarm for its monitor loop + onStop).
    await this.schedule(1, 'pollLogs');
  }

  override async onStop(params: {
    exitCode: number;
    reason: 'exit' | 'runtime_signal';
  }): Promise<void> {
    const config = await this.getConfig();
    if (!config) {
      return;
    }

    const current = config.status;
    if (TERMINAL_STATUSES.includes(current)) {
      // Already finalized (e.g. timeout alarm fired and stopped the container).
      // A natural stop after onError is a producer barrier. A forced teardown's
      // marker owner must publish completion instead, after its marker attempt.
      await this.completeNaturalLogDrain();
      await this.pokeScheduler();
      return;
    }

    const db = this.db();
    const completedAt = new Date().toISOString();
    // Mirror enforceTimeout / cancelBuild: set the LOCAL terminal status FIRST
    // (DO storage — can't fail on Hyperdrive), then run the Postgres terminal
    // write + broadcast inside a try whose `finally` ALWAYS pokes the scheduler.
    // `markBuildTerminalIfActive` has no internal try/catch, so a transient
    // Postgres throw here must NOT skip pokeScheduler() — otherwise the row would
    // stay ACTIVE and pin the concurrency slot until the 75m idle reaper even
    // though the container has already exited (and, on exit 0, the deploy is
    // live). The container already exited, so there is no stop() to make.
    if (params.exitCode === 0) {
      await this.setStatus('complete');
      await this.completeNaturalLogDrain();
      try {
        // The deployment link is BEST-EFFORT and must run inside this try. The
        // lookup is a Hyperdrive/Postgres read that can throw on a transient
        // error AFTER `void deploy` already exited 0; if it threw outside the
        // try, `onStop` would reject before `setStatus` and the
        // `finally`, leaving the build row ACTIVE with no scheduler poke — the
        // deploy live but the concurrency slot pinned until the 75m idle reaper.
        // Swallow the lookup error and finalize 'complete' with a null link
        // instead; the row is still terminalized and the slot freed.
        let deploymentId: string | null = null;
        try {
          const deployment = await getDeploymentByProjectAndCommit(
            db,
            config.projectId,
            config.commitSha,
          );
          deploymentId = deployment?.id ?? null;
        } catch (err) {
          console.error('onStop: deployment lookup failed; finalizing without link', err);
        }
        // CAS terminal-if-active: the in-memory guard above is defense in depth;
        // this is the authoritative check against clobbering an outcome a
        // concurrent terminal write (e.g. the timeout) already recorded in the DB.
        const won = await markBuildTerminalIfActive(db, config.buildId, 'complete', {
          exitCode: 0,
          completedAt,
          deploymentId,
        });
        await this.broadcast({ type: 'status', status: 'complete' });
        // CAS-aware finalize: only PATCH 'success' when THIS exit-0 won the terminal
        // transition. On a lost CAS (the row was terminalized out-of-band first, e.g.
        // an admin cancel committed 'cancelled') finalizing 'success' would contradict
        // the DB. Read the authoritative row and finalize to ITS recorded outcome so
        // GitHub matches the DB. `details_url` comes from `projectSlug` (already in
        // hand) so a deployment lookup miss does NOT cost the link.
        if (won) {
          await this.finalizeCheckRun(config, 'success', {
            detailsUrl: this.projectUrl(config),
            title: 'Void build succeeded',
            summary: deploymentId ? 'Deployment is live.' : 'Build complete.',
          });
        } else {
          await this.finalizeCheckRunToRecordedOutcome(config);
        }
      } finally {
        await this.pokeScheduler();
      }
    } else {
      await this.setStatus('failed');
      await this.completeNaturalLogDrain();
      try {
        const won = await markBuildTerminalIfActive(db, config.buildId, 'failed', {
          error: `build exited with code ${params.exitCode} (${params.reason})`,
          exitCode: params.exitCode,
          completedAt,
        });
        await this.broadcast({ type: 'status', status: 'failed' });
        // CAS-aware: finalize 'failure' only when THIS site won; otherwise finalize to
        // the out-of-band recorded outcome so GitHub matches the DB.
        if (won) {
          // `reason` is carried too, not just the code. It is the ONE bit that
          // separates "the agent decided to exit" (`exit`) from "the runtime killed
          // the container" (`runtime_signal`), and the two need completely different
          // investigations, and the check run is the only surface most people see.
          await this.finalizeCheckRun(config, 'failure', {
            detailsUrl: this.projectUrl(config),
            title: 'Void build failed',
            summary: `Build exited with code ${params.exitCode} (${params.reason}).`,
          });
        } else {
          await this.finalizeCheckRunToRecordedOutcome(config);
        }
      } finally {
        await this.pokeScheduler();
      }
    }
  }

  override async onError(error: unknown): Promise<void> {
    const config = await this.getConfig();
    if (!config) {
      return;
    }
    if (TERMINAL_STATUSES.includes(config.status)) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    // Mirror onStop / enforceTimeout / cancelBuild: set the LOCAL terminal status
    // FIRST (DO storage — can't fail on Hyperdrive), then run the Postgres terminal
    // write + broadcast inside a try whose `finally` ALWAYS pokes the scheduler.
    // `markBuildTerminalIfActive` has no internal try/catch, so a transient
    // Postgres throw here must NOT skip pokeScheduler() — otherwise the row stays
    // ACTIVE and pins the concurrency slot until the 75m idle reaper even though
    // the container has already errored.
    await this.setStatus('failed');
    let won: boolean | null = null;
    let terminalError: unknown;
    try {
      try {
        won = await markBuildTerminalIfActive(this.db(), config.buildId, 'failed', {
          error: message,
          completedAt: new Date().toISOString(),
        });
      } catch (err) {
        terminalError = err;
      }
      // Drain BEFORE finalizing, because `finalizeCheckRun` embeds the last
      // CHECK_RUN_LOG_TAIL_LINES rows and this is the ONE terminalizer that does not
      // force-stop — so nothing else has pulled. `pollLogs`' terminal branch does
      // pull, but up to POLL_SECONDS later, i.e. after the check run is already
      // completed: its tail then reaches `void build logs` and the live tail while
      // being permanently absent from the check run a reader actually opens.
      // Deliberately no stop() here — an errored container is left to the base class,
      // and adding a kill would change onError's contract.
      await this.drainLogsAfterError();
      if (won !== null) {
        await this.broadcast({ type: 'status', status: 'failed' });
        // CAS-aware: finalize 'failure' only when THIS site won; otherwise finalize to
        // the out-of-band recorded outcome so GitHub matches the DB.
        if (won) {
          await this.finalizeCheckRun(config, 'failure', {
            detailsUrl: this.projectUrl(config),
            title: 'Void build failed',
            summary: message,
          });
        } else {
          await this.finalizeCheckRunToRecordedOutcome(config);
        }
      }
    } finally {
      await this.pokeScheduler();
    }
    if (terminalError) {
      throw terminalError;
    }
  }

  /**
   * Drain the live agent before `onError` snapshots the check-run tail. A terminal
   * status stops the normal poll loop, so a one-shot transient port failure would
   * otherwise strand the final diagnostics even though the agent is deliberately
   * waiting for our cursor acknowledgement. Retry within that bounded idle window.
   *
   * `pullLogsOnce` can also return false because it spent MAX_LOG_SINK_OPS_PER_DRAIN
   * on a deep backlog, and this loop retries that case too — which is what replaces
   * the next scheduled callback the poll loop no longer has. The iteration count
   * stays bounded even though a Worker clock does not advance during CPU work: each
   * retry sleeps a real POLL_SECONDS, and time does advance across that.
   */
  private async drainLogsAfterError(): Promise<void> {
    const deadline = Date.now() + LOG_TERMINAL_DRAIN_RETRY_WINDOW_MS;

    // A snapshot already in flight may have frozen before the error line was
    // recorded. Join it for single-flight ordering, then still take a fresh pull.
    await this.pullInFlight?.catch(() => false);

    while (Date.now() < deadline) {
      const activeTeardown = this.teardownInFlight;
      if (activeTeardown) {
        // A cancel/startup-failure teardown owns the final snapshot once it has
        // installed this gate. Join its drain/signals so onError neither starts a
        // late pull nor finalizes before the teardown-owned snapshot completes.
        await activeTeardown.catch(() => {});
        return;
      }

      const container = this.rawContainer();
      if (!container?.running) {
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return;
      }
      const drained = await this.pullLogsOnce(container, remaining);

      // A teardown can begin while the pull is awaiting I/O. It joins that stale
      // snapshot and then owns a fresh one plus the signals; join it even when our
      // pull succeeded so check finalization cannot outrun its final tail.
      const teardownAfterPull = this.teardownInFlight;
      if (teardownAfterPull) {
        await teardownAfterPull.catch(() => {});
        return;
      }

      if (drained) {
        return;
      }
      const retryRemaining = deadline - Date.now();
      if (retryRemaining <= 0) {
        return;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(POLL_SECONDS * 1000, retryRemaining)),
      );
    }
  }

  /**
   * Force the container down on a timeout/cancel path. `stop()` only sends a
   * SIGTERM — which the agent (PID 1) handles cooperatively — but a wedged or
   * adversarial child (e.g. a `postinstall` that blocks uninterruptibly or
   * ignores SIGTERM) can survive it, and `@cloudflare/containers` never escalates
   * to SIGKILL on its own. So follow the best-effort SIGTERM with `destroy()`
   * (SIGKILL), which a PID-1 process cannot mask. Without the escalation a hung
   * build keeps running and permanently pins one of the fleet's global
   * `max_instances` slots — capacity starvation across every tenant, since the
   * STALE reaper only re-cancels rows still ACTIVE (this row is already terminal).
   *
   * Both calls are best-effort + idempotent: the build is already recorded
   * terminal locally, so neither a no-op stop()/destroy() on an already-exited
   * container nor a transient teardown error must propagate past here. `destroy()`
   * triggers onStop, whose TERMINAL_STATUSES guard makes it a safe no-op (it only
   * pokes the scheduler).
   *
   * DRAIN FIRST. The agent's exit-time `waitForLogDrain()` barrier does NOT cover
   * this path: `stop()`'s SIGTERM lands in `onShutdownSignal`, which ends in
   * `process.exit(1)` (container/build-agent.mjs) — so `main()`'s `finally`, and
   * with it the barrier, never runs. Everything the agent buffered since the last
   * poll would die with the container: `pollLogs` re-arms on a 1s floor-to-the-
   * second schedule, so the next tick lands 0–1s later, by which point `destroy()`
   * has resolved and its `container.running` guard early-outs without fetching.
   * One synchronous pull here, in front of the signals, is what keeps a cancelled
   * or timed-out build from losing up to a full second of its tail — the pull
   * happens-before the kill, so it captures everything the agent had recorded up
   * to that instant.
   *
   * What it CANNOT capture, by construction, is anything the agent writes AFTER
   * the pull returns — including the agent's own
   * `[build-agent] received SIGTERM; cancelling build and shutting down` line,
   * which `onShutdownSignal` only generates once our SIGTERM arrives, and which
   * `process.exit(1)` then takes to the grave. Chasing it is impossible: any pull
   * that could see it would have to run after the signal, i.e. against a process
   * already exiting. So the DO writes its own terminated marker after at least
   * one control signal succeeds — same information (why the output stops), no
   * agent dependency, and no false claim when both control calls reject. The
   * rest of the residue is the handful of milliseconds between this pull
   * resolving and `stop()`'s signal landing, which is inherent to an
   * asynchronous kill.
   *
   * Best-effort: `pullLogsOnce` never throws and each paginated callback is bounded
   * by `LOG_DRAIN_BUDGET_MS`. Teardown may wait out one in-flight callback then
   * take one fresh snapshot, so a wedged/productive-slow agent delays the SIGKILL
   * by at most 2x that budget. The whole sequence is single-flight per teardown,
   * not per caller.
   *
   * `reason` is recorded verbatim in the marker, so each teardown site passes its
   * own: a startup failure is not a cancellation and must not claim to be one.
   */
  private async forceStopContainer(
    reason: string,
    markerAuthoritative = true,
    drainFirst = true,
  ): Promise<void> {
    const container = this.rawContainer();
    // The single-flight owns the WHOLE first-caller policy: scheduled-pull join,
    // fresh drain, liveness recheck, and signals. Consulting it only after the
    // drain would let a second cancellation enter while the first was blocked in
    // stop()/destroy(), start a late pull, and ingest after the first caller's
    // final marker/check-run completion. It also matters that `drainFirst=false`
    // wins when it is first: a later peer must not reopen a pull while the token
    // revocation is still unsettled.
    let teardown = this.teardownInFlight;
    if (!teardown) {
      teardown = (async () => {
        // JOINING an in-flight pull is NOT a drain and is always safe: the
        // request has already reached the agent, while its response may still be
        // parsing or ingesting into SQLite. Teardown must wait for that sink work
        // before it can signal the container and append the final marker. A
        // failed/timed-out terminal write sets `drainFirst=false` only to forbid
        // a NEW request while revocation is unsettled; it must not let an existing
        // pull write rows after finalization. `.catch` is belt-and-braces: a pull
        // failure must never skip the signals and strand a pinned slot.
        const activePull = this.pullInFlight;
        await activePull?.catch(() => {});
        if (container?.running === true && drainFirst) {
          // The agent snapshots each response at receipt, so after the old cursor
          // advances take one fresh snapshot for lines written in the meantime.
          await this.pullLogsOnce(container);
        }
        // The drain can last several seconds, during which the build may exit
        // naturally and finish its own acknowledgement barrier. Successful
        // stop()/destroy() no-ops against an already-dead container are not
        // evidence that this manager terminated it.
        if (this.rawContainer()?.running !== true) {
          return true;
        }
        let signalSucceeded = false;
        let destroySucceeded = false;
        try {
          await this.stop();
          signalSucceeded = true;
        } catch {
          // Best-effort SIGTERM — the build is already recorded terminal locally.
        }
        try {
          await this.destroy();
          signalSucceeded = true;
          destroySucceeded = true;
        } catch {
          // Best-effort SIGKILL — container already gone / mid-teardown.
        }
        if (signalSucceeded) {
          this.containerTornDown = true;
        }
        return destroySucceeded || this.rawContainer()?.running !== true;
      })();
      this.teardownInFlight = teardown;
      void teardown.finally(() => {
        if (this.teardownInFlight === teardown) {
          this.teardownInFlight = null;
        }
      });
    }
    const producerStopped = teardown ? await teardown : false;

    if (markerAuthoritative && producerStopped && this.activeLaunch?.containerStartPending) {
      // The base start path awaits storage/network I/O BEFORE launching, and its
      // abort signal only cancels readiness waiting. Seeing no container here is
      // therefore not a producer barrier yet. Transfer the reservation to the
      // startup continuation, which tears down again after start() settles.
      this.deferredLaunchTermination = reason;
      return;
    }
    const resumeFinalization =
      !this.activeLaunch?.containerStartPending && this.deferredLaunchTermination !== null;
    if (resumeFinalization) {
      markerAuthoritative = true;
      reason = this.deferredLaunchTermination!;
      this.deferredLaunchTermination = null;
    }

    // AFTER the drain AND a successful signal so it reads as the truthful last
    // line of the build's output. Ingested through the same sink as pulled lines,
    // so it reaches the live WS tail, `void build logs`, and the check-run tail.
    // Best-effort like everything else on this path: a SQLite/broadcast throw
    // must never affect teardown or strand a pinned fleet slot.
    //
    // Emitted ONLY by the caller that owns the synchronous first-caller-wins
    // marker claim. Teardowns overlap in more ways than one: two cancels (a
    // push-supersede and a project delete), or a startup-failure teardown racing a
    // cancel that finds the row already terminal. All of them can observe
    // `running`, coalesce onto the same drain/signals, and would otherwise ingest
    // their own reason — leaving the reader and check-run tail two contradictory
    // explanations for one termination.
    //
    // Authority is claimed SYNCHRONOUSLY before each site's first await — see
    // `claimTerminationMarker`. It is deliberately independent of terminal CAS
    // ownership because an external caller can commit the row before entering this
    // DO, and `onError` can leave a locally terminal container live and unclaimed.
    //
    // Deliberately OUTSIDE the `running` guard, unlike the drain. A peer teardown
    // that observed the already-terminal local status can drain and `destroy()`
    // while the claiming caller is still awaiting Hyperdrive; that caller then
    // arrives here with `running === false`. Gating the marker on a live container
    // would mean NOBODY ingests one — the peer has no claim and the owner has no
    // container — and the build's log just stops. Ingesting is DO-local
    // (SQLite + broadcast), so it needs no container at all.
    if (markerAuthoritative && producerStopped && this.containerTornDown) {
      try {
        await this.ingestLines([
          {
            line: `[build-manager] container terminated: ${reason}`,
            stream: 'stderr',
            ts: Date.now(),
          },
        ]);
      } catch (err) {
        console.warn('forceStopContainer: terminated marker ingest failed', err);
      }
    }
    if (markerAuthoritative && producerStopped) {
      // This write follows the shared teardown and the authoritative marker
      // attempt. Non-owners can kill the container, but they cannot tell readers
      // the stream is complete while the owner is still waiting to append it.
      await this.markLogDrainComplete();
      if (resumeFinalization) {
        await this.reconcileTerminalWrite().catch((err) => {
          console.warn('forceStopContainer: deferred startup finalization failed', err);
        });
      }
    } else if (markerAuthoritative) {
      // Container control did not prove the producer stopped. Release the claim
      // so a later recovery attempt can own both the marker and completion.
      this.terminationMarkerClaimed = false;
    }
  }

  /**
   * Wall-clock build timeout, invoked by the base Container's alarm loop when
   * the schedule armed in `startBuild` comes due (NOT an `alarm()` override —
   * the base owns the single DO alarm to drive its container monitor + onStop
   * dispatch, so we MUST NOT hijack it). Force-stops the container and fails the
   * build. `stop()` ultimately triggers onStop, which sees the terminal status
   * set here and won't clobber it.
   *
   * Public + named so the base scheduler can resolve it as a callback.
   */
  async enforceTimeout(): Promise<void> {
    this.abortActiveLaunch();
    const config = await this.getConfig();
    if (!config) {
      return;
    }
    if (TERMINAL_STATUSES.includes(config.status)) {
      // Local terminal state is not a producer barrier. Cancellation writes it
      // before awaiting Postgres and before signalling the container, so an
      // interrupted/racing cancellation can leave a live startup producer behind.
      // The timeout is the durable recovery path: revoke the build-bound token
      // first when possible, then tear down regardless of Postgres health.
      if (this.rawContainer()?.running !== true) {
        return;
      }
      const ownsMarker = this.claimTerminationMarker();
      let authorityRevoked = false;
      let terminalError: unknown;
      try {
        if (config.status === 'failed' || config.status === 'cancelled') {
          await this.revokeBuildRow(config.buildId, config.status, {
            error:
              config.status === 'cancelled'
                ? 'build cancelled during startup'
                : 'build failed during startup',
            completedAt: new Date().toISOString(),
          });
          authorityRevoked = true;
        } else {
          const row = await withDeadline(
            getBuild(this.db(), config.buildId),
            TERMINAL_WRITE_TIMEOUT_MS,
            `build ${config.buildId}: terminal recovery read did not settle within ${TERMINAL_WRITE_TIMEOUT_MS}ms`,
          );
          authorityRevoked = row === null || TERMINAL_STATUSES.includes(row.status);
        }
      } catch (err) {
        terminalError = err;
      }
      try {
        await this.forceStopContainer(
          'build terminated before startup completed',
          ownsMarker,
          authorityRevoked,
        );
        // Recovery may be the first completed terminal invocation. Finalize from
        // the recorded winner even when this revocation succeeded or lost its CAS.
        await this.reconcileTerminalWrite();
      } finally {
        await this.pokeScheduler();
      }
      if (terminalError) {
        throw terminalError;
      }
      return;
    }
    // Set the LOCAL terminal status first (DO storage — can't fail on Hyperdrive)
    // so onStop, triggered by the teardown below, sees the terminal status and
    // won't clobber it. Container teardown + the scheduler poke are then made
    // INDEPENDENT of the Postgres terminal write: `markBuildTerminalIfActive` has
    // no internal try/catch, so a Hyperdrive/Postgres throw must NOT skip
    // forceStopContainer() (leaving a timed-out container running with a
    // still-honored deploy token + a pinned fleet slot) or pokeScheduler()
    // (stranding the freed concurrency slot). forceStopContainer SIGTERMs then
    // SIGKILLs so a SIGTERM-ignoring build can't outlive its timeout.
    // Claimed HERE, synchronously, not at the `forceStopContainer` call below: the
    // revocation await between them is long enough for a peer teardown to run to
    // completion, and whoever holds the claim must be decided before yielding.
    const ownsMarker = this.claimTerminationMarker();
    await this.setStatus('failed');
    // The Postgres write comes BEFORE the teardown, because `builds.status` is the
    // deploy token's authority: `middleware/auth.ts` honors a build-bound token for
    // as long as the row is in ACTIVE_BUILD_STATUSES, and `routes/deploy.ts`
    // re-checks the same set inside its go-live transaction. `forceStopContainer`
    // spends up to 2x LOG_DRAIN_BUDGET_MS draining logs before it even signals,
    // and every millisecond of that is a window in which a `void deploy` sitting at
    // its go-live step can still publish — writing routing KV, committing the
    // deployment 'live' — only to be recorded `failed`/'build timed out' immediately
    // after. Revoking first collapses that: the deploy's own re-check then fails and
    // it unwinds instead of going live.
    //
    // The write still must NOT gate the teardown. `markBuildTerminalIfActive` has no
    // internal try/catch, so its throw is captured here and rethrown only after
    // `forceStopContainer` and `pokeScheduler` have run — otherwise a Hyperdrive
    // blip would leave a timed-out container alive with a pinned fleet slot. A throw is only
    // half of it: `revokeBuildRow` bounds the write so one that PENDS lands in that
    // same catch instead of stranding the container (TERMINAL_WRITE_TIMEOUT_MS).
    let terminal: { won: boolean } | null = null;
    let terminalError: unknown;
    try {
      terminal = {
        won: await this.revokeBuildRow(config.buildId, 'failed', {
          error: 'build timed out',
          completedAt: new Date().toISOString(),
        }),
      };
    } catch (err) {
      terminalError = err;
    }
    try {
      // Marker ownership was claimed before this branch's terminal transition.
      // The Postgres CAS can still lose to an out-of-band terminalization
      // (an external cancel committing the row), and that must NOT silence the
      // marker — nobody else emits one on that path. See cancelBuild.
      // Reason, not ownership, defers to the CAS. Ownership must stay independent of
      // it (an external cancel commits the row BEFORE its RPC arrives, so every
      // caller loses and nobody would speak). But a LOST CAS means this build was
      // terminalized elsewhere, and asserting "build timed out" there contradicts the
      // check run, which finalizes from the recorded outcome — and the cancel RPC
      // that follows sees a terminal local status and can no longer correct it. Say
      // only what we know. A timed-out/failed CAS is unknown for the same reason:
      // its uncancelled query can still lose to another terminal writer later.
      await this.forceStopContainer(
        terminal?.won === true ? 'build timed out' : 'build terminated out of band',
        ownsMarker,
        terminalError === undefined,
      );
      // Skipped when the terminal write threw: without it we don't know the recorded
      // outcome, and finalizing the check run on a guess is worse than leaving it to
      // the retry or the reaper.
      if (terminal) {
        await this.broadcast({ type: 'status', status: 'failed' });
        // CAS-aware: finalize 'failure' only when THIS site won; otherwise finalize to
        // the out-of-band recorded outcome so GitHub matches the DB.
        if (terminal.won) {
          await this.finalizeCheckRun(config, 'failure', {
            detailsUrl: this.projectUrl(config),
            title: 'Void build failed',
            summary: 'build timed out',
          });
        } else {
          await this.finalizeCheckRunToRecordedOutcome(config);
        }
      } else if (terminalError !== undefined) {
        // A terminal write that MISSED ITS DEADLINE may still commit afterwards, and
        // the rejection left `terminal` null so nothing above finalizes. Reconcile
        // once now — which catches a commit that beat this line — and let the
        // reconciler re-arm itself for one that lands after it. Nothing else ever
        // completes this check run; see `reconcileTerminalWrite`.
        await this.reconcileTerminalWrite();
      }
    } finally {
      // Free the slot even if the teardown (or broadcast) threw.
      await this.pokeScheduler();
    }
    if (terminalError) {
      throw terminalError;
    }
  }

  /**
   * Internal RPC cancel — invoked by the API (github.ts) when a project is
   * disconnected or its branch/executor changes, orphaning this build. Trusted
   * DO→DO / API→DO path (like startBuild), so NO agent secret is required; the
   * agent-authenticated POST /cancel path stays for the in-container agent.
   *
   * Mirrors enforceTimeout's teardown but with a cancel outcome, using the CAS
   * (`markBuildTerminalIfActive`) so it can't clobber an outcome a concurrent
   * onStop/timeout already recorded. Idempotent: a no-op once the build is
   * already terminal. Best-effort stop() then pokes the scheduler so the freed
   * concurrency slot is reclaimed.
   */
  async cancelBuild(reason = 'build cancelled'): Promise<void> {
    // Invalidate startup synchronously, before the first storage/Postgres await.
    // A token fetch or base start() already in flight will observe the aborted
    // generation and cannot resume into an unconditional container launch.
    this.abortActiveLaunch();
    const config = await this.getConfig();
    const shouldTerminalize = config != null && !TERMINAL_STATUSES.includes(config.status);
    // Claimed HERE, synchronously, not at the `forceStopContainer` call below: the
    // revocation await between them is long enough for a peer teardown to run to
    // completion, and whoever holds the claim must be decided before yielding.
    //
    // UNCONDITIONAL, like enforceTimeout and the startBuild catch. Peer exclusion is
    // the claim flag itself, never `shouldTerminalize`: `onError` is a terminal
    // transition that deliberately does NOT stop the container and never reserves the
    // marker, so a cancel arriving after it would see `shouldTerminalize === false`,
    // skip the claim, and SIGKILL a LIVE container with `markerAuthoritative` false —
    // the log would just stop, which is the exact failure the marker exists to end. A DO
    // evicted between a peer's `setStatus(terminal)` and its `forceStopContainer`
    // reaches the same state with no `onError` involved: durable terminal status, and
    // a restarted instance whose claim flag is back to false.
    //
    // A pending base start can still launch after an early no-container teardown.
    // forceStopContainer defers this reservation until that continuation settles,
    // so its eventual kill can publish the marker and the producer barrier.
    const ownsMarker = this.claimTerminationMarker();
    // Set the LOCAL terminal status first (DO storage — can't fail on Hyperdrive)
    // so onStop, triggered by stop() below, sees the terminal status and won't
    // clobber it. Only when the build isn't already terminal — a late cancel
    // against an already-finalized row must NOT downgrade the recorded outcome.
    if (shouldTerminalize) {
      await this.setStatus('cancelled');
    }
    // Revoke in Postgres BEFORE the teardown, for the same reason as
    // `enforceTimeout`: `builds.status` is the deploy token's authority, and
    // `forceStopContainer` drains logs for up to 2x LOG_DRAIN_BUDGET_MS before it
    // signals — a window in which a superseded `void deploy` at its go-live step
    // would still pass both `middleware/auth.ts` and the go-live transaction's
    // re-check and publish stale code.
    //
    // Container teardown stays UNCONDITIONAL and independent of that write:
    // `markBuildTerminalIfActive` has no internal try/catch, so its throw is captured
    // and rethrown only after forceStopContainer() (else an orphaned container keeps
    // running on a pinned fleet slot) and pokeScheduler() (else the freed slot is
    // stranded). Independence needs a DEADLINE too, not just a catch — hence
    // `revokeBuildRow` (TERMINAL_WRITE_TIMEOUT_MS). forceStopContainer SIGTERMs then SIGKILLs (idempotent) so a
    // SIGTERM-ignoring orphan can't survive the cancel.
    //
    // `config` rides along on the captured result so the finalize block below keeps
    // its non-null proof: `shouldTerminalize` implies `config != null`, but that
    // narrowing does not survive into a separate `if (terminal)`.
    let terminal: { won: boolean; config: BuildConfig } | null = null;
    let terminalError: unknown;
    let authoritativeRowIsTerminal = true;
    let needsTerminalReconciliation = false;
    let authoritativeTerminalRow: NonNullable<Awaited<ReturnType<typeof getBuild>>> | null = null;
    if (shouldTerminalize) {
      try {
        terminal = {
          won: await this.revokeBuildRow(config.buildId, 'cancelled', {
            error: reason,
            completedAt: new Date().toISOString(),
          }),
          config,
        };
      } catch (err) {
        terminalError = err;
      }
    } else if (config != null) {
      // A terminal DO-local status is not proof that Postgres revoked the deploy
      // token: enforceTimeout writes local state before awaiting its CAS, and a
      // concurrent cancel can enter during that await. Verify the authoritative
      // row on the same deadline as a revocation. Only an explicitly terminal or
      // absent row makes a multi-second drain safe; active/unknown means signal now.
      try {
        const row = await withDeadline(
          getBuild(this.db(), config.buildId),
          TERMINAL_WRITE_TIMEOUT_MS,
          `build ${config.buildId}: authoritative terminal read did not settle within ${TERMINAL_WRITE_TIMEOUT_MS}ms`,
        );
        authoritativeRowIsTerminal = row === null || TERMINAL_STATUSES.includes(row.status);
        needsTerminalReconciliation = !authoritativeRowIsTerminal;
        if (row !== null && authoritativeRowIsTerminal) {
          authoritativeTerminalRow = row;
        }
      } catch (err) {
        authoritativeRowIsTerminal = false;
        needsTerminalReconciliation = true;
        console.warn('cancelBuild: authoritative terminal read failed; skipping drain', err);
      }
    }
    try {
      // Marker authority is the LOCAL terminal transition, not the Postgres CAS.
      // `shouldTerminalize` is exactly "no other in-DO teardown had already
      // claimed this build" — which is what the marker must not duplicate.
      //
      // Losing the CAS does NOT mean someone else emitted a marker. The normal
      // external cancel path (`cancelContainerBuildDos`: push-supersede,
      // disconnect, branch-delete, project-delete) commits the terminal row
      // BEFORE invoking this RPC by design, so `revokeBuildRow` always returns
      // false there. Gating on `won` would suppress the only marker those builds
      // ever get, and the agent's own post-SIGTERM line can't be pulled — so
      // their logs would just stop, with nothing saying why.
      await this.forceStopContainer(
        // See enforceTimeout: a lost or unknown revocation can belong to another
        // terminal writer. A recovered terminal row likewise owns an earlier
        // outcome, so this later cancellation cannot authoritatively explain the
        // kill. When the row is still active/unknown, the cancellation does.
        terminalError !== undefined || terminal?.won === false || authoritativeTerminalRow !== null
          ? 'build terminated out of band'
          : reason,
        ownsMarker,
        terminalError === undefined && authoritativeRowIsTerminal,
      );
      if (authoritativeTerminalRow && config != null) {
        // This bounded read already found the outcome a lost prior invocation failed
        // to publish. Reuse the row and check-run id instead of waiting for a retry
        // path that only scans active builds.
        await this.finalizeCheckRunToStatus(
          config,
          authoritativeTerminalRow.status,
          authoritativeTerminalRow.check_run_id,
        );
      } else if (needsTerminalReconciliation) {
        // Local terminal state can outlive a lost invocation before its Postgres
        // write or check-run finalize completes. Keep watching an active/unknown
        // authoritative row until the late write or stale reaper terminalizes it.
        await this.reconcileTerminalWrite();
      }
      // This branch owns a newly attempted terminalization. A recovered terminal row
      // was finalized above from its authoritative outcome; a thrown terminal write
      // is also skipped because finalizing a guessed outcome would be worse.
      if (terminal) {
        await this.broadcast({ type: 'status', status: 'cancelled' });
        // CAS-aware: finalize 'cancelled' only when THIS site won; otherwise finalize
        // to the out-of-band recorded outcome so GitHub matches the DB.
        if (terminal.won) {
          await this.finalizeCheckRun(terminal.config, 'cancelled', {
            detailsUrl: this.projectUrl(terminal.config),
            title: 'Void build cancelled',
            summary: reason,
          });
        } else {
          await this.finalizeCheckRunToRecordedOutcome(terminal.config);
        }
      } else if (terminalError !== undefined && config != null) {
        // A terminal write that MISSED ITS DEADLINE may still commit afterwards, and
        // the rejection left `terminal` null so nothing above finalizes. Reconcile
        // once now — which catches a commit that beat this line — and let the
        // reconciler re-arm itself for one that lands after it. Nothing else ever
        // completes this check run; see `reconcileTerminalWrite`.
        await this.reconcileTerminalWrite();
      }
    } finally {
      // Free the slot even if the teardown (or broadcast) threw.
      await this.pokeScheduler();
    }
    if (terminalError) {
      throw terminalError;
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade();
    }
    // Admin log poll: a plain (no-Upgrade) `GET /logs?since=N` read of the stored
    // SQLite `logs` table. Branches AFTER the WS upgrade above so a GET WITH the
    // upgrade header still takes the WS path. DOs aren't publicly reachable — only
    // our worker holds the binding — so no token auth; this is strictly READ-ONLY
    // (no inserts, no status writes, no broadcast, no container fetch).
    if (request.method === 'GET' && path === '/logs') {
      return this.handleReadLogs(url);
    }
    // Agent control endpoints are authenticated with the per-build secret so a
    // malicious repo build step can't POST forged logs/status to the DO even if
    // it discovers the endpoint URL.
    if (request.method === 'POST' && (path === '/status' || path === '/cancel')) {
      if (!(await this.isAuthorizedAgent(request))) {
        return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
      }
      if (path === '/status') {
        return this.handleStatus(request);
      }
      return this.handleCancel();
    }

    // Anything else is forwarded to the container (health checks, etc.).
    return super.fetch(request);
  }

  /**
   * Constant-time check of the per-build agent secret presented on a control
   * request (`Authorization: Bearer <token>` or `X-Agent-Token`). Returns false
   * if no secret was minted yet (build not started) or it doesn't match.
   */
  private async isAuthorizedAgent(request: Request): Promise<boolean> {
    const expected = await this.ctx.storage.get<string>(STORAGE_KEY_AGENT_TOKEN);
    if (!expected) {
      return false;
    }
    const header = request.headers.get('Authorization');
    const presented =
      header && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : (request.headers.get('X-Agent-Token') ?? '');
    return constantTimeEqual(presented, expected);
  }

  // --- log storage + fan-out ---

  private ensureLogTable(): void {
    if (this.logTableReady) {
      return;
    }
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS logs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        line TEXT NOT NULL,
        stream TEXT NOT NULL,
        ts INTEGER NOT NULL,
        line_ending TEXT
      )`,
    );
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>('PRAGMA table_info(logs)')
      .toArray();
    if (!columns.some((column) => column.name === 'line_ending')) {
      // Existing per-build DOs may have created the table before delimiter
      // provenance was stored. Keep those values NULL so the formatter can
      // reconstruct CRLF only BETWEEN legacy rows without fabricating an EOL
      // after the final row.
      this.ctx.storage.sql.exec('ALTER TABLE logs ADD COLUMN line_ending TEXT');
    }
    this.logTableReady = true;
  }

  /**
   * READ-ONLY poll read of the stored `logs` table for the admin worker.
   * `GET /logs?since=N` → `{ lines: Array<{seq,line,stream,ts}>, lastSeq, status,
   * terminal, logsComplete }` where `lines` are the rows with `seq > N` (ascending) and
   * `lastSeq` is the table's MAX(seq) — or the requested `since` when the table
   * is empty, so a poller's cursor never moves backward across an empty response
   * (same monotonic intent as `pollLogs`). A missing/non-numeric `since` is
   * treated as 0. No inserts, no status writes, no broadcast — this only reads
   * SQLite + DO storage.
   *
   * `status`/`terminal` are surfaced from the DO-local config (the authoritative
   * live status): every completion path sets the DO status terminal FIRST, then
   * does the Postgres CAS write — so if that PG write throws, the PG row can lag
   * ACTIVE until the stale reaper while the DO/container is already terminal.
   * `logsComplete` is published only after the producer has stopped and every
   * final append has been attempted, so follow mode does not mistake a terminal
   * status for a completed log drain.
   */
  private async handleReadLogs(url: URL): Promise<Response> {
    // Read completion before taking the final synchronous SQLite snapshot. Once
    // complete is visible, its final sequence was stored after every append, so
    // this response cannot pair `logsComplete: true` with a stale row snapshot.
    const drainState = (await this.ctx.storage.get<LogDrainState>(STORAGE_KEY_LOG_DRAIN)) ?? null;
    const cfg = await this.getConfig();
    const legacyComplete =
      drainState === null &&
      cfg !== null &&
      isTerminalBuildStatus(cfg.status) &&
      this.rawContainer()?.running !== true &&
      !this.pullInFlight &&
      !this.teardownInFlight &&
      !this.terminationMarkerClaimed;
    this.ensureLogTable();
    const raw = Number(url.searchParams.get('since'));
    const since = Number.isFinite(raw) ? raw : 0;
    const lines = this.ctx.storage.sql
      .exec<{ seq: number; line: string; stream: string; ts: number }>(
        'SELECT seq, line, stream, ts FROM logs WHERE seq > ? ORDER BY seq ASC',
        since,
      )
      .toArray();
    const maxRow = this.ctx.storage.sql
      .exec<{ max: number | null }>('SELECT MAX(seq) AS max FROM logs')
      .toArray()[0];
    const lastSeq = maxRow?.max ?? since;
    return Response.json({
      lines,
      lastSeq,
      status: cfg?.status ?? null,
      terminal: cfg ? isTerminalBuildStatus(cfg.status) : false,
      logsComplete:
        drainState?.state === 'complete'
          ? true
          : drainState?.state === 'open'
            ? false
            : legacyComplete
              ? true
              : null,
    });
  }

  /**
   * Assemble the check-run `output.text` log tail from the stored `logs` table:
   * the newest CHECK_RUN_LOG_TAIL_LINES rows (read newest-first, rendered
   * chronologically) plus the total captured count, so the omission marker can
   * say when earlier lines exist. Null when nothing was captured — the
   * completion PATCH then omits `text`.
   */
  private async readLogTailMarkdown(): Promise<string | null> {
    this.ensureLogTable();
    const rows = this.ctx.storage.sql
      .exec<{ line: string; lineEnding: TerminalLineEnding | null }>(
        'SELECT line, line_ending AS lineEnding FROM logs ORDER BY seq DESC LIMIT ?',
        CHECK_RUN_LOG_TAIL_LINES,
      )
      .toArray();
    const countRow = this.ctx.storage.sql
      .exec<{ count: number }>('SELECT COUNT(*) AS count FROM logs')
      .toArray()[0];
    return formatLogTailMarkdown(rows.reverse(), countRow?.count ?? rows.length);
  }

  /**
   * Persist a batch of log lines into the SQLite `logs` table (bounded to the
   * most-recent MAX_STORED_LOG_LINES rows) and fan each out over the WebSocket.
   * Fed ONLY by the DO→container pull-loop (`pollLogs`) — the single
   * authoritative transport for container output into the DO sink. (The agent
   * still POSTs to `DO_LOG_URL`, but that push has no route back to the DO, so
   * it never reaches here; the pull-loop is the sole producer.)
   */
  private async ingestLines(lines: ReadonlyArray<BuildLogLine>): Promise<void> {
    this.ensureLogTable();
    for (const entry of lines) {
      this.ctx.storage.sql.exec(
        'INSERT INTO logs (line, stream, ts, line_ending) VALUES (?, ?, ?, ?)',
        entry.line,
        entry.stream,
        entry.ts,
        entry.lineEnding ?? null,
      );
    }
    // Evict everything older than the most-recent MAX_STORED_LOG_LINES rows so the
    // table (and the WS replay that loads it) stays bounded for the build's
    // lifetime. `seq` is a monotonic AUTOINCREMENT, so the kept window is always
    // the contiguous tail; once-per-batch keeps this O(1) statements, not O(line).
    if (lines.length > 0) {
      this.ctx.storage.sql.exec(
        'DELETE FROM logs WHERE seq <= (SELECT MAX(seq) FROM logs) - ?',
        MAX_STORED_LOG_LINES,
      );
    }
    for (const entry of lines) {
      await this.broadcast({
        type: 'log',
        line: entry.line,
        stream: entry.stream,
        ts: entry.ts,
      });
    }
  }

  /**
   * DO→container log pull-loop. The agent buffers stdout/stderr and serves
   * `GET /logs?since=N` (`{ lines: Array<{seq,line,stream,ts,lineEnding?}>, lastSeq }`);
   * this method polls it, ingests any new lines (cursor-stripped), advances the
   * cursor to `lastSeq`, and re-arms itself — the only transport feeding container
   * output into the DO's store + WS fan-out. Public + named so the base scheduler can
   * resolve it as a callback (same mechanism as `enforceTimeout`); we MUST NOT
   * override `alarm()` (the base owns the single DO alarm).
   *
   * Self-terminating: returns WITHOUT re-arming once the build is gone or terminal
   * so the loop stops at completion. The pull uses a NON-STARTING port fetch (see
   * `runLogPull`), so a poll can never resurrect a finished build. The
   * `container.running` guard is purely a cheap early-out for the common
   * already-exited case (it avoids a 1s busy-retry; onStop finalizes).
   * A transient fetch failure is swallowed and the loop re-arms to retry next tick.
   */
  async pollLogs(): Promise<void> {
    const config = await this.getConfig();
    // Teardown owns the complete join -> optional fresh drain -> signal -> final
    // marker ordering. Once that gate exists, a scheduled callback must not start
    // another pull outside it. This guard covers both terminal and stale
    // non-terminal config snapshots; if teardown began after the guard, its
    // unconditional pullInFlight join above still orders the newly-started pull.
    if (this.teardownInFlight) {
      return;
    }
    // The base copies `ctx.container` into a private field; read the same object via
    // a public-typed cast. We need both `running` (the cheap early-out below) and
    // `getTcpPort` (the NON-starting fetch path `pullLogsOnce` uses).
    const container = this.rawContainer();
    if (!config || TERMINAL_STATUSES.includes(config.status)) {
      // No build, or the build finished — stop the loop (do NOT re-arm).
      //
      // The last pull below is a BACKSTOP, not the primary drain, and it is worth
      // being precise about why — the obvious reading is wrong. It is NOT what
      // releases the agent's `waitForLogDrain()` barrier: the agent's only status
      // report is `deploying` and `handleStatus` rejects anything but
      // `building`/`deploying`, so a terminal status can NEVER originate from the
      // agent. While the barrier waits, the DO status is still non-terminal and
      // the loop is taking the NORMAL branch below, pulling and re-arming until
      // the cursor catches up. That path is self-sufficient.
      //
      // Nor is it the cancel/timeout drain: `forceStopContainer`
      // pulls synchronously in front of its own SIGTERM, which covers all three
      // teardown sites (cancelBuild / enforceTimeout / the startBuild catch)
      // without depending on an alarm landing in a sub-millisecond window.
      //
      // What is left is genuinely narrow, which is exactly why it stays: a
      // terminal status written WITHOUT a teardown pull (`onError` sets 'failed'
      // and never force-stops), or a tick that happens to land between a
      // teardown's `setStatus` and its `destroy()`. Both leave a live agent
      // holding unpulled lines. One best-effort, NON-starting, never-re-arming
      // pull is cheap insurance; when the terminal status came from `onStop`
      // (complete / failed) the container is already gone and the `running` guard
      // skips it.
      if (config && container?.running) {
        await this.pullLogsOnce(container);
      }
      return;
    }
    // Common case: the container has already exited. Stop the loop (do NOT re-arm)
    // — onStop will finalize the build. Skips the fetch entirely, and by this point
    // the tail has already been drained by whichever path ended the container: a
    // natural exit holds the agent's control server open until this loop catches up
    // (`waitForLogDrain` in container/build-agent.mjs), and a SIGTERM teardown —
    // where that barrier is skipped, because `onShutdownSignal` calls
    // `process.exit(1)` — pulls in `forceStopContainer` before signalling.
    if (!container?.running) {
      return;
    }
    await this.pullLogsOnce(container);
    // Re-arm. Reached on success AND on a swallowed fetch error (the container may
    // still be running and just briefly unreachable). The running guard above ends
    // the loop once the container is gone.
    await this.schedule(POLL_SECONDS, 'pollLogs');
  }

  /**
   * Read `ctx.container` off the base class (it copies it into a private field) as
   * the narrow surface the log pull needs: `running` for the cheap early-out and
   * `getTcpPort` for the NON-starting fetch.
   */
  private rawContainer(): ContainerPortSurface | undefined {
    return (this as unknown as { container?: ContainerPortSurface }).container;
  }

  /**
   * One `GET /logs?since=<cursor>` pull: ingest any new lines and advance the
   * cursor. Returns true only after a successful terminal/acknowledgement page;
   * false tells a bounded caller it may retry from the unchanged/advanced cursor.
   * Never throws — it is called from a scheduled callback (`pollLogs`), where an
   * escaping rejection would kill the alarm, and from
   * `forceStopContainer`, where it must never block a cancel/timeout teardown.
   * Bounded by `LOG_PULL_TIMEOUT_MS` for the same reason.
   *
   * SINGLE-FLIGHT (same shape as the agent's `flushLogs`, container/build-agent.mjs).
   * The body reads `this.logCursor` to build the URL and writes it three awaits
   * later, so two overlapping calls both request `since=<stale>` and ingest the
   * same lines TWICE. Nothing downstream dedupes: the agent serves
   * `logBuffer.filter(e => e.seq > since)`, the source `seq` is stripped at
   * ingest, and the `logs` table is keyed only by its own AUTOINCREMENT `seq` —
   * so duplicates land as distinct rows, are re-broadcast to every live tail,
   * and spend the MAX_STORED_LOG_LINES / CHECK_RUN_LOG_TAIL_LINES budgets,
   * evicting genuine history.
   *
   * The overlap is reachable because a `fetch()` is NOT storage I/O and so does
   * NOT hold the DO input gate (only `ctx.storage` operations do): while a
   * scheduled `pollLogs` sits in the await below, a `cancelBuild` RPC — or the
   * agent's `POST /cancel`, or the `startBuild` catch — reaches
   * `forceStopContainer`, which pulls again. (`enforceTimeout` cannot: it and
   * `pollLogs` are both base-scheduler callbacks, which the alarm loop runs one
   * at a time.) Concurrent callers JOIN the in-flight pull instead of starting a
   * second one, which keeps N concurrent teardowns coalesced onto ONE pull.
   *
   * Joining is NOT a drain, though, and `forceStopContainer` must not treat it as
   * one: the agent freezes a response body at RECEIPT, so a joined pull cannot
   * carry lines written after it was issued, and on the teardown path there is no
   * later poll to collect them. That is why teardown ALWAYS awaits this gate and,
   * when its caller permits a new agent request, THEN takes its own fresh snapshot
   * — see the comment there. A bare join would be deduplicated but truncated.
   */
  private pullLogsOnce(
    container: Pick<ContainerPortSurface, 'getTcpPort'>,
    budgetMs = LOG_DRAIN_BUDGET_MS,
  ): Promise<boolean> {
    this.pullInFlight ??= this.runLogPull(container, budgetMs).finally(() => {
      this.pullInFlight = null;
    });
    return this.pullInFlight;
  }

  /** The actual pull. Only ever entered via `pullLogsOnce`'s single-flight gate. */
  private async runLogPull(
    container: Pick<ContainerPortSurface, 'getTcpPort'>,
    budgetMs: number,
  ): Promise<boolean> {
    try {
      // NON-STARTING fetch. Unlike `this.containerFetch(...)`, `getTcpPort().fetch()`
      // does NOT auto-start a stopped container (containerFetch's auto-start branch,
      // container.js:847, is exactly what we must avoid here). So even if the
      // container exits in the TOCTOU window between the caller's running guard and
      // this call, the fetch FAILS (caught below) instead of RESURRECTING the
      // just-finished build — which would otherwise rerun install/build/`void
      // deploy`. On a running/healthy container this is identical to what
      // containerFetch does after its start check.
      //
      // TIMEBOXED. An agent that accepts the connection but never answers would
      // otherwise hang here forever: on the poll path that stalls the alarm chain
      // (no re-arm, no further logs), and on the teardown path it stalls the
      // cancel/timeout SIGTERM+SIGKILL itself, pinning a global fleet slot. The
      // abort surfaces as a throw, which the catch below swallows like any other
      // transient failure.
      // Drain PAGES within this one call rather than one per tick. The agent caps
      // a response (MAX_LOG_RESPONSE_BYTES / _LINES) so an oversized backlog can
      // never blow the per-request timeout, but at POLL_SECONDS per page a deep
      // backlog would make no useful progress for long stretches. Productive
      // pagination resets the agent's idle deadline; batching still reduces
      // callback churn and acknowledgement latency.
      //
      // ONE deadline for the whole drain, not one per page. Without it, fresh
      // per-request timeouts let 32 productive-slow pages hold one callback for
      // 64s and a join+fresh teardown for ~128s, also postponing the serialized
      // timeout enforcer and token revocation.
      //
      // The deadline bounds LATENCY only. It cannot bound the parse/insert/fan-out
      // CPU between the fetches, because a deployed Worker's clock does not advance
      // during CPU work — see MAX_LOG_SINK_OPS_PER_DRAIN, which bounds that
      // deterministically and is the reason this loop can also stop mid-backlog
      // with time left on the clock.
      const drainDeadline = Date.now() + Math.min(LOG_DRAIN_BUDGET_MS, Math.max(0, budgetMs));
      let sinkOps = 0;
      for (let page = 0; page < MAX_LOG_PULL_PAGES; page++) {
        const remaining = drainDeadline - Date.now();
        if (remaining <= 0) {
          return false; // resume from the advanced cursor on the next tick
        }
        const res = await container
          .getTcpPort(this.defaultPort)
          .fetch(`http://manager/logs?since=${this.logCursor}`, {
            signal: AbortSignal.timeout(Math.min(LOG_PULL_TIMEOUT_MS, remaining)),
          });
        if (!res.ok) {
          return false;
        }
        const body = (await res.json()) as {
          lines: Array<BuildLogLine & { seq: number }>;
          lastSeq: number;
          hasMore?: boolean;
        };
        if (body.lines.length > 0) {
          // Charge the page BEFORE ingesting it: the accounting must reflect the
          // work this callback is about to do, and the fan-out width must be the
          // one `ingestLines` will actually broadcast to.
          const fanOut = 1 + this.ctx.getWebSockets().length;
          for (const entry of body.lines) {
            sinkOps +=
              fanOut * Math.max(1, Math.ceil(entry.line.length / LOG_SINK_OP_PAYLOAD_BYTES));
          }
          await this.ingestLines(
            body.lines.map(({ line, stream, ts, lineEnding }) => ({
              line,
              stream,
              ts,
              lineEnding,
            })),
          );
        }
        // Monotonic-advance: never move the cursor backward if a stale/empty
        // response reports a lower lastSeq than we've already ingested.
        const advanced = Math.max(this.logCursor, body.lastSeq);
        const moved = advanced > this.logCursor;
        this.logCursor = advanced;
        // A moving final page still needs ONE more request. Its `since=<advanced>`
        // is the acknowledgement the agent's exit barrier trusts; waiting for the
        // next scheduled callback spends another POLL_SECONDS and can land exactly
        // on the barrier deadline after a budget-length paginated drain. The extra
        // empty request closes that loop immediately (and safely picks up lines
        // recorded between the two snapshots).
        //
        // `hasMore` is absent on an older agent without paging; keep one page per
        // tick for it. Also stop if the cursor did not move, or an empty page
        // claiming more would spin.
        if (!moved || body.hasMore === undefined) {
          return true;
        }
        // Whole pages only: the page just ingested is fully accounted for and the
        // cursor covers exactly the rows that reached the sink, so stopping here
        // loses nothing. The next callback resumes from the advanced cursor, and
        // that request doubles as the acknowledgement this one is skipping.
        if (sinkOps >= MAX_LOG_SINK_OPS_PER_DRAIN) {
          return false;
        }
      }
      return false;
    } catch (err) {
      // Container gone / mid-start / transient — swallow. Normal polling re-arms;
      // the onError path observes false and retries inside its bounded window.
      // Must NOT throw out of a scheduled callback.
      console.warn('pollLogs: container log fetch failed', err);
      return false;
    }
  }

  private async handleStatus(request: Request): Promise<Response> {
    const body = (await request.json()) as { status?: StoredBuildStatus };
    const config = await this.getConfig();
    if (!body.status || !config) {
      return Response.json({ ok: false }, { status: 400 });
    }
    // The agent may only report *non-terminal* PROGRESS ('building'|'deploying').
    // Terminal outcomes (complete/failed/cancelled) are decided exclusively by
    // the trusted DO lifecycle — onStop (container exit code), the timeout
    // alarm, or an authenticated cancel — so a build step can never forge a
    // 'complete' that frees the slot while the container is still running.
    // Anything else (incl. 'queued'/'starting') is rejected so a buggy/malicious
    // agent can't write an arbitrary lifecycle state.
    if (body.status !== 'building' && body.status !== 'deploying') {
      return Response.json({ ok: false, error: 'status not allowed' }, { status: 400 });
    }
    // Don't let a late progress report clobber an already-finalized build (local
    // fast path; the CAS below is the authoritative cross-process guard).
    if (TERMINAL_STATUSES.includes(config.status)) {
      return Response.json({ ok: false, error: 'build already finalized' }, { status: 409 });
    }
    // Guarded CAS: only write the progress status while the DB row is still
    // active. A CAS-miss means a concurrent terminalizer (push-supersede,
    // disconnect, branch/executor change, app removal) already drove the row
    // terminal out-of-band while the DO's local status still said active. An
    // unconditional write here would resurrect that `cancelled` row to
    // 'deploying' and re-enable the bound deploy token, letting a superseded
    // runner publish stale code. On a CAS-miss, tear down via cancelBuild — its
    // own `markBuildTerminalIfActive` CAS no-ops against the already-terminal row
    // (NO clobber) and best-effort stop()s the orphaned container + pokes the
    // scheduler. Never write `cancelled` directly here.
    const moved = await markBuildProgressIfActive(this.db(), config.buildId, body.status);
    if (!moved) {
      await this.cancelBuild('build superseded');
      return Response.json({ ok: false, error: 'build no longer active' }, { status: 409 });
    }
    await this.setStatus(body.status);
    await this.broadcast({ type: 'status', status: body.status });
    return Response.json({ ok: true });
  }

  private async handleCancel(): Promise<Response> {
    // The agent-authenticated POST /cancel path shares the same teardown as the
    // internal RPC; delegate so the cancel outcome + CAS guard live in one place.
    await this.cancelBuild();
    return Response.json({ ok: true });
  }

  private handleWebSocketUpgrade(): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Hibernatable accept — the DO can sleep between log batches and still
    // receive the socket on wake.
    this.ctx.acceptWebSocket(server);

    // Replay every stored log line, then a caught-up marker, then the socket
    // live-streams subsequent broadcasts.
    this.ensureLogTable();
    const rows = this.ctx.storage.sql
      .exec<{ line: string; stream: string; ts: number }>(
        'SELECT line, stream, ts FROM logs ORDER BY seq ASC',
      )
      .toArray();
    for (const row of rows) {
      server.send(JSON.stringify({ type: 'log', line: row.line, stream: row.stream, ts: row.ts }));
    }
    server.send(JSON.stringify({ type: 'caught_up' }));

    return new Response(null, { status: 101, webSocket: client });
  }

  private async broadcast(message: Record<string, unknown>): Promise<void> {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Dead socket — ignore; the runtime will surface a close event.
      }
    }
  }

  private async pokeScheduler(): Promise<void> {
    try {
      await this.env.BUILD_SCHEDULER.get(this.env.BUILD_SCHEDULER.idFromName('global')).fetch(
        'https://scheduler/poke',
        { method: 'POST' },
      );
    } catch {
      // Best-effort — the scheduler's own poke-on-next-webhook backstops this.
    }
  }
}

/**
 * Larger build container for paid plans. Identical behavior to BuildManager —
 * it exists only as a distinct container-enabled DO class so wrangler.jsonc can
 * bind it to a bigger static `instance_type` (standard-4). @cloudflare/containers
 * has no per-start sizing, so a second class is the only way to offer a second
 * container size. Routing (which class a build uses) is decided elsewhere by the
 * build's persisted instance_type.
 */
export class BuildManagerLarge extends BuildManager {}
