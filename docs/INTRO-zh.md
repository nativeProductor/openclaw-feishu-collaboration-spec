# 让你的 OpenClaw bot 真正"会聊群天"

> 一个开箱即用的飞书插件,bot 安装后默默听群,@ 它才说话,被 @ 自动 @ 回去,跟同事 bot 你来我往不超过 5 轮——不需要任何 chat_id / bot_id 配置。

## 装了它之后的体验

**场景一：群里聊半天,@ bot 让它给个总结**

| | 没装插件的 bot | 装了之后的 bot |
|---|---|---|
| 你的输入 | "@bot 这件事你怎么看?" | 同一句 |
| bot 的回复 | "您问的是哪件事呢?" | 直接基于刚才那 20 条群聊给出意见,引用具体发言 |

**场景二:两个 bot 在群里聊起来了**

没装的话:bot A @ bot B 问一句,B 答完不 @ 回去,对话当场断掉,需要人手动重新 @。

装了之后:B 自动 @ 回 A,接上下一棒;到第 3 轮 B 收到一个隐式提示"差不多收尾吧";第 5 轮直接不带 @,让对话自然散场——绝不会两个 bot 在群里对骂到死。

**场景三:bot 装在群里,但你只想它在被 @ 时插嘴**

这就是默认行为。不被 @,bot 一个字都不说,但**它一直在听**——下次你 @ 它,它能引用刚才你跟同事的讨论。

## 工作原理(一图)

```
              ┌──────────────────────────────────────────┐
群里有人发消息 │ Module A: 旁听 → 本地 JSONL              │
              │  (顺手用 API 把 WebSocket 漏掉的 bot 消息 │
              │   也补回来)                              │
              └──────────────────────────────────────────┘
                              ↓
              ┌──────────────────────────────────────────┐
你 @ 了 bot   │ Module B: 鉴权                            │
              │  群里 = 只回 @ 自己的;私聊 = 全回         │
              └──────────────────────────────────────────┘
                              ↓
              ┌──────────────────────────────────────────┐
              │ Module C: 拼上下文                        │
              │  本地有缓存 → 几毫秒搞定                  │
              │  冷群 → 调一下 API 补齐                   │
              └──────────────────────────────────────────┘
                              ↓
                         模型生成回复
                              ↓
              ┌──────────────────────────────────────────┐
              │ Module D: @ 回 + 刹车                     │
              │  人 @ bot → 回复带 @                      │
              │  bot @ bot → 回复带 @,但深度递增          │
              │   3 轮:温和提示收尾                       │
              │   4 轮:强烈建议收尾                       │
              │   5 轮:不带 @ 了                          │
              │   6 轮+:不回了                            │
              │  人来一句 → 深度归零                      │
              └──────────────────────────────────────────┘
```

## 三个核心约定(写在配置 schema 里的硬约束)

1. **零拓扑配置**:插件的 config 里没有任何 `chat_id` / `open_id` / `app_id` 列表。所有身份、群、对端 bot 全部运行时发现。装到任何 OpenClaw + 飞书部署里都直接生效。

2. **安装即用**:三个命令搞定(install / ensure-hooks / restart),不需要按群调任何参数,不需要给 bot 绑 lark-cli profile,不需要手填 app-id 映射。

3. **默认就对**:`gate.mode=mention-only` / `crossBot.atBackHumans=true` / `crossBot.atBackBots=true` / `crossBot.loopGuard.maxDepth=5` / `context.enabled=true`。装上什么都不动,行为就是你期望的。

## 安装(3 步)

```bash
# 1. 装插件
openclaw plugins install openclaw-feishu-collaboration-spec

# 2. **必须**:授权钩子(每次 reinstall 都需要再跑一次)
node scripts/ensure-hooks.mjs

# 3. 重启 gateway
openclaw gateway restart
```

启动日志里会出现一行:

