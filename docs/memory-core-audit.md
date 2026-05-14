# memory-core capability audit (2026-05-14)

Research agent output. Audit of OpenClaw 2026.5.6's bundled `memory-core` plugin, to determine if it can serve as the storage layer for our group-transcript needs.

## TL;DR (3 lines)

- **J verdict: NEEDS-GLUE.** memory-core is a markdown-file recall engine, not a transcript store; you cannot feed it raw group messages through any public API.
- **Best path forward**: keep a separate per-group transcript store (Plan B), and OPTIONALLY surface it to the agent via `registerMemoryCorpusSupplement` so `memory_search` can also reach group-message context.
- **Biggest risk**: misreading "session transcript indexing" as the answer — it is gated to the requester's own session-visibility tree (`tools-Bxtu-guO.js:19-51`) and ingests only the agent's own JSONL transcripts, not raw inbound group messages, especially unmentioned ones.

## A. Data model — PARTIAL

memory-core indexes content per-agent, not per-conversation. The index is keyed `${agentId}:${workspaceDir}` and lives at `~/.openclaw/memory/{agentId}.sqlite` (`manager-UTNjRDLW.js:2624-2626`; schema `extensions/memory-core/openclaw.plugin.json` and root schema `properties.memory.store.path` description at `/tmp/schema-mem.json:4672`). Chunks are tagged with `source = "memory" | "sessions"` and an absolute `path` (`tools-Bxtu-guO.js:33-49`, `manager-UTNjRDLW.js:1269-1273`). "Session" partitioning is implicit — only via the path of the indexed transcript file plus `extractTranscriptIdentityFromSessionsMemoryHit` (`tools-Bxtu-guO.js:39-47`). There is no first-class `conversationId` / `chatId` field.

## B. Ingestion path — NO (for the goal stated)

memory-core only ingests two corpora:

1. Markdown files under `${workspaceDir}/MEMORY.md` and `${workspaceDir}/memory/**` plus `memorySearch.extraPaths` (`manager-UTNjRDLW.js:1069-1070, 1273`).
2. The agent's own session-transcript JSONL files under `resolveSessionTranscriptsDirForAgent(agentId)` (`manager-UTNjRDLW.js:1101-1108, 1225-1230`), gated by `memorySearch.sources` containing `"sessions"` and `memorySearch.experimental.sessionMemory=true` (`memory-search-Bpossryy.js:55, 88`; schema line 4442).

There is **no `memory_add`, `memory.append`, or "ingest message" API anywhere in memory-core's exports** (`extensions/memory-core/index.js:239-276`, `runtime-api.js`, `api.js`). Sessions are picked up only via the internal `onSessionTranscriptUpdate` event (`manager-UTNjRDLW.js:1103`), which is fired by the dispatcher (`dispatch-DHFZoYxZ.js:569-573`) **after** the mention-gate, which `return null;`-drops unmentioned group messages (`prepare-DoW6_hdn.js:972-991`). Net: unmentioned group messages never become indexable by memory-core.

The only public extension point that adds new readable content is `registerMemoryCorpusSupplement(pluginId, supplement)` (`memory-state-Zcnt5VJy.js:7-14`, SDK type `plugin-sdk/src/plugins/memory-state.d.ts:39-54`). It exposes `search()`/`get()` only — your plugin still owns the store and answers `memory_search corpus=wiki|all` queries.

## C. Storage — YES

SQLite per agent at `${memory.store.path | ~/.openclaw/memory/{agentId}.sqlite}` (`manager-UTNjRDLW.js:3028`, schema `/tmp/schema-mem.json:4672`). Tables: `files`, `chunks`, FTS5 mirror, optional sqlite-vec table (`manager-UTNjRDLW.js:1269-1272, 3037, 3043-3060`). On this Mac there is no SQLite yet — `/Users/bytedance/.openclaw/workspace-bot2/` has none of `MEMORY.md`/`memory/` and `find ~/.openclaw -name '*.sqlite*'` returns empty; memory hasn't been provisioned for this agent.

## D. Retrieval API — YES (read-only)

