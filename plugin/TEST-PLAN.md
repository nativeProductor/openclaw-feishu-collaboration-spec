# feishu-collab — QA test plan

Status: **draft** (design phase; no execution yet)
Plugin under test: `openclaw-feishu-collaboration-spec` (augments `@openclaw/feishu` channel)
Target OpenClaw runtime: `2026.5.6`
Owner: QA (this doc) · Dev: feishu-collab authors · Product: openclaw-team-in-feishu

---

## 0. Test environment & conventions

### 0.1 Bots and group

| Role | app_id              | Host                                  | Notes                                  |
|------|---------------------|---------------------------------------|----------------------------------------|
| bot1 | `cli_BOT_A_APP_ID` | Remote `REMOTE_HOST` (systemd unit `openclaw-gateway.service`) | Acts as "the other bot" in Module D tests |
| bot2 | `cli_BOT_B_APP_ID` | Local Mac, `--profile bot2`, port `18889` | Plugin under test runs here          |

Shared group chat id: `oc_TEST_GROUP_ID` (referred to as `$GROUP` below).

### 0.2 Harness commands

Sender (run on the host of whichever bot is the *sender* of the test message):

```bash
OPENCLAW_HOME=$HOME/.openclaw-bot2 \
  lark-cli --profile <bot1|bot2> im +messages-send \
    --chat-id $GROUP \
    --msg-type text \
    --content '{"text":"<at user_id=\"OPEN_ID_OF_BOT2\"></at> hello"}'
```

Notes:
- `OPEN_ID_OF_BOT2` is tenant-scoped. A separate research agent is producing the canonical mapping; for this plan we treat the variable as resolved at runtime and refer to it as `$OPEN_ID_BOT2` / `$OPEN_ID_BOT1`.
- Non-`@` plain text: drop the `<at .../>` element and send `{"text":"hello"}`.
- To impersonate a non-bot human user during allowFrom tests, run lark-cli `--as user` (see `lark-shared` skill); otherwise messages are sent as the bot identity.

Observers:

```bash
# bot2 (local) — primary SUT logs
tail -F /Users/bytedance/.openclaw-bot2/logs/gateway.log

# bot1 (remote) — only needed for Module D
ssh root@REMOTE_HOST 'journalctl --user -u openclaw-gateway.service -f'
```

### 0.3 Log signals QA greps for

| Signal                                                | Meaning                                  |
|-------------------------------------------------------|------------------------------------------|
| `bot2 RECV`                                           | Inbound Feishu event received            |
| `bot2 DISP-S`                                         | Dispatch into plugin pipeline started    |
| `bot2 DISP-E queuedFinal=<bool> replies=<n>`          | Dispatch finished                        |
| `bot2 BLOCK`                                          | Sender rejected by `allowFrom`           |
| `[feishu-collab] gate-decision: reply\|skip`            | Module B decision                        |
| `[feishu-collab] context-injected msgs=<n>`             | Module C activated                       |
| `[feishu-collab] cross-bot detected sender=<app_id>`    | Module D activated                       |
| `[feishu-collab] cross-bot reply-with-at target=<id>`   | Module D output                          |
| `[feishu-collab] loop-guard tripped depth=<n>`          | Module D anti-loop fired                 |

Dev MUST emit at least these strings; this is locked in §5.

### 0.4 Test ID naming

`<Module>-<Group>.<Case>` — e.g. `B-1.3` = Module B, group 1 (mention-only), case 3.
Negative cases use `N-`; perf cases use `P-`.

### 0.5 Pass/fail rule

A case passes iff **all** lines under `expected:` appear in log within the listed timeout, **and no** line under `must_not_log:` appears. Timeouts default to 15s after `wait_for`.

---

## 1. Acceptance criteria per module

### Module B — Reply Gate

#### B-1 mention-only (P0, Phase 1)

Bot replies iff the inbound message contains an `<at>` element targeting bot2's open_id.

**Preconditions (apply to all B-1.x):**
- feishu-collab installed on bot2, `mode=mention-only`
- bot2 daemon running, joined `$GROUP`
- gateway.log being tailed
- group has no other pending messages (drain first)

