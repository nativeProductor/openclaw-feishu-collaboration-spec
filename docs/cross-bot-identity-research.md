# Cross-bot open_id resolution — research report (2026-05-14)

Research agent output. Empirical investigation of how to reliably identify "another bot" inside a Feishu group from within an OpenClaw plugin, including the tenant-scoped open_id gotcha.

## TL;DR (3 lines)

- `<at user_id="ou_...">` is server-resolved: **either tenant's view of the same bot's open_id works** — the renderer translates app_id mentions per viewer, so cross-bot @ is trivially safe once you have any valid open_id pointing at the target app.
- The cheap, no-extra-scope path to discover "the other bot" is via the public `/open-apis/bot/v3/info` (each bot maps its own app_id -> open_id) plus the `im.v1` message event (`sender.tenant_key`, `sender.sender_type=app`, and `sender.sender_id.open_id`). For symmetric discovery in a group, `im.v1.chats.members.bots` is the canonical list but it requires the `im:chat.members:read` scope.
- The "failed to resolve sender name for ou_..." log comes from `@openclaw/feishu` calling `contact/v3/users/{user_id}` on a bot's open_id — bots return **41050 "no user authority error"**, not a permission scope problem; that API is humans-only.

## A. Group members from each viewpoint

Both bots got HTTP 200 from `/open-apis/bot/v3/info`:

| Profile | app_id | app_name | own open_id (tenant-scoped, view of self) |
|---|---|---|---|
| bot1 | `cli_BOT_A_APP_ID` | 话唠AI | `ou_BOT_A_OPEN_ID_OWN` |
| bot2 | `cli_BOT_B_APP_ID` | 工具人 | `ou_BOT_B_OPEN_ID_OWN` |

The group is `oc_TEST_GROUP_ID` ("插件开发"), `bot_count=2`, `user_count=1`, `tenant_key=TENANT_KEY_REDACTED` (confirmed via `GET /open-apis/im/v1/chats/{chat_id}` — same scope as listing, see G). `chat.members.bots` (the documented enumeration endpoint) returns `99991672` from both bots because neither has `im:chat.members:read`/`im:chat:readonly`/`im:chat.group_info:readonly` enabled — same error from both. So we could not directly confirm "bot2 sees `ou_dbd5e...c39` for bot1" via member listing right now; we only confirmed it indirectly by sending an @-message (see C).

## B. union_id

The `member_id_type` enum on `im.v1.chats.members.get` (lark-cli `schema im.chat.members.get`) accepts `open_id | union_id | user_id` — Feishu docs describe `union_id` as stable across all apps from the **same ISV/developer**. In our setup both apps live under the same tenant but lark-cli/the API does not surface a bot's union_id anywhere: `/open-apis/bot/v3/info` only returns `open_id`; `contact/v3/users/{user_id}?user_id_type=union_id` against a bot open_id returns `41050 no user authority error` (bot identities are not in the contact graph). Verdict: **for bots, union_id is effectively unavailable through public APIs** — design around `app_id` + `open_id` instead.

## C. What `<at user_id="...">` accepts (empirical)

bot2 sent three texts to the group (`im.v1.messages.send`, then `messages-mget` to read them back; full output captured):