- Library: `memoryRuntime.getMemorySearchManager({cfg, agentId, purpose})` → returns `MemoryIndexManager` with `search(query, { maxResults, minScore, sessionKey, sources })`, `readFile({relPath, from, lines})`, `status()` (`extensions/memory-core/index.js:226-238`; `manager-UTNjRDLW.js:2742-2790, 2999-3007, 3008-3082`). Re-exported as `getMemorySearchManager` (`extensions/memory-core/runtime-api.js`).
- CLI: `openclaw memory search "<q>"`, `openclaw memory status [--json]`, `openclaw memory index --force` (`openclaw memory --help`).
- Agent tools: `memory_search`, `memory_get` (signatures `tools-Bxtu-guO.js:119-138`).

There is **no** "messages since timestamp T" / "last N from chat X" API — all retrieval is semantic + FTS over chunks.

## E. Automatic prompt injection — PARTIAL

memory-core itself only contributes a small **prompt fragment** (the "Memory Recall" section telling the model to call `memory_search` first) via `buildPromptSection` (`extensions/memory-core/index.js:97-110`, registered at `:247-255`). It does NOT auto-fetch memories per turn.

The actually-relevant plugin is **`active-memory`** (`extensions/active-memory/openclaw.plugin.json`, `extensions/active-memory/index.js:1659`), which runs a bounded subagent on `before_prompt_build` and injects results into the prompt. It is per-session and supports `allowedChatTypes: ["direct","group","channel","explicit"]` and `allowedChatIds`/`deniedChatIds` (manifest lines 34-57). It also has `recentUserTurns`/`recentAssistantTurns` knobs (lines 110-129).

## F. Tools the model can call — YES, 2

`memory_search` and `memory_get` only (`openclaw.plugin.json:11-14`; impl `tools-Bxtu-guO.js:320, 439`). No `memory_add` / `recall` / `memory_list`.

## G. Limitations — PARTIAL but real

- No multi-conversation partition key; index is per-agent (`manager-UTNjRDLW.js:2624`).
- `corpus=sessions` results are post-filtered by `filterMemorySearchHitsBySessionVisibility` (`tools-Bxtu-guO.js:19-51`): a session hit is dropped unless the **requesting** session's visibility tree allows it. Default `visibility=self` means a group session cannot see other group sessions' transcripts.
- Session indexing requires opt-in `memorySearch.experimental.sessionMemory=true` and `sources: ["memory","sessions"]` (schema lines 4341-4354, 4442).
- Mention-gate drops unmentioned group messages BEFORE the transcript is written (`prepare-DoW6_hdn.js:972-991`).
- `memory_get` is capped to ~250000 chars (schema line 3950) with a default line window cap (line 3958).
- Dreaming sweeps have lookback caps (e.g. light `lookbackDays`, deep `maxAgeDays`) in plugin schema lines 101-156.

## H. Embedding/semantic recall — YES, configurable

Providers: `openai | gemini | voyage | mistral | bedrock | lmstudio | ollama | local` plus `auto` (schema line 4450; `manager-UTNjRDLW.js:67-122`). FTS5 + optional sqlite-vec hybrid (`/tmp/schema-mem.json:4692-4707`). Plugin contract declares `memoryEmbeddingProviders: ["local"]` (`openclaw.plugin.json:8-10`), but the global `memorySearch.provider` overrides this.

## I. The `/dreaming` command — admin toggle only

Reading the handler (`dreaming-command-DrayW2_x.js:77-97`): `/dreaming` takes `status | on | off | help` only. It mutates `plugins.entries.memory-core.config.dreaming.enabled` in the config file. It does **not** capture, store, or recall conversation messages. "Dreaming" is a background cron sweep that re-scores already-indexed memory entries through light/REM/deep phases and may APPEND to `MEMORY.md` (sweep code `dreaming-CfrhHXBc.js`, `short-term-promotion-CUgO3iR5.js`).

## J. Use-case fit verdict — NEEDS-GLUE

You cannot achieve "ingest every group message including non-mentions, then re-surface them" with memory-core's public surface alone:

