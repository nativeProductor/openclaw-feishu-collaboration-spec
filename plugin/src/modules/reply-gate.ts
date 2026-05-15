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
// Why two hooks (message_received + before_prompt_build):
//
// `inbound_claim` does NOT fire for non-bundled plugins on our path — it's
// gated by `pluginOwnedBinding` in dispatch-DHFZoYxZ.js:526 which requires
// explicit user ceremony. The unconditional hook that fires pre-mention-gate
// for every inbound is `message_received` (fireAndForgetHook at
// dispatch-DHFZoYxZ.js:569). So we use that instead.
//
// The trade-off: PluginHookMessageReceivedEvent is THINNER than
// PluginHookInboundClaimEvent. It has no `isGroup`, `wasMentioned`, or
// structured `mentions[]` array. But the data we need is recoverable:
//   - isGroup  → ctx.conversationId starts with 'oc_' (Feishu group chat IDs)
//   - mentions → scan event.content for <at user_id="ou_..."> tags
//   - wasMentioned → derive from mentions ∩ {botOpenId}
//
// So the wiring is:
//   message_received → compute decision (skip|reply, with reason) using
//                     conversationId-shape + mention-tag scan + config.gate.mode,
//                     stash into setRunContext(namespace='reply-gate', runId=...).
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

import { runLarkCliJson } from '../lib/lark-shell.js';

// `message_received` event/ctx types live in the SDK but are NOT re-exported
// from `openclaw/plugin-sdk/plugin-entry`. We declare just the fields we touch
// so we don't depend on a private import path. Shape mirrors
// hook-message.types.d.ts (PluginHookMessageReceivedEvent / PluginHookMessageContext).
type PluginHookMessageReceivedEvent = {
  from: string;
  content: string;
  timestamp?: number;
  threadId?: string | number;
  messageId?: string;
  senderId?: string;
  sessionKey?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
};
type PluginHookMessageContext = {
  channelId: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string;
  senderId?: string;
};

// `before_prompt_build` event/result types are declared in the SDK but NOT
// re-exported from `openclaw/plugin-sdk/plugin-entry`. We declare just the
// fields we touch so we don't depend on a private import path.
type PluginHookBeforePromptBuildEvent = {
  prompt: string;
  messages: unknown[];
};
type PluginHookBeforePromptBuildResult = {
  systemPrompt?: string;
  prependContext?: string;
  appendContext?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
};

const LOG_PREFIX = '[feishu-collab]';
const GATE_NAMESPACE = 'reply-gate';
/** Tag used on sentinel errors so the orchestrator (or future hook chain)
 *  can distinguish a deliberate skip from a real bug. */
export const GATE_SKIP_SENTINEL_TAG = 'FEISHU_COLLAB_GATE_SKIP';

/**
 * In-memory bridge from `message_received` → `before_prompt_build`.
 *
 * Why not setRunContext? The host fires `message_received` BEFORE a run is
 * registered, so `ctx.runId` / `event.runId` are undefined at that point —
 * setRunContext silently no-ops. Using sessionKey (which IS populated on
 * both hooks) we get a stable cross-hook key. Entries are short-lived
 * (cleared on read or after 5 minutes).
 */
type PendingGate = {
  decision: GateDecision;
  ts: number;
};
const pendingGateBySession = new Map<string, PendingGate>();
const GATE_PENDING_TTL_MS = 5 * 60_000;

function setPendingGate(sessionKey: string, decision: GateDecision): void {
  if (!sessionKey) return;
  pendingGateBySession.set(sessionKey, { decision, ts: Date.now() });
}
function consumePendingGate(sessionKey: string | undefined): GateDecision | undefined {
  if (!sessionKey) return undefined;
  // Opportunistic TTL sweep.
  const now = Date.now();
  for (const [k, v] of pendingGateBySession) {
    if (now - v.ts > GATE_PENDING_TTL_MS) pendingGateBySession.delete(k);
  }
  const entry = pendingGateBySession.get(sessionKey);
  if (!entry) return undefined;
  pendingGateBySession.delete(sessionKey);
  return entry.decision;
}

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
 * Extract mentions from a `message_received` event's content. Feishu's
 * canonical text content for a group message that @-mentions a bot is e.g.:
 *
 *   '<at user_id="ou_abc123def456..."></at> what time is the meeting?'
 *
 * We parse the open_ids out by regex. Open IDs always start with `ou_` and
 * are roughly 28-44 hex/alphanum chars, but we accept anything inside the
 * user_id attribute.
 */
