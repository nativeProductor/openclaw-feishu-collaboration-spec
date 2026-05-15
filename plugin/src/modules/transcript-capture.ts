// Module A — Passive transcript capture.
//
// Subscribes to `message_received` for every inbound Feishu message the host
// delivers and appends a normalized record to the per-chat JSONL transcript
// store (see lib/transcript-store.ts). Module C reads from this store; Module
// D's logic is unaffected.
//
// Capture vs reply:
//   - Module A captures BOTH @-mentioned and non-@-mentioned messages —
//     anything that reaches `message_received` is fair game.
//   - Module B is what decides whether to reply.
//   - The two modules are independent.
//
// Current Feishu delivery situation (2026-05):
//   The Feishu plugin in this build only delivers `group_at_msg` events to
//   `message_received`; we don't yet see non-@ messages here. Module A still
//   captures whatever lands. Once the event-subscription scope question is
//   resolved upstream, Module A will automatically pick up the extra traffic
//   with no code change.
//
// Why JSONL (not SQLite):
//   - One write = one `fs.appendFileSync` ≈ <1ms on local disk; SQLite is
//     ~2ms with WAL plus a binding dependency.
//   - Tail-read is line-walk-backwards, O(N) on the bounded tail (N≤2000).
//   - Plain text is grep-able from the shell during ops — useful for QA.
//   - No npm dep added.

import { parseInboundSummary } from '../lib/feishu-payload.js';
import { getTranscriptStore } from '../lib/transcript-store.js';

const LOG_PREFIX = '[feishu-collab]';

// Subset of the message_received event we use here. Full type lives in the
// SDK but isn't re-exported from `openclaw/plugin-sdk/plugin-entry`.
type PluginHookMessageReceivedEvent = {
  from?: string;
  content?: string;
  timestamp?: number;
  messageId?: string;
  senderId?: string;
  sessionKey?: string;
  metadata?: Record<string, unknown>;
};
type PluginHookMessageContext = {
  channelId?: string;
  conversationId?: string;
  messageId?: string;
};

type CtxApi = {
  on: (hookName: string, handler: (...args: any[]) => any) => void;
  logger?: {
    info?: (m: string) => void;
    debug?: (m: string) => void;
    warn?: (m: string) => void;
  };
};

function log(api: CtxApi, level: 'info' | 'debug' | 'warn', msg: string): void {
  const line = `${LOG_PREFIX} ${msg}`;
  const lg = api.logger;
  if (lg && typeof lg[level] === 'function') {
    lg[level]!(line);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(line);
}

function readSenderName(
  event: PluginHookMessageReceivedEvent,
): string {
  const meta = event.metadata;
  if (meta && typeof meta === 'object') {
    const m = meta as Record<string, unknown>;
    if (typeof m.senderName === 'string' && m.senderName) return m.senderName;
    if (typeof m.senderUsername === 'string' && m.senderUsername) return m.senderUsername;
  }
  return '';
}

function readMsgType(event: PluginHookMessageReceivedEvent): string {
  const meta = event.metadata;
  if (meta && typeof meta === 'object') {
    const m = meta as Record<string, unknown>;
    if (typeof m.msg_type === 'string') return m.msg_type;
    if (typeof m.msgType === 'string') return m.msgType;
  }
  return 'text';
}

export function register(api: CtxApi): void {
  const store = getTranscriptStore();

  api.on(
    'message_received',
    async (
      event: PluginHookMessageReceivedEvent,
      ctx: PluginHookMessageContext,
    ): Promise<void> => {
      const summary = parseInboundSummary(event, ctx);
      if (!summary.chatId) {
        // P2P / unknown — skip; transcript is group-scoped.
        return;
      }
      const senderName = readSenderName(event);
      const msgType = readMsgType(event);
      const content = typeof event?.content === 'string' ? event.content : '';
      store.append({
        ts: typeof event?.timestamp === 'number' ? event.timestamp : Date.now(),
        chatId: summary.chatId,
        senderOpenId: summary.senderOpenId,
        senderName,
        msgType,
        messageId: summary.messageId || event?.messageId || ctx?.messageId || '',
        content,
      });
      log(
        api,
        'debug',
        `transcript captured chat=${summary.chatId} sender=${summary.senderOpenId || '?'} type=${msgType} bytes=${content.length}`,
      );
    },
  );
}
