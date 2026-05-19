/**
 * Pure helpers for parsing Feishu/Lark inbound event payloads into a small
 * typed `InboundSummary`. No I/O, no side effects, no host calls — purely
 * structural shape extraction. Reusable by Modules B/C/D.
 *
 * The official Feishu IM event shape we care about is roughly:
 *
 *   {
 *     event: {
 *       sender: {
 *         sender_id: { open_id?: string, union_id?: string, user_id?: string, app_id?: string },
 *         sender_type: 'user' | 'app' | 'anonymous' | 'tenant' | string,
 *         tenant_key?: string,
 *       },
 *       message: {
 *         chat_id: string,
 *         chat_type: 'p2p' | 'group' | string,
 *         message_id: string,
 *         mentions?: Array<{
 *           key: string,
 *           id: { open_id?: string, union_id?: string, user_id?: string },
 *           name?: string,
 *           tenant_key?: string,
 *         }>,
 *         message_type?: string,
 *         content?: string,
 *       },
 *     },
 *   }
 *
 * In practice the host channel may pre-normalize this; we accept either the
 * raw IM event or an already-flattened shape (`event.sender`, `event.message`,
 * or `event.payload.event.sender`, etc.) and probe defensively.
 */

export type FeishuSenderType = 'user' | 'app' | 'anonymous' | 'tenant' | string;

export interface InboundSummary {
  /** open_id of the entity that sent the inbound message. Empty string if unknown. */
  senderOpenId: string;
  /** sender_type as reported by Feishu. 'user' for humans, 'app' for bots. */
  senderType: FeishuSenderType;
  /** True if any mention in `message.mentions` resolves to an app (bot) rather than a user. */
  isMentionedByBot: boolean;
  /**
   * If the inbound was sent BY another bot, the peer's app_id (best-effort).
   * Empty string when sender is a user or app_id is not present in the payload.
   */
  peerAppId: string;
  /** Chat id, for state keying. Empty string if unknown. */
  chatId: string;
  /** 'p2p' | 'group' | …; empty string if unknown. */
  chatType: string;
  /** Inbound message_id, for debugging. Empty string if unknown. */
  messageId: string;
}

