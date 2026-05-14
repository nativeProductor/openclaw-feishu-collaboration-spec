// Module B — Reply Gate (P0: mention-only mode).
//
// Verify:
//   1. Send no-@ msg in a group → log [feishu-collab] gate-decision: skip (reason=no-mention)
//                              → the agent NEVER calls the model for this turn
//   2. Send @-bot msg in a group → log [feishu-collab] gate-decision: reply
//                              → model runs normally
//   3. Send p2p (1:1) msg       → log [feishu-collab] gate-decision: reply (reason=p2p-bypass)
//   4. Switch gate.mode=autonomous → log [feishu-collab] gate-decision: skip (reason=autonomous-mode-stub)
//                              → real autonomous behaviour lands in Phase 2
//
// ─────────────────────────────────────────────────────────────────────────────
// Why two hooks (inbound_claim + before_prompt_build):
//
// The SDK's `PluginHookBeforePromptBuildEvent` only exposes { prompt, messages }
// — no chat_type, no mentions list, no chat_id. That data IS on the
// `inbound_claim` event (isGroup, wasMentioned, metadata, etc.). Per
// docs/architecture.md, inbound_claim is also the only hook that sees ALL
// inbound group messages (it runs before the host's own mention-gate strips
// unmentioned messages).
//
// So the wiring is:
//   inbound_claim   → compute decision (skip|reply, with reason) using
//                     event.isGroup + event.wasMentioned + config.gate.mode,
//                     stash into setRunContext(namespace='gate', runId=...).
//   before_prompt_build → read the stashed decision. If skip, log and throw
//                     a sentinel error so the host aborts this turn. (See note
//                     below on why we throw.)
//
// ─────────────────────────────────────────────────────────────────────────────
// The skip-signal workaround.
//
// `PluginHookBeforePromptBuildResult` (hook-before-agent-start.types.d.ts) is:
//   { systemPrompt?; prependContext?; appendContext?;
//     prependSystemContext?; appendSystemContext? }
//
// There is NO `skip`, `cancel`, `abort`, or `handled` field on this hook's
// result. Returning `{ skip: true }` is a no-op (the field is silently
// ignored). The closest "stop the agent" hook with a result-side cancel is
// `before_dispatch` (has `handled: true`) and `before_agent_reply` (has
// `handled: true`), but neither runs before the model is invoked — by the time
// they fire we've already spent tokens.
//
// Discovery path:
//   1. Read /Users/bytedance/openclaw-bot2/node_modules/openclaw/dist/plugin-sdk/
//      src/plugins/hook-before-agent-start.types.d.ts → confirmed the result type.
//   2. Grep `PluginHookBeforePromptBuildResult` across the SDK — no cancellation
//      surface.
//   3. Confirmed `inbound_claim` does have a cancellation surface
//      (PluginHookInboundClaimResult.handled), but cancelling at inbound_claim
//      cancels for everyone, not just our reply, so we'd lose Module A capture.
//
// Workaround: throw a tagged sentinel error from `before_prompt_build`. The
// host catches handler exceptions per-plugin (see hook-runner-global.d.ts) and
// surfaces them as a turn abort — which is exactly the user-visible behaviour
// we want for "don't reply". The downside is a `WARN handler threw` log line
// per skip, which is acceptable for P0 and documented here so QA knows what to
// expect. Module Orchestrator (index.ts owner) may upgrade to a cleaner signal
// once the SDK gains one.
//
// If a future SDK adds e.g. `{ cancel: true }` to PluginHookBeforePromptBuildResult,
// switch `signalSkip()` to return that instead of throwing — the rest of the
// module stays the same.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
  PluginHookInboundClaimResult,
} from 'openclaw/plugin-sdk/plugin-entry';
import { runLarkCliJson } from '../lib/lark-shell.js';

const LOG_PREFIX = '[feishu-collab]';
const GATE_NAMESPACE = 'reply-gate';
/** Tag used on sentinel errors so the orchestrator (or future hook chain)
 *  can distinguish a deliberate skip from a real bug. */
export const GATE_SKIP_SENTINEL_TAG = 'FEISHU_COLLAB_GATE_SKIP';

export type GateMode = 'mention-only' | 'autonomous';

export type GateDecision = {
  outcome: 'reply' | 'skip';
  reason: string;
};

type RunGateState = {
  decision: GateDecision;
};

// Module-scoped cache: bot's own open_id, fetched lazily on first mention check.
let cachedBotOpenId: string | null = null;
let botOpenIdFetchInflight: Promise<string | null> | null = null;

/**
 * Sentinel thrown from before_prompt_build to signal "do not reply this turn".
 *
 * Carries the gate-decision reason so a top-level catch can log/measure cleanly.
 * Any future SDK skip-result-field should replace this throw entirely.
 */
