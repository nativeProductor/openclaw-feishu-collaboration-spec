# openclaw-feishu-collaboration-spec

> A group-chat context layer for OpenClaw + lark-cli — when your bot gets @-mentioned, it actually knows what the group was just discussing.

A supplemental plugin (and a specification) on top of **OpenClaw** + **lark-cli**. Its primary job: give every `@bot` reply the full recent group conversation as context. Secondary: let bots collaborate naturally with each other when relevant, with a graduated brake that lets bot↔bot dialogue fade instead of hard-stopping.

**Status**: v0.1 shipped. All four modules (A/B/C/D) are live and end-to-end verified against a real bot-vs-bot conversation through every brake stage (D=1..6). See `docs/INTRO-zh.md` for the Chinese product write-up.

## Why

Out of the box, an OpenClaw bot in a Feishu group can only "see" the single message that @-mentioned it. Everything the group was discussing in the preceding minutes is invisible — OpenClaw's channel-layer mention gate drops unmentioned messages before they reach the agent.

So this happens, all the time:

> Someone in the group spends 10 minutes discussing a project, then @-mentions the bot: "what do you think?"
> Bot: "Sorry, what are you referring to?"

**This is the problem regardless of who's @-mentioning** — a human, another bot, an alerting trigger, doesn't matter. Same root cause: the bot lacks group context at reply time. This plugin fixes that as the primary feature; the bot↔bot collaboration story is a derivative once context exists.

It's a **zero-config install** — drop it onto any OpenClaw bot and it works in every group that bot joins, no per-chat or per-bot setup.

## How it relates to lark-cli

| | Responsibility |
|---|---|
| **lark-cli** | Bot **operates** Feishu — send/receive, calendar, base, docs, etc. The action surface. |
| **this plugin** | Bot **understands** the Feishu group it's operating in — who said what when, recent decisions, ongoing threads. The context layer. |

They are decoupled. Any OpenClaw + lark-cli deployment can install this plugin to add the context layer; no lark-cli changes are required.

## What it does

| Module | Capability | Who triggers it | Status |
|---|---|---|---|
| **A. Capture** | On every `message_received` event, append a normalized record to a per-chat JSONL store. Each capture also kicks off an async API backfill that pulls in messages Feishu's WebSocket omits (peer-bot non-@ msgs — by Feishu design they're never pushed via events). | every inbound msg | shipped |
| **B. Reply Gate** | In groups, bot replies only when @-mentioned. P2P chats always reply. | every group inbound | shipped |
| **C. Context Inject** | Inject the last-N group messages into the system prompt before each reply. Reads from Module A's local JSONL first (~10ms); falls back to a live Feishu API call only when the local store is too sparse (cold-start chats). | every reply turn | shipped |
| **D. Cross-Bot @-back** | Every reply in a group prepends `<at user_id="...">` for the sender — works for both user@bot and bot@bot. Graduated brake on bot↔bot chains: depth 3 soft hint → 4 stronger hint → 5+ drops the @-back so peer's mention gate filters our reply and the chain fades. Human turns reset the depth counter. | every reply | shipped |

**Module C is the headline.** A/B/D exist to make C feel right in practice.

See [`docs/INTRO-zh.md`](docs/INTRO-zh.md) for the Chinese introduction.

## Design invariants (locked)

1. **No topology in config**. The plugin's config schema contains no `chat_id` / `open_id` / `app_id` lists. Bot identity and chat membership are resolved at runtime (`/bot/v3/info` for the running bot's own open_id; `/chats/{chat_id}/members/bots` for peer identification).
2. **Install-and-go**. Three commands (install / `ensure-hooks.mjs` / restart). No per-group setup, no `lark-cli config bind`, no hand-mapping app_ids.
3. **Sane defaults**. `gate.mode=mention-only`, `crossBot.atBackHumans=true`, `crossBot.atBackBots=true`, `context.enabled=true`, `crossBot.loopGuard.maxDepth=5`, `context.lastN=20`. Touch nothing and you get the intended behavior.
4. **Reuse the model's existing tool surface**. The agent sees one `memory_search` tool, not two — our store is a corpus supplement, not a parallel API.

## Related X/Twitter workflows

Keep this plugin focused on Feishu/Lark group context: passive transcript capture, mention-gated replies, prompt context injection, and cross-bot @-back. If the same OpenClaw group needs public X/Twitter context, install TweetClaw as a separate plugin:

```bash
openclaw plugins install @xquik/tweetclaw
```