```yaml
id: B-1.1
module: B
title: @-mention from human user → bot replies
steps:
  - send_as: bot1            # used here as a stand-in sender
    text: '<at user_id="$OPEN_ID_BOT2"></at> what time is it?'
  - wait_for: 'bot2 DISP-E'
expected:
  - 'bot2 RECV'
  - 'bot2 DISP-S'
  - '[feishu-collab] gate-decision: reply'
  - 'bot2 DISP-E queuedFinal=true replies=1'
  - bot2 posts a reply visible in $GROUP that references the question
must_not_log:
  - 'bot2 BLOCK'
  - '[feishu-collab] gate-decision: skip'
```

```yaml
id: B-1.2
module: B
title: plain text (no @) in group → bot stays silent
steps:
  - send_as: bot1
    text: 'random chatter, no mention'
  - wait_for: 'bot2 DISP-E'
expected:
  - 'bot2 RECV'
  - 'bot2 DISP-S'
  - '[feishu-collab] gate-decision: skip'
  - 'bot2 DISP-E queuedFinal=false replies=0'
must_not_log:
  - bot2 posting any text into $GROUP
```

```yaml
id: B-1.3
module: B
title: @-mention targeting a DIFFERENT user → bot stays silent
steps:
  - send_as: bot1
    text: '<at user_id="$OPEN_ID_SOMEONE_ELSE"></at> hi'
  - wait_for: 'bot2 DISP-E'
expected:
  - '[feishu-collab] gate-decision: skip'
  - 'bot2 DISP-E queuedFinal=false replies=0'
```

```yaml
id: B-1.4
module: B
title: @-mention inside quoted/reply message → bot replies
steps:
  - send_as: bot1
    text: '> earlier text\n<at user_id="$OPEN_ID_BOT2"></at> follow-up?'
expected:
  - '[feishu-collab] gate-decision: reply'
  - 'bot2 DISP-E queuedFinal=true replies=1'
```

```yaml
id: B-1.5
module: B
title: 1:1 DM (not group) → bot always replies regardless of mention
preconditions:
  - bot2 is in a P2P chat with the test sender
steps:
  - send_as: bot1
    chat_type: p2p
    text: 'ping'
expected:
  - '[feishu-collab] gate-decision: reply (reason=p2p-bypass)'
  - 'bot2 DISP-E queuedFinal=true replies=1'
```

```yaml
id: B-1.6
module: B
title: @all mention → bot stays silent (don't fire on broadcasts)
steps:
  - send_as: bot1
    text: '<at user_id="all"></at> announcement'
expected:
  - '[feishu-collab] gate-decision: skip (reason=at-all-ignored)'
```

#### B-2 autonomous (P1, Phase 2 — placeholder, see §1.B-2 deferred file)

```yaml
id: B-2.1
module: B
title: autonomous classifier returns reply on direct question
preconditions:
  - mode=autonomous
  - classifier model configured (e.g. mimo-v2.5-mini)
steps:
  - send_as: bot1
    text: 'anyone know how OpenClaw handles retries?'
expected:
  - '[feishu-collab] gate-decision: reply (classifier=YES score=0.xx)'
  - 'bot2 DISP-E queuedFinal=true replies=1'
```

```yaml
id: B-2.2
module: B
title: autonomous skips ambient chitchat
steps:
  - send_as: bot1
    text: 'lol nice'
expected:
  - '[feishu-collab] gate-decision: skip (classifier=NO score=0.xx)'
```

```yaml
id: B-2.3
module: B
title: autonomous still replies when explicitly @-mentioned (override)
steps:
  - send_as: bot1
    text: '<at user_id="$OPEN_ID_BOT2"></at> lol nice'
expected:
  - '[feishu-collab] gate-decision: reply (reason=explicit-mention)'
```

### Module C — Context Inject

Goal: when Module B decides to reply, the prompt to the LLM contains the last N group messages.

**Preconditions (all C-x):** mode=mention-only, context_window=20 (TBD), bot2 has access to chat/messages API.