export class GateSkipSignal extends Error {
  readonly tag = GATE_SKIP_SENTINEL_TAG;
  readonly reason: string;
  constructor(reason: string) {
    super(`feishu-collab: gate skip (${reason})`);
    this.name = 'GateSkipSignal';
    this.reason = reason;
  }
}

export function isGateSkipSignal(err: unknown): err is GateSkipSignal {
  return (
    err instanceof Error &&
    (err as { tag?: unknown }).tag === GATE_SKIP_SENTINEL_TAG
  );
}

// Narrow accessors for the parts of the plugin API surface we touch. Kept
// loose on purpose: index.ts passes the full PluginApi as `any` today.
type GateApi = {
  pluginConfig?: Record<string, unknown> | undefined;
  logger?: {
    info?: (m: string) => void;
    warn?: (m: string) => void;
    error?: (m: string) => void;
    debug?: (m: string) => void;
  };
  on: (hookName: string, handler: (...args: any[]) => any) => void;
  setRunContext: (patch: {
    runId: string;
    namespace: string;
    value: unknown;
    mergeStrategy?: 'replace' | 'merge';
  }) => boolean;
  getRunContext: <T = unknown>(params: { runId: string; namespace: string }) => T | undefined;
};

function log(api: GateApi, level: 'info' | 'warn' | 'error', msg: string) {
  const line = `${LOG_PREFIX} ${msg}`;
  const lg = api.logger;
  if (lg && typeof lg[level] === 'function') {
    lg[level]!(line);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(line);
}

function readGateMode(api: GateApi): GateMode {
  const cfg = api.pluginConfig as
    | { gate?: { mode?: string } | undefined }
    | undefined;
  const raw = cfg?.gate?.mode;
  if (raw === 'autonomous') return 'autonomous';
  // Default + any unknown value collapses to mention-only (safer).
  return 'mention-only';
}

/**
 * Resolve the bot's own open_id by calling `GET /open-apis/bot/v3/info`
 * via lark-cli `--as bot`. Cached module-scope across the process lifetime.
 *
 * Returns null on failure so callers can degrade (in mention-only mode,
 * if we cannot identify ourselves we conservatively SKIP — the alternative
 * would be replying to every group message, violating the install-and-go
 * invariant).
 */
export async function getBotOpenId(): Promise<string | null> {
  if (cachedBotOpenId) return cachedBotOpenId;
  if (botOpenIdFetchInflight) return botOpenIdFetchInflight;

  botOpenIdFetchInflight = (async () => {
    try {
      const raw = await runLarkCliJson<unknown>(
        ['api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot'],
        { timeoutMs: 10_000 },
      );
      const openId = extractBotOpenId(raw);
      if (openId) {
        cachedBotOpenId = openId;
        return openId;
      }
      return null;
    } catch {
      return null;
    } finally {
      botOpenIdFetchInflight = null;
    }
  })();
  return botOpenIdFetchInflight;
}

function extractBotOpenId(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const top = raw as Record<string, unknown>;
  // Feishu bot info typically lives at .bot.open_id or .data.bot.open_id;
  // lark-cli may further wrap as { ok, data: { ... } }.
  const candidates: unknown[] = [
    (top.bot as Record<string, unknown> | undefined)?.open_id,
    ((top.data as Record<string, unknown> | undefined)?.bot as
      | Record<string, unknown>
      | undefined)?.open_id,
    (top.data as Record<string, unknown> | undefined)?.open_id,
    top.open_id,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return null;
}

/**
 * Extract mentions from the inbound_claim event. The SDK type only declares
 * `metadata?: Record<string, unknown>` and a top-level `wasMentioned?` flag;
 * the feishu channel populates `metadata.mentions` (an array of open_id
 * strings) and/or the raw event object on `metadata.raw`.
 *
 * We prefer the structured array; we fall back to raw scanning so this still
 * works if the channel plugin evolves its metadata shape.
 */
function extractMentions(event: PluginHookInboundClaimEvent): string[] {
  const meta = event.metadata ?? {};
  const direct = (meta as { mentions?: unknown }).mentions;
  if (Array.isArray(direct)) {
    const out: string[] = [];
    for (const m of direct) {
      if (typeof m === 'string') out.push(m);
      else if (m && typeof m === 'object') {
        const idObj = (m as { id?: unknown; open_id?: unknown }).open_id ??
          ((m as { id?: { open_id?: unknown } }).id?.open_id);
        if (typeof idObj === 'string') out.push(idObj);
      }
    }
    if (out.length) return out;
  }
  // Fallback: scan raw event payload for "@_user_N" style mention ids' open_id.
  const raw = (meta as { raw?: unknown }).raw;
  if (raw && typeof raw === 'object') {
    const message = (raw as { message?: { mentions?: unknown } }).message;
    if (message && Array.isArray(message.mentions)) {
      const out: string[] = [];
      for (const m of message.mentions) {
        const idObj = (m as { id?: { open_id?: unknown } | string })?.id;
        if (typeof idObj === 'string') out.push(idObj);
        else if (idObj && typeof idObj === 'object' && typeof (idObj as { open_id?: unknown }).open_id === 'string') {
          out.push((idObj as { open_id: string }).open_id);
        }
      }
      return out;
    }
  }
  return [];
}

/**
 * Compute the gate decision from an inbound_claim event.
 * Pure function, no I/O — useful for unit testing if/when QA wires it up.
 */
export function computeGateDecision(opts: {
  isGroup: boolean;
  mode: GateMode;
  mentions: string[];
  botOpenId: string | null;
  wasMentioned?: boolean;
}): GateDecision {
  if (!opts.isGroup) {
    return { outcome: 'reply', reason: 'p2p-bypass' };
  }
  if (opts.mode === 'autonomous') {
    // P0: stub. Real classifier lands in Phase 2.
    return { outcome: 'skip', reason: 'autonomous-mode-stub' };
  }
  // mention-only
  if (opts.wasMentioned === true) {
    return { outcome: 'reply', reason: 'mention-host-flag' };
  }
  if (opts.botOpenId && opts.mentions.includes(opts.botOpenId)) {
    return { outcome: 'reply', reason: 'mention-match' };
  }
  if (!opts.botOpenId) {
    // Identity not yet known — default to skip (safer than spamming).
    return { outcome: 'skip', reason: 'no-bot-identity' };
  }
  return { outcome: 'skip', reason: 'no-mention' };
}

/**
 * Register Module B's hooks.
 *
 * Wiring contract for the orchestrator:
 *   - Call `register(api)` once during plugin `register()`.
 *   - When `inbound_claim` fires, this module records the decision into
 *     run context but returns `undefined` (does NOT claim the message — that
 *     belongs to Module A).
 *   - When `before_prompt_build` fires, this module reads the decision and
 *     either returns void (reply) or throws GateSkipSignal (skip).
 */
export function register(api: GateApi): void {
  const inboundClaimHandler = async (
    event: PluginHookInboundClaimEvent,
    ctx: PluginHookInboundClaimContext,
  ): Promise<PluginHookInboundClaimResult | void> => {
    try {
      const mode = readGateMode(api);
      const mentions = extractMentions(event);
      const botOpenId = await getBotOpenId();
      const decision = computeGateDecision({
        isGroup: !!event.isGroup,
        mode,
        mentions,
        botOpenId,
        wasMentioned: event.wasMentioned,
      });

      // Stash for before_prompt_build to read. Keyed by runId so we don't
      // bleed decisions across concurrent runs.
      const runId = ctx.runId ?? event.runId;
      if (runId) {
        const ok = api.setRunContext({
          runId,
          namespace: GATE_NAMESPACE,
          value: { decision } satisfies RunGateState,
          mergeStrategy: 'replace',
        });
        if (!ok) {
          // Run context write failed (e.g. run not yet registered). We still
          // log the decision so we have observability; before_prompt_build
          // will recompute on the fly.
          log(
            api,
            'warn',
            `gate-decision-deferred (setRunContext returned false) decision=${decision.outcome} reason=${decision.reason}`,
          );
        }
      }
      log(api, 'info', `gate-decision: ${decision.outcome} (reason=${decision.reason})`);
    } catch (err) {
      // Never let the gate's bookkeeping crash inbound_claim — Module A still
      // needs to capture this message. Fall through to "no decision recorded";
      // before_prompt_build will treat that as "reply" so we err on the side
      // of responsiveness.
      log(api, 'warn', `gate-decision-error: ${(err as Error).message}`);
    }
    return undefined;
  };

  const beforePromptBuildHandler = async (
    _event: PluginHookBeforePromptBuildEvent,
    ctx: { runId?: string },
  ): Promise<PluginHookBeforePromptBuildResult | void> => {
    const runId = ctx?.runId;
    let decision: GateDecision | undefined;
    if (runId) {
      const stored = api.getRunContext<RunGateState>({ runId, namespace: GATE_NAMESPACE });
      decision = stored?.decision;
    }
    if (!decision) {
      // No inbound_claim ran for this run (e.g. CLI-triggered or non-feishu
      // surface). Conservative: allow the reply. Module A is the source of
      // truth for "is this a feishu group event".
      return undefined;
    }
    if (decision.outcome === 'skip') {
      log(api, 'info', `gate-enforce: aborting turn (reason=${decision.reason})`);
      // Workaround documented at top of file: throw sentinel to abort the turn.
      throw new GateSkipSignal(decision.reason);
    }
    // outcome === 'reply' — let the prompt build proceed unchanged.
    return undefined;
  };

  api.on('inbound_claim', inboundClaimHandler);
  api.on('before_prompt_build', beforePromptBuildHandler);
}

// Test seam: allow QA to reset the cached bot open_id between integration runs.
export function __resetForTest(): void {
  cachedBotOpenId = null;
  botOpenIdFetchInflight = null;
}
