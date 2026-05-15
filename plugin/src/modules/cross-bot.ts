/**
 * Module D — Universal @-back + graduated brake for bots.
 *
 * Behavior summary (final, per product owner clarification):
 *
 *   - @-back is universal: ANY group inbound (human OR bot) gets an @-mention
 *     prepended to our outgoing reply by default. Basic group etiquette.
 *   - `reply.atBackHumans` / `reply.atBackBots` (both default true) let users
 *     opt out per sender-type.
 *   - The graduated brake only applies when the inbound sender is itself a
 *     bot — humans don't loop, no brake.
 *
 * Graduated brake (D = depth-after-this-turn = stored_depth + 1):
 *
 *   D ≤ 2  → normal @-back
 *   D = 3  → log soft-hint, inject hint into system prompt
 *   D = 4  → log soft-hint, inject stronger hint
 *   D = 5  → drop the @-back (reply goes out plain); peer's mention gate
 *            filters it, conversation fades
 *   D ≥ 6  → hard-skip: do not reply at all
 *
 * Hook bookkeeping (which hook does what):
 *
 *   `agent_end`:
 *     - The most reliable hook for "we just replied". We use it to bump
 *       depth for (chat_id, peer_app_id) when the inbound we just answered
 *       was sent by a bot, and to RESET the chain when the inbound was sent
 *       by a human (or any non-bot sender).
 *     - After bumping, we *also* compute the soft hint for the NEXT turn
 *       (so if we're at depth=2 now, when the peer pings us again, our
 *       next pre-generation will pull D=3 and emit the soft hint).
 *
 *   `before_prompt_build`:
 *     - Reads stored depth and the pending hint registry.
 *     - If next-depth would be ≥ 6 → returns `{ skip: true }` to short-circuit.
 *     - If next-depth is 3 or 4 → injects the corresponding hint string into
 *       the system prompt.
 *     - Marks an in-band flag (via the pending hint registry) so the
 *       outbound-rewrite hook (`llm_output`) knows whether to drop the @-back.
 *
 *   `llm_output`:
 *     - Prepends `<at user_id="…"></at>` to the reply text, subject to the
 *       atBack* config flags and the depth-5 drop-@-back rule.
 *
 *   `inbound_claim`:
 *     - Module A owns this hook for transcript capture. Module D doesn't
 *       claim from it; we rely on `before_prompt_build` to see the inbound
 *       via its `ctx.inbound` / `event` payload.
 */

import {
  parseInboundSummary,
  isBotSender,
  shouldResetChain,
  isGroupChat,
  type InboundSummary,
} from '../lib/feishu-payload.js';
import {
  getLoopStateStore,
  getPendingHintRegistry,
} from '../lib/state.js';

const LOG_PREFIX = '[feishu-collab]';

// Hint copy — kept inline so there's no separate i18n surface to wire up.
const HINT_D3 =
  '你已经和另一个 bot 来回了 3 轮,如果话题接近收束,本轮做一个总结也很合适。';
const HINT_D4 =
  '你已经和另一个 bot 来回了 4 轮,强烈建议本轮做一个收束,把后续交回给人类参与者。';

// Decision thresholds — match spec exactly. Configurable via crossBot.loopGuard.*
// but defaults below make the module install-and-go.
const DEFAULT_SOFT_HINT_AT_DEPTH = 3;
const DEFAULT_MAX_DEPTH = 5;

interface CrossBotConfig {
  atBackHumans: boolean;
  atBackBots: boolean;
  loopGuardEnabled: boolean;
  maxDepth: number;
  softHintAtDepth: number;
}

const DEFAULT_CONFIG: CrossBotConfig = {
  atBackHumans: true,
  atBackBots: true,
  loopGuardEnabled: true,
  maxDepth: DEFAULT_MAX_DEPTH,
  softHintAtDepth: DEFAULT_SOFT_HINT_AT_DEPTH,
};

/**
 * Read plugin config from whatever shape the host gives us, falling back to
 * defaults. We accept both the new shape (`crossBot.atBackHumans`, etc.) and
 * the legacy shape (`crossBot.atBack`, `crossBot.loopMaxDepth`,
 * `crossBot.softHintAtDepth`) so this works before the orchestrator merges
 * in the spec-recommended config additions.
 */