```yaml
id: C-1.1
module: C
title: context inject pulls last N messages from group
steps:
  - send_as: bot1, text: 'apple'
  - send_as: bot1, text: 'banana'
  - send_as: bot1, text: 'cherry'
  - send_as: bot1, text: '<at user_id="$OPEN_ID_BOT2"></at> which fruits did I just list?'
  - wait_for: 'bot2 DISP-E'
expected:
  - '[feishu-collab] context-injected msgs=4'  # the 3 fruit lines + trigger
  - bot2 reply text contains 'apple', 'banana', 'cherry'
```

```yaml
id: C-1.2
module: C
title: context window cap honored
preconditions:
  - context_window=10
steps:
  - send_as: bot1: send 25 messages 'm1'..'m25' (no mention)
  - send_as: bot1, text: '<at user_id="$OPEN_ID_BOT2"></at> repeat the last 10 things i said'
expected:
  - '[feishu-collab] context-injected msgs=10'
  - bot2 reply references 'm16' .. 'm25' (or similar tail-10 slice)
  - bot2 reply does NOT reference 'm1' .. 'm15'
```

```yaml
id: C-1.3
module: C
title: context excludes other bots' system events / heartbeats
steps:
  - emit a non-message event in $GROUP (e.g. join/leave noise — manual)
  - send_as: bot1, text: '<at user_id="$OPEN_ID_BOT2"></at> summarize chat'
expected:
  - '[feishu-collab] context-injected msgs=<n>' where n equals real message count, not events
```

```yaml
id: C-1.4
module: C
title: context inject is skipped when gate decides 'skip'
steps:
  - send_as: bot1, text: 'random chatter'
expected:
  - '[feishu-collab] gate-decision: skip'
must_not_log:
  - '[feishu-collab] context-injected'
```

```yaml
id: C-1.5
module: C
title: context fetch failure → degrades gracefully, still replies
preconditions:
  - simulate failure: revoke chat/messages scope or block egress to open.feishu.cn
steps:
  - send_as: bot1, text: '<at user_id="$OPEN_ID_BOT2"></at> hi'
expected:
  - '[feishu-collab] context-fetch failed err=<...>'
  - '[feishu-collab] context-injected msgs=0 (fallback)'
  - 'bot2 DISP-E queuedFinal=true replies=1'   # still replies, just contextless
```

```yaml
id: C-1.6
module: C
title: context source = memory-core when enabled
preconditions:
  - config: context.source=memory-core
  - memory-core plugin installed & has indexed prior turns
expected (over a multi-turn dialogue):
  - '[feishu-collab] context-injected source=memory-core msgs=<n>'
  - bot2 reply references content from > context_window ago via semantic recall
```

### Module U — Universality (zero-topology, install-and-go)

**Hard product invariant (locked by product owner):** the plugin must work on **any** OpenClaw bot in **any** Feishu group with **zero** per-chat or per-bot configuration. No `chat_id` / `open_id` / `app_id` lists may appear in config; everything is runtime-discovered.

These cases gate release — any failure here is a P0 bug.

```yaml
id: U-1
module: U
title: brand-new bot in a brand-new group works without any config touch
preconditions:
  - a third Feishu app `cli_NEW` (NOT bot1 or bot2) exists, never seen by feishu-collab before
  - bot3 added to a fresh group `$NEW_GROUP` together with bot1
  - feishu-collab installed via `openclaw plugins install openclaw-feishu-collaboration-spec` on bot3 (one command, default config)
  - bot3's `openclaw.json` contains NO entries under `plugins.entries.feishu-collab.config.crossBot.knownBotOpenIds`, `.knownChats`, or similar topology fields (because those fields MUST NOT EXIST in the schema)
steps:
  - send_as: bot1 (in $NEW_GROUP)
    text: '<at user_id="$OPEN_ID_BOT3_AS_SEEN_BY_BOT1"></at> hi bot3'
expected:
  - '[feishu-collab] gate-decision: reply'
  - bot3 'DISP-E queuedFinal=true replies=1'
  - bot3 reply outbound text contains '<at user_id=' resolving to bot1 (via bot1 RECV)
  - '[feishu-collab] cross-bot reply-with-at target=<runtime-resolved>'
must_not_log:
  - any log line containing the literal app_id of bot1 inside feishu-collab's CONFIG read (i.e. a hardcoded match)
```

