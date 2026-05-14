# openclaw-feishu-collaboration-spec

> A group-chat context layer for OpenClaw + lark-cli — when your bot gets @-mentioned, it actually knows what the group was just discussing.

A supplemental plugin (and a specification) on top of **OpenClaw** + **lark-cli**. Its primary job: give every `@bot` reply the full recent group conversation as context. Secondary: let bots collaborate naturally with each other when relevant, with a graduated brake that lets bot↔bot dialogue fade instead of hard-stopping.

**Status**: v0.1 in active development. Skeleton + architecture + QA plan complete. Modules A/B/C/D implementation in progress.

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
| **A. Capture** | Hooks `inbound_claim` to record **every** group message — even ones not @-mentioning the bot — into a local per-group SQLite store | every inbound msg | scaffold |
| **B. Reply Gate** | In groups, bot replies only when @-mentioned (`mention-only` default). P2P unchanged. Autonomous classifier mode is Phase 2 | every group inbound | scaffold |
| **C. Context Inject** | When the bot does reply (to a user OR a bot), the last ~20 group msgs are injected into the prompt; same store also exposed via `memory_search` corpus supplement | every reply turn | scaffold |
| **D. Cross-Bot @-back** | When the inbound was from another bot, auto-include `<at>` in the reply so the chain continues. Graduated brake at depth 3→5 makes it fade naturally | bot-from-bot inbound | scaffold |

**Module C is the headline.** A/B/D exist to make C feel right in practice.

See [`docs/INTRO-zh.md`](docs/INTRO-zh.md) for the friendly Chinese introduction, [`docs/architecture.md`](docs/architecture.md) for the full design.

## Design invariants (locked)

1. **Zero-topology config**. The plugin's config schema contains no `chat_id` / `open_id` / `app_id` lists. Everything is runtime-discovered.
2. **Install-and-go**. One `openclaw plugins install …` command. No per-group setup, no `lark-cli config bind`, no app-id mapping by hand.
3. **Sane defaults**. `gate.mode=mention-only`, `crossBot.atBack=true`, `context.enabled=true`, `loop.maxDepth=5`. Touch nothing and you get the intended behavior.
4. **Reuse the model's existing tool surface**. The agent sees one `memory_search` tool, not two — our store is a corpus supplement, not a parallel API.

## Install

```bash
# in any OpenClaw profile, once published to npm:
openclaw plugins install openclaw-feishu-collaboration-spec
openclaw config patch --stdin <<EOF
{
  plugins: {
    entries: {
      "feishu-collab": {
        enabled: true,
        hooks: { allowConversationAccess: true }
      }
    }
  }
}
EOF
# restart the gateway daemon to load the plugin
```

Required Feishu scopes (in feishu.cn console for each app using the plugin):
- `im:message`, `im:message.group_at_msg` (you almost certainly already have these)
- `im:chat.members:read` *(optional; speeds up cross-bot discovery)*
- `im:resource` *(optional; required for image / file context, Phase 1)*

## Repo layout

```
plugin/        npm package source (TypeScript), the installable artifact
docs/          architecture, audit reports, intro
harness/       dev test harness (lark-cli wrapper for sending stimuli)
scripts/       bootstrap helpers for spinning up a local "bot2" dev instance
```

## Development

```bash
git clone https://github.com/nativeProductor/openclaw-feishu-collaboration-spec
cd openclaw-feishu-collaboration-spec
cp .env.example .env  # fill in your Feishu + Xiaomi creds for the dev bot
cp harness/.env.example harness/.env  # if you want to run the test harness

# build the plugin
cd plugin && npm install --registry=https://registry.npmjs.org && npm run build && npm pack

# bring up a local dev bot
bash scripts/bootstrap-bot2.sh
```

See [`plugin/TEST-PLAN.md`](plugin/TEST-PLAN.md) for the QA acceptance criteria (41 test cases across Modules A/B/C/D + universality + negative + perf).

## License

MIT
