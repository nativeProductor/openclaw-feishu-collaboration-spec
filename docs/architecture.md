# openclaw-feishu-collaboration-spec — architecture & design decisions

Status: **draft, design phase**. Locked decisions below; refine through implementation, then RFC.

## What this project is

A specification (and reference implementation) for how **OpenClaw bots collaborate in Feishu/Lark group chats**. Any OpenClaw bot that installs this plugin gains three coordinated behaviors:

1. **Group-context awareness**: the bot is aware of the recent conversation in the group, even messages it wasn't @-mentioned in.
2. **Polite reply gate**: in groups, the bot only speaks when @-mentioned (default); optionally, a classifier can decide per-message (Phase 2).
3. **Cross-bot dialogue**: when another bot @-mentions this one, it replies with the inverse @-tag so multi-turn bot↔bot exchange works; with a graduated brake that lets conversations fizzle naturally rather than hard-stopping.

Positioning is a **spec**, not just a plugin: the reference implementation is canonical, and the protocol (hooks observed, events emitted, data stored, scope of config) is documented so other agent frameworks could implement the same contract.

## Hard design invariants (cannot be violated)

These ride above all module work. Any PR that violates them is rejected.

1. **Zero-topology config**. No `chat_id`, `open_id`, `app_id`, or any "list of known peers" lives in the plugin's config schema. Everything is **runtime discovered** and cached at `~/.openclaw-bot2/state/feishu-collab.json` (or similar plugin-private file).
2. **Install-and-go**. The user runs `openclaw plugins install openclaw-feishu-collaboration-spec` (one command), restarts gateway, and the bot is collaboration-ready in every group it's a member of. No `lark-cli config bind`, no per-chat config edits.
3. **Defaults are sane**. `gate.mode=mention-only`, `crossBot.atBack=true`, `context.enabled=true`, `loop.maxDepth=5`. A user who never touches config gets the intended behavior.
4. **Reuse the model's existing tool surface**. The agent sees one `memory_search` tool, not two. Our group-transcript store is exposed via `registerMemoryCorpusSupplement`, so the model uses the same API it already knows.

## Locked architecture (post audit)

```
                                     ┌─────────────────────────────┐
inbound Feishu event                 │ before_prompt_build hook    │
       │                             │ - default inject "recent N" │
       ▼                             │   group msgs into prompt    │
┌──────────────────────────┐         │ - Module C                  │
│ inbound_claim hook       │         └─────────────────────────────┘
│ - runs BEFORE mention-   │                       ▲
│   gate (see audit)       │                       │ recall query
│ - capture ALL group msgs │                       │
│ - Module A               │                       │
└──────────┬───────────────┘                       │
           │                                       │
           ▼                                       │
┌──────────────────────────┐    ┌────────────────────────────────┐
│ Per-group SQLite         │◄───┤ registerMemoryCorpusSupplement │
│ - (chat_id, ts, sender,  │    │ - exposed under memory_search  │
│   text, sender_type)     │    │ - model can also call          │
│ - TTL, size cap          │    │   semantically                 │
└──────────────────────────┘    └────────────────────────────────┘

┌──────────────────────────┐
│ Reply gate (Module B)    │
│ - mention-only (P0)      │
│ - autonomous (P1)        │ — short-circuits at before_prompt_build
└──────────────────────────┘

┌──────────────────────────┐
│ Cross-bot @-back         │
│ - hook llm_output        │
│ - detect sender_type=app │
│ - inject <at> in reply   │
│ - Module D               │
│ - graduated brake at     │
│   depth 3/4/5            │
└──────────────────────────┘
```

### Why this shape

- **`message_received` is the actual unconditional hook**, NOT `inbound_claim`. Source-level research (`docs/inbound-claim-debug.md`, 2026-05-14) verified at `dispatch-DHFZoYxZ.js:569`: `message_received` fires for every inbound, fire-and-forget, **pre mention-gate**. The earlier memory-core audit claim was second-hand and wrong.
- **`inbound_claim` does NOT work for passive capture**. Only dispatched inside `if (pluginOwnedBinding)` at `dispatch-DHFZoYxZ.js:526`; requires explicit user-approved binding ceremony AND takes over the chat from OpenClaw's default agent.
- **`before_agent_finalize` also won't fire** on Xiaomi/openai-completions path — it's a Codex/Claude-Code provider harness hook. Module D uses `llm_output` + `message_sending` + `agent_end` instead.
- **`registerMemoryCorpusSupplement` is the magic API**. memory-core can't ingest external data, but it has a search-time corpus supplement contract (`@openclaw/plugin-sdk/plugins/memory-state.d.ts:39-54`). The model calls `memory_search corpus=all`, our store answers alongside memory-core's own results.
- **Feishu's `<at user_id>` is server-normalized**. cross-bot identity research established that any open_id pointing to the target bot works — Feishu's renderer translates per-viewer. Massive simplification: no tenant-scoped open_id juggling.
- **Self-identity via `/open-apis/bot/v3/info`**. Public endpoint, no scope, returns the bot's own open_id. Cache forever.

## Module breakdown

### Module A — Capture

