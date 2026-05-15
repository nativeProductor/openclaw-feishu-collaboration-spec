// Module C — Context Inject.
//
// Verify:
//   1. Send no-@ msg → Module B skips; context-inject is never invoked. No log.
//   2. Send @-bot msg in an active group →
//        log [feishu-collab] context-injected msgs=<n> chat=<chat_id>
//        bot reply demonstrably references prior chat content
//   3. Send @-bot msg in a chat where lark-cli has no scope →
//        log [feishu-collab] context-fetch failed err=<reason>
//        log [feishu-collab] context-injected msgs=0 (fallback)
//        bot still replies (degraded, no context)
//   4. Set context.enabled=false → no fetch, no injection, no log lines beyond
//      a one-time "context-disabled" debug.
//   5. corpus-supplement is registered exactly once at plugin load (P1.5 stub).
//
// ─────────────────────────────────────────────────────────────────────────────
// Data sources (in priority order):
//
//   1. Module A's local JSONL transcript (lib/transcript-store.ts).
//      Populated by Module A on every `message_received`. Reads are <10ms
//      (single fs.readFileSync + JSON.parse per line). Used when the store
//      has at least `max(3, lastN/2)` rows for the chat.
//
//   2. Live Feishu open-api list endpoint (fallback for cold chats).
//      The raw call we use is:
//
//        lark-cli api GET /open-apis/im/v1/messages \
//          --params '{"container_id_type":"chat","container_id":"<oc_…>",
//                     "page_size":<N+5>,"sort_type":"ByCreateTimeDesc"}' \
//          --as bot
//
//      We deliberately bypass the `+chat-messages-list` shortcut, which
//      adds `only_thread_root_messages=true` and silently filters out every
//      threaded reply (the dominant shape in active group chats).
//
//      Cost: ~1.5–2s (lark-cli spawn + HTTPS round-trip + JSON parse), so
//      we only use it when the transcript is too sparse to satisfy `lastN`.
//
// We over-fetch slightly in both paths because we filter out:
//   - the current trigger message (matched by message_id)
//   - bot's own past replies (matched by bot open_id)
//   - non-text events (system join/leave, recall markers, etc.)
//
// Then we format newest-first and inject via
// `appendSystemContext` on the before_prompt_build result. We chose
// `appendSystemContext` over `appendContext` so providers can cache the rest
// of the system prompt; the per-turn context block is small enough that the
// cache miss only covers it, not the whole prompt.
//
// ─────────────────────────────────────────────────────────────────────────────
// Hook ordering vs Module B.
//
// Both modules register on `before_prompt_build`. Module B throws
// GateSkipSignal when the decision is "skip"; Module C must NOT do work in
// that case (waste of an API call). The SDK invokes hooks in registration
// order (per hook-runner-global.d.ts), so we rely on the orchestrator
// (src/index.ts) registering Module B before Module C. If Module B throws
// the sentinel, Module C never runs. If Module B returns undefined (reply
// allowed), Module C runs next.
//

// Note (2026-05): Both modules switched from `inbound_claim` (which doesn't
// fire for non-bundled plugins on our path) to `message_received` (which
// unconditionally fires pre-mention-gate). The message_received event is
// thinner; we recover chat_id from ctx.conversationId.
// ─────────────────────────────────────────────────────────────────────────────

import { LarkShellError, runLarkCliJson } from '../lib/lark-shell.js';
import { getTranscriptStore, type TranscriptRecord } from '../lib/transcript-store.js';
import { getBotOpenId } from './reply-gate.js';

// `message_received` event/ctx types are declared in the SDK but NOT
// re-exported from `openclaw/plugin-sdk/plugin-entry`. We declare just the
// fields we touch so we don't depend on a private import path. Shape mirrors
// hook-message.types.d.ts.
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

// `before_prompt_build` event/result types live in the SDK but aren't
// re-exported from `openclaw/plugin-sdk/plugin-entry`. We declare the fields
// we touch so we don't reach into a private import path.
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
const CONTEXT_NAMESPACE = 'context-inject';
const GATE_NAMESPACE = 'reply-gate';
const DEFAULT_LAST_N = 20;
const OVERFETCH_PAD = 5;

/**
 * In-memory bridge from `message_received` → `before_prompt_build`,
 * keyed by sessionKey. See reply-gate.ts for the rationale (runId is not
 * assigned at message_received time).
 */