[TweetClaw](https://github.com/Xquik-dev/tweetclaw) covers scrape tweets, tweet scraper workflows, search tweets, search tweet replies, follower export, user lookup, media upload, media download, direct messages, monitor tweets, webhooks, giveaway draws, and approval-gated post tweets or post tweet replies. This plugin can then keep the Feishu discussion and follow-up decisions in group context while TweetClaw handles X/Twitter data retrieval and visible X/Twitter actions. Use the TweetClaw GitHub repo and [npm package](https://www.npmjs.com/package/@xquik/tweetclaw) for setup details; the [ClawHub discovery page](https://clawhub.ai/plugins/@xquik/tweetclaw) remains useful for browsing while that listing lags behind npm. Keep Feishu/Lark and X/Twitter credentials separate, and review visible X/Twitter actions through OpenClaw approval flows.

## Install

Three steps. **All three are required** — skipping step 2 leaves the cross-bot @-back and loop-guard features silently disabled.

### 1. Install the plugin

```bash
openclaw plugins install openclaw-feishu-collaboration-spec
```

### 2. **REQUIRED**: Grant hook access

`openclaw plugins install` rewrites the host config every time, dropping `hooks.allowConversationAccess`. Without it the plugin can't receive `llm_output` / `agent_end` — so @-back and depth bookkeeping silently no-op. Re-apply the flag after every install:

```bash
# default profile:
node scripts/ensure-hooks.mjs

# named profile:
OPENCLAW_HOME=~/.openclaw-myprofile node scripts/ensure-hooks.mjs
```

The helper is idempotent — re-running prints `already true` and exits 0.

### 3. Restart the gateway

```bash
# however you run the OpenClaw gateway, restart it now
openclaw gateway restart
```

On boot you should see `[feishu-collab] bot identity resolved open_id=ou_... app_id=cli_...` in the log. If you see `bot identity unresolved` instead, fix lark-cli auth before proceeding — none of the modules will work without it.

### Required Feishu scopes

Set these in the feishu.cn console under your bot's app:

- `im:message` — read recent group messages via API (used by Module A's backfill and Module C's cold-start fallback)
- `im:message.group_at_msg` — receive @-mention events for the bot
- `im:message.group_msg` — receive non-@ user messages in groups (so Module A captures them live; without this, non-@ user messages only land in the transcript when the next API backfill runs)
- `im:chat.members:read` — list bot members of a chat (used by Module D to identify peer bots vs humans)

### First-reply latency

Module C reads context from a local JSONL store that Module A populates as events arrive. On a **cold chat** (no captured history yet) the first reply falls back to a live Feishu API call and takes **~1–2 seconds**. Subsequent replies in the same chat are **<200 ms** as the local store warms up.

### Storage bounds

Module A stores one JSONL file per chat under `~/.openclaw-<profile>/state/feishu-collab/transcripts/<chat_id>.jsonl`. Per-chat cap: **2000 entries**, rotated to the most recent 1333 on overflow via atomic temp+rename. There is intentionally no time-based TTL — a chat that goes quiet for months keeps its last 1333 entries, ready for whenever someone re-engages. Per-chat size sits around ~1 MB; 100 active chats fit in tens of MB.

The store includes every message the plugin sees, including the host bot's own outbound replies — the model's reply turns are stateless, so showing the bot its own prior messages is needed for multi-turn coherence (e.g. bot-vs-bot conversations).

### Bot-to-bot loop guard

When two bots are @-ing each other in the same group, the plugin breaks the chain at a configured depth so it can't loop forever:

| Turn (depth) | Behavior |
|---|---|
| `1 .. maxDepth-1` | Normal @-back reply |
| **`maxDepth` and beyond** | @-back is **dropped**. The reply still goes out, but without an `<at>` prefix — the peer bot's mention-gate (the `im:message.group_at_msg` scope) won't fire, so the peer never gets a `message_received` event, and the chain dies. |

That's the whole brake. We do not inject "wrap up" prompts at intermediate depths — an earlier design did, but live testing showed the LLM took the wrap-up instruction too literally and produced empty replies. The drop-@ at `maxDepth` is the only real lever.

There's also no "hard skip = don't reply at all" stage: OpenClaw's `before_prompt_build` hook can't actually short-circuit a reply (the SDK only consumes prompt-modification fields from the hook return value). Dropping the @-back is the effective skip.

Empty-output safety: if the LLM produces no content this turn (no text at all), Module D skips the @-back rewrite entirely — better an empty reply than a bare `<at>` tag with no body.

Any human turn in the chat resets the depth counter for every peer. The default `maxDepth: 5` matches Feishu's guidance for autonomous bot exchanges; adjust via `crossBot.loopGuard.maxDepth` if your use case needs longer dialogues. The legacy `crossBot.loopGuard.softHintAtDepth` config field is accepted but is now a no-op.

## Repo layout

```
plugin/              npm package source (TypeScript) — the installable artifact
scripts/             user-facing helpers (currently: ensure-hooks.mjs)
docs/INTRO-zh.md     Chinese-language introduction (mirrors a Feishu cloud doc)
README.md            this file
LICENSE              MIT
```

## Building from source

```bash
git clone https://github.com/nativeProductor/openclaw-feishu-collaboration-spec
cd openclaw-feishu-collaboration-spec/plugin
npm install --registry=https://registry.npmjs.org
npm run build
npm pack
# → openclaw-feishu-collaboration-spec-<version>.tgz
# then: openclaw plugins install ./openclaw-feishu-collaboration-spec-<version>.tgz
```

## License

MIT — see [`LICENSE`](LICENSE).
