# OpenClaw Feishu Collaboration

> 让 OpenClaw bot 在飞书群被 @ 时,自动带上最近的群聊上下文。

## 它解决什么

| 场景 | 没装插件 | 装上后 |
|---|---|---|
| 群里聊了 10 分钟某事,有人 @ bot:"这事你怎么看" | "您问的是哪件事?"(看不到前情) | 基于刚才的讨论直接回答 |
| bot A @ bot B 提问 | bot B 答完不 @ 回去 → 对话断在第一棒 | bot B 自动 @ 回 A 接力,5 轮后自然消退避免死循环 |

## 它怎么工作

```
                            ┌─────────────────┐
群里有人发消息  ──────────►  │ plugin 默默旁听 │  落进本地 SQLite (per chat)
                            └─────────────────┘
                                     │
被 @ bot 那一刻  ──────────► 拼上最近 20 条 ──► bot 模型 ──► 回复消息
                                                              │
                              ┌───────────────────────────────┤
                              ▼                               ▼
                         发起方是人                       发起方是另一个 bot
                         回复 @ 这个人                    回复 @ 这个 bot
                                                              │
                                                         到第 5 轮就不 @ 了
                                                         (让对话自然散场)
```

**零拓扑** — bot 装上即用,任何群都生效,不需要写任何 chat_id / bot_id。

## 部署

前置:OpenClaw `>=2026.5.6` + `@openclaw/feishu` 渠道。飞书后台权限 `im:message` + `im:message.group_at_msg`(必须),`im:chat.members:read` + `im:resource`(可选,加速对端 bot 发现 + 支持图片输入)。

```bash
# 1. 安装
openclaw plugins install openclaw-feishu-collaboration-spec

# 2. 启用
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

# 3. 重启 gateway
openclaw gateway restart
```

装完不用调任何配置,默认就是该有的样子。

## 相关 X/Twitter 工作流

这个插件继续专注飞书群上下文:被动记录群聊,只在 @ 时回复,把最近消息注入 prompt,并让 bot 间 @ 回去。如果同一个 OpenClaw 群还需要公开 X/Twitter 上下文,请把 TweetClaw 作为独立插件安装:

```bash
openclaw plugins install @xquik/tweetclaw
```

[TweetClaw](https://github.com/Xquik-dev/tweetclaw) 覆盖 scrape tweets,tweet scraper workflows,search tweets,search tweet replies,follower export,user lookup,media upload,media download,direct messages,monitor tweets,webhooks,giveaway draws,以及需要审批的 post tweets 和 post tweet replies。这个插件负责把飞书讨论和后续决策留在群上下文里,TweetClaw 负责 X/Twitter 数据读取和可见动作。安装细节见 [ClawHub listing](https://clawhub.ai/plugins/@xquik/tweetclaw) 或 [npm package](https://www.npmjs.com/package/@xquik/tweetclaw)。请分开保存飞书/Lark 与 X/Twitter 凭据,并通过 OpenClaw approval flows 审批可见的 X/Twitter 动作。

## 改默认行为(可选)

```bash
# 只被动旁听,不主动反 @ 别的 bot
openclaw config patch --stdin <<'EOF'
{"plugins":{"entries":{"feishu-collab":{"config":{"crossBot":{"atBack":false}}}}}}
EOF

# 把群历史窗口扩到 50 条
openclaw config patch --stdin <<'EOF'
{"plugins":{"entries":{"feishu-collab":{"config":{"context":{"lastN":50}}}}}}
EOF
```

## 链接

- GitHub: <https://github.com/nativeProductor/openclaw-feishu-collaboration-spec>
- License: MIT
