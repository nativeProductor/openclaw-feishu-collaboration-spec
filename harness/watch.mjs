// Tail bot2's gateway log and emit one structured event per relevant log line.
// Designed to be run via Monitor — each stdout line becomes a notification.
//
// Usage:
//   node --env-file=.env watch.mjs
//
// Emits lines like:
//   bot2 RECV   <ts> <chatId> from=<openId> (group|p2p) "<text>"
//   bot2 BLOCK  <ts> "blocked unauthorized sender" (etc)
//   bot2 DISP-S <ts> dispatch started
//   bot2 DISP-E <ts> dispatch complete queuedFinal=<bool> replies=<n>
//   bot2 STREAM <ts> Started/Closed streaming
//   bot2 ERR    <ts> <error message>
//
// To watch both bots (bot1 is remote), tail bot2 locally; for bot1, do
// ad-hoc journalctl checks via SSH when needed.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const env = process.env;
const LOG = env.BOT2_LOG_FILE;
if (!LOG || !existsSync(LOG)) {
  console.error(`[watch] bot2 log not found: ${LOG}`);
  process.exit(1);
}

const tail = spawn('tail', ['-n', '0', '-F', LOG], { stdio: ['ignore', 'pipe', 'pipe'] });

const buf = [];
let leftover = '';
tail.stdout.on('data', chunk => {
  const s = leftover + chunk.toString('utf8');
  const lines = s.split('\n');
  leftover = lines.pop() ?? '';
  for (const line of lines) processLine(line);
});
tail.stderr.on('data', d => process.stderr.write(`[tail-err] ${d}`));
tail.on('exit', code => {
  console.error(`[watch] tail exited code=${code}`);
  process.exit(code ?? 0);
});

function processLine(line) {
  // Lines we care about
  let m;
  if ((m = line.match(/^([\d\-T:.+]+)\s+\[feishu\] feishu\[default\]: received message from (\S+) in (\S+) \((\w+)\)/))) {
    emit('RECV', m[1], `from=${m[2]} chat=${m[3]} type=${m[4]}`);
  } else if ((m = line.match(/^([\d\-T:.+]+)\s+\[feishu\] feishu\[default\]: Feishu\[default\] message in (\S+) (\S+):\s*(.*)$/))) {
    emit('TEXT', m[1], `${m[2]} ${m[3]} text=${JSON.stringify(m[4])}`);
  } else if ((m = line.match(/^([\d\-T:.+]+)\s+\[feishu\] feishu\[default\]: blocked unauthorized sender (\S+) \((.*)\)/))) {
    emit('BLOCK', m[1], `sender=${m[2]} ${m[3]}`);
  } else if ((m = line.match(/^([\d\-T:.+]+)\s+\[feishu\] feishu\[default\]: dispatching to agent \(session=(\S+)\)/))) {
    emit('DISP-S', m[1], `session=${m[2]}`);
  } else if ((m = line.match(/^([\d\-T:.+]+)\s+\[feishu\] feishu\[default\]: dispatch complete \(queuedFinal=(\w+), replies=(\d+)\)/))) {
    emit('DISP-E', m[1], `queuedFinal=${m[2]} replies=${m[3]}`);
  } else if (/\[error\]|Error:|ERR /.test(line) && /feishu|gateway|plugin/i.test(line)) {
    emit('ERR', '-', line.slice(0, 200));
  }
}

function emit(kind, ts, rest) {
  console.log(`bot2 ${kind.padEnd(6)} ${ts} ${rest}`);
}

console.error(`[watch] tailing ${LOG} — Ctrl-C to stop`);