function readConfig(rawCfg: unknown): CrossBotConfig {
  const out: CrossBotConfig = { ...DEFAULT_CONFIG };
  if (!rawCfg || typeof rawCfg !== 'object') return out;
  const cfg = rawCfg as Record<string, unknown>;
  const cb = cfg.crossBot;
  if (!cb || typeof cb !== 'object') return out;
  const c = cb as Record<string, unknown>;

  if (typeof c.atBackHumans === 'boolean') out.atBackHumans = c.atBackHumans;
  if (typeof c.atBackBots === 'boolean') out.atBackBots = c.atBackBots;

  // Legacy: a single `atBack` flag drove both. If new flags are absent but
  // the old one is set, mirror it onto both new flags.
  if (
    typeof c.atBack === 'boolean' &&
    typeof c.atBackHumans !== 'boolean' &&
    typeof c.atBackBots !== 'boolean'
  ) {
    out.atBackHumans = c.atBack;
    out.atBackBots = c.atBack;
  }

  const lg = c.loopGuard;
  if (lg && typeof lg === 'object') {
    const l = lg as Record<string, unknown>;
    if (typeof l.enabled === 'boolean') out.loopGuardEnabled = l.enabled;
    if (typeof l.maxDepth === 'number') out.maxDepth = l.maxDepth;
    if (typeof l.softHintAtDepth === 'number')
      out.softHintAtDepth = l.softHintAtDepth;
  } else {
    // Legacy flat fields.
    if (typeof c.loopMaxDepth === 'number') out.maxDepth = c.loopMaxDepth;
    if (typeof c.softHintAtDepth === 'number')
      out.softHintAtDepth = c.softHintAtDepth;
  }

  return out;
}

/** Try to find the host's own bot app_id from the runtime context. */
function readOwnAppId(ctx: unknown): string {
  if (!ctx || typeof ctx !== 'object') return '';
  const c = ctx as Record<string, unknown>;
  // Common shapes we accept (host adapter dependent):
  const direct = c.botAppId ?? c.ownAppId ?? c.appId;
  if (typeof direct === 'string') return direct;
  const account = c.account;
  if (account && typeof account === 'object') {
    const a = account as Record<string, unknown>;
    if (typeof a.appId === 'string') return a.appId;
    if (typeof a.app_id === 'string') return a.app_id;
  }
  const channel = c.channel;
  if (channel && typeof channel === 'object') {
    const ch = channel as Record<string, unknown>;
    if (typeof ch.appId === 'string') return ch.appId;
    if (typeof ch.app_id === 'string') return ch.app_id;
  }
  return process.env.FEISHU_APP_ID || process.env.LARK_APP_ID || '';
}

/** Pull the inbound event payload off whatever shape `before_prompt_build` gives us. */
function readInboundFromCtx(event: unknown, ctx: unknown): unknown {
  const e = (event && typeof event === 'object') ? (event as Record<string, unknown>) : undefined;
  const c = (ctx && typeof ctx === 'object') ? (ctx as Record<string, unknown>) : undefined;
  // Try a few likely fields.
  if (e?.inbound) return e.inbound;
  if (e?.message) return event;
  if (e?.event) return e;
  if (c?.inbound) return c.inbound;
  if (c?.lastInbound) return c.lastInbound;
  return event;
}

/**
 * Pull the configuration blob the host attached to context. Different host
 * versions use different keys; we probe a few likely ones, falling back to
 * an empty object (defaults apply).
 */
function readPluginCfgFromCtx(ctx: unknown): unknown {
  if (!ctx || typeof ctx !== 'object') return undefined;
  const c = ctx as Record<string, unknown>;
  return c.config ?? c.pluginConfig ?? c.cfg;
}

// ---------------------------------------------------------------------------
// Cross-hook inbound bridge
//
// The host fires `llm_output` and `agent_end` without an inbound payload on
// `event`/`ctx` — Module B/C run into the same gap and use a sessionKey-keyed
// Map to bridge from `message_received` to `before_prompt_build`. We do the
// same so Module D's outbound @-back rewrite and depth bookkeeping can read
// the inbound that triggered this turn.
// ---------------------------------------------------------------------------

interface CachedInbound {
  summary: InboundSummary;
  ts: number;
}

const inboundBySession = new Map<string, CachedInbound>();
const INBOUND_CACHE_MAX = 256;