/** Safe `unknown` → object|undefined narrowing. */
function asObj(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asStr(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Walk the event payload defensively to find the Feishu IM `event` envelope
 * (the inner one that contains `sender` + `message`). Different host adapters
 * pass slightly different shapes:
 *   - `{ event: { sender, message } }` (raw v2 IM event)
 *   - `{ payload: { event: { … } } }` (some webhook wrappers)
 *   - `{ sender, message }` (already-unwrapped)
 */
function findFeishuEnvelope(input: unknown): Record<string, unknown> | undefined {
  const root = asObj(input);
  if (!root) return undefined;

  // Already unwrapped.
  if (asObj(root.message) || asObj(root.sender)) return root;

  const evt = asObj(root.event);
  if (evt && (asObj(evt.message) || asObj(evt.sender))) return evt;

  const payload = asObj(root.payload);
  if (payload) {
    const inner = asObj(payload.event);
    if (inner && (asObj(inner.message) || asObj(inner.sender))) return inner;
    if (asObj(payload.message) || asObj(payload.sender)) return payload;
  }

  return undefined;
}

/**
 * Strip OpenClaw routing prefixes from a conversationId to recover the
 * underlying Feishu chat_id. Examples:
 *   "chat:oc_38e..."        → "oc_38e..."
 *   "feishu:chat:oc_38e..." → "oc_38e..."
 *   "oc_38e..."             → "oc_38e..."
 */
export function stripChannelPrefix(value: string): string {
  let out = value;
  // strip up to two layers of "<prefix>:" if they don't match the Feishu id shape
  for (let i = 0; i < 2; i++) {
    if (out.startsWith('oc_') || out.startsWith('ou_') || out.startsWith('on_')) break;
    const idx = out.indexOf(':');
    if (idx < 0) break;
    out = out.slice(idx + 1);
  }
  return out;
}

/**
 * Parse the FLAT `message_received` shape:
 *   event = { from, content, senderId, messageId, sessionKey, runId, metadata, ... }
 *   ctx   = { channelId, accountId, conversationId, sessionKey, messageId, senderId, ... }
 *
 * Returns a partial InboundSummary; merged with envelope-based parsing by the
 * caller. The two shapes are NOT mutually exclusive — some hosts populate
 * both, in which case envelope wins (richer info).
 */
function parseFlatMessageReceived(
  event: Record<string, unknown> | undefined,
  ctx: Record<string, unknown> | undefined,
): Partial<InboundSummary> {
  if (!event && !ctx) return {};

  // sender open_id: event.from / event.senderId / ctx.senderId
  // OpenClaw namespaces ids like "feishu:ou_xxx"; strip the routing prefix.
  const senderOpenIdRaw =
    asStr(event?.from) || asStr(event?.senderId) || asStr(ctx?.senderId);
  const senderOpenId = senderOpenIdRaw ? stripChannelPrefix(senderOpenIdRaw) : '';

  // chat_id: ctx.conversationId, possibly prefixed
  const conversationId = asStr(ctx?.conversationId);
  const chatId = conversationId ? stripChannelPrefix(conversationId) : '';

  // chat_type: heuristic — Feishu group chat ids start with 'oc_'
  let chatType = '';
  if (chatId.startsWith('oc_')) chatType = 'group';
  else if (chatId.startsWith('ou_') || chatId.startsWith('on_')) chatType = 'p2p';

  // sender_type: best-effort from event.metadata.senderType / sender_type
  const meta = asObj(event?.metadata);
  let senderType = asStr(meta?.sender_type) || asStr(meta?.senderType);
  // Fallback: try sender_id.app_id presence in metadata
  const metaSenderId = asObj(meta?.sender_id);
  const metaAppId = asStr(metaSenderId?.app_id) || asStr(meta?.app_id);

  // peer_app_id: only set if metadata explicitly reveals an app_id
  const peerAppId = metaAppId;

  // If we have a peer app_id, sender is a bot.
  if (peerAppId && !senderType) senderType = 'app';

  // mentions: scan event.content for <at user_id="ou_..."> tags
  // (Feishu rich text includes <at> tags in `content`.)
  const content = asStr(event?.content);
  let isMentionedByBot = false;
  if (content) {
    // We can't reliably tell from raw `<at user_id="ou_xxx">` alone whether
    // the mention target is a bot — that requires a member-list lookup.
    // Leave isMentionedByBot=false; Module B/D's caller logic that needs this
    // signal can supplement via member-cache or by checking metadata.mentions.
    // Mentions list in metadata, if host provides it:
    const metaMentions = meta?.mentions;
    if (Array.isArray(metaMentions)) {
      for (const m of metaMentions) {
        const mo = asObj(m);
        if (!mo) continue;
        const mid = asObj(mo.id);
        if (mid && asStr(mid.app_id)) {
          isMentionedByBot = true;
          break;
        }
        if (asStr(mo.app_id)) {
          isMentionedByBot = true;
          break;
        }
      }
    }
  }

  const messageId = asStr(event?.messageId) || asStr(ctx?.messageId);

  return {
    senderOpenId,
    senderType: (senderType || '') as FeishuSenderType,
    isMentionedByBot,
    peerAppId,
    chatId,
    chatType,
    messageId,
  };
}

/**
 * Parse an inbound event payload into a normalized {@link InboundSummary}.
 *
 * Handles BOTH event shapes:
 *   - Nested envelope (inbound_claim / raw IM event): `event.message.sender.…`
 *   - Flat message_received: `event.from / event.content / ctx.conversationId`
 *
 * Always returns a fully-shaped object; missing fields are empty strings
 * (or `false` for booleans). Never throws on malformed input.
 *
 * Pass `ctx` whenever you're called from a hook that gets it — the flat
 * message_received shape requires ctx.conversationId for chat_id.
 */
export function parseInboundSummary(rawEvent: unknown, ctx?: unknown): InboundSummary {
  const envelope = findFeishuEnvelope(rawEvent);
  const sender = asObj(envelope?.sender);
  const senderId = asObj(sender?.sender_id);
  const message = asObj(envelope?.message);

  const envelopeSenderOpenId = asStr(senderId?.open_id);
  const envelopeSenderType = asStr(sender?.sender_type) as FeishuSenderType;
  const envelopePeerAppId = asStr(senderId?.app_id);
  const envelopeChatId = asStr(message?.chat_id);
  const envelopeChatType = asStr(message?.chat_type);
  const envelopeMessageId = asStr(message?.message_id);

  const mentionsRaw = message?.mentions;
  const mentions: unknown[] = Array.isArray(mentionsRaw) ? mentionsRaw : [];
  let envelopeIsMentionedByBot = false;
  for (const m of mentions) {
    const mo = asObj(m);
    if (!mo) continue;
    const mid = asObj(mo.id);
    if (mid && asStr(mid.app_id)) {
      envelopeIsMentionedByBot = true;
      break;
    }
    if (asStr(mo.app_id)) {
      envelopeIsMentionedByBot = true;
      break;
    }
  }

  // If envelope-based parsing gave us anything substantive, use it.
  const envelopeUseful = !!(envelopeSenderOpenId || envelopeChatId);

  if (envelopeUseful) {
    return {
      senderOpenId: envelopeSenderOpenId,
      senderType: envelopeSenderType,
      isMentionedByBot: envelopeIsMentionedByBot,
      peerAppId: envelopePeerAppId,
      chatId: envelopeChatId,
      chatType: envelopeChatType,
      messageId: envelopeMessageId,
    };
  }

  // Fall back to flat message_received shape (event + ctx).
  const flat = parseFlatMessageReceived(asObj(rawEvent), asObj(ctx));
  return {
    senderOpenId: flat.senderOpenId ?? '',
    senderType: (flat.senderType ?? '') as FeishuSenderType,
    isMentionedByBot: flat.isMentionedByBot ?? false,
    peerAppId: flat.peerAppId ?? '',
    chatId: flat.chatId ?? '',
    chatType: flat.chatType ?? '',
    messageId: flat.messageId ?? '',
  };
}

/**
 * True iff this inbound came from another bot (sender_type === 'app').
 * Convenience wrapper for the common predicate.
 */
export function isBotSender(summary: InboundSummary): boolean {
  return summary.senderType === 'app';
}

/**
 * True iff this inbound came from a human (sender_type === 'user').
 * 'tenant' / 'anonymous' / unknown values are treated as non-human for the
 * graduated brake's purposes but Module D resets `depth` on any non-bot.
 */
export function isHumanSender(summary: InboundSummary): boolean {
  return summary.senderType === 'user';
}

/**
 * True iff this inbound resets the bot-bot loop chain. Anything that is not
 * a confirmed 'app' sender (user, tenant, anonymous, unknown) counts as a
 * "human-equivalent" turn that breaks the chain.
 */
export function shouldResetChain(summary: InboundSummary): boolean {
  return summary.senderType !== 'app';
}

/** True iff `summary.chatType === 'group'`. P2P chats have no loop dynamics. */
export function isGroupChat(summary: InboundSummary): boolean {
  return summary.chatType === 'group';
}
