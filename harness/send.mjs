// Send a message into the test Feishu group as a chosen bot.
//
// Usage:
//   node --env-file=.env send.mjs <bot1|bot2> "<text>" [at:<botKey>...]
//
// Examples:
//   node --env-file=.env send.mjs bot1 "ping no mention"
//   node --env-file=.env send.mjs bot1 "你在吗" at:bot2
//   node --env-file=.env send.mjs bot2 "好的" at:bot1
//
// Notes:
//   - "as bot1" means we use bot1's tenant_access_token to call the Feishu
//     send API, so the message appears in the group as bot1 (an icon + name
//     like a normal bot post).
//   - at:<botKey> prepends <at user_id="OPEN_ID"></at> to the text — that is
//     a real Feishu @-mention, which the receiving bot's OpenClaw plugin will
//     see as `mentions[].id == open_id`.

import { Client } from '@larksuiteoapi/node-sdk';

const env = process.env;
const BOTS = {
  bot1: {
    appId: env.BOT1_APP_ID,
    appSecret: env.BOT1_APP_SECRET,
    openId: env.BOT1_OPEN_ID,
  },
  bot2: {
    appId: env.BOT2_APP_ID,
    appSecret: env.BOT2_APP_SECRET,
    openId: env.BOT2_OPEN_ID,
  },
};
const GROUP = env.GROUP_CHAT_ID;

function die(msg) {
  console.error(`[send] ERROR: ${msg}`);
  process.exit(1);
}

const [botKey, text, ...rest] = process.argv.slice(2);
if (!botKey || !text) die('usage: send.mjs <bot1|bot2> "<text>" [at:bot1|at:bot2 ...]');
const sender = BOTS[botKey];
if (!sender?.appId) die(`unknown bot: ${botKey}`);
if (!GROUP) die('GROUP_CHAT_ID not set');

const atKeys = rest.filter(a => a.startsWith('at:')).map(a => a.slice(3));
const atTags = atKeys.map(k => {
  const target = BOTS[k];
  if (!target?.openId) die(`unknown @-target bot: ${k}`);
  return `<at user_id="${target.openId}"></at>`;
}).join(' ');

const finalText = atTags ? `${atTags} ${text}` : text;

const client = new Client({
  appId: sender.appId,
  appSecret: sender.appSecret,
  disableTokenCache: false,
});

const t0 = Date.now();
const res = await client.im.message.create({
  params: { receive_id_type: 'chat_id' },
  data: {
    receive_id: GROUP,
    msg_type: 'text',
    content: JSON.stringify({ text: finalText }),
  },
});
const ms = Date.now() - t0;

if (res.code !== 0) {
  console.error(`[send] FAILED code=${res.code} msg=${res.msg}`);
  process.exit(2);
}

const messageId = res.data?.message_id;
console.log(`[send] ok as=${botKey} ${ms}ms message_id=${messageId} text=${JSON.stringify(finalText)}`);
