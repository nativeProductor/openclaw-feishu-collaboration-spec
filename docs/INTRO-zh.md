# OpenClaw Feishu Collaboration

> lark-cli 的群聊上下文补充层 —— 让 OpenClaw bot 在群里被 @ 时,真正知道前情。

## 这个插件解决什么问题

如果你已经用 lark-cli 把 OpenClaw bot 拉进过飞书群,大概率遇到过这件最尴尬的事:

> **同事在群里聊了 10 分钟某个项目,最后 @ bot:「这个事你怎么看?」**
> **bot:「您问的是哪件事?」**

不是 bot 笨,是它真的看不见。OpenClaw 的 channel 层 mention gate 在 `prepare-DoW6_hdn.js:972` 把所有**没 @ bot 的群消息**提前丢弃了 —— bot 入手的就只有最后那条 @ 它的消息,前面 10 分钟的讨论它一无所知。

这个问题**不区分谁 @ 的它**:同事 @ 是这样,另一个 bot @ 也是这样。所以下游所有"被 @ 才回复"的场景都共用一个底座 —— **bot 在被 @ 的瞬间,需要群聊的完整上下文**。

这个插件就是干这一件事的:**为 lark-cli 加持的 bot 补一层群聊上下文能力**,让 bot 被任何人 @ 时,都能基于群里最近发生的事来回答。在此之上,顺手把"bot 之间接力对话"和"群里的自然发言时机"两件相关产品逻辑做对了。

## 它和 lark-cli 是什么关系

lark-cli 让 bot **能操作** 飞书(发消息、读消息、查日历、操作多维表格...);
这个插件让 bot **能理解** 它正在操作的飞书群(谁刚才说了什么,讨论到哪一步)。

两者解耦:lark-cli 是操作面 API 入口,这个插件是上下文感知层。任何 OpenClaw + lark-cli 的部署,装上这个插件就能升级。

## 三个核心能力 🎯

### 1. 群聊全感知(主功能)

插件挂在 OpenClaw 的 `inbound_claim` hook 上,这个 hook 早于 mention gate —— 所以**所有**群消息原样捕获,不管这条是 @ bot 的、@ 其他人的、还是没 @ 任何人的闲聊。捕获后落进插件私有的 SQLite:`~/.openclaw-<profile>/state/feishu-collab/transcript.db`,按 `chat_id` 分行存,7 天 TTL、每群 2000 条上限自动滚动。

到 bot 真正要回话时,**无论被谁 @**(用户、其他 bot、还是命令式 trigger),`before_prompt_build` 会把该群最近 20 条消息塞进 system prompt 末尾。同时这份转录也通过 `registerMemoryCorpusSupplement("feishu-collab", ...)` 接进了 OpenClaw 的 `memory_search` 工具 —— 模型对外仍然只看到**一个** `memory_search`,既能查 memory-core 原有的 Markdown,也能查群里的历史聊天。

整条链路**零拓扑配置**:`configSchema` 里**找不到**任何 `chat_id` / `open_id` / `app_id` 列表。bot 自己的身份通过 `/open-apis/bot/v3/info` 启动时解析并缓存;群成员通过 `im.v1.chats.members.bots` 懒加载。这意味着 —— 装上插件,bot 在任何群里都立即生效,不需要为每个群单独配置。

### 2. 礼貌的发言时机 ⚡

Module B 给 bot 加了一道"reply gate":在 group 里,**默认只在本 bot 被 @ 时才进入回话流程**;其他消息全部安静捕获、不出声。1:1 私聊不变,继续全回。

这不是关键词匹配 —— gate 基于事件的 `mentions[]` 数组判断,所以 `@all`、@ 别人、引用消息里的旧 @ 都不会误触发。

路线图上还有一个 autonomous 模式:用一个便宜的分类模型对每条消息打分,达到阈值才接话。v0.1 发布时默认关闭,要主动切到 `gate.mode=autonomous` 才生效。

### 3. Bot 之间也能自然接力 🛡️

Module D 处理一个相关但更窄的场景:当**另一个 bot @ 了我**,我的回复要不要反向 @ 它?

**反向 @ 接力**:插件检测入站消息的 `sender.sender_type === 'app'`,就在回复里注入 `<at user_id="...">` 指向对方。一个研究发现帮了大忙 —— 飞书的 `<at user_id>` 由服务端按观察者重写,任意一个指向目标 bot 的 open_id 都能用,不必管"我看到的 open_id"和"对方看到的"有什么差异。

**自然刹车,而不是硬截断**:很多人写过 bot 互聊都见过两个 bot 互 @ 死循环刷屏。硬截断"到 5 轮停"很扎眼 —— 突然没人接话,反而像 bot 故障。这里按"当前 chat × 对端 app_id"维度记 `depth`,做渐进式衰减:

