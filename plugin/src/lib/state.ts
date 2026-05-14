/**
 * Loop-guard runtime state for Module D.
 *
 * Per spec, this is NOT user-editable config: it lives under
 *   ~/.openclaw-<profile>/state/feishu-collab/loop-state.json
 *
 * Schema:
 *   {
 *     "$schemaVersion": 1,
 *     "chats": {
 *       "<chat_id>": {
 *         "lastHumanTs": <epoch_ms>,
 *         "bots": { "<peer_app_id>": { "depth": <int>, "lastTurnTs": <epoch_ms> } }
 *       }
 *     }
 *   }
 *
 * Writes are atomic: write to `<file>.tmp` then `rename` over the target.
 * Reads are tolerant of missing / corrupt files (return empty state).
 *
 * Also exposes a small in-memory "pending hint" registry used to bridge the
 * two hooks involved in the graduated brake: depth bookkeeping happens at
 * `agent_end` (after we know what we replied to), but the soft hint must be
 * injected at `before_prompt_build` (before generation). The registry maps
 * (chat_id, peer_app_id) → next-turn hint payload so the prompt-builder hook
 * can read and consume it without touching disk.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export const LOOP_STATE_SCHEMA_VERSION = 1 as const;

export interface BotChainEntry {
  depth: number;
  lastTurnTs: number;
}

export interface ChatLoopState {
  lastHumanTs: number;
  bots: Record<string, BotChainEntry>;
}

export interface LoopStateFile {
  $schemaVersion: typeof LOOP_STATE_SCHEMA_VERSION;
  chats: Record<string, ChatLoopState>;
}

function emptyState(): LoopStateFile {
  return { $schemaVersion: LOOP_STATE_SCHEMA_VERSION, chats: {} };
}

/**
 * Resolve the state directory for a given openclaw profile. The host normally
 * exposes the profile name via env (`OPENCLAW_PROFILE`) or context; we accept
 * an override and fall back to `default`.
 */
export function resolveStateDir(profile?: string): string {
  const p =
    profile ||
    process.env.OPENCLAW_PROFILE ||
    process.env.OPENCLAW_PROFILE_NAME ||
    'default';
  return path.join(os.homedir(), `.openclaw-${p}`, 'state', 'feishu-collab');
}

export function resolveStateFile(profile?: string): string {
  return path.join(resolveStateDir(profile), 'loop-state.json');
}

function ensureChat(state: LoopStateFile, chatId: string): ChatLoopState {
  let entry = state.chats[chatId];
  if (!entry) {
    entry = { lastHumanTs: 0, bots: {} };
    state.chats[chatId] = entry;
  }
  if (!entry.bots || typeof entry.bots !== 'object') entry.bots = {};
  if (typeof entry.lastHumanTs !== 'number') entry.lastHumanTs = 0;
  return entry;
}

function ensureBot(chat: ChatLoopState, peerAppId: string): BotChainEntry {
  let bot = chat.bots[peerAppId];
  if (!bot) {
    bot = { depth: 0, lastTurnTs: 0 };
    chat.bots[peerAppId] = bot;
  }
  if (typeof bot.depth !== 'number') bot.depth = 0;
  if (typeof bot.lastTurnTs !== 'number') bot.lastTurnTs = 0;
  return bot;
}

function validate(parsed: unknown): LoopStateFile {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return emptyState();
  }
  const obj = parsed as Record<string, unknown>;
  const chatsRaw = obj.chats;
  const out = emptyState();
  if (chatsRaw && typeof chatsRaw === 'object' && !Array.isArray(chatsRaw)) {
    for (const [chatId, chatVal] of Object.entries(
      chatsRaw as Record<string, unknown>,
    )) {
      if (!chatVal || typeof chatVal !== 'object' || Array.isArray(chatVal)) {
        continue;
      }
      const cv = chatVal as Record<string, unknown>;
      const chat = ensureChat(out, chatId);
      if (typeof cv.lastHumanTs === 'number') chat.lastHumanTs = cv.lastHumanTs;
      const botsRaw = cv.bots;
      if (botsRaw && typeof botsRaw === 'object' && !Array.isArray(botsRaw)) {
        for (const [peer, botVal] of Object.entries(
          botsRaw as Record<string, unknown>,
        )) {
          if (!botVal || typeof botVal !== 'object' || Array.isArray(botVal)) {
            continue;
          }
          const bv = botVal as Record<string, unknown>;
          const b = ensureBot(chat, peer);
          if (typeof bv.depth === 'number') b.depth = bv.depth;
          if (typeof bv.lastTurnTs === 'number') b.lastTurnTs = bv.lastTurnTs;
        }
      }
    }
  }
  return out;
}

/**
 * Singleton in-memory store. We keep the on-disk file as the durable record
 * but mirror it in memory so hot paths (hook handlers) don't pay file I/O
 * on every event for the read side.
 */
class LoopStateStore {
  private cache: LoopStateFile | null = null;
  private filePath: string;

  constructor(profile?: string) {
    this.filePath = resolveStateFile(profile);
  }

  /** Override the file path (test/dev hook). */
  setFilePath(p: string): void {
    this.filePath = p;
    this.cache = null;
  }

