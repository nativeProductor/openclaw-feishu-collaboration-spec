/**
 * Feishu chat bot-membership cache.
 *
 * OpenClaw's `message_received` event metadata does NOT pass `sender_type`
 * through to plugins (see `toPluginMessageReceivedEvent` in
 * message-hook-mappers). Module D needs to distinguish bot peers from human
 * senders to engage the graduated brake, so we look up which open_ids in a
 * given chat are bots ahead of time and check the inbound sender against
 * that set.
 *
 * Lookup endpoint:
 *   GET /open-apis/im/v1/chats/{chat_id}/members/bots
 *
 * Returns `{ items: [{ bot_id, bot_name }] }`. `bot_id` is the open_id of
 * each bot member, scoped to the calling app's tenant view (which is exactly
 * the same scoping the inbound sender open_id uses, so equality works).
 *
 * Caching:
 *   - Per-chat. Re-fetched on TTL expiry (default 10 min).
 *   - Cache shape is a Set of open_ids — we don't need bot_name here.
 *   - Negative results (API error) are cached for a short window (30s) to
 *     avoid hammering the API when scopes are missing.
 */

import { LarkShellError, runLarkCliJson } from './lark-shell.js';

const POSITIVE_TTL_MS = 10 * 60_000;
const NEGATIVE_TTL_MS = 30_000;

type CacheEntry = {
  bots: Set<string>;
  /** Empty set + `negative=true` means "we tried, got an error". */
  negative: boolean;
  expiresAt: number;
};

const cacheByChat = new Map<string, CacheEntry>();
/**
 * In-flight promise dedup: avoids two concurrent before_prompt_build calls
 * for the same chat both firing a lark-cli child process.
 */
const inFlight = new Map<string, Promise<Set<string>>>();

type BotsEnvelope = {
  code?: number;
  msg?: string;
  data?: {
    items?: Array<{ bot_id?: string; bot_name?: string }>;
  };
};

async function fetchBotMembers(chatId: string): Promise<Set<string>> {
  const envelope = await runLarkCliJson<BotsEnvelope>(
    [
      'api',
      'GET',
      `/open-apis/im/v1/chats/${chatId}/members/bots`,
      '--as',
      'bot',
    ],
    { timeoutMs: 10_000 },
  );
  if (envelope && typeof envelope.code === 'number' && envelope.code !== 0) {
    throw new Error(`lark-api code=${envelope.code} msg=${envelope.msg ?? ''}`);
  }
  const set = new Set<string>();
  for (const item of envelope?.data?.items ?? []) {
    if (item && typeof item.bot_id === 'string' && item.bot_id) {
      set.add(item.bot_id);
    }
  }
  return set;
}

/**
 * Look up bot open_ids in a chat, with TTL caching. Never throws; returns an
 * empty Set on lookup failure (caller treats the inbound as a human peer, the
 * safe default — @-back still works, brake just doesn't engage).
 */
export async function getBotOpenIdsInChat(chatId: string): Promise<Set<string>> {
  if (!chatId) return new Set();
  const now = Date.now();
  const cached = cacheByChat.get(chatId);
  if (cached && now < cached.expiresAt) {
    return cached.bots;
  }
  const existing = inFlight.get(chatId);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const bots = await fetchBotMembers(chatId);
      cacheByChat.set(chatId, {
        bots,
        negative: false,
        expiresAt: now + POSITIVE_TTL_MS,
      });
      return bots;
    } catch (err) {
      // Cache the negative briefly. Don't surface — caller treats missing
      // sender_type as "human" which is the safe default.
      const empty = new Set<string>();
      cacheByChat.set(chatId, {
        bots: empty,
        negative: true,
        expiresAt: now + NEGATIVE_TTL_MS,
      });
      const reason =
        err instanceof LarkShellError
          ? `exit=${err.exitCode} stderr=${err.stderr.trim().slice(0, 120)}`
          : (err as Error).message;
      // eslint-disable-next-line no-console
      console.warn(
        `[feishu-collab] bot-members lookup failed chat=${chatId} err=${reason}`,
      );
      return empty;
    } finally {
      inFlight.delete(chatId);
    }
  })();
  inFlight.set(chatId, promise);
  return promise;
}

/**
 * Synchronous cache peek. Returns undefined if the chat hasn't been looked up
 * yet (caller should fall back to `getBotOpenIdsInChat`).
 */
export function peekBotOpenIdsInChat(chatId: string): Set<string> | undefined {
  const entry = cacheByChat.get(chatId);
  if (!entry || Date.now() >= entry.expiresAt) return undefined;
  return entry.bots;
}

/** Test-only: drop all cache state. */
export function _resetBotMembersCacheForTests(): void {
  cacheByChat.clear();
  inFlight.clear();
}
