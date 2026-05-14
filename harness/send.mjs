// Send a message into the test Feishu group as a chosen bot — via lark-cli.
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
//   - "as bot1" means we shell out to `lark-cli --profile bot1 im
//     +messages-send`, so the message appears in the group as bot1 (an
//     icon + name like a normal bot post). The bot1/bot2 profiles must
//     already exist in lark-cli (see scripts/bootstrap-bot2.sh, or
//     `lark-cli profile add --name bot1 --app-id <app_id>
//     --app-secret-stdin`).
//   - at:<botKey> prepends <at user_id="OPEN_ID"></at> to the text — that
//     is a real Feishu @-mention, which the receiving bot's OpenClaw
//     plugin will see as `mentions[].id == open_id`. open_id is read from
//     the .env (BOT1_OPEN_ID / BOT2_OPEN_ID).
//   - We deliberately use lark-cli (not @larksuiteoapi/node-sdk) so the
//     harness exercises the same code path documented in TEST-PLAN.md §0.2
//     and so contributors don't need an extra npm dependency.

import { spawn } from 'node:child_process';

const env = process.env;
const BOTS = {
  bot1: { openId: env.BOT1_OPEN_ID },
  bot2: { openId: env.BOT2_OPEN_ID },
};
const GROUP = env.GROUP_CHAT_ID;
const OPENCLAW_HOME = env.OPENCLAW_HOME || `${env.HOME}/.openclaw-bot2`;

function die(msg) {
  console.error(`[send] ERROR: ${msg}`);
  process.exit(1);
}

const [botKey, text, ...rest] = process.argv.slice(2);
if (!botKey || !text) die('usage: send.mjs <bot1|bot2> "<text>" [at:bot1|at:bot2 ...]');
if (!BOTS[botKey]) die(`unknown bot: ${botKey}`);
if (!GROUP) die('GROUP_CHAT_ID not set');

const atKeys = rest.filter(a => a.startsWith('at:')).map(a => a.slice(3));
const atTags = atKeys.map(k => {
  const target = BOTS[k];
  if (!target?.openId) die(`unknown @-target bot: ${k} (need ${k.toUpperCase()}_OPEN_ID in .env)`);
  return `<at user_id="${target.openId}"></at>`;
}).join(' ');

const finalText = atTags ? `${atTags} ${text}` : text;
const content = JSON.stringify({ text: finalText });

const args = [
  '--profile', botKey,
  'im', '+messages-send',
  '--chat-id', GROUP,
  '--msg-type', 'text',
  '--content', content,
];

const t0 = Date.now();
const child = spawn('lark-cli', args, {
  env: { ...process.env, OPENCLAW_HOME },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', d => { stdout += d.toString(); });
child.stderr.on('data', d => { stderr += d.toString(); });

const exitCode = await new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('close', resolve);
});

const ms = Date.now() - t0;

if (exitCode !== 0) {
  console.error(`[send] FAILED exit=${exitCode} stderr=${stderr.trim()}`);
  process.exit(2);
}

let payload;
try {
  payload = JSON.parse(stdout);
} catch (e) {
  console.error(`[send] FAILED could not parse lark-cli output as JSON: ${e.message}`);
  console.error(`[send] raw stdout: ${stdout}`);
  process.exit(3);
}

if (payload.ok === false) {
  console.error(`[send] FAILED ${JSON.stringify(payload.error)}`);
  process.exit(4);
}

const messageId = payload.data?.message_id;
console.log(`[send] ok as=${botKey} ${ms}ms message_id=${messageId} text=${JSON.stringify(finalText)}`);