function setPendingInbound(sessionKey: string, summary: InboundSummary): void {
  if (!sessionKey) return;
  inboundBySession.set(sessionKey, { summary, ts: Date.now() });
  // Cap size; evict the oldest entry on overflow.
  if (inboundBySession.size > INBOUND_CACHE_MAX) {
    let oldestKey: string | undefined;
    let oldestTs = Infinity;
    for (const [k, v] of inboundBySession) {
      if (v.ts < oldestTs) {
        oldestTs = v.ts;
        oldestKey = k;
      }
    }
    if (oldestKey) inboundBySession.delete(oldestKey);
  }
}

function peekPendingInbound(sessionKey: string | undefined): InboundSummary | undefined {
  if (!sessionKey) return undefined;
  return inboundBySession.get(sessionKey)?.summary;
}

function evictPendingInbound(sessionKey: string | undefined): void {
  if (!sessionKey) return;
  inboundBySession.delete(sessionKey);
}

/** Extract sessionKey from event or ctx (host populates one of them). */
function readSessionKey(event: unknown, ctx: unknown): string | undefined {
  const e = event && typeof event === 'object' ? (event as Record<string, unknown>) : undefined;
  const c = ctx && typeof ctx === 'object' ? (ctx as Record<string, unknown>) : undefined;
  const candidates = [
    e?.sessionKey,
    (e as Record<string, unknown> | undefined)?.['session_key'],
    c?.sessionKey,
    (c as Record<string, unknown> | undefined)?.['session_key'],
  ];
  for (const v of candidates) {
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

/**
 * Resolve the inbound summary for a hook that may not carry it directly.
 * Tries event/ctx first (works for `before_prompt_build`); falls back to the
 * sessionKey cache populated at `message_received` (needed for `llm_output`
 * and `agent_end`).
 */
function resolveInboundSummary(event: unknown, ctx: unknown): InboundSummary {
  // First try envelope/flat parsing on the live event+ctx.
  const direct = parseInboundSummary(readInboundFromCtx(event, ctx), ctx);
  if (direct.senderOpenId || direct.chatId) return direct;
  // Fall back to the cache populated at message_received time.
  const cached = peekPendingInbound(readSessionKey(event, ctx));
  return cached ?? direct;
}

/**
 * Build the `<at>` prefix for an open_id. Feishu rich-text accepts
 * `<at user_id="ou_xxxx"></at>` to render an @-mention.
 */
function buildAtPrefix(openId: string): string {
  return `<at user_id="${openId}"></at> `;
}

/**
 * Best-effort: read whatever the LLM produced as the outbound text from the
 * `llm_output` event. We accept both `event.text` and `event.output.text`
 * and `event.content`.
 */
function readOutboundText(event: unknown): string {
  if (typeof event === 'string') return event;
  if (!event || typeof event !== 'object') return '';
  const e = event as Record<string, unknown>;
  if (typeof e.text === 'string') return e.text;
  if (typeof e.content === 'string') return e.content;
  const out = e.output;
  if (out && typeof out === 'object') {
    const o = out as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.content === 'string') return o.content;
  }
  // OpenClaw `llm_output` event surfaces the model text as:
  //   - event.lastAssistant: string  (the most recent assistant message)
  //   - event.assistantTexts: string[] (all assistant turns this run)
  if (typeof e.lastAssistant === 'string') return e.lastAssistant;
  const ats = e.assistantTexts;
  if (Array.isArray(ats) && ats.length > 0) {
    const tail = ats[ats.length - 1];
    if (typeof tail === 'string') return tail;
  }
  return '';
}

/** Mutate-in-place writer for the same payload, preserving the host's wrapper. */
function writeOutboundText(event: unknown, newText: string): void {
  if (!event || typeof event !== 'object') return;
  const e = event as Record<string, unknown>;
  // Prefer OpenClaw's llm_output canonical fields when present.
  if (typeof e.lastAssistant === 'string') {
    e.lastAssistant = newText;
    const ats = e.assistantTexts;
    if (Array.isArray(ats) && ats.length > 0) {
      // Keep the array in sync so downstream readers see the same value.
      ats[ats.length - 1] = newText;
    }
    return;
  }
  if (Array.isArray(e.assistantTexts) && e.assistantTexts.length > 0) {
    e.assistantTexts[e.assistantTexts.length - 1] = newText;
    return;
  }
  if (typeof e.text === 'string') {
    e.text = newText;
    return;
  }
  if (typeof e.content === 'string') {
    e.content = newText;
    return;
  }
  const out = e.output;
  if (out && typeof out === 'object') {
    const o = out as Record<string, unknown>;
    if (typeof o.text === 'string') {
      o.text = newText;
      return;
    }
    if (typeof o.content === 'string') {
      o.content = newText;
      return;
    }
  }
  // No known field — attach a fallback so the host adapter can find it.
  e.text = newText;
}

// Internal flag the cross-bot module attaches to the pending hint registry
// to signal "drop the @-back for this turn even if config allows it".
// We piggyback on the same registry to avoid introducing a second module
// of shared state.
function dropAtBackKey(chatId: string, peerAppId: string): string {
  // Use a sentinel namespace prefix the hint registry's `consumeByChat` won't
  // collide with hints (it does string startsWith on the chat prefix).
  return `__drop_at__::${chatId}::${peerAppId}`;
}

/**
 * Pre-compute the hint / brake decision for the *next* outbound, given the
 * inbound we just observed. Returns:
 *   - skip:   true if D ≥ maxDepth+1 → host should not generate a reply
 *   - dropAt: true if D === maxDepth → reply goes out without @-back
 *   - hint:   non-empty when D === softHintAtDepth or softHintAtDepth+1
 *   - nextD:  the projected depth if we DO reply
 */
interface BrakeDecision {
  skip: boolean;
  dropAt: boolean;
  hint: string;
  nextD: number;
}

function decideBrake(
  storedDepth: number,
  cfg: CrossBotConfig,
): BrakeDecision {
  const nextD = storedDepth + 1;
  const decision: BrakeDecision = {
    skip: false,
    dropAt: false,
    hint: '',
    nextD,
  };
  if (!cfg.loopGuardEnabled) return decision;
  if (nextD >= cfg.maxDepth + 1) {
    decision.skip = true;
    return decision;
  }
  if (nextD === cfg.maxDepth) {
    decision.dropAt = true;
    return decision;
  }
  if (nextD === cfg.softHintAtDepth) decision.hint = HINT_D3;
  else if (nextD === cfg.softHintAtDepth + 1) decision.hint = HINT_D4;
  return decision;
}

/**
 * Inject a hint into a system prompt structure. We accept a few common shapes:
 *   - `event.systemPrompt` (string)             → append
 *   - `event.system` (string)                   → append
 *   - `event.messages` (array, message[0].role==='system') → append to content
 *   - none of the above                          → set `event.systemPromptHint`
 *     as a fallback the host may pick up
 */
function injectSystemHint(event: unknown, hint: string): void {
  if (!event || typeof event !== 'object' || !hint) return;
  const e = event as Record<string, unknown>;
  const appended = (existing: string) =>
    existing ? `${existing}\n\n[loop-guard hint]\n${hint}` : `[loop-guard hint]\n${hint}`;

  if (typeof e.systemPrompt === 'string') {
    e.systemPrompt = appended(e.systemPrompt);
    return;
  }
  if (typeof e.system === 'string') {
    e.system = appended(e.system);
    return;
  }
  const msgs = e.messages;
  if (Array.isArray(msgs)) {
    const sysMsg = msgs.find(
      (m): m is Record<string, unknown> =>
        !!m && typeof m === 'object' && (m as Record<string, unknown>).role === 'system',
    );
    if (sysMsg && typeof sysMsg.content === 'string') {
      sysMsg.content = appended(sysMsg.content);
      return;
    }
    // No system message yet → prepend one.
    msgs.unshift({ role: 'system', content: appended('') });
    return;
  }
  e.systemPromptHint = hint;
}

// ---------------------------------------------------------------------------
// Public registration
// ---------------------------------------------------------------------------

/**
 * PluginApi shape we rely on. The host types `api.on(hookName, handler)`
 * with a discriminated union we don't have access to from a plugin — so we
 * accept `any` and rely on the hook names being strings.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PluginApi = any;

export function register(api: PluginApi): void {
  const store = getLoopStateStore();
  const hints = getPendingHintRegistry();

  // ---- message_received: stash inbound for llm_output/agent_end ----
  // `message_received` is the only hook the host fires for every inbound with
  // the full payload. `llm_output` and `agent_end` lack the inbound payload,
  // so we cache the parsed summary keyed by sessionKey here and read it back
  // in those later hooks.
  api.on('message_received', async (event: unknown, ctx?: unknown) => {
    const sessionKey = readSessionKey(event, ctx);
    if (!sessionKey) return undefined;
    // Pass ctx so the flat message_received shape resolves (chat_id is in ctx.conversationId).
    const summary = parseInboundSummary(event, ctx);
    if (!summary.chatId && !summary.senderOpenId) return undefined;
    setPendingInbound(sessionKey, summary);
    // Note: OpenClaw's message_received event does NOT carry `sender_type` —
    // metadata exposes {to, provider, surface, originatingChannel, messageId,
    // senderId, senderName} but no user-vs-app discriminator. To distinguish
    // human from bot peers we'd need to either (a) cache `im.v1.chats.members.bots`
    // per chat, (b) lookup via `messages-mget` per message, or (c) hit
    // contact/v3/users and treat 41050 as "is a bot". TODO for the bot-bot
    // brake; currently we treat unknown sender_type as human (no brake), which
    // is the safe default. The @-back rewrite still works in both cases.
    // eslint-disable-next-line no-console
    console.log(
      `${LOG_PREFIX} cross-bot inbound-cached chat=${summary.chatId} sender=${summary.senderOpenId || '?'} type=${summary.senderType || '?'}`,
    );
    return undefined;
  });

  // ---- before_prompt_build: read depth, decide skip/hint, mark drop-@ ----
  api.on('before_prompt_build', async (event: unknown, ctx?: unknown) => {
    const cfg = readConfig(readPluginCfgFromCtx(ctx));
    const summary = resolveInboundSummary(event, ctx);

    // Only operate in group chats. P2P has no loop dynamics.
    if (!isGroupChat(summary)) return undefined;

    // Defensive self-check — never @-mention or chain against ourselves.
    const ownAppId = readOwnAppId(ctx);
    if (ownAppId && summary.peerAppId && summary.peerAppId === ownAppId) {
      return undefined;
    }

    // Only the bot-bot case engages the graduated brake. Human inbound: nop.
    if (!isBotSender(summary) || !summary.peerAppId || !summary.chatId) {
      return undefined;
    }

    const storedDepth = store.getDepth(summary.chatId, summary.peerAppId);
    const decision = decideBrake(storedDepth, cfg);

    if (decision.skip) {
      // eslint-disable-next-line no-console
      console.log(
        `${LOG_PREFIX} cross-bot hard-skip depth=${decision.nextD}`,
      );
      // Signal skip back to the host. We return an object the host can
      // consult; we also try the common boolean shape just in case.
      return { skip: true, reason: 'feishu-collab:cross-bot:hard-skip' };
    }

    if (decision.dropAt) {
      // eslint-disable-next-line no-console
      console.log(
        `${LOG_PREFIX} cross-bot drop-at depth=${decision.nextD}`,
      );
      // Stash a marker the outbound-rewrite hook will read.
      hints.set(
        summary.chatId,
        dropAtBackKey(summary.chatId, summary.peerAppId),
        '1',
      );
    }

    if (decision.hint) {
      // eslint-disable-next-line no-console
      console.log(
        `${LOG_PREFIX} cross-bot soft-hint depth=${decision.nextD}`,
      );
      injectSystemHint(event, decision.hint);
      // Also stash for any handler that prefers pull semantics.
      hints.set(summary.chatId, summary.peerAppId, decision.hint);
    }

    return undefined;
  });

  // ---- llm_output: rewrite outbound text to prepend @-back ----
  api.on('llm_output', async (event: unknown, ctx?: unknown) => {
    const cfg = readConfig(readPluginCfgFromCtx(ctx));
    const summary = resolveInboundSummary(event, ctx);

    if (!isGroupChat(summary)) return undefined;
    if (!summary.senderOpenId) return undefined;

    // Self-check.
    const ownAppId = readOwnAppId(ctx);
    if (ownAppId && summary.peerAppId && summary.peerAppId === ownAppId) {
      return undefined;
    }

    // Honor per-sender-type opt-out.
    const senderIsBot = isBotSender(summary);
    if (senderIsBot && !cfg.atBackBots) return undefined;
    if (!senderIsBot && !cfg.atBackHumans) return undefined;

    // Honor depth-5 drop-@ decision recorded earlier.
    if (senderIsBot && summary.peerAppId) {
      const drop = hints.consume(
        summary.chatId,
        dropAtBackKey(summary.chatId, summary.peerAppId),
      );
      if (drop) return undefined; // Reply goes out plain.
    }

    const existing = readOutboundText(event);
    const prefix = buildAtPrefix(summary.senderOpenId);
    // Idempotency — if the LLM already produced an @-tag for this user,
    // don't double up.
    if (existing.includes(`user_id="${summary.senderOpenId}"`)) return undefined;
    const newText = `${prefix}${existing}`;
    writeOutboundText(event, newText);
    // eslint-disable-next-line no-console
    console.log(
      `${LOG_PREFIX} cross-bot reply-with-at target=${summary.senderOpenId} (sender=${summary.senderType || 'unknown'})`,
    );
    return undefined;
  });

  // ---- agent_end: bump depth on bot-inbound replies, reset on human ----
  // NOTE: do NOT evict the inbound cache here. In practice the host fires
  // agent_end BEFORE llm_output completes (or the relative order is racy),
  // so evicting on agent_end strands llm_output with an empty summary.
  // The cache is bounded by INBOUND_CACHE_MAX (LRU-ish eviction on overflow),
  // so leaving entries is safe and bounded.
  api.on('agent_end', async (event: unknown, ctx?: unknown) => {
    const summary = resolveInboundSummary(event, ctx);

    if (!isGroupChat(summary) || !summary.chatId) return undefined;

    // Self-check.
    const ownAppId = readOwnAppId(ctx);
    if (ownAppId && summary.peerAppId && summary.peerAppId === ownAppId) {
      return undefined;
    }

    if (shouldResetChain(summary)) {
      // Any non-bot inbound that we just replied to resets the chain for
      // every peer in the chat — humans speaking re-zero the loop counters.
      store.resetChain(summary.chatId);
      // eslint-disable-next-line no-console
      console.log(
        `${LOG_PREFIX} cross-bot depth reset chat=${summary.chatId} (human turn)`,
      );
      return undefined;
    }

    // Bot inbound that we just replied to → bump depth.
    if (summary.peerAppId) {
      const newDepth = store.bumpDepth(summary.chatId, summary.peerAppId);
      // eslint-disable-next-line no-console
      console.log(
        `${LOG_PREFIX} cross-bot depth bump chat=${summary.chatId} peer=${summary.peerAppId} depth=${newDepth}`,
      );
    }
    return undefined;
  });
}

export default register;

// ---------------------------------------------------------------------------
// ## Config additions needed (orchestrator merges into openclaw.plugin.json + config.ts)
//
// crossBot:
//   atBackHumans: boolean (default true)
//     - When true and inbound sender_type === 'user', the bot prepends an
//       @-mention to its reply. Set to false to silence universal @-back
//       for humans (e.g. for quieter chats).
//   atBackBots: boolean (default true)
//     - Same as above but for inbound sender_type === 'app' (peer bots).
//     - This replaces the legacy `crossBot.atBack` flag.
//   loopGuard:
//     enabled: boolean (default true)
//       - Master switch for the graduated brake. When false, bot→bot chains
//         are uncapped (NOT recommended outside of test fixtures).
//     maxDepth: integer (default 5)
//       - Depth at which the @-back is dropped; depth+1 hard-skips the reply.
//         Replaces legacy `crossBot.loopMaxDepth`.
//     softHintAtDepth: integer (default 3)
//       - Depth at which the first soft hint is injected. The stronger
//         hint fires at softHintAtDepth+1. Replaces legacy
//         `crossBot.softHintAtDepth`.
//
// JSON Schema (drop in under `configSchema.properties.crossBot.properties`):
//
//   "atBackHumans": { "type": "boolean", "default": true },
//   "atBackBots":   { "type": "boolean", "default": true },
//   "loopGuard": {
//     "type": "object",
//     "additionalProperties": false,
//     "properties": {
//       "enabled":         { "type": "boolean", "default": true },
//       "maxDepth":        { "type": "integer", "default": 5, "minimum": 1, "maximum": 20 },
//       "softHintAtDepth": { "type": "integer", "default": 3, "minimum": 1, "maximum": 20 }
//     }
//   }
//
// TypeBox (drop in under FeishuCollabConfig.crossBot):
//
//   atBackHumans: Type.Optional(Type.Boolean()),
//   atBackBots:   Type.Optional(Type.Boolean()),
//   loopGuard: Type.Optional(Type.Object({
//     enabled:         Type.Optional(Type.Boolean()),
//     maxDepth:        Type.Optional(Type.Number()),
//     softHintAtDepth: Type.Optional(Type.Number()),
//   })),
//
// Legacy `crossBot.atBack`, `crossBot.loopMaxDepth`, `crossBot.softHintAtDepth`
// should be removed in the same merge — readConfig() above still tolerates
// them for transitional reads but they will no longer be documented.
