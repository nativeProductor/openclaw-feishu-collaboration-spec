# OpenClaw 飞书插件

让 OpenClaw bot 在飞书群里被 @ 时能拿到完整的群聊上下文。不被 @ 时静默旁听，但消息记录会进本地存储；下次被 @ 时模型能引用前面的讨论。

## 装了之后的效果

**场景 1**：群里讨论了 10 分钟某个 PR 怎么改，有人 @ bot 问"方案 A 还是 B 好"。

装之前：bot 回"您说的方案 A 和 B 是？"——它只能看到最新这条消息。
装之后：bot 基于前面的讨论给意见，会引用具体发言。

**场景 2**：两个 bot 同时被拉进群，A @ B 提问。

装之前：B 答完不会 @ 回 A，对话断在第一棒。
装之后：B 自动 @ 回 A 接力。但**不会**无限循环——到第 3 轮系统提示 B 收尾，第 5 轮起 B 的回复不带 @，对方接收不到 @ 事件，对话自然散场。

## 工作原理

```
              ┌──────────────────────────────────────────┐
群里有人发消息  │ Module A: 旁听 → 本地 JSONL              │
              │ 同时用 API 把 WebSocket 漏掉的             │
              │ 其他 bot 的非 @ 消息补回来                 │
              └──────────────────────────────────────────┘
                              ↓
              ┌──────────────────────────────────────────┐
被 @          │ Module B: 鉴权                            │
              │ 群里只回 @ 自己的；私聊全回                │
              └──────────────────────────────────────────┘
                              ↓
              ┌──────────────────────────────────────────┐
              │ Module C: 拼上下文                        │
              │ 本地有缓存 → 几毫秒                       │
              │ 冷启动 → 现拉 API 1~2 秒                  │
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

注：上下文窗口默认取最近 20 条（可配置），本地实际保留最近 2000 条记录——存的多是为了应对群内聊得快的情况，每次取 20 是因为更多通常没用且占 token。

## 安装

三步，缺一不可。

```bash
# 1. 装包
openclaw plugins install openclaw-feishu-collaboration-spec

# 2. 授权钩子访问
node scripts/ensure-hooks.mjs

# 3. 重启 gateway
openclaw gateway restart
```

第二步必须跑：`plugins install` 会重置钩子配置，这个脚本用来恢复；之后每次 reinstall 都要重跑一遍。我们试过把它合进 `plugins install` 主流程，结论是 OpenClaw 当前架构上做不到完全自动化，原因写在了下面的常见问题里。

启动日志里能看到这一行表示成功：

```
[feishu-collab] bot identity resolved open_id=ou_... app_id=cli_...
```

### 飞书权限

| 权限 | 用途 |
|---|---|
| `im:message` | 通过 API 拉群消息历史 |
| `im:message.group_at_msg` | 接收"@ 自己"的事件 |
| `im:chat.members:read` | 区分群成员是人还是 bot（刹车需要） |

后台开权限后记得发版。

## 排查问题

按这个顺序查：

1. `~/.openclaw-<profile>/logs/gateway.log` 里搜 `feishu-collab`，看插件是否加载成功
2. 看启动日志里有没有 `bot identity resolved`，没有说明 `lark-cli auth` 没登录或权限未开
3. 看消息处理日志里有没有 `gate-decision: reply`——这是 bot 决定要回复的标志。消息来了但没这行说明 Module B 把它过滤掉了
4. 本地 transcript 在 `~/.openclaw-<profile>/state/feishu-collab/transcripts/<chat_id>.jsonl`
5. 这个文件被删不会让插件崩，只会丢上下文（下次有事件触发 backfill 会重新拉一遍）

## 已知限制

装之前需要了解：

- **单机本地存储**。JSONL 文件不跨实例共享。多机部署同一个 bot 时，每台机器维护各自的 transcript。这是有意的设计——加分布式存储会带来不成比例的协调复杂度。
- **没有 API rate limit 重试**。飞书 API 撞墙时该轮 backfill 会丢失，下次事件触发会自动重试。稳态下未遇到过限流，但激进部署需要监控。
- **不能完全停止回复**。OpenClaw SDK 不支持插件层 short-circuit 整个回复流程。刹车最强档是"回复不带 @"——对方接收不到 @ 事件，对话链路自然中断。
- **冷启动首次回复较慢**。新装的 bot 在新群里第一次被 @ 时，本地无缓存，需要现调 API 拉历史，约 1~2 秒。第二次起本地命中，<10 ms。

## 修改默认配置

绝大多数场景无需修改。如需调整：

```bash
# 关闭 bot↔bot 的自动 @ 回（只对人 @ 回）
openclaw config patch --stdin <<'EOF'
{"plugins":{"entries":{"feishu-collab":{"config":{"crossBot":{"atBackBots":false}}}}}}
EOF

