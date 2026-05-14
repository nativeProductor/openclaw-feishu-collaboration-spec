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
 * Parse an inbound event payload into a normalized {@link InboundSummary}.
 * Always returns a fully-shaped object; missing fields are empty strings
 * (or `false` for booleans). Never throws on malformed input.
 */
export function parseInboundSummary(rawEvent: unknown): InboundSummary {
  const envelope = findFeishuEnvelope(rawEvent);
  const sender = asObj(envelope?.sender);
  const senderId = asObj(sender?.sender_id);
  const message = asObj(envelope?.message);

  const senderOpenId = asStr(senderId?.open_id);
  const senderType = asStr(sender?.sender_type) as FeishuSenderType;

  // peer app_id: when a bot is the sender, Feishu surfaces `sender_id.app_id`.
  // We treat any non-empty app_id under sender_id as the peer identity.
  const peerAppId = asStr(senderId?.app_id);

  const chatId = asStr(message?.chat_id);
  const chatType = asStr(message?.chat_type);
  const messageId = asStr(message?.message_id);

  const mentionsRaw = message?.mentions;
  const mentions: unknown[] = Array.isArray(mentionsRaw) ? mentionsRaw : [];
  let isMentionedByBot = false;
  for (const m of mentions) {
    const mo = asObj(m);
    if (!mo) continue;
    // A mention is "by a bot" when its `id` block carries an app_id, or when
    // its `tenant_key` is the same as a bot tenant_key. The cheap reliable
    // signal Feishu gives us is the presence of `app_id` on the mention id.
    const mid = asObj(mo.id);
    if (mid && asStr(mid.app_id)) {
      isMentionedByBot = true;
      break;
    }
    // Some host normalizers flatten id into the mention itself.
    if (asStr(mo.app_id)) {
      isMentionedByBot = true;
      break;
    }
  }

  return {
    senderOpenId,
    senderType,
    isMentionedByBot,
    peerAppId,
    chatId,
    chatType,
    messageId,
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