```
[feishu-collab] bot identity resolved open_id=ou_... app_id=cli_...
```

看到这行就代表插件认得自己是哪个 bot 了。如果是 `bot identity unresolved`,先把 lark-cli auth 修好再继续。

### 飞书后台需要的权限

| 权限 | 干什么 |
|---|---|
| `im:message` | 让 Module A 的 backfill 能调 `/im/v1/messages` 拉历史(包含 WebSocket 漏掉的对端 bot 非 @ 消息) |
| `im:message.group_at_msg` | 接收"@ 我"事件——这个就是默认让 bot 在群里听到自己被 @ 的那条 |
| `im:chat.members:read` | 让 Module D 能区分群里的人和 bot(刹车只针对 bot↔bot) |

## 性能数字

- **常规回复**:本地 JSONL 命中 → 上下文注入 **<10ms**
- **冷启动第一次回复**:本地空,fallback 到 Feishu API → **1~2 秒**(从第二次开始就回到 <10ms)
- **Module A 旁听**:每条入站事件 → 单次 `fs.appendFileSync` ≈ <1ms
- **机会式 backfill**:每个事件触发一次 API 调用,**完全异步**,不影响回复路径,同群 3 秒内最多一次

## 改默认(可选)

绝大多数人不需要。但如果你想:

```bash
# 关掉 bot↔bot 之间的 @ 回(只对人 @ 回)
openclaw config patch --stdin <<'EOF'
{"plugins":{"entries":{"feishu-collab":{"config":{"crossBot":{"atBackBots":false}}}}}}
EOF

# 把上下文窗口扩到 50 条
openclaw config patch --stdin <<'EOF'
{"plugins":{"entries":{"feishu-collab":{"config":{"context":{"lastN":50}}}}}}
EOF

# 调整 bot↔bot 刹车阈值(默认 5,设大一点让 bot 们多聊几轮)
openclaw config patch --stdin <<'EOF'
{"plugins":{"entries":{"feishu-collab":{"config":{"crossBot":{"loopGuard":{"maxDepth":8}}}}}}}
EOF
```

## 一些设计上的取舍,顺便回答常见疑问

**Q:为什么不让 bot 主动发言?**
A:试过,坏体验。"bot 看到群里聊得起劲,主动来插一嘴"在所有场景里都是噪音。`gate.mode` 只保留 `mention-only` 一个值——@ 它它说话,不 @ 它它闭嘴。这是产品决定,不是技术限制。

**Q:为什么 bot↔bot 默认带刹车,人 @ bot 不带?**
A:人 @ bot 没循环风险——人下一次就走开了。bot @ bot 不刹会变成两台机器对着群里吐字数千轮。刹车 5 轮、并且第 5 轮直接不带 @ 让对话自然消失——这个数字来自飞书官方对 agent 多轮对话的建议。

**Q:能在 P2P 里用吗?**
A:能,但很多东西不会触发——P2P 没有"@ vs 不@"的区分,也没有 bot↔bot 循环风险。所以 Module B/C/D 在 P2P 里只走最简单的路径:全回,带最近 20 条上下文(私聊也是会拉历史的)。

**Q:飞书 WebSocket 不推 bot 的非 @ 消息怎么办?**
A:这是飞书的硬限制(`im:message.group_msg` scope 明确说"不含机器人消息")。Module A 的对策是:每次有事件来时,顺手用 REST API 把最近 30 条历史拉一遍,跟本地去重后合并。这样 bot A 在群里说一句没 @ 的话→ bot B 拿不到 WebSocket → 但下次群里有人 @ bot B 时,Module A 会顺便把 bot A 那句话也补进本地。

**Q:本地存的 JSONL 会无限涨吗?**
A:不会。每群默认 2000 行上限,溢出时原子重写保留最近 2/3。

## 链接

- GitHub: <https://github.com/nativeProductor/openclaw-feishu-collaboration-spec>
- 协议:MIT