# 把上下文窗口拉到 50 条
openclaw config patch --stdin <<'EOF'
{"plugins":{"entries":{"feishu-collab":{"config":{"context":{"lastN":50}}}}}}
EOF

# 调整刹车阈值（默认 5）
openclaw config patch --stdin <<'EOF'
{"plugins":{"entries":{"feishu-collab":{"config":{"crossBot":{"loopGuard":{"maxDepth":8}}}}}}}
EOF
```

## 常见问题

**Q：怎么不让 bot 自己主动发言？**

不会发。`gate.mode` 只支持 `mention-only`——只回复 @ 自己的消息。早期考虑过让 bot 主动插嘴，试下来体验很差，所以从代码层面去掉了。

**Q：bot↔bot 为什么有刹车，人 @ bot 没刹车？**

人 @ bot 不会循环——人下一句就走开了。bot @ bot 不加约束会变成机器对机器无限对刷。刹车分四档：前两轮正常回；第 3 轮系统提示词里塞"差不多收尾"；第 4 轮塞更强的；第 5 轮起回复不带 @，对方收不到 @ 事件，链路自然断。`maxDepth=5` 这个值来自飞书官方对 agent 多轮对话的建议。

**Q：私聊里能用吗？**

私聊不受这个插件影响。私聊里不存在 bot @ bot 的循环，也没有"@ vs 不 @"的区分，bot 对所有消息都正常回复。

**Q：历史消息里包含哪些内容？人和 bot 的非 @ 消息都有吗？**

包含。两条管道合起来：

1. WebSocket 事件推送你能收到的所有消息——包括人没 @ 的发言和其他 bot @ 你的发言
2. 每次事件触发时，插件会用 API 把 WebSocket 漏掉的内容（其他 bot 没 @ 任何人时说的话）补回本地

唯一不进 transcript 的是这台 bot 自己说过的话——因为模型 session 里已经有这些 assistant turn 了，重复存进上下文是浪费 token。

**Q：消息会存到爆吗？**

不会。每个群一个 JSONL 文件，默认上限 2000 条；超出后保留最近 1333 条，旧消息丢弃。纯按条数算，没有按天数过期——群冷了不代表上下文要忘掉，下次激活时历史还在。

容量估算：单条记录约 500 字节，单群最大约 1MB，100 个活跃群占用几十 MB。

**Q：`ensure-hooks.mjs` 能合进 `plugins install` 一起跑吗？**

短答：目前不行。长答：

OpenClaw 的 `plugins install` 在跑 `npm install` 时硬编码了 `--ignore-scripts`（出于安全考虑，避免插件包通过 npm 钩子执行任意代码），所以普通的 `package.json` `postinstall` 钩子不会触发。

SDK 里有一个 `registerConfigMigration` API，理论上可以让插件声明一个配置迁移，host 应用之后就不用手动跑脚本——我们已经写了 `setup-api.ts` 来用这个机制。但实际验证发现：这个迁移只在 `openclaw doctor --fix` 命令里跑，**不会**在 `plugins install` 或 gateway 启动时自动跑。

所以现在有三种应对方式（任选一个）：

1. **手动跑 `ensure-hooks.mjs`**（推荐）——脚本幂等，跑一次永久生效，直到下次 reinstall
2. **跑 `openclaw doctor --fix`**——会触发 setup migration，效果一样
3. **手动编辑 `~/.openclaw-<profile>/openclaw.json`**，在 `plugins.entries.feishu-collab` 里加 `"hooks": {"allowConversationAccess": true}`

我们倾向于上游给 OpenClaw 提 PR 让 `plugins install` 自动跑 setup migration，但那是 OpenClaw 团队的事，不是这个插件能单方面解决的。

## 源码

[GitHub](https://github.com/nativeProductor/openclaw-feishu-collaboration-spec) · MIT License
