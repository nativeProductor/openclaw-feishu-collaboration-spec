# OpenClaw Feishu Collaboration

> 让你的 OpenClaw bot 在飞书群里像同事一样听、说、接力。

## 这个插件解决什么问题

如果你已经把 OpenClaw bot 拉进过飞书群,大概率遇到过这三件事:

第一,bot 只能看见**直接 @ 它**的那条消息。群里前面在聊什么、上下文是什么、有没有人贴过链接,它一无所知 —— 因为 OpenClaw 的 channel 层 mention gate 在 `message_received` 之前就把未被 @ 的群消息丢弃了(`prepare-DoW6_hdn.js:972`)。所以你问它「刚才那个事怎么办」,它只能茫然反问「哪件事」。

第二,**两个 bot 没法接力**。bot A @ bot B,bot B 回话默认不会反向 @ bot A,飞书的 mention gate 在 bot A 那边又把这条消息丢了,对话直接断在第一棒。

第三,即使勉强配通了,行为也很**生硬**:要么完全不说话,要么逮谁回谁,要么两个 bot 互 @ 进入死循环刷屏。

这个插件把这三件事一次性补齐,而且**不改 OpenClaw 默认行为**、**不需要写任何 chat_id / open_id**。

## 三个核心能力 🎯

### 1. 群消息全感知

插件在 `inbound_claim` 这个早于 mention gate 的 hook 上挂载(Module A),所以即使消息没 @ bot,也会被原样捕获,落进插件私有的 SQLite —— 默认路径 `~/.openclaw-<profile>/state/feishu-collab/transcript.db`,按 `chat_id` 分行存储,7 天 TTL、每群 2000 条上限自动滚动。

这份群转录通过 `registerMemoryCorpusSupplement("feishu-collab", ...)` 接入了 OpenClaw 自带的 `memory_search` 工具(Module C)。也就是说:**模型仍然只看到一个 `memory_search` 工具**,既能查到原来 memory-core 索引的 Markdown,也能查到群里的历史聊天 —— 调用方式完全不变。

每次模型要回话时,`before_prompt_build` 会顺手把这个群最近 20 条注入 system prompt 末尾,所以"最近发生了什么"是默认就在的上下文。

整条链路**零拓扑配置**:没有任何 `chat_id` / `bot_id` 出现在 schema 里。bot 自己的 open_id 走 `/open-apis/bot/v3/info` 启动时解析并缓存,群成员走 `im.v1.chats.members.bots` 懒加载。

### 2. 礼貌的发言时机 ⚡

Module B 给 bot 装了一道"reply gate":在 group 里,**默认只有当本 bot 被 @ 时才会进入回话流程**;其他消息全部安静捕获、不出声。1:1 私聊则继续是默认全回。

这不是单纯的关键词匹配 —— gate 是基于事件本身的 `mentions[]` 数组做的判断,所以 `@all`、@ 别人、引用里的旧 @ 都不会误触发(详见 TEST-PLAN 的 B-1.3 / B-1.6)。

路线图上有一个 autonomous 模式:用一个便宜的分类模型对每条消息打分,达到阈值才接话。这部分在 v0.1 发布时**默认关闭**,需要主动切到 `gate.mode=autonomous` 才生效。

### 3. 像同事一样和别的 bot 协作 🛡️

这是 Module D,也是这个项目最值得展开讲的一块。

**反向 @ 接力**:当 bot 检测到入站消息的 `sender.sender_type === 'app'`,就在自己回复的开头注入 `<at user_id="...">` 指向对方。这里有个研究发现帮了大忙:飞书的 `<at user_id="...">` 是服务端按观察者重写的 —— 任意一个指向目标 bot 的 open_id 都行,不必关心"我看到的 open_id"和"对方看到的 open_id"差异。所以这步不需要任何额外的 open_id 翻译表。

**自然刹车,而不是硬截断**(产品亮点):

很多人写过 bot 互聊就知道,最怕两个 bot 互 @ 进入死循环。直觉是"到 N 轮就硬截断",但硬截断在群里很扎眼 —— 突然没人接话,反而显得 bot 故障。

这个插件采用 graduated brake,按"当前 chat × 对端 app_id"维度记 `depth`:

- **depth 1–2**:正常对话。
- **depth 3**:往 system prompt 里塞一句轻提示:"你已经和另一个 bot 互动 3 轮,可考虑话题收束"。
- **depth 4**:更强的收束提示。
- **depth 5(关键一招)**:照常回复,但**悄悄不再 @ 对方**。因为对方默认也是 mention-only,失去 @ 就触发不到对方的 reply gate,对话**自然消退**,像两个同事聊完一个话题各自散开。
- **depth ≥6**:插件层硬跳过,作为兜底。

`lastHumanTs` 被任何人类发言重置;`depth` 状态持久化在 `~/.openclaw-<profile>/state/feishu-collab/loop-state.json`,bot 重启不丢。

## 设计哲学