type PendingContext = {
  chatId?: string;
  triggerMessageId?: string;
  channel?: string;
  ts: number;
};
const pendingContextBySession = new Map<string, PendingContext>();
const CONTEXT_PENDING_TTL_MS = 5 * 60_000;

function setPendingContext(sessionKey: string, state: Omit<PendingContext, 'ts'>): void {
  if (!sessionKey) return;
  pendingContextBySession.set(sessionKey, { ...state, ts: Date.now() });
}
function consumePendingContext(sessionKey: string | undefined): PendingContext | undefined {
  if (!sessionKey) return undefined;
  const now = Date.now();
  for (const [k, v] of pendingContextBySession) {
    if (now - v.ts > CONTEXT_PENDING_TTL_MS) pendingContextBySession.delete(k);
  }
  const entry = pendingContextBySession.get(sessionKey);
  if (!entry) return undefined;
  pendingContextBySession.delete(sessionKey);
  return entry;
}

type CtxApi = {
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
  registerMemoryCorpusSupplement?: (supplement: unknown) => void;
};

type ContextRunState = {
  chatId?: string;
  triggerMessageId?: string;
  channel?: string;
};

type GateRunState = {
  decision?: { outcome: 'reply' | 'skip'; reason: string };
};

type FeishuMessage = {
  message_id?: string;
  chat_id?: string;
  msg_type?: string;
  create_time?: string | number;
  update_time?: string | number;
  sender?: {
    id?: string;
    id_type?: string;
    sender_type?: string;
    sender_id?: { open_id?: string; user_id?: string; union_id?: string };
  };
  body?: { content?: string };
  mentions?: Array<{ id?: { open_id?: string }; name?: string; key?: string }>;
};

type LarkListMessagesEnvelope = {
  // lark-cli typically returns the raw open-api envelope verbatim.
  code?: number;
  msg?: string;
  data?: {
    items?: FeishuMessage[];
    has_more?: boolean;
    page_token?: string;
  };
};

