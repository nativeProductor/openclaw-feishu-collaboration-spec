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
// Data source today: lark-cli on-demand fetch only.
//
// Module A's transcript SQLite store is still under research (the inbound_claim
// scope question — see docs/architecture.md). Until it lands, we fetch on every
// reply turn via:
//
//   lark-cli im chats.messages list --chat-id <chat_id> --page-size <N+5>
//
// We over-fetch slightly because we filter out:
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
// To stay robust if registration order ever flips, Module C also re-checks
// the run-context gate state and bails out if it sees `outcome: 'skip'`.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
  PluginHookInboundClaimResult,
} from 'openclaw/plugin-sdk/plugin-entry';
import { LarkShellError, runLarkCliJson } from '../lib/lark-shell.js';
import { getBotOpenId } from './reply-gate.js';

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

function extractChatId(event: PluginHookInboundClaimEvent): string | undefined {
  if (typeof event.conversationId === 'string' && event.conversationId.length > 0) {
    return event.conversationId;
  }
  const meta = event.metadata ?? {};
  const direct = (meta as { chat_id?: unknown; chatId?: unknown });
  if (typeof direct.chat_id === 'string') return direct.chat_id;
  if (typeof direct.chatId === 'string') return direct.chatId;
  const raw = (meta as { raw?: unknown }).raw;
  if (raw && typeof raw === 'object') {
    const message = (raw as { message?: { chat_id?: unknown } }).message;
    if (message && typeof message.chat_id === 'string') return message.chat_id;
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
 * Fetch and format the last-N transcript block for a chat. Returns null on
 * any failure (caller logs + degrades gracefully).
 */
export async function fetchContextBlock(opts: {
  chatId: string;
  lastN: number;
  triggerMessageId?: string;
  botOpenId: string | null;
}): Promise<FormattedContext | { error: string }> {
  const pageSize = String(opts.lastN + OVERFETCH_PAD);
  try {
    const envelope = await runLarkCliJson<LarkListMessagesEnvelope>(
      [
        'im',
        'chats.messages',
        'list',
        '--chat-id',
        opts.chatId,
        '--page-size',
        pageSize,
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

  const inboundClaimHandler = async (
    event: PluginHookInboundClaimEvent,
    ctx: PluginHookInboundClaimContext,
  ): Promise<PluginHookInboundClaimResult | void> => {
    const runId = ctx.runId ?? event.runId;
    if (!runId) return undefined;
    const chatId = extractChatId(event);
    const state: ContextRunState = {
      chatId,
      triggerMessageId: event.messageId ?? ctx.messageId,
      channel: event.channel,
    };
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
    return undefined;
  };

  const beforePromptBuildHandler = async (
    _event: PluginHookBeforePromptBuildEvent,
    ctx: { runId?: string },
  ): Promise<PluginHookBeforePromptBuildResult | void> => {
    const cfg = readContextConfig(api);
    if (!cfg.enabled) {
      log(api, 'debug', 'context-disabled (config)');
      return undefined;
    }
    const runId = ctx?.runId;
    if (!runId) return undefined;

    // Defensive cross-check against the gate decision. If Module B somehow
    // ran AFTER us (registration order mishap), we'd otherwise pay for a
    // doomed fetch.
    const gateState = api.getRunContext<GateRunState>({ runId, namespace: GATE_NAMESPACE });
    if (gateState?.decision?.outcome === 'skip') {
      return undefined;
    }

    const state = api.getRunContext<ContextRunState>({ runId, namespace: CONTEXT_NAMESPACE });
    if (!state?.chatId) {
      // No inbound feishu context — either CLI-triggered or non-group.
      return undefined;
    }

    const botOpenId = await getBotOpenId();
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
      `context-injected msgs=${result.msgCount} chat=${state.chatId}`,
    );
    if (result.msgCount === 0 || !result.block) {
      return undefined;
    }
    return {
      appendSystemContext: result.block,
    };
  };

  api.on('inbound_claim', inboundClaimHandler);
  api.on('before_prompt_build', beforePromptBuildHandler);
}