- Hook **`message_received`** (NOT `inbound_claim`; the latter is binding-gated, see Why this shape).
- For each event: extract `chat_id`, `message_id`, `ts`, `sender.sender_id.open_id`, `sender.sender_type`, text content (or msg_type marker for non-text).
- Insert into SQLite at `~/.openclaw-<profile>/state/feishu-collab/transcript.db`.
- TTL job (cron) trims rows older than 7d; cap 2000 rows per chat.
- ~150 LOC.

### Module B — Reply Gate

- mention-only (P0): if `chat_type === 'group'` and bot's own open_id not in `event.message.mentions[]`, return `skip` from `before_prompt_build`. Else proceed.
- p2p: bypass gate (always reply).
- autonomous (P1): on `skip` candidate, call cheap classifier (`mimo-v2.5` non-pro) with last few messages; threshold 0.7 → reply.
- ~120 LOC for P0; +200 for P1.

### Module C — Context Inject

- In `before_prompt_build`: query SQLite for last N messages in this chat (default 20), exclude system/event noise, format as transcript block.
- Inject into system prompt suffix.
- Plus register `MemoryCorpusSupplement` so model can also query semantically via `memory_search`.
- Image messages: store image_key in DB row; when rendering context, attach as multimodal block if model supports vision.
- ~200 LOC.

### Module D — Universal @-back (with graduated brake for bot peers)

**Scope clarification (2026-05-14, owner):** @-back applies to **both** user@bot AND bot@bot. For human sender, always @-back if `reply.atBackHumans=true`. For bot sender, apply graduated brake described below. `before_agent_finalize` does NOT fire on our model path — use `llm_output` + `message_sending` + `agent_end`.

- Hooks: `llm_output` (mutate assistant text candidates) + `message_sending` (final outbound intercept / cancel) + `agent_end` (depth bookkeeping & reset).
- Detect: read inbound's `sender_type` and `sender.sender_id.open_id`. If sender_type is 'app' AND peer is another bot (not self), apply brake. Otherwise (human), no brake.
- Prepend `<at user_id="${inbound.sender.open_id}"></at>` to the reply text (atBackHumans for human / atBackBots for bot, both default true).
- **Graduated brake**:
  - Track `depth` = consecutive bot↔bot turns per `(chat_id, peer_app_id)` in plugin state.
  - Reset to 0 when sender_type !== 'app'.
  - depth 1-2: normal.
  - depth 3: inject hint into system prompt: "你已经和另一个 bot 互动 3 轮,可考虑话题收束".
  - depth 4: stronger hint: "强烈建议本轮收束,内容已经清楚可礼貌结束".
  - **depth 5: reply but DROP the @-back** (key turn). If the other bot is mention-only, its gate filters our reply naturally → conversation fades.
  - depth ≥6: hard skip at plugin layer (safety net for autonomous-mode peers).
- ~180 LOC.

### Vision support (cross-cutting, was N-2 in QA plan)

- When `event.message.message_type === 'image' || 'post'` containing image:
  - fetch image binary via `im/v1/messages/{message_id}/resources/{file_key}` (needs `im:resource` or appropriate scope)
  - if primary model supports vision (e.g. `mimo-v2-omni`), pass image block in prompt
  - if primary doesn't (e.g. `mimo-v2.5-pro` is text-only): per-turn model override to `mimo-v2-omni` for this turn. Mechanism: `before_prompt_build` returns `{modelOverride: "xiaomi/mimo-v2-omni"}` — verify OpenClaw runtime supports this.
- Phase 1 includes vision; if model override doesn't work, fall back to "[图片] " marker + skip vision; document as known limitation.

## Required Feishu scopes (must be granted in feishu.cn console for each bot)

- `im:message` and `im:message.group_msg` (already have)
- `im:chat.members:read` — for listing bots in a chat (enables faster cross-bot discovery; lazy fallback exists)
- `im:resource` — for fetching image/file binaries (Module C vision support)

The plugin must work even if `im:chat.members:read` is denied — fall back to lazy event-based learning per the cross-bot identity research.

## Loop guard state schema

State persisted to `~/.openclaw-<profile>/state/feishu-collab/loop-state.json`:

```jsonc
{
  "$schemaVersion": 1,
  "chats": {
    "oc_xxx": {
      "lastHumanTs": 1778750000,
      "bots": {
        "cli_other_bot_app_id": {
          "depth": 3,
          "lastTurnTs": 1778750120
        }
      }
    }
  }
}
```

Survives restart (per QA's N-7 concern). Pruned on inactivity > 1h.

## Open questions (still pending product decision)

_None blocking Phase 1. Cooldown / rate-limit behavior is deferred to Phase 2 alongside autonomous mode (natural backpressure from reasoning-model latency is acceptable for v0.1)._

## References

- `docs/memory-core-audit.md` — full audit report (verdict: NEEDS-GLUE, plan B + corpus supplement)
- `docs/cross-bot-identity-research.md` — open_id resolution recipe (Feishu renderer is server-normalized — huge simplification)
- `plugin/TEST-PLAN.md` — 42-case QA plan (Module B/C/D/U + negative + perf)