1. **Capture**: unmentioned group messages never reach `message_received` because the channel-side mention gate drops them earlier (`prepare-DoW6_hdn.js:972-991`). Even if you set `requireMention=false`, the bot then **replies** to every message — there is no "passive observe" mode in the runtime.
2. **Per-group partition**: memory-core has no chat-id key; it's per-agent. Session-corpus filtering enforces a self/tree visibility model (`tools-Bxtu-guO.js:19-51`) that actively blocks cross-session recall, which is exactly what you'd want WITHIN one group but unhelpful if mixing.
3. **Ingestion API**: no public "append message" function exists.

What glue works:

- Build a small per-group transcript store yourself (SQLite/JSONL). Capture at the Feishu adapter layer **before** the mention gate (your own plugin's inbound listener, not `message_received`).
- Expose it to the agent through `registerMemoryCorpusSupplement("feishu-group-context", supplement)` (`memory-state-Zcnt5VJy.js:7`, SDK contract `plugin-sdk/src/plugins/memory-state.d.ts:39-54`). The model then calls `memory_search corpus=wiki|all` and your store answers.
- Optionally also register a `registerMemoryPromptSupplement` to add a "Group context recall" hint (`memory-state-Zcnt5VJy.js:43-50`).
- For automatic per-turn injection, enable `active-memory` with `allowedChatTypes: ["group"]` and `allowedChatIds: [oc_xxx]` — but note this only fires when the bot is actually about to reply (i.e. mention path); it cannot drive ingestion.

## Specific code/CLI hooks the plugin can call

- `registerMemoryCorpusSupplement(pluginId, { search, get })` — `memory-state-Zcnt5VJy.js:7`. Make your group transcripts answer `memory_search corpus=wiki|all`.
- `registerMemoryPromptSupplement(pluginId, builder)` — `memory-state-Zcnt5VJy.js:43`. Append a recall hint.
- `memoryRuntime.getMemorySearchManager({cfg, agentId})` — `extensions/memory-core/index.js:227`. Read-only access to the underlying SQLite manager if you need it.
- Plugin hook `inbound_claim` (`plugin-sdk/.../hook-types.d.ts:17`) — fires BEFORE mention gate dispatch; this is the right hook for an observe-everything Feishu plugin.
- `openclaw memory search/status/index` CLI for debugging.

## Things memory-core CANNOT do for us

- Ingest raw inbound chat messages.
- Partition by `chatId`/`groupId` (no such field anywhere in `chunks`/`files` tables; `manager-UTNjRDLW.js:1269-1272`).
- Provide "last N messages" or time-window retrieval (purely semantic + FTS).
- Index messages the bot wasn't @-mentioned in (mention-gate drops them at `prepare-DoW6_hdn.js:972`).
- Cross-session recall by default (`filterMemorySearchHitsBySessionVisibility` blocks it; `tools-Bxtu-guO.js:19-51`).
- Provide a hook to ingest external data; only **search-time supplements** are public.

## Recommended next step

**Fall back to Plan B (own transcript store) + bolt onto memory-core via `registerMemoryCorpusSupplement`.**

Why: the data shape needed (per-group, all messages incl. non-mentioned, time-ordered) doesn't match memory-core's per-agent markdown-recall design, and the only public ingestion surface is the implicit "agent writes its own JSONL" path which the mention-gate already filters. But the surfacing problem (let the model query group history during a reply) IS solvable cleanly through the supplement contract, so the model still uses the same `memory_search` tool surface without duplication.

Integration shape:

- New plugin (this project). Subscribes to `inbound_claim` to capture every group message regardless of mention status. Stores per-`chat_id` SQLite (one DB or one row-with-chatId column).
- Implements `MemoryCorpusSupplement.search/get` scoped by `agentSessionKey` → parse to `chatId` via `parseRawSessionConversationRef` (`session-key-utils-8PXPWO4Z.js:60`) → query only that chat's rows.
- Calls `registerMemoryCorpusSupplement("feishu-collab", supplement)` at activation.
- Optionally enable bundled `active-memory` with `allowedChatTypes:["group"]` so recall fires per-reply automatically.
