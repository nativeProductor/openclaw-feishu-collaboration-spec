# OpenClaw 飞书插件 — 让 bot 真正"在群里"

我前阵子在飞书群里用 OpenClaw bot，遇到一个挺常见的问题：群里聊了半天，我 @ bot 问"你怎么看"，它一脸懵——它根本不知道前面发生了什么。

写了这个插件就是为了解决这件事。装上之后 bot 一直在后台听群，被 @ 的时候会拿前面 20 条消息当上下文给模型，回得就像个正常聊过天的人。

## 装了之后大概是这样

**场景 1**：群里讨论了 10 分钟某个 PR 怎么改，你 @ bot 问"你觉得方案 A 还是 B 好"。

没装之前：bot 反问"您说的方案 A 和 B 分别是？"，因为它只能看到你最新这条消息。

装上之后：bot 直接基于前面的讨论给出意见，会引用具体发言比如"上面老王说的那个边界 case"。

**场景 2**：两个 bot 同时被拉进群，A bot @ B bot 问东西。

没装之前：B 答完不会主动 @ 回 A，对话当场断在第一棒。手动续上很烦。

装上之后：B 自动 @ 回 A 接力。但**不会**两个 bot 你来我往刷屏到 1000 轮——到第 3 轮系统会让 B 收尾，第 5 轮直接不带 @，对话自然散场。

**场景 3**：你只想让 bot 在被 @ 时插嘴，别的时候闭嘴。

这是默认行为，不用配置。不被 @ 一个字都不说，但**它一直在听**——下次你 @ 它，它能引用刚才你跟同事聊的内容。

## 工作原理

```
              ┌──────────────────────────────────────────┐
群里有人发消息  │ Module A: 旁听 → 本地 JSONL              │
              │ 顺手用 API 把 WebSocket 漏掉的             │
              │ 其他 bot 的非 @ 消息也补回来               │
              └──────────────────────────────────────────┘
                              ↓
              ┌──────────────────────────────────────────┐
你 @ 了 bot   │ Module B: 鉴权                            │
              │ 群里只回 @ 自己的；私聊全回                │
              └──────────────────────────────────────────┘
                              ↓
              ┌──────────────────────────────────────────┐
              │ Module C: 拼上下文                        │
              │ 本地有 → 几毫秒；没有 → 现拉 API 1~2 秒    │
              └──────────────────────────────────────────┘
                              ↓
                         模型生成回复
                              ↓
              ┌──────────────────────────────────────────┐
              │ Module D: 自动 @ 回 + 刹车                │
              │ 人 @ bot   → 回复带 @                    │
              │ bot @ bot → 带 @，深度递增               │
              │   第 3 轮: 系统提示收尾                   │
              │   第 4 轮: 系统提示更强烈收尾             │
              │   第 5 轮+: 回复不带 @，链路自然断        │
              │ 人插一句话 → 深度归零                    │
              └──────────────────────────────────────────┘
```

## 怎么装

三步。第二步容易漏，漏了第三步就装了个寂寞。

```bash
# 1. 装包
openclaw plugins install openclaw-feishu-collaboration-spec

# 2. 授权钩子访问 —— 这步必须跑
node scripts/ensure-hooks.mjs
```

第二步是因为 `openclaw plugins install` 每次都会把配置里 `hooks.allowConversationAccess` 给抹掉，没这个 flag 我们就接不到 `llm_output` 和 `agent_end` 钩子，`@ 回去`和刹车都会哑火。这个脚本重跑不会有问题，可以每次装完都跑一遍。

```bash
# 3. 重启 gateway
openclaw gateway restart
```

启动日志里能看到这一行：

```
[feishu-collab] bot identity resolved open_id=ou_... app_id=cli_...
```

看到这行就 OK 了。如果没看到，看下面的 troubleshooting。

需要的飞书权限：`im:message`（让 API 能拉历史）、`im:message.group_at_msg`（让 bot 听到自己被 @）、`im:chat.members:read`（让插件区分群里的人和 bot，刹车要用）。后台开权限以后记得发版。

## 出问题怎么排查

bot 装上没反应？按这个顺序查：

1. `~/.openclaw-<profile>/logs/gateway.log` 里搜 `feishu-collab`，看插件是不是加载成功
2. 看有没有 `bot identity resolved` 这一行。没有的话大概率是 `lark-cli auth` 没登或者飞书权限没开
3. 还是不行，看有没有 `gate-decision: reply` —— 这是 bot 决定要回复的日志。如果消息来了但没这行，说明 Module B 把它过滤了
4. JSONL 文件在 `~/.openclaw-<profile>/state/feishu-collab/transcripts/<chat_id>.jsonl`，直接 `cat` 看里面有没有内容
5. 把这个文件删掉不会让插件崩，只会丢失上下文（下次有事件触发时 backfill 会重新拉一遍）

## 这玩意儿现在还做不到的事

写文档我不想藏问题。装之前你最好知道：