- **depth 1–2**:正常对话。
- **depth 3**:往 system prompt 塞一句轻提示 —— "已经互动 3 轮,可考虑话题收束"。
- **depth 4**:更强的收束提示。
- **depth 5(关键)**:照常回复,但**悄悄不再 @ 对方**。因为对方默认也是 mention-only,失去 @ 就触发不到对方的 reply gate,对话**自然消退**,像两个同事聊完一个话题各自散开。
- **depth ≥6**:插件层硬跳过兜底。

任何人类发言都把 depth 重置为 0;状态持久化在 `loop-state.json`,bot 重启不丢。

## 设计哲学

**1. 零拓扑(zero-topology config)** —— 不可妥协的硬边界。schema 里没有任何形如"已知群列表/已知 bot 列表"的字段。所有身份解析、群成员发现、对端 bot 识别**全在运行时**完成。这意味着插件可以装在**任何** OpenClaw bot 上,加入**任何**飞书群都立即生效,**不需要任何安装后配置**。

**2. Install-and-go** —— 一行 `openclaw plugins install`,重启 gateway 就生效。默认值:`mention-only` + `crossBot.atBack=true` + `loopMaxDepth=5` + `context.lastN=20` + `ttlHours=168`。绝大多数群聊场景下这就是它该有的样子,不调一个 knob 也对。

**3. 复用而非重造** —— 不取代 OpenClaw 既有的 `memory_search` 工具,而是通过 `registerMemoryCorpusSupplement` 把数据接进去。模型继续调它已经熟悉的 `memory_search`,我们的 SQLite 在背后回答 `corpus=all` 的那一份。

## 安装与使用

### 前置要求

- OpenClaw `>=2026.5.6`,且已装好 `@openclaw/feishu` 渠道
- lark-cli 已 `config bind` 到本 OpenClaw workspace(本插件用 lark-cli 调 Feishu API)
- 飞书后台开启以下权限(每个 bot 都要):
  - `im:message`(默认)
  - `im:message.group_at_msg`
  - `im:chat.members:read` *(可选,加速对端 bot 发现;不开就走 lazy 发现兜底)*
  - `im:resource` *(可选,完整 vision/图片支持需要;路线图)*

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

- **被任何人 @ 时**(用户 / 其他 bot / 命令式 trigger),回话前自动带上本群最近 **20 条** 消息作上下文
- 没被 @ 时静默旁观但全量捕获 —— 不出声,但下次你 @ 它,它"知道"刚才发生了什么
- 收到另一个 bot 的 @ 时自动反向 @,接力对话
- 与对端 bot 连续来回 5 轮后,**悄悄停止 @-back**,让对话自然消退
- 群转录在本地 SQLite 保留 **7 天**,每群上限 2000 条;loop guard depth 跨重启持久化

### 调参示例

只想被动旁听、不主动反 @ 别的 bot:

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
不会。插件挂在 `inbound_claim` / `before_prompt_build` / `llm_output` 等公共 hook 上,不替换、不 patch 任何 core 模块。卸载后行为完全回退。

**Q:用户 @ bot 和 bot @ bot 都有用吗?**
是的,这是设计的核心点。无论谁 @ bot,bot 都会获得相同的群聊上下文 —— 这才是它跟普通 mention-only bot 的本质区别。bot 互聊的接力(Module D)是衍生场景,不是主功能。

**Q:不装这个插件,lark-cli 用得了吗?**
完全可以。lark-cli 是 OpenClaw bot 操作飞书 API 的基础;这个插件是上下文层补充,让 bot 在被 @ 时更聪明地回答。两者解耦。

**Q:我和 bot 在私聊里,行为会变吗?**
不变。reply gate 仅对 `chat_type === 'group'` 生效,P2P 走默认全回路径。

**Q:数据存哪?会上云吗?**
不会。所有群消息存在本地 SQLite(`~/.openclaw-<profile>/state/feishu-collab/transcript.db`),loop guard 状态存在同目录 `loop-state.json`。插件不向任何第三方上报。

**Q:装了以后想看 bot 之间在群里说了什么,在哪儿看?**
直接打开上述 SQLite,表里有 `chat_id / ts / sender_open_id / sender_type / text`。或者让 bot 自己回答 —— 它现在能通过 `memory_search` 查到这些记录。

**Q:怎么卸载?数据怎么处理?**
`openclaw plugins uninstall openclaw-feishu-collaboration-spec` 即可移除插件本体;数据文件在 `~/.openclaw-<profile>/state/feishu-collab/` 下,手动删除即可,OpenClaw 主流程不依赖它们。

**Q:支不支持视觉/图片?**
v0.1 支持图片输入 —— 当消息含图时,plugin 通过 Feishu `im:resource` API 拉取图片二进制,在 prompt 中加多模态 block,并 per-turn 切换到 vision 模型(如 `xiaomi/mimo-v2-omni`)。文本模型(如 `mimo-v2.5-pro`)继续用于无图回话。

## 相关链接

- GitHub: <https://github.com/nativeProductor/openclaw-feishu-collaboration-spec>
- License: MIT
