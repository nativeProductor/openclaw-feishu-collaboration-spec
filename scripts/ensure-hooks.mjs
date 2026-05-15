#!/usr/bin/env node
// scripts/ensure-hooks.mjs
//
// `openclaw plugins install` does NOT persist non-default fields under
// `plugins.entries.<id>.hooks` — they get rewritten every install. This
// plugin needs `hooks.allowConversationAccess: true` because it is not
// bundled with the host and would otherwise be blocked from receiving the
// `llm_output` and `agent_end` typed hooks (see
// node_modules/openclaw/dist/loader-*.js:2755 → "typed hook ... blocked
// because non-bundled plugins must set ... hooks.allowConversationAccess=true").
//
// Run after every `openclaw plugins install @openclaw/feishu-collab@...`:
//
//   node scripts/ensure-hooks.mjs                # uses OPENCLAW_HOME or ~/.openclaw
//   OPENCLAW_HOME=~/.openclaw-bot2 node scripts/ensure-hooks.mjs
//
// Exits non-zero on any unrecoverable error (missing config file,
// malformed JSON). Silent + idempotent when the flag is already set.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PLUGIN_ID = 'feishu-collab';

function resolveOpenClawHome() {
  if (process.env.OPENCLAW_HOME) return process.env.OPENCLAW_HOME;
  const profile = process.env.OPENCLAW_PROFILE || 'default';
  return join(homedir(), profile === 'default' ? '.openclaw' : `.openclaw-${profile}`);
}

function fail(msg) {
  console.error(`ensure-hooks: ${msg}`);
  process.exit(1);
}

const home = resolveOpenClawHome();
const configPath = join(home, 'openclaw.json');
if (!existsSync(configPath)) {
  fail(`config not found at ${configPath}. Set OPENCLAW_HOME or OPENCLAW_PROFILE.`);
}

let raw;
try {
  raw = readFileSync(configPath, 'utf8');
} catch (err) {
  fail(`cannot read ${configPath}: ${err.message}`);
}

let cfg;
try {
  cfg = JSON.parse(raw);
} catch (err) {
  fail(`malformed JSON at ${configPath}: ${err.message}`);
}

cfg.plugins = cfg.plugins ?? {};
cfg.plugins.entries = cfg.plugins.entries ?? {};
const entry = cfg.plugins.entries[PLUGIN_ID] ?? {};
entry.enabled = entry.enabled !== false;
entry.hooks = entry.hooks ?? {};

const already = entry.hooks.allowConversationAccess === true;
if (already) {
  console.log(`ensure-hooks: ${PLUGIN_ID}.hooks.allowConversationAccess already true at ${configPath}`);
  process.exit(0);
}

entry.hooks.allowConversationAccess = true;
cfg.plugins.entries[PLUGIN_ID] = entry;

// Preserve trailing newline + 2-space indent (the host's house style).
const next = JSON.stringify(cfg, null, 2) + '\n';
try {
  writeFileSync(configPath, next, 'utf8');
} catch (err) {
  fail(`cannot write ${configPath}: ${err.message}`);
}

console.log(`ensure-hooks: set ${PLUGIN_ID}.hooks.allowConversationAccess=true at ${configPath}`);
console.log(`ensure-hooks: restart the gateway for the change to take effect.`);