- **是单机本地存的**。JSONL 在本地文件系统，多个 gateway 实例之间不共享。如果你跨机部署多个实例听同一个群，每台机器都会维护自己的 transcript。这不是 bug，是有意的选择——加 Redis 这种共享存储会带来更多协调问题，不值得。
- **没有 API rate limit 重试**。如果飞书 API 撞墙了，那一轮的 backfill 就丢了，本地数据会少一些。下次有消息进来时会自动再补一次。我们看下来稳态下没撞过墙，但激进部署需要留意。
- **没有"完全不让 bot 回复"那一档**。OpenClaw SDK 的 `before_prompt_build` 钩子不支持让插件 short-circuit 整个回复流程——返回 `{skip: true}` 也会被忽略。所以刹车的最强档其实是"回复不带 @"，让 peer 的 mention gate 天然过滤掉。功能上等效，但和"硬 skip"不一样。
- **冷启动第一次回复慢**。新装的 bot 在一个新群里第一次被 @，本地 JSONL 是空的，要现去飞书 API 拉一次历史，大概 1~2 秒。从第二次开始本地有缓存，<10 毫秒搞定。
- **ensure-hooks.mjs 每次重装都得重跑**。`openclaw plugins install` 设计上会重写 plugin entry，这个 flag 不在它管的范围内。

## 改默认配置（一般用不到）

99% 装上不动就行。但如果想改：

```bash
# 关掉 bot↔bot 的 @ 回（只对人 @ 回）
openclaw config patch --stdin <<'EOF'
{"plugins":{"entries":{"feishu-collab":{"config":{"crossBot":{"atBackBots":false}}}}}}
EOF

# 把上下文窗口拉到 50 条
openclaw config patch --stdin <<'EOF'
{"plugins":{"entries":{"feishu-collab":{"config":{"context":{"lastN":50}}}}}}
EOF

# 调刹车阈值（默认 5）
openclaw config patch --stdin <<'EOF'
{"plugins":{"entries":{"feishu-collab":{"config":{"crossBot":{"loopGuard":{"maxDepth":8}}}}}}}
EOF
```

## FAQ

**怎么不让 bot 自己主动发言？**

不会发。设计上就只回 @ 它的消息。早期考虑过让 bot 在群里气氛好的时候主动说点什么，试了下体验非常烂——这种"主动插嘴"在所有场景里到头来都是噪音，干脆从代码里删了。`gate.mode` 现在只剩一个值 `mention-only`，配也只能配这个。

**为什么 bot↔bot 有刹车，人 @ bot 没刹车？**

人 @ bot 没循环风险——你自己下一句就走开了。bot @ bot 不刹会变成两台机器对着群里互相 @ 几千轮。刹车设计：前两轮正常回；第 3 轮在系统提示词里偷偷塞句"差不多收尾吧"；第 4 轮塞更强的；第 5 轮起回复不带 @，对方收不到 @ 事件就不会被触发，链路自然死。这个数字 (5) 是从飞书官方对 agent 多轮对话的建议来的。

**P2P 私聊能用吗？**

能。但很多东西不会触发——私聊没有"@ vs 不 @"的区分，也没有 bot↔bot 循环。所以 Module B/C/D 在私聊里走最简单的路径：全回，带最近 20 条上下文。

**历史消息里包含哪些内容？人和 bot 的非 @ 消息都有吗？**

包含。两条管道合起来：(1) WebSocket 事件实时推送你能收到的所有消息，包括人没 @ 的发言和其他 bot @ 你的发言；(2) 每次有事件触发时，插件会顺手调一下飞书 API，把 WebSocket 漏掉的（其他 bot 没 @ 任何人时说的话）补回本地。

唯一不会进 transcript 的是你自己（这台 bot）说过的话——因为模型自己的 session 里已经有这些 assistant turn 了，再塞进 system prompt 是重复。

**消息会存到爆吗？多久清理一次？**

不会爆。每个群一个 JSONL 文件，默认上限 2000 条；超了之后保留最近 1333 条，旧的丢。这是纯按条数算的，没有按天数过期——你的群冷了 6 个月没人说话，文件就停在 6 个月前最后一条不动；下次有人重新激活群，那 1333 条上下文还在。

容量估算：单条记录平均 500 字节，单群最大约 1MB，装在 100 个活跃群里大概几十 MB，不会出事。

**为什么没有按天过期？**

试过想加 `ttlHours` 配置，写到 schema 里又删了。理由：群冷了不代表上下文该忘——下次激活时上下文还在反而是对的体验。按条数限制就足够防止文件无限增长。

**这玩意儿能跨机共享吗？**

不能。JSONL 是机器本地的。多实例部署同一个 bot 的话，每台机器有自己的一份 transcript。如果两台机器同时收到不同的 @ 事件去回复，行为是各自独立的。需要共享得自己加 Redis 之类的——但坦白说，跨机一致性大概率不是你目前需要解决的问题。

## 链接

- GitHub: <https://github.com/nativeProductor/openclaw-feishu-collaboration-spec>
- 协议：MIT