```yaml
id: U-2
module: U
title: chat membership discovery is runtime + cached per chat
expected (first message into a chat bot3 has never seen):
  - '[feishu-collab] chat-members-discovered chat=<id> bots=<count> humans=<count> elapsed_ms=<n>'
expected (subsequent message into same chat within cache TTL):
  - NO new chat-members-discovered log
  - '[feishu-collab] chat-members-cache-hit chat=<id>'
expected (after cache TTL expires):
  - members re-fetched
```

```yaml
id: U-3
module: U
title: zero-topology invariant — config diff stays empty after running U-1
preconditions:
  - snapshot bot3's openclaw.json before U-1
  - run U-1
  - snapshot after
steps:
  - diff "before" and "after"
expected:
  - feishu-collab config section has NO new entries under any field of shape "list of ids" or "map keyed by chat/bot id"
  - any runtime state must live OUTSIDE the user-editable config (e.g. cache file at ~/.openclaw-bot2/state/feishu-collab.json or in-memory)
```

```yaml
id: U-4
module: U
title: bot identifies itself at runtime without being told its own open_id
expected (on startup of bot3 with plugin):
  - '[feishu-collab] self-identity resolved app_id=cli_NEW open_id=<value>'
  - no config field `selfOpenId` or `selfAppId` is required by the plugin's schema
```

```yaml
id: U-5
module: U
title: works in a group with 3+ bots all running the plugin
preconditions:
  - bot1, bot2, bot3 all installed feishu-collab with default config
  - all three in $NEW_GROUP3
steps:
  - send_as: human, text: '<at user_id="$BOT2_BY_HUMAN"></at> let bot1 and bot3 brainstorm something'
expected:
  - bot2 replies @-mentioning bot1 (or bot3) by name
  - chain may continue but loop_guard caps it
  - no stack traces, no "unknown bot" errors
```

```yaml
id: U-6
module: U
title: plugin schema rejects any topology-bound config field
preconditions:
  - attempt to put hand-edited config:
    ```json5
    { plugins: { entries: { 'feishu-collab': { config: {
      knownBotOpenIds: ['ou_xxx'],          // should be rejected
      perChat: { 'oc_xxx': { ... } },        // should be rejected
    } } } } }
    ```
steps:
  - run `openclaw config validate`
expected:
  - validation error: unknown property `knownBotOpenIds` / `perChat`
  - schema export shows ONLY policy fields (mode, window, atBack, etc.) and ZERO id-list fields
```

---

### Module D — Cross-Bot @-back

Goal: if inbound was from another bot, bot2's reply auto-includes `<at user_id="$OPEN_ID_BOT1">` so bot1 sees & can chain.

```yaml
id: D-1.1
module: D
title: bot1 @-mentions bot2 → bot2 replies with @bot1 inline
steps:
  - send_as: bot1
    text: '<at user_id="$OPEN_ID_BOT2"></at> hello bot2'
  - wait_for: 'bot2 DISP-E'
expected:
  - '[feishu-collab] cross-bot detected sender=cli_BOT_A_APP_ID'
  - '[feishu-collab] cross-bot reply-with-at target=$OPEN_ID_BOT1'
  - bot2 outbound text contains '<at user_id="$OPEN_ID_BOT1">' (verify via bot1 RECV log)
```

```yaml
id: D-1.2
module: D
title: bot1 sends WITHOUT @-mention → mention-only gate still applies; no auto-@-back when no reply
steps:
  - send_as: bot1, text: 'hi everyone'
expected:
  - '[feishu-collab] gate-decision: skip'
must_not_log:
  - 'cross-bot reply-with-at'
```