**1. 零拓扑(zero-topology config)** —— 这是不可妥协的硬边界。`configSchema` 里你**找不到**任何 `chat_id` / `open_id` / `app_id` 列表字段,也找不到"已知 bot 名单"。bot 自己的身份在启动时通过 `/open-apis/bot/v3/info` 解析;别的 bot 在第一次见到时通过事件 `sender.sender_id.open_id` + `mentions[].id` 学到;群成员通过 `im.v1.chats.members.bots` 懒拉取(没权限就走事件学习兜底)。运行时学到的所有东西落在插件私有 state 文件,**永远不写回用户的 `openclaw.json`**。

**2. Install-and-go** —— 一行 `openclaw plugins install`,重启 gateway 就生效。默认值经过反复打磨:`mention-only` + `crossBot.atBack=true` + `loopMaxDepth=5` + `context.lastN=20` + `ttlHours=168`,这是绝大多数群聊场景下"它该有的样子"。如果你从来不改配置,行为也是对的。

**3. 复用而非重造** —— 我们做了一份 memory-core 审计(`docs/memory-core-audit.md`),结论是 memory-core 的 ingestion 通道不接受群消息(它只索引 Markdown 和自己的 session JSONL,而后者又被 mention gate 提前过滤掉了)。但 memory-core 暴露了 `registerMemoryCorpusSupplement` 这个 search-time 补充契约,正好可以让我们**接进去,而不是另起一个工具**。模型继续调它已经熟悉的 `memory_search`,我们的 SQLite 在背后回答 `corpus=all` 的那一份。

## 安装与使用

### 前置要求

- OpenClaw `>=2026.5.6`
- 一个或多个 Feishu 自建应用(也就是你会在群里和它互动的 bot)
- 飞书后台已开启以下权限:
  - `im:message`(已是默认)
  - `im:message.group_at_msg`
  - `im:chat.members:read`(可选,加速 bot 发现;不开启会走 lazy 发现)
  - `im:resource`(可选,Phase 1 vision 支持需要)

### 安装

```bash
openclaw plugins install openclaw-feishu-collaboration-spec

openclaw config patch --stdin <<'EOF'
{
  "plugins": {
    "entries": {
      "feishu-collab": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
EOF

# 重启 gateway 让插件加载
openclaw gateway restart
```

### 默认行为

装好之后什么都不调,bot 在群里就会:

- 只有被 `@` 时才开口回复;其他消息静默旁观但全量捕获
- 收到另一个 bot 的 @ 时,自动在回复里反向 `@` 对方,接力对话
- 与对端 bot 连续来回 5 轮后,悄悄停止 @-back,让对话自然消退
- 每次回话时,system prompt 自动带上本群最近 **20 条** 消息作上下文
- 群转录在本地 SQLite 保留 **7 天**,每群上限 2000 条

### 调参示例

只想被动旁听、不主动 @ 别的 bot:

```bash
openclaw config patch --stdin <<'EOF'
{
  "plugins": {
    "entries": {
      "feishu-collab": {
        "config": {
          "crossBot": { "atBack": false }
        }
      }
    }
  }
}
EOF
```

把上下文窗口拉大到 50 条(适合长议题群):

```bash
openclaw config patch --stdin <<'EOF'
{
  "plugins": {
    "entries": {
      "feishu-collab": {
        "config": {
          "context": { "lastN": 50, "ttlHours": 336 }
        }
      }
    }
  }
}
EOF
```

## 常见问题

**Q:这是侵入式的吗?会改 OpenClaw 默认行为吗?**
不会。插件是叠加式的:挂在 `inbound_claim`、`before_prompt_build`、`llm_output` 这几个公共 hook 上,不替换、不 patch 任何 core 模块。卸载后行为完全回退到 OpenClaw 默认。

**Q:我和 bot 在私聊里,行为会变吗?**
不变。reply gate 仅对 `chat_type === 'group'` 生效,P2P 走默认全回路径。

**Q:数据存哪?会上云吗?**
不会。所有群消息存在本地 SQLite(`~/.openclaw-<profile>/state/feishu-collab/transcript.db`),loop guard 状态存在同目录 `loop-state.json`。插件不向任何第三方上报。

**Q:装了以后想看 bot 之间在群里说了什么,在哪儿看?**
直接打开上述 SQLite,表里有 `chat_id / ts / sender_open_id / sender_type / text`。或者让 bot 自己回答 —— 它现在能通过 `memory_search` 查到这些记录。

**Q:怎么卸载?数据怎么处理?**
`openclaw plugins uninstall openclaw-feishu-collaboration-spec` 即可移除插件本体;数据文件在 `~/.openclaw-<profile>/state/feishu-collab/` 下,手动删除即可,OpenClaw 主流程不依赖它们。

**Q:支不支持视觉/图片?**
v0.1 发布时,图片消息按 `[图片]` 标记入库;完整 vision 支持(走 `im:resource` 拉二进制 + 多模态 prompt 块,必要时 per-turn 切换到 `mimo-v2-omni`)在路线图上。

## 相关链接

- GitHub: (占位,待补)
- Architecture deep-dive: `docs/architecture.md`
- 测试与验收标准: `plugin/TEST-PLAN.md`
- License: MIT