| input | server-rendered content | `mentions[].id` |
|---|---|---|
| `<at user_id="ou_BOT_A_OPEN_ID_AS_SEEN_BY_B">` (bot2's view of bot1) | `@话唠AI test-openid-bot2view` | `cli_BOT_A_APP_ID` (app_id, `key=@_user_1`, name=话唠AI) |
| `<at user_id="ou_BOT_A_OPEN_ID_OWN">` (bot1's view of bot1) | `@话唠AI test-openid-bot1view` | `cli_BOT_A_APP_ID` |
| `<at user_id="all">` | `@_all test-at-all` | (no mentions array) |

**Verdict**: any open_id that points to the target bot in **any tenant** is accepted; Feishu rewrites it server-side to the per-viewer alias. So for cross-bot @ we don't need to know the "right" view at all — we just need any open_id of the target bot.

## D. Bot self-identity API

`GET /open-apis/bot/v3/info` (lark-cli: `api GET /open-apis/bot/v3/info`). No scope, returns `{open_id, app_name, avatar_url, activate_status, ip_white_list}`. It is the canonical "given my tenant token, who am I?" call. The OpenClaw probe (`probe-BNzzU_uR.js:105`) hits an internal `/open-apis/bot/v1/openclaw_bot/ping` instead — that one is not generally available to plugins so we shouldn't depend on it.

## E. How `@openclaw/feishu` resolves its own open_id

Trace: `monitor.account-CUZxYkjE.js:4978` calls `fetchBotIdentityForMonitor` → `monitor.state-DYM02ipp.js:24` → `probe-BNzzU_uR.js:88 probeFeishu` which POSTs `/open-apis/bot/v1/openclaw_bot/ping {needBotInfo:true}` and reads `data.pingBotInfo.botID`. The result is stored in two module-scoped Maps `botOpenIds` and `botNames` (`monitor.state-DYM02ipp.js:44-45`) keyed by `accountId`; that map is read via `getBotOpenId(accountId)` everywhere. We cannot reuse this Map directly from another plugin (it's a private module binding), and the underlying endpoint is OpenClaw-private. **For our plugin: call `/open-apis/bot/v3/info` ourselves and cache.**

## F. Recipe for our plugin

1. **On startup (per account):** `GET /open-apis/bot/v3/info` → cache `selfOpenId`, `selfAppId`, `selfAppName`. (Stable per tenant; refresh only on app-info-changed event.)
2. **On first message in a new chat:** call `GET /open-apis/im/v1/chats/{chat_id}/members/bots` to enumerate `[{bot_id, bot_name}]`. Build cache `(chat_id) -> Map<app_id_or_bot_name, open_id_in_my_view>`. (Requires `im:chat.members:read`; see J.) Fallback if scope absent: lazily learn other bots from incoming events — `sender.sender_type==="app"` + `sender.tenant_key` + `sender.sender_id.open_id` give you everything you need without any extra API call. The mentions array on inbound messages also exposes other bots' app_ids (`mentions[].id` is the app_id when the mention is a bot, as shown in C).
3. **When @-mentioning bot X back:** insert `<at user_id="<any open_id you have for X>"></at>` into the post-format content. As C proved, you can use either the open_id you learned from the inbound event (X-as-seen-by-you) or any open_id of X you cached from somewhere else — Feishu's renderer normalizes it for every viewer.
4. **Re-validation:** invalidate `(chat_id) -> bots` on `im.chat.member.bot.added_v1` / `im.chat.member.bot.deleted_v1`. Invalidate `selfOpenId` on `application.bot.updated_v3` (uncommon).
5. **Identity key**: use `app_id` (e.g. `cli_BOT_A_APP_ID`) as the **stable, cross-view identity** of a bot, NOT open_id. `app_id` shows up in three places: event `sender.sender_id` (when fetched via `messages-mget` as `sender.id` with `id_type=app_id`), event `message.mentions[].id`, and the chat-members-bots response (`bot_id` is open_id, so pair via name or via the next inbound from that bot).

## G. Error mode (sender name resolve)

`@openclaw/feishu` calls `client.contact.user.get({path:{user_id}, params:{user_id_type:"open_id"}})` (`monitor.account-CUZxYkjE.js:363`). Reproduced from bot2 against bot1's open_id (`api GET /open-apis/contact/v3/users/ou_BOT_A_OPEN_ID_AS_SEEN_BY_B?user_id_type=open_id`):

```
code: 41050  message: "no user authority error"  (HTTP 400)
```

**That is not a missing scope** — it is the contact API refusing to look up *a bot* by open_id; bots are not contacts. With `im:chat.members:read` you can still get `bot_name` cheaply from `chat.members.bots`. With `contact:contact:readonly` or `contact:user.base:readonly` you can resolve *human* senders. Suggested fix in our plugin: detect `sender_type === "app"` in the event and short-circuit name resolution to `mentions[].name` or `chat.members.bots` instead of calling `contact.users.get`.

## H. Recipe summary

1. Startup: `bot/v3/info` -> self open_id (cache forever).
2. New chat: `im.v1.chats.members.bots` -> `{bot_id, bot_name}` per bot (cache; invalidate on member events).
3. Inbound event: read `sender.sender_type`, `sender.sender_id.open_id`, `event.message.mentions[]` — for each entry where `id` looks like `cli_*` you have an app_id you can map back via the cache.
4. To @-back: emit `<at user_id="<that open_id>"></at>`; the renderer rewrites to the recipient's view.
5. To display a sender name when `sender_type==="app"`: look it up from the `chat.members.bots` cache rather than from `contact/users/get`.

## I. lark-cli commands the plugin will rely on

- `lark-cli api GET /open-apis/bot/v3/info` — resolve self open_id + app_name; no scope.
- `lark-cli im chat.members bots --params '{"chat_id":"oc_..."}'` (a.k.a. `GET /open-apis/im/v1/chats/{chat_id}/members/bots`) — enumerate bots in a group; needs `im:chat.members:read`.
- `lark-cli api GET /open-apis/im/v1/chats/{chat_id}` — chat metadata (`bot_count`, `tenant_key`, owner); needs `im:chat:readonly` or equivalents.
- `lark-cli im +messages-mget --message-ids ...` — get `sender.id` (app_id) + `mentions[]` for any historical message; useful for back-fill.
- `lark-cli im +messages-send --chat-id ... --text '<at user_id="ou_..."></at> ...'` — emit cross-bot @-mention.

## J. Permissions the user must grant in feishu.cn console

For **both** apps (`cli_BOT_A_APP_ID` and `cli_BOT_B_APP_ID`):

- `im:chat.members:read` — list bots in a group (`chat.members.bots`). Without this we fall back to the lazy event-driven discovery in F.2.
- `im:chat:readonly` (or `im:chat.group_info:readonly`) — read chat metadata; also satisfies `chat.members.bots`.
- `im:message` / `im:message.group_msg` — already present (we are sending messages).
- *Not needed*: `contact:user.base:readonly` for bot-to-bot identity (it returns 41050 anyway). Only grant if you also need to resolve **human** sender display names.

Console URLs surfaced by lark-cli:

- bot1: https://open.feishu.cn/page/scope-apply?clientID=cli_BOT_A_APP_ID&scopes=im%3Achat.members%3Aread
- bot2: https://open.feishu.cn/page/scope-apply?clientID=cli_BOT_B_APP_ID&scopes=im%3Achat.members%3Aread

## Key files / endpoints referenced

- `/Users/bytedance/.openclaw-bot2/npm/node_modules/@openclaw/feishu/dist/probe-BNzzU_uR.js:88-139` — bot self-id via private `openclaw_bot/ping`.
- `/Users/bytedance/.openclaw-bot2/npm/node_modules/@openclaw/feishu/dist/monitor.state-DYM02ipp.js:24-45` — `botOpenIds`/`botNames` private caches.
- `/Users/bytedance/.openclaw-bot2/npm/node_modules/@openclaw/feishu/dist/monitor.account-CUZxYkjE.js:352-388` — `resolveFeishuSenderName` (the 400-logger).
- `/Users/bytedance/.openclaw-bot2/npm/node_modules/@openclaw/feishu/dist/monitor.account-CUZxYkjE.js:1669-1692` — event payload shape (`sender.sender_id.{open_id,user_id,union_id}`, `mentions[]`).
- `/Users/bytedance/.openclaw-bot2/npm/node_modules/@openclaw/feishu/dist/monitor.account-CUZxYkjE.js:1722, 4743` — `senderType === "app"` is the bot-vs-human discriminator already used inside the plugin.
