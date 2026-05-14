import { Type, type Static } from 'typebox';

/**
 * Runtime-validated typed config for the feishu-collab plugin.
 *
 * Hard invariant: NO topology data. No chat_id lists, no bot open_id allowlists.
 * All identity / routing is runtime-discovered. See docs/architecture.md.
 */
export const FeishuCollabConfig = Type.Object({
  enabled: Type.Boolean({ default: true }),

  gate: Type.Optional(
    Type.Object({
      mode: Type.Optional(
        Type.Union([Type.Literal('mention-only'), Type.Literal('autonomous')]),
      ),
    }),
  ),

  context: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      lastN: Type.Optional(Type.Number()),
      ttlHours: Type.Optional(Type.Number()),
      maxRowsPerChat: Type.Optional(Type.Number()),
    }),
  ),

  crossBot: Type.Optional(
    Type.Object({
      atBack: Type.Optional(Type.Boolean()),
      loopMaxDepth: Type.Optional(Type.Number()),
      softHintAtDepth: Type.Optional(Type.Number()),
    }),
  ),
});

export type FeishuCollabConfig = Static<typeof FeishuCollabConfig>;
