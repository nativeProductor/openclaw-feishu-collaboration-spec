/**
 * Module A's passive transcript store.
 *
 * Per-chat JSONL file at:
 *   ~/.openclaw-<profile>/state/feishu-collab/transcripts/<chat_id>.jsonl
 *
 * Append-only, one JSON record per line:
 *   { ts, chatId, senderOpenId, senderName, msgType, messageId, content }
 *
 * Bounded by a max-line cap (default 2000). On overflow we rewrite the file
 * with the most recent 2/3 of records (atomic temp+rename). Append latency
 * is `fs.appendFileSync` + a cheap line-counter; rotation cost is amortized.
 *
 * Module C reads the tail via {@link readTranscriptTail}. The store is
 * deliberately dumb about message semantics — it stores whatever Module A
 * captures from `message_received`, including any future non-@ messages
 * (currently blocked by Feishu event subscription scope).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveStateDir } from './state.js';

export interface TranscriptRecord {
  /** Capture timestamp (ms since epoch). */
  ts: number;
  chatId: string;
  /** Sender open_id; `''` if unknown. */
  senderOpenId: string;
  /** Best-effort display name; `''` if unknown. */
  senderName: string;
  /** Feishu msg_type (`text`, `post`, `image`, etc.) or `'unknown'`. */
  msgType: string;
  /** Feishu message_id; `''` if unknown. */
  messageId: string;
  /** Decoded text body, single-line. Empty for non-text events. */
  content: string;
}

export interface TranscriptStoreOptions {
  /** Override the state-dir base; tests pass a tmp path. */
  baseDir?: string;
  /** Max records to keep per chat before rotation. */
  maxLines?: number;
  /** Profile name override; defaults to env-driven resolveStateDir(). */
  profile?: string;
}

const DEFAULT_MAX_LINES = 2000;
/** Rotation keeps this fraction of the max after trimming. */
const RETAIN_FRACTION = 2 / 3;

export class TranscriptStore {
  private readonly baseDir: string;
  private readonly maxLines: number;

  constructor(opts: TranscriptStoreOptions = {}) {
    this.baseDir =
      opts.baseDir ?? path.join(resolveStateDir(opts.profile), 'transcripts');
    this.maxLines =
      typeof opts.maxLines === 'number' && opts.maxLines > 10
        ? Math.floor(opts.maxLines)
        : DEFAULT_MAX_LINES;
  }

  /** Filesystem path for a chat's transcript file. */
  pathFor(chatId: string): string {
    return path.join(this.baseDir, `${chatId}.jsonl`);
  }

  /**
   * Append a record. Never throws — write failures are logged to stderr but
   * never propagate; capture is best-effort and must not break the dispatch
   * pipeline.
   */
  append(record: TranscriptRecord): void {
    if (!record.chatId) return;
    try {
      if (!fs.existsSync(this.baseDir)) {
        fs.mkdirSync(this.baseDir, { recursive: true });
      }
      const file = this.pathFor(record.chatId);
      // Single-line JSON; replace embedded newlines defensively.
      const line =
        JSON.stringify({
          ts: record.ts,
          chatId: record.chatId,
          senderOpenId: record.senderOpenId || '',
          senderName: record.senderName || '',
          msgType: record.msgType || 'unknown',
          messageId: record.messageId || '',
          content: (record.content || '').replace(/\r?\n/g, ' '),
        }) + '\n';
      fs.appendFileSync(file, line, { encoding: 'utf8' });
      this.maybeRotate(file);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[feishu-collab] transcript-store append failed chat=${record.chatId} err=${(err as Error).message}`,
      );
    }
  }

  /**
   * Read the most recent N records for a chat (newest LAST). Returns [] if
   * the file is missing, empty, or unreadable.
   */
  readTail(chatId: string, n: number): TranscriptRecord[] {
    if (!chatId || n <= 0) return [];
    const file = this.pathFor(chatId);
    if (!fs.existsSync(file)) return [];
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    if (!raw) return [];
    const lines = raw.split('\n');
    const out: TranscriptRecord[] = [];
    // Walk from the end so we can stop at N without parsing the whole file.
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
      const line = lines[i];
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as TranscriptRecord;
        if (parsed && typeof parsed === 'object' && typeof parsed.chatId === 'string') {
          out.push(parsed);
        }
      } catch {
        // skip malformed
      }
    }
    // out is newest-first because we walked backward; reverse to chronological.
    return out.reverse();
  }

  /** Returns the number of lines in a chat's transcript file. 0 if missing. */
  size(chatId: string): number {
    const file = this.pathFor(chatId);
    if (!fs.existsSync(file)) return 0;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw) return 0;
      let count = 0;
      for (const line of raw.split('\n')) if (line.length > 0) count++;
      return count;
    } catch {
      return 0;
    }
  }

  /** Test-only: clear a chat's transcript. */
  clear(chatId: string): void {
    const file = this.pathFor(chatId);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // swallow
    }
  }

  /**
   * Rotate the file if it exceeds the line cap. Atomic via temp+rename so a
   * crash mid-rotation can't lose all data (the original is intact until the
   * rename succeeds).
   */
  private maybeRotate(file: string): void {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    const lines = raw.split('\n').filter((l) => l.length > 0);
    if (lines.length <= this.maxLines) return;
    const retain = Math.floor(this.maxLines * RETAIN_FRACTION);
    const kept = lines.slice(lines.length - retain).join('\n') + '\n';
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, kept, { encoding: 'utf8' });
      fs.renameSync(tmp, file);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[feishu-collab] transcript-store rotate failed file=${file} err=${(err as Error).message}`,
      );
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        // swallow
      }
    }
  }
}

// Singleton — most callers use this. Tests instantiate their own.
let singleton: TranscriptStore | undefined;

export function getTranscriptStore(): TranscriptStore {
  if (!singleton) singleton = new TranscriptStore();
  return singleton;
}

/** Convenience tail-reader using the singleton. */
export function readTranscriptTail(chatId: string, n: number): TranscriptRecord[] {
  return getTranscriptStore().readTail(chatId, n);
}

/** Test-only: drop the singleton so tests can configure baseDir. */
export function _resetTranscriptStoreSingletonForTests(): void {
  singleton = undefined;
}