function log(api: CtxApi, level: 'info' | 'warn' | 'error' | 'debug', msg: string) {
  const line = `${LOG_PREFIX} ${msg}`;
  const lg = api.logger;
  if (lg && typeof lg[level] === 'function') {
    lg[level]!(line);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(line);
}

function readContextConfig(api: CtxApi): { enabled: boolean; lastN: number } {
  const cfg = api.pluginConfig as
    | { context?: { enabled?: unknown; lastN?: unknown } }
    | undefined;
  const enabled = cfg?.context?.enabled;
  const lastN = cfg?.context?.lastN;
  return {
    enabled: enabled === false ? false : true,
    lastN:
      typeof lastN === 'number' && Number.isFinite(lastN) && lastN > 0
        ? Math.floor(lastN)
        : DEFAULT_LAST_N,
  };
}

function stripChannelPrefix(value: string): string {
  for (const prefix of ['channel:', 'chat:', 'user:', 'feishu:']) {
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return value;
}

function extractChatId(
  event: PluginHookMessageReceivedEvent,
  ctx: PluginHookMessageContext,
): string | undefined {
  // ctx.conversationId is the canonical source under message_received; for
  // Feishu groups this is the `oc_…` chat_id (possibly with a `chat:` host
  // prefix). We strip the prefix so lark-cli calls receive a clean id.
  if (typeof ctx?.conversationId === 'string' && ctx.conversationId.length > 0) {
    return stripChannelPrefix(ctx.conversationId);
  }
  const meta = event?.metadata ?? {};
  const direct = (meta as { chat_id?: unknown; chatId?: unknown; to?: unknown });
  if (typeof direct.chat_id === 'string') return stripChannelPrefix(direct.chat_id);
  if (typeof direct.chatId === 'string') return stripChannelPrefix(direct.chatId);
  if (typeof direct.to === 'string') {
    const stripped = stripChannelPrefix(direct.to);
    if (stripped.startsWith('oc_')) return stripped;
  }
  return undefined;
}

function decodeFeishuText(msg: FeishuMessage): string | null {
  const msgType = msg.msg_type ?? '';
  const rawContent = msg.body?.content;
  if (typeof rawContent !== 'string' || rawContent.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    // Body is sometimes already a plain string for system events.
    return msgType === 'text' ? rawContent : null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  if (msgType === 'text') {
    const text = (parsed as { text?: unknown }).text;
    return typeof text === 'string' ? text : null;
  }
  if (msgType === 'post') {
    // Feishu rich post: { title, content: [[ {tag,text}, ... ]] }
    const content = (parsed as { content?: unknown }).content;
    if (!Array.isArray(content)) return null;
    const lines: string[] = [];
    for (const para of content) {
      if (!Array.isArray(para)) continue;
      const pieces: string[] = [];
      for (const span of para) {
        if (span && typeof span === 'object') {
          const text = (span as { text?: unknown }).text;
          if (typeof text === 'string') pieces.push(text);
        }
      }
      if (pieces.length) lines.push(pieces.join(''));
    }
    return lines.length ? lines.join('\n') : null;
  }
  if (msgType === 'image') return '[图片]';
  if (msgType === 'file') return '[文件]';
  if (msgType === 'audio') return '[语音]';
  if (msgType === 'video') return '[视频]';
  if (msgType === 'sticker') return '[表情]';
  // system events, share_chat, etc. — skip
  return null;
}

function senderOpenId(msg: FeishuMessage): string | undefined {
  return msg.sender?.sender_id?.open_id;
}

function senderDisplayName(msg: FeishuMessage): string {
  // We don't have a name from list-messages alone; show a truncated open_id
  // so the model has a stable handle. The orchestrator (or a later patch)
  // can hydrate names via contact.users.batch if it cares.
  const sid = senderOpenId(msg);
  if (!sid) return 'unknown';
  return sid.length > 12 ? `${sid.slice(0, 4)}…${sid.slice(-4)}` : sid;
}

function formatTimestamp(msg: FeishuMessage): string {
  const t = msg.create_time;
  const ms = typeof t === 'string' ? Number(t) : typeof t === 'number' ? t : NaN;
  if (!Number.isFinite(ms)) return '??:??';
  // Feishu create_time is ms-since-epoch as a stringified number.
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '??:??';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export type FormattedContext = {
  block: string;
  msgCount: number;
};

export function formatContextBlock(opts: {
  messages: FeishuMessage[];
  botOpenId: string | null;
  triggerMessageId: string | undefined;
  lastN: number;
}): FormattedContext {
  const filtered: FeishuMessage[] = [];
  for (const m of opts.messages) {
    if (!m || typeof m !== 'object') continue;
    if (opts.triggerMessageId && m.message_id === opts.triggerMessageId) continue;
    if (opts.botOpenId && senderOpenId(m) === opts.botOpenId) continue;
    const text = decodeFeishuText(m);
    if (!text) continue;
    filtered.push(m);
    if (filtered.length >= opts.lastN) break;
  }
  if (filtered.length === 0) {
    return { block: '', msgCount: 0 };
  }
  const lines = filtered.map((m) => {
    const text = decodeFeishuText(m) ?? '';
    const single = text.replace(/\s+/g, ' ').trim();
    return `[${formatTimestamp(m)}] ${senderDisplayName(m)}: ${single}`;
  });
  const block = [
    '## Recent group conversation (latest first)',
    '',
    ...lines,
  ].join('\n');
  return { block, msgCount: filtered.length };
}

/**
 * Convert a TranscriptRecord (Module A's JSONL row) into the loose
 * FeishuMessage shape used by formatContextBlock. We don't have full Feishu
 * envelope fields here — we only need `message_id`, `create_time`,
 * `body.content`, and `sender.sender_id.open_id`.
 */
function transcriptRecordToFeishuMessage(r: TranscriptRecord): FeishuMessage {
  // formatContextBlock decodes body.content based on msg_type; text records
  // are JSON-encoded `{"text":"..."}` in real Feishu payloads, but Module A
  // stores the raw `event.content` (already a JSON string for posts, plain
  // for text). The simplest, lossless choice: wrap as a `text` msg with the
  // already-decoded `content` re-encoded as `{"text": "..."}` so the
  // existing decoder path works uniformly.
  return {
    message_id: r.messageId,
    msg_type: r.msgType === 'post' ? 'text' : (r.msgType || 'text'),
    create_time: String(r.ts),
    body: { content: JSON.stringify({ text: r.content }) },
    sender: {
      sender_id: { open_id: r.senderOpenId },
    },
  };
}

/**
 * Read the last-N transcript block from Module A's local store. Returns
 * `null` when the store has fewer than `minRows` qualifying records (caller
 * falls back to the live API).
 *
 * Ordering note: the JSONL file is append-only with two writers — direct
 * event-capture (Module A) and API backfill (transcript-backfill.ts). They
 * write at different times, so the file's line order is NOT strictly
 * chronological. We sort by `ts` desc here to recover the true ordering
 * before handing off to `formatContextBlock`, which labels its output
 * "latest first".
 *
 * To cap the cost of the sort we over-read by OVERFETCH_PAD records and
 * trim post-sort to `lastN`, so we never pay more than O((lastN+pad) log)
 * on the tail.
 */
export function readContextBlockFromTranscript(opts: {
  chatId: string;
  lastN: number;
  triggerMessageId?: string;
  botOpenId: string | null;
  /** Minimum useful row count before we trust the local store. */
  minRows: number;
}): FormattedContext | null {
  // Over-fetch a little: we filter out the trigger message and own-bot
  // messages, so the raw tail must be larger than `lastN`.
  const records = getTranscriptStore().readTail(opts.chatId, opts.lastN + OVERFETCH_PAD);
  if (records.length < opts.minRows) return null;
  // Sort newest-first. Stable enough for our needs — ts collisions are rare
  // and inconsequential.
  records.sort((a, b) => b.ts - a.ts);
  const messages = records.map(transcriptRecordToFeishuMessage);
  return formatContextBlock({
    messages,
    botOpenId: opts.botOpenId,
    triggerMessageId: opts.triggerMessageId,
    lastN: opts.lastN,
  });
}

/**
 * Fetch and format the last-N transcript block for a chat. Returns null on
 * any failure (caller logs + degrades gracefully).
 *
 * Implementation note: we call the raw open-api endpoint
 * (`/open-apis/im/v1/messages`) via `lark-cli api GET --params <json>` instead
 * of the `+chat-messages-list` shortcut. The shortcut implicitly sends
 * `only_thread_root_messages=true`, which silently filters out all threaded
 * replies — the dominant message shape in active group chats. Calling the
 * endpoint directly lets us omit that param and get the full transcript.
 */
export async function fetchContextBlock(opts: {
  chatId: string;
  lastN: number;
  triggerMessageId?: string;
  botOpenId: string | null;
}): Promise<FormattedContext | { error: string }> {
  const pageSize = opts.lastN + OVERFETCH_PAD;
  const params = JSON.stringify({
    container_id_type: 'chat',
    container_id: opts.chatId,
    page_size: pageSize,
    sort_type: 'ByCreateTimeDesc',
  });
  try {
    const envelope = await runLarkCliJson<LarkListMessagesEnvelope>(
      [
        'api',
        'GET',
        '/open-apis/im/v1/messages',
        '--params',
        params,
        '--as',
        'bot',
      ],
      { timeoutMs: 12_000 },
    );
    if (envelope && typeof envelope === 'object' && typeof envelope.code === 'number' && envelope.code !== 0) {
      return { error: `lark-api code=${envelope.code} msg=${envelope.msg ?? ''}` };
    }
    const items = envelope?.data?.items ?? [];
    return formatContextBlock({
      messages: items,
      botOpenId: opts.botOpenId,
      triggerMessageId: opts.triggerMessageId,
      lastN: opts.lastN,
    });
  } catch (err) {
    if (err instanceof LarkShellError) {
      return { error: `lark-shell exit=${err.exitCode} stderr=${err.stderr.trim().slice(0, 200)}` };
    }
    return { error: (err as Error).message };
  }
}

/**
 * Phase 1.5 stub: register an empty memory corpus supplement so the
 * `memory_search` tool can be aware of this plugin without surfacing any
 * data yet. Real implementation lands once Module A's SQLite store ships.
 */
function registerCorpusSupplementStub(api: CtxApi): void {
  if (typeof api.registerMemoryCorpusSupplement !== 'function') {
    // Older host build — silently skip.
    return;
  }
  try {
    api.registerMemoryCorpusSupplement({
      async search() {
        return [];
      },
      async get() {
        return null;
      },
    });
    log(api, 'info', 'corpus-supplement registered (stub)');
  } catch (err) {
    log(api, 'warn', `corpus-supplement register failed: ${(err as Error).message}`);
  }
}

export function register(api: CtxApi): void {
  // Phase 1.5 stub — register once on plugin load.
  registerCorpusSupplementStub(api);

  const messageReceivedHandler = async (
    event: PluginHookMessageReceivedEvent,
    ctx: PluginHookMessageContext,
  ): Promise<void> => {
    const sessionKey = ctx?.sessionKey ?? event?.sessionKey;
    const chatId = extractChatId(event, ctx);
    const state = {
      chatId,
      triggerMessageId: event?.messageId ?? ctx?.messageId,
      channel: ctx?.channelId,
    };
    if (sessionKey) {
      setPendingContext(sessionKey, state);
    }
    // Best-effort: also setRunContext if a runId IS present (it usually isn't
    // at message_received time, but no harm if it does).
    const runId = ctx?.runId ?? event?.runId;
    if (runId) {
      try {
        api.setRunContext({
          runId,
          namespace: CONTEXT_NAMESPACE,
          value: state,
          mergeStrategy: 'replace',
        });
      } catch (err) {
        log(api, 'warn', `context-inject setRunContext failed: ${(err as Error).message}`);
      }
    }
  };

  const beforePromptBuildHandler = async (
    _event: PluginHookBeforePromptBuildEvent,
    ctx: { runId?: string; sessionKey?: string },
  ): Promise<PluginHookBeforePromptBuildResult | void> => {
    const cfg = readContextConfig(api);
    if (!cfg.enabled) {
      log(api, 'debug', 'context-disabled (config)');
      return undefined;
    }

    // Prefer the session-key bridge (set by our own message_received) over
    // setRunContext, because runId isn't usually assigned at the time we
    // capture the inbound. Fall back to runContext if present.
    let state: { chatId?: string; triggerMessageId?: string } | undefined =
      consumePendingContext(ctx?.sessionKey);
    if ((!state || !state.chatId) && ctx?.runId) {
      const stored = api.getRunContext<ContextRunState>({
        runId: ctx.runId,
        namespace: CONTEXT_NAMESPACE,
      });
      if (stored?.chatId) state = stored;
    }
    if (!state?.chatId) {
      // No captured feishu context — either CLI-triggered, non-group, or
      // session-key mismatch. Bail silently.
      return undefined;
    }

    const botOpenId = await getBotOpenId();

    // ── Fast path: Module A's local JSONL transcript ──
    // Module A captures every `message_received` event into a per-chat JSONL
    // file. When the local store has enough rows to satisfy `lastN`, we use
    // it — a few-millisecond file read vs the ~1.5–2s lark-cli round-trip.
    //
    // `minRows` heuristic: half the requested lastN, with a floor of 3. If the
    // local store has fewer rows than that, the chat probably hasn't been
    // around long enough for Module A to be useful yet — fall back to the
    // live API which sees server-side history that pre-dates plugin install.
    const localMin = Math.max(3, Math.floor(cfg.lastN / 2));
    const local = readContextBlockFromTranscript({
      chatId: state.chatId,
      lastN: cfg.lastN,
      triggerMessageId: state.triggerMessageId,
      botOpenId,
      minRows: localMin,
    });
    if (local && local.msgCount > 0 && local.block) {
      log(
        api,
        'info',
        `context-injected msgs=${local.msgCount} chat=${state.chatId} src=transcript`,
      );
      return {
        appendSystemContext: local.block,
      };
    }

    // ── Fallback: live Feishu API ──
    const result = await fetchContextBlock({
      chatId: state.chatId,
      lastN: cfg.lastN,
      triggerMessageId: state.triggerMessageId,
      botOpenId,
    });

    if ('error' in result) {
      log(api, 'warn', `context-fetch failed err=${result.error}`);
      log(api, 'info', `context-injected msgs=0 (fallback) chat=${state.chatId}`);
      return undefined;
    }
    log(
      api,
      'info',
      `context-injected msgs=${result.msgCount} chat=${state.chatId} src=lark-api`,
    );
    if (result.msgCount === 0 || !result.block) {
      return undefined;
    }
    return {
      appendSystemContext: result.block,
    };
  };

  api.on('message_received', messageReceivedHandler);
  api.on('before_prompt_build', beforePromptBuildHandler);
}
