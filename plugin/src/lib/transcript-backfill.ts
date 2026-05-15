/**
 * Opportunistic transcript backfill (Path A from the design discussion).
 *
 * Feishu's WebSocket event stream deliberately omits one class of message:
 * messages sent by OTHER bots that don't @-mention us. The
 * `im:message.group_msg` scope only covers user-authored non-@ messages
 * (docs explicitly note "不含机器人消息"). The `im/v1/messages` REST endpoint
 * has no such omission — it returns the full history including peer-bot
 * non-@ messages.
 *
 * Strategy:
 *   - Every time Module A captures an inbound event (any inbound — @ or
 *     not, user or bot), kick off a fire-and-forget API pull for the same
 *     chat.
 *   - The pull asks for the recent N messages, dedups against the local
 *     store's recent tail by message_id, and appends only the new ones.
 *   - Per-chat throttle (MIN_INTERVAL_MS) and in-flight dedup keep the API
 *     call rate proportional to inbound event rate, not multiplied by it.
 *
 * Why per-chat (not global): two different chats can race their own
 * backfills concurrently — they share no state. But two backfills for the
 * SAME chat would duplicate work and risk race-y appends, so we coalesce
 * them with `inFlightByChat`.
 *
 * Cost model: one extra lark-cli child + API round-trip per qualifying
 * inbound event. Both happen OFF the reply hot path (Module C's
 * before_prompt_build reads the local store directly, never blocks on the
 * backfill). Steady-state QPS is exactly the inbound-event rate, throttled
 * to one call per chat per MIN_INTERVAL_MS.
 */

import { LarkShellError, runLarkCliJson } from './lark-shell.js';
import type { TranscriptStore, TranscriptRecord } from './transcript-store.js';

const MIN_INTERVAL_MS = 3000;
const PAGE_SIZE = 30;
/** Dedup window: how far back in the local store we read message_ids. */
const DEDUP_TAIL_ROWS = 100;

const lastRunByChat = new Map<string, number>();
const inFlightByChat = new Map<string, Promise<number>>();

type FeishuApiSender = {
  id?: string;
  id_type?: string;
  sender_type?: string;
  sender_id?: { open_id?: string; user_id?: string; union_id?: string };
};

type FeishuApiItem = {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  body?: { content?: string };
  sender?: FeishuApiSender;
};

type FeishuApiEnvelope = {
  code?: number;
  msg?: string;
  data?: {
    items?: FeishuApiItem[];
  };
};

/**
 * Decode Feishu message body to plain text. Mirrors the helper in
 * context-inject.ts but lives here to keep transcript-backfill self-contained
 * (no inter-module circular deps).
 */
function decodeFeishuContent(msgType: string | undefined, rawBody: string | undefined): string {
  if (!rawBody) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return msgType === 'text' ? rawBody : '';
  }
  if (!parsed || typeof parsed !== 'object') return '';
  if (msgType === 'text') {
    const t = (parsed as { text?: unknown }).text;
    return typeof t === 'string' ? t : '';
  }
  if (msgType === 'post') {
    const content = (parsed as { content?: unknown }).content;
    if (!Array.isArray(content)) return '';
    const lines: string[] = [];
    for (const para of content) {
      if (!Array.isArray(para)) continue;
      const pieces: string[] = [];
      for (const span of para) {
        if (span && typeof span === 'object') {
          const t = (span as { text?: unknown }).text;
          if (typeof t === 'string') pieces.push(t);
        }
      }
      if (pieces.length) lines.push(pieces.join(''));
    }
    return lines.join('\n');
  }
  // Lightweight placeholders for non-text events; matches context-inject.ts.
  if (msgType === 'image') return '[图片]';
  if (msgType === 'file') return '[文件]';
  if (msgType === 'audio') return '[语音]';
  if (msgType === 'video') return '[视频]';
  if (msgType === 'sticker') return '[表情]';
  return '';
}