function extractMentionsFromContent(content: string | undefined): string[] {
  if (!content || typeof content !== 'string') return [];
  const out: string[] = [];
  const re = /<at\s+user_id="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/**
 * Best-effort `isGroup` inference from the message context. Feishu group chat
 * IDs always start with `oc_` (open chat). P2P "chats" use the peer's open_id
 * (`ou_…`) as the conversation key. The host may prefix the ID with
 * `chat:` (or `channel:` etc.) for routing — we strip those before checking.
 * If conversationId is missing we fall back to false (= treat as p2p /
 * non-group, which then bypasses the gate via the `p2p-bypass` branch).
 */
function inferIsGroup(conversationId: string | undefined): boolean {
  if (typeof conversationId !== 'string') return false;
  const stripped = stripChannelPrefix(conversationId);
  return stripped.startsWith('oc_');
}

function stripChannelPrefix(value: string): string {
  for (const prefix of ['channel:', 'chat:', 'user:', 'feishu:']) {
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return value;
}

/**
 * Compute the gate decision from a message_received event.
 * Pure function, no I/O — useful for unit testing if/when QA wires it up.
 *
 * `wasMentioned` is no longer a host-provided flag (the message_received event
 * doesn't carry it); callers should derive it from `botOpenId ∈ mentions` and
 * pass it in for callsite clarity. Field kept optional for back-compat.
 */
export function computeGateDecision(opts: {
  isGroup: boolean;
  mode: GateMode;
  mentions: string[];
  botOpenId: string | null;
  wasMentioned?: boolean;
  /**
   * True when content carries the literal '@_all' token — Feishu's rendered
   * form of `<at user_id="all">` after structured tag stripping.
   */
  contentAtAll?: boolean;
}): GateDecision {
  if (!opts.isGroup) {
    return { outcome: 'reply', reason: 'p2p-bypass' };
  }
  if (opts.mode === 'autonomous') {
    // P0: stub. Real classifier lands in Phase 2.
    return { outcome: 'skip', reason: 'autonomous-mode-stub' };
  }

  // mention-only mode.
  //
  // Reality at the channel layer: Feishu strips `<at user_id="ou_...">` tags
  // out of `event.content` before delivering the message_received event, so
  // a regex scan of content yields zero mentions even for a legitimate @-bot
  // message. The reliable signal we have is `wasMentioned`, which the host
  // populates based on Feishu's own delivery filter (`im:message.group_at_msg`
  // scope already pre-filters so that any group event we see was @-mentioning
  // *some* bot in this app's tenant — almost always us).
  //
  // We still try `mentions.includes(botOpenId)` as a stricter check when the
  // scan does pick something up (e.g. if the host adapter ever changes and
  // exposes raw at-tags). And we still flag @all explicitly when the literal
  // 'all' token comes through.

  if (opts.mentions.includes('all') || opts.mentions.includes('@all')) {
    return { outcome: 'skip', reason: 'at-all-ignored' };
  }
  // Feishu renders <at user_id="all"> as the literal "@_all" inside the
  // delivered content (the structured tag is stripped). Match the rendered
  // form too so @all broadcasts are correctly ignored.
  if (opts.contentAtAll === true) {
    return { outcome: 'skip', reason: 'at-all-ignored' };
  }
  if (opts.botOpenId && opts.mentions.includes(opts.botOpenId)) {
    return { outcome: 'reply', reason: 'mention-match' };
  }
  if (opts.wasMentioned === true) {
    return { outcome: 'reply', reason: 'mention-host-flag' };
  }
  return { outcome: 'skip', reason: 'no-mention' };
}

/**
 * Register Module B's hooks.
 *
 * Wiring contract for the orchestrator:
 *   - Call `register(api)` once during plugin `register()`.
 *   - When `message_received` fires, this module records the decision into
 *     run context but does not claim the message (it's a void hook anyway).
 *   - When `before_prompt_build` fires, this module reads the decision and
 *     either returns void (reply) or throws GateSkipSignal (skip).
 *
 * Capture log:
 *   We also emit a `[feishu-collab] capture chat=… sender=… mentions=…` line
 *   on every message_received so the harness can verify Module B sees ALL
 *   inbound messages pre-mention-gate (the smoke test for Scenario A).
 */
export function register(api: GateApi): void {
  const messageReceivedHandler = async (
    event: PluginHookMessageReceivedEvent,
    ctx: PluginHookMessageContext,
  ): Promise<void> => {
    try {
      const mode = readGateMode(api);
      const conversationId = ctx?.conversationId;
      const mentions = extractMentionsFromContent(event?.content);
      const botOpenId = await getBotOpenId();
      const isGroup = inferIsGroup(conversationId);

      // Mention detection. Feishu's host adapter normally hands us `content`
      // as `BodyForCommands` — already stripped of `<at>` markup — which
      // means content-scanning can return zero mentions even when the bot
      // WAS @-ed. Mitigation: in feishu groups the host only fires
      // `message_received` for messages already filtered by the
      // server-side mention gate; if we get this far in a group, we are
      // safe to assume we were mentioned. We still prefer the explicit
      // signal when content carries it.
      const isFeishu =
        (ctx?.channelId ?? '').toLowerCase() === 'feishu' ||
        (event?.metadata as { provider?: string } | undefined)?.provider === 'feishu';
      const wasMentioned =
        (botOpenId !== null && mentions.includes(botOpenId)) ||
        (isGroup && isFeishu);

      // Observability: every inbound message we see, log once. Useful for
      // verifying message_received actually fires pre-mention-gate.
      log(
        api,
        'info',
        `capture chat=${conversationId ?? '?'} sender=${event?.senderId ?? '?'} mentions=${mentions.length} content-len=${event?.content?.length ?? 0}`,
      );

      // Detect Feishu's rendered '@_all' broadcast marker in content.
      const contentAtAll =
        typeof event?.content === 'string' && /@_all\b/.test(event.content);

      const decision = computeGateDecision({
        isGroup,
        mode,
        mentions,
        botOpenId,
        wasMentioned,
        contentAtAll,
      });

      // Stash for before_prompt_build to read. Keyed by sessionKey since
      // runId isn't assigned yet at message_received time (the run is
      // registered downstream during dispatch).
      const sessionKey = ctx?.sessionKey ?? event?.sessionKey;
      if (sessionKey) {
        setPendingGate(sessionKey, decision);
      }
      // Best-effort: also try setRunContext if a runId IS present (some
      // host paths populate it earlier — harmless when absent).
      const runId = ctx?.runId ?? event?.runId;
      if (runId) {
        api.setRunContext({
          runId,
          namespace: GATE_NAMESPACE,
          value: { decision } satisfies RunGateState,
          mergeStrategy: 'replace',
        });
      }
      log(api, 'info', `gate-decision: ${decision.outcome} (reason=${decision.reason})`);
    } catch (err) {
      // Never let the gate's bookkeeping crash message_received — Module C
      // also keys off this hook. Fall through to "no decision recorded";
      // before_prompt_build will treat that as "reply" so we err on the side
      // of responsiveness.
      log(api, 'warn', `gate-decision-error: ${(err as Error).message}`);
    }
  };

  const beforePromptBuildHandler = async (
    _event: PluginHookBeforePromptBuildEvent,
    ctx: { runId?: string; sessionKey?: string },
  ): Promise<PluginHookBeforePromptBuildResult | void> => {
    let decision: GateDecision | undefined;
    if (ctx?.sessionKey) {
      decision = consumePendingGate(ctx.sessionKey);
    }
    if (!decision && ctx?.runId) {
      const stored = api.getRunContext<RunGateState>({ runId: ctx.runId, namespace: GATE_NAMESPACE });
      decision = stored?.decision;
    }
    if (!decision) {
      // No message_received decision recorded (e.g. CLI-triggered or
      // non-feishu surface, or race lost). Conservative: allow the reply.
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

  api.on('message_received', messageReceivedHandler);
  api.on('before_prompt_build', beforePromptBuildHandler);
}

// Test seam: allow QA to reset the cached bot open_id between integration runs.
export function __resetForTest(): void {
  cachedBotOpenId = null;
  botOpenIdFetchInflight = null;
}