```yaml
id: D-2.1
module: D
title: anti-loop — break after N bot↔bot turns
preconditions:
  - loop_guard_max_depth=5 (TBD)
  - configure bot1's policy so it always @-replies bot2 when @-mentioned (forces ping-pong)
steps:
  - send_as: human (lark-cli --as user)
    text: '<at user_id="$OPEN_ID_BOT2"></at> start a thread with bot1'
  - observe: bot1 ↔ bot2 ping-pong
expected:
  - turns 1..5: '[feishu-collab] cross-bot reply-with-at' on bot2
  - turn 6 on bot2: '[feishu-collab] loop-guard tripped depth=5'
  - 'bot2 DISP-E queuedFinal=false replies=0'
  - thread stops
```

```yaml
id: D-2.2
module: D
title: loop guard depth resets after human interjects
steps:
  - run D-2.1 to depth=3
  - send_as: human, text: 'hold on'
  - send_as: bot1, text: '<at user_id="$OPEN_ID_BOT2"></at> resume?'
expected:
  - depth counter reset; bot2 replies normally
  - '[feishu-collab] loop-guard depth=1'
```

```yaml
id: D-3.1
module: D
title: bot2 sender open_id resolution from bot's app_id
preconditions:
  - inbound event metadata includes sender app_id but not open_id directly
steps:
  - send_as: bot1, text: '<at user_id="$OPEN_ID_BOT2"></at> ping'
expected:
  - '[feishu-collab] cross-bot resolve app_id=cli_BOT_A_APP_ID → open_id=$OPEN_ID_BOT1'
  - no resolution failure
```

```yaml
id: D-3.2
module: D
title: unknown bot sender (third-party bot in group) → @-back still works or graceful skip
steps:
  - introduce a third bot bot3 into $GROUP (manual)
  - send_as: bot3, text: '<at user_id="$OPEN_ID_BOT2"></at> hi'
expected (either acceptable, document which Dev picks):
  - Option A: '[feishu-collab] cross-bot reply-with-at target=$OPEN_ID_BOT3'
  - Option B: '[feishu-collab] cross-bot resolve failed; reply without @-back'
must_not_log:
  - uncaught exception / stack trace
```

---

## 2. Negative / edge cases

```yaml
id: N-1
title: allowFrom blocks an unauthorized sender
preconditions:
  - bot2 channel config: allowFrom=[bot1.app_id]
steps:
  - send_as: random user not in allowFrom, text: '<at user_id="$OPEN_ID_BOT2"></at> hi'
expected:
  - 'bot2 RECV'
  - 'bot2 BLOCK'
must_not_log:
  - 'DISP-S'
  - '[feishu-collab]'
```

```yaml
id: N-2
title: image-only message with @-mention (no text) → bot handles gracefully
steps:
  - send_as: bot1, msg-type: image, mention: bot2
expected:
  - either reply ('I see an image') or skip (reason=unsupported-msg-type)
  - no crash, gateway.log has no stack traces
```

```yaml
id: N-3
title: group with 100+ messages backlog → context window doesn't overflow
preconditions:
  - context_window=20
  - $GROUP has > 100 prior messages
steps:
  - send_as: bot1, text: '<at user_id="$OPEN_ID_BOT2"></at> hello'
expected:
  - '[feishu-collab] context-injected msgs=20'
  - bot2 prompt token count (from log if Dev adds metric) < model context limit
```

```yaml
id: N-4
title: malformed @-element (broken xml) → bot doesn't crash; treated as no-mention
steps:
  - send_as: bot1, text: '<at user_id="$OPEN_ID_BOT2"> hi'   # missing close
expected:
  - '[feishu-collab] gate-decision: skip (reason=no-valid-mention)'
  - no stack trace
```

```yaml
id: N-5
title: extremely long inbound message (>32 KB)
steps:
  - send_as: bot1, text: '<at .../> ' + 'A'*32000
expected:
  - truncation logged, processed without OOM, reply returned
```

```yaml
id: N-6
title: cross-bot AND mention-only on, bot1 sends @ → bot2 replies AND auto-@-backs
  (combined module B + D path)
expected:
  - 'gate-decision: reply'
  - 'cross-bot reply-with-at target=$OPEN_ID_BOT1'
```