function resolveSenderOpenId(sender: FeishuApiSender | undefined): string {
  if (!sender) return '';
  // Structured field (preferred for users).
  if (sender.sender_id && typeof sender.sender_id.open_id === 'string' && sender.sender_id.open_id) {
    return sender.sender_id.open_id;
  }
  // For users, `id` is often the open_id; for bots `id` is the app_id.
  // Either way it's a stable per-tenant handle, suitable for display.
  if (typeof sender.id === 'string' && sender.id) return sender.id;
  return '';
}

export interface BackfillOptions {
  /** App_id of the running bot, used to skip our own outbound replies. */
  ownAppId?: string;
  /** Max API page size; default 30. */
  pageSize?: number;
}

/**
 * Fetch recent chat history and merge new rows into the local transcript.
 *
 * Returns the number of rows appended. Never throws — failures are logged
 * to stderr and reported as `0` appended. Safe to call from a
 * fire-and-forget context (Module A's message_received handler).
 */
export function backfillChatTranscript(
  chatId: string,
  store: TranscriptStore,
  opts: BackfillOptions = {},
): Promise<number> {
  if (!chatId) return Promise.resolve(0);

  const existing = inFlightByChat.get(chatId);
  if (existing) return existing;

  const now = Date.now();
  const last = lastRunByChat.get(chatId) ?? 0;
  if (now - last < MIN_INTERVAL_MS) return Promise.resolve(0);
  lastRunByChat.set(chatId, now);

  const pageSize = opts.pageSize ?? PAGE_SIZE;

  const promise = (async (): Promise<number> => {
    try {
      const params = JSON.stringify({
        container_id_type: 'chat',
        container_id: chatId,
        page_size: pageSize,
        sort_type: 'ByCreateTimeDesc',
      });
      const envelope = await runLarkCliJson<FeishuApiEnvelope>(
        ['api', 'GET', '/open-apis/im/v1/messages', '--params', params, '--as', 'bot'],
        { timeoutMs: 10_000 },
      );
      if (envelope && typeof envelope.code === 'number' && envelope.code !== 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[feishu-collab] transcript-backfill api-error chat=${chatId} code=${envelope.code} msg=${envelope.msg ?? ''}`,
        );
        return 0;
      }
      const items = envelope?.data?.items ?? [];
      if (items.length === 0) return 0;

      // Build a fast-lookup of recent message_ids to skip dupes.
      const known = new Set(
        store
          .readTail(chatId, DEDUP_TAIL_ROWS)
          .map((r) => r.messageId)
          .filter((id) => id.length > 0),
      );

      // API gives us newest-first; we want to append oldest-first so the
      // file stays in chronological order matching event-capture writes.
      const candidates = items.slice().reverse();
      let added = 0;
      for (const item of candidates) {
        const msgId = typeof item.message_id === 'string' ? item.message_id : '';
        if (!msgId || known.has(msgId)) continue;
        if (opts.ownAppId && item.sender?.id === opts.ownAppId) continue;
        const ts = typeof item.create_time === 'string' ? Number(item.create_time) : NaN;
        if (!Number.isFinite(ts)) continue;
        const senderOpenId = resolveSenderOpenId(item.sender);
        const record: TranscriptRecord = {
          ts,
          chatId,
          senderOpenId,
          senderName: '',
          msgType: item.msg_type ?? 'unknown',
          messageId: msgId,
          content: decodeFeishuContent(item.msg_type, item.body?.content),
        };
        store.append(record);
        known.add(msgId);
        added++;
      }
      if (added > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[feishu-collab] transcript-backfill chat=${chatId} added=${added} scanned=${items.length}`,
        );
      }
      return added;
    } catch (err) {
      const reason =
        err instanceof LarkShellError
          ? `exit=${err.exitCode} stderr=${err.stderr.trim().slice(0, 120)}`
          : (err as Error).message;
      // eslint-disable-next-line no-console
      console.warn(
        `[feishu-collab] transcript-backfill failed chat=${chatId} err=${reason}`,
      );
      return 0;
    } finally {
      inFlightByChat.delete(chatId);
    }
  })();

  inFlightByChat.set(chatId, promise);
  return promise;
}

/** Test-only: reset all per-chat throttle / in-flight state. */
export function _resetBackfillStateForTests(): void {
  lastRunByChat.clear();
  inFlightByChat.clear();
}
