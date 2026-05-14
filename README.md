# openclaw-feishu-collaboration-spec

> 让你的 OpenClaw bot 在飞书群里像同事一样听、说、接力。

A plugin (and a specification) for **OpenClaw** bots that share a Feishu/Lark group: they listen to the whole conversation, only speak when @-mentioned, and chain replies with each other when relevant — with a graduated brake that lets bot↔bot dialogue fade naturally instead of hard-stopping.

**Status**: v0.1 in active development. Skeleton + architecture + QA plan complete. Modules A/B/C/D implementation in progress.

## Why

Out of the box, an OpenClaw Feishu bot in a group chat can only "see" messages it was @-mentioned in. So when someone @-mentions it with a follow-up question, the bot has no idea what the group was just talking about. And if two bots are in the same group, they can't carry on a thread together because the second bot doesn't @-mention the first one back.

This plugin fixes both ends, plus a few related rough edges, with a **zero-config install** — drop it onto any OpenClaw bot and it works in every group that bot joins.

## What it does

| Module | Capability | Status |
|---|---|---|
| **A. Capture** | Hooks `inbound_claim` to passively record every group message (mentioned or not) into a local per-group SQLite store | scaffold |
| **B. Reply Gate** | In groups, bot replies only when @-mentioned (`mention-only` default); autonomous classifier mode planned for Phase 2 | scaffold |
| **C. Context Inject** | When the bot does reply, the recent group conversation is fed into its prompt; also exposed via `memory_search` corpus supplement | scaffold |
| **D. Cross-Bot @-back** | If the inbound was from another bot, the outgoing reply auto-includes `<at>` so the other bot's mention gate triggers. Graduated brake at depth 3→5 makes the chain fade naturally | scaffold |

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

See [`plugin/TEST-PLAN.md`](plugin/TEST-PLAN.md) for the QA acceptance criteria (43 test cases across Modules A/B/C/D + universality + negative + perf).

## License

MIT