```yaml
id: N-7
title: bot2 restarts mid-dialogue; loop-guard depth state lost on restart
  (document expected behavior; ideally depth persisted to bot2 cache file)
expected: TBD with Dev; record actual behavior
```

```yaml
id: N-8
title: feishu-collab plugin disabled at runtime → channel falls back to default reply-everywhere behavior
expected:
  - no '[feishu-collab]' log lines
  - bot2 replies to every group message it can see (verify by sending plain text → reply)
```

```yaml
id: N-9
title: two @-mentions in one message (bot2 + bot1) → bot2 replies once, auto-@-backs bot1
expected:
  - 'gate-decision: reply'
  - 'cross-bot reply-with-at target=$OPEN_ID_BOT1'
  - exactly 1 outbound message
```

---

## 3. Performance / non-functional

```yaml
id: P-1
title: median dispatch→reply latency ≤ 12s with mimo-v2.5-pro
method:
  - run B-1.1 30 times spaced 30s apart
  - extract t(DISP-S) and t(DISP-E) from gateway.log
  - compute median, p95
pass:
  - median ≤ 12000 ms
  - p95 ≤ 25000 ms
```

```yaml
id: P-2
title: autonomous classifier cost ≤ 5% of primary model spend
method:
  - 50 messages in autonomous mode, mix of YES/NO
  - sum classifier tokens vs primary model tokens from log
pass:
  - classifier_cost / total_cost ≤ 0.05
```

```yaml
id: P-3
title: context fetch latency ≤ 1.5s p95
method:
  - log `[feishu-collab] context-fetch took=<ms>` for 30 runs
pass:
  - p95 ≤ 1500 ms
```

```yaml
id: P-4
title: no memory leak over 200-message session
method:
  - run continuous traffic for 30 min; observe bot2 RSS via `ps`
pass:
  - RSS growth < 50 MB over the session
```

```yaml
id: P-5
title: log volume — no log-spam regression
pass:
  - gateway.log grows < 2 KB per dispatch on average
```

---

## 4. Test case format

(Already used throughout §1-§3.) Reproduced here as the canonical schema:

```yaml
id: <Module>-<group>.<case>
module: B | C | D | N | P
title: short imperative
preconditions:
  - bullet list
steps:
  - send_as: bot1 | bot2 | human
    text: 'literal Feishu text (xml escapes allowed)'
    chat_type: group | p2p   # default group
    delay_ms: <int, optional>
  - wait_for: '<log substring>'
    timeout_ms: 15000        # default
expected:
  - literal log substring (each must appear)
  - or 'bot2 posts text containing X' (verified by tailing $GROUP)
must_not_log:
  - literal log substring (none may appear)
```

Each case is independent; reset state between cases by:
1. `> /Users/bytedance/.openclaw-bot2/logs/gateway.log` (truncate)
2. Wait 2s for any pending dispatches
3. Begin next case

---

## 5. What QA needs from Dev before running

Blocking deliverables — please confirm before sprint exit:

1. **Hook names / log strings.** Dev must emit at minimum the strings enumerated in §0.3. If names change, update this doc in the same PR.
2. **Config schema.** YAML/JSON shape for:
   - `mode: mention-only | autonomous`
   - `context.window: int`
   - `context.source: feishu-api | memory-core`
   - `cross_bot.enabled: bool`
   - `cross_bot.loop_guard_max_depth: int`
   QA needs this to spin alternate-config runs (e.g. context_window=10 for C-1.2).
3. **Tarball of the plugin** installable via `openclaw plugin install ./feishu-collab-<ver>.tgz`, or a published `openclaw-feishu-collaboration-spec@<ver>` we can `npm i`.
4. **Test-mode toggle** (nice-to-have): a flag that makes the classifier deterministic (e.g. `FEISHU_MIND_TEST_FORCE=reply|skip`) so B-2.x doesn't depend on LLM nondeterminism.
5. **open_id resolver helper** (or doc): how QA scripts can look up `$OPEN_ID_BOT1` / `$OPEN_ID_BOT2` for the tenant. Coordinate with the open_id research agent.
6. **Sample inbound event fixtures** for replay (JSON of a Feishu `im.message.receive_v1` event) so we can unit-test offline without a live group.