  getFilePath(): string {
    return this.filePath;
  }

  /** Load (and memoize) the current state. Safe on missing / corrupt files. */
  load(): LoopStateFile {
    if (this.cache) return this.cache;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.cache = validate(parsed);
    } catch {
      this.cache = emptyState();
    }
    return this.cache;
  }

  /** Persist current state to disk atomically (write tmp + rename). */
  flush(): void {
    if (!this.cache) return;
    const dir = path.dirname(this.filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // Best-effort; the writeFile below will surface a real error if so.
    }
    const tmp = `${this.filePath}.tmp`;
    const payload = JSON.stringify(this.cache, null, 2);
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  /** Read current depth for (chat_id, peer_app_id). Returns 0 when unknown. */
  getDepth(chatId: string, peerAppId: string): number {
    if (!chatId || !peerAppId) return 0;
    const state = this.load();
    const chat = state.chats[chatId];
    if (!chat) return 0;
    const bot = chat.bots[peerAppId];
    return bot ? bot.depth : 0;
  }

  /**
   * Increment depth for (chat_id, peer_app_id) and persist. Returns the new
   * depth value. Updates `lastTurnTs` to `now`.
   */
  bumpDepth(chatId: string, peerAppId: string, now: number = Date.now()): number {
    const state = this.load();
    const chat = ensureChat(state, chatId);
    const bot = ensureBot(chat, peerAppId);
    bot.depth += 1;
    bot.lastTurnTs = now;
    this.flush();
    return bot.depth;
  }

  /**
   * Reset depth for one peer in one chat (or all peers if `peerAppId` is
   * undefined). Also stamps `lastHumanTs` to `now`. Persists.
   */
  resetChain(
    chatId: string,
    peerAppId?: string,
    now: number = Date.now(),
  ): void {
    if (!chatId) return;
    const state = this.load();
    const chat = ensureChat(state, chatId);
    chat.lastHumanTs = now;
    if (peerAppId) {
      const bot = ensureBot(chat, peerAppId);
      bot.depth = 0;
      bot.lastTurnTs = now;
    } else {
      for (const k of Object.keys(chat.bots)) {
        chat.bots[k].depth = 0;
        chat.bots[k].lastTurnTs = now;
      }
    }
    this.flush();
  }

  /** Test/diagnostic accessor — returns a deep clone of the cached state. */
  snapshot(): LoopStateFile {
    return JSON.parse(JSON.stringify(this.load())) as LoopStateFile;
  }
}

/**
 * Pending hint registry — pure in-memory; survives only the process lifetime.
 * Bridges `agent_end` (decides hint) → `before_prompt_build` (consumes hint).
 *
 * Keyed by `${chatId}::${peerAppId}` because the same chat might host
 * conversations with multiple distinct peer bots.
 */
class PendingHintRegistry {
  private hints = new Map<string, string>();

  private key(chatId: string, peerAppId: string): string {
    return `${chatId}::${peerAppId}`;
  }

  set(chatId: string, peerAppId: string, hint: string): void {
    if (!chatId || !peerAppId || !hint) return;
    this.hints.set(this.key(chatId, peerAppId), hint);
  }

  /** Look up by exact (chat_id, peer_app_id). */
  peek(chatId: string, peerAppId: string): string | undefined {
    return this.hints.get(this.key(chatId, peerAppId));
  }

  /**
   * Look up by chat_id only — returns the first hint registered for any
   * peer in that chat. Useful at `before_prompt_build` time when we may
   * not have a confirmed peer_app_id yet on the inbound side.
   */
  peekByChat(chatId: string): string | undefined {
    for (const [k, v] of this.hints) {
      if (k.startsWith(`${chatId}::`)) return v;
    }
    return undefined;
  }

  /** Consume (read + delete) a hint for the given peer. */
  consume(chatId: string, peerAppId: string): string | undefined {
    const k = this.key(chatId, peerAppId);
    const v = this.hints.get(k);
    if (v !== undefined) this.hints.delete(k);
    return v;
  }

  /** Consume any hint registered for `chatId` (first match wins). */
  consumeByChat(chatId: string): string | undefined {
    for (const [k, v] of this.hints) {
      if (k.startsWith(`${chatId}::`)) {
        this.hints.delete(k);
        return v;
      }
    }
    return undefined;
  }

  clear(): void {
    this.hints.clear();
  }
}

// Single global instances. The module is loaded once per process, so this
// is effectively a singleton — exactly what Module D needs.
let _store: LoopStateStore | null = null;
let _hints: PendingHintRegistry | null = null;

export function getLoopStateStore(): LoopStateStore {
  if (!_store) _store = new LoopStateStore();
  return _store;
}

export function getPendingHintRegistry(): PendingHintRegistry {
  if (!_hints) _hints = new PendingHintRegistry();
  return _hints;
}

/** Test / diagnostic helper. */
export function __resetForTests(): void {
  _store = null;
  _hints = null;
}

// Type-only re-exports for ergonomic consumption (the classes themselves
// stay module-private; consumers must go through the getters above).
export type LoopStateStoreType = LoopStateStore;
export type PendingHintRegistryType = PendingHintRegistry;