---

## 6. Open questions for the user / product owner

1. **Mention-only scope**: does an `@bot2` *inside a reply-thread* (Feishu native reply, not free-text quote) count as a mention? Likely yes — please confirm so we can lock B-1.4.
2. **Cross-bot reply-with-at**: when bot2's reply contains the @-back, should the visible text *prepend* the `<at>` or *embed* it mid-sentence? Affects user readability.
3. **Loop guard**: depth=5 is a placeholder. What's the product intent — 3? 10? Should the bot also rate-limit (e.g. ≤ 1 cross-bot turn per 30s) as a second axis?
4. **Context source default**: ship with `feishu-api` and let memory-core be opt-in, or auto-detect when memory-core is installed?
5. **P2P bypass (B-1.5)**: should DMs bypass the gate entirely, or also honor mention-only? Current draft assumes bypass.
6. **@all behavior (B-1.6)**: ignore is the safe default but product may want bot2 to acknowledge `@all` announcements.
7. **Image/file messages (N-2)**: do we want a Phase-1 reply-with-OCR/vision-summary, or pure skip?
8. **Restart durability (N-7)**: should loop-guard depth survive a bot2 restart? If yes, where do we persist it (`~/.openclaw-bot2/state/feishu-collab.json`)?
9. **Phase-2 split**: should the autonomous-mode test suite move to a sibling file `TEST-PLAN-PHASE2.md` once B-2 lands, or stay merged? Current doc keeps B-2 inline as a placeholder.

---

## Appendix A — case index

| ID    | Module | Title (truncated)                                                |
|-------|--------|------------------------------------------------------------------|
| B-1.1 | B      | @-mention from human → reply                                     |
| B-1.2 | B      | plain text → silent                                              |
| B-1.3 | B      | @ different user → silent                                        |
| B-1.4 | B      | @ inside quote → reply                                           |
| B-1.5 | B      | P2P DM bypass                                                    |
| B-1.6 | B      | @all → silent                                                    |
| B-2.1 | B      | autonomous YES                                                   |
| B-2.2 | B      | autonomous NO                                                    |
| B-2.3 | B      | autonomous override on explicit mention                          |
| C-1.1 | C      | last N messages injected                                         |
| C-1.2 | C      | window cap honored                                               |
| C-1.3 | C      | excludes system events                                           |
| C-1.4 | C      | no inject on skip                                                |
| C-1.5 | C      | fetch failure degrades gracefully                                |
| C-1.6 | C      | memory-core source                                               |
| D-1.1 | D      | @-back on cross-bot                                              |
| D-1.2 | D      | no @-back when no reply                                          |
| D-2.1 | D      | loop guard trips at depth=5                                      |
| D-2.2 | D      | human interjection resets depth                                  |
| D-3.1 | D      | app_id → open_id resolution                                      |
| D-3.2 | D      | unknown third-party bot                                          |
| N-1   | N      | allowFrom blocks unauthorized sender                             |
| N-2   | N      | image-only with mention                                          |
| N-3   | N      | 100+ backlog doesn't overflow window                             |
| N-4   | N      | malformed @-element                                              |
| N-5   | N      | 32 KB message                                                    |
| N-6   | N      | combined B+D path                                                |
| N-7   | N      | restart mid-dialogue                                             |
| N-8   | N      | plugin disabled fallback                                         |
| N-9   | N      | dual @-mention                                                   |
| P-1   | P      | dispatch latency p50 ≤ 12s                                       |
| P-2   | P      | classifier cost ≤ 5%                                             |
| P-3   | P      | context fetch p95 ≤ 1.5s                                         |
| P-4   | P      | no memory leak over 200 msgs                                     |
| P-5   | P      | log volume sane                                                  |

Total: 41 cases (9 B, 6 C, 6 D, 6 U, 9 N, 5 P).
