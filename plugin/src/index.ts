// `openclaw` is a peer dependency provided by the host at runtime.
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

import { register as registerReplyGate } from './modules/reply-gate.js';
import { register as registerContextInject } from './modules/context-inject.js';
import { register as registerCrossBot } from './modules/cross-bot.js';

// Re-export config schema for downstream tooling. Currently unused at runtime
// (host plugin config is validated by openclaw.plugin.json's JSON Schema).
export { FeishuCollabConfig } from './config.js';

const PLUGIN_ID = 'feishu-collab';
const LOG_PREFIX = `[${PLUGIN_ID}]`;

/**
 * Plugin entry — orchestrates Modules B, C, D.
 *
 *   Module B (Reply Gate):     message_received + before_prompt_build
 *   Module C (Context Inject): message_received + before_prompt_build
 *   Module D (Cross-bot @):    before_prompt_build + llm_output + agent_end
 *
 * Registration order matters: B is registered before C so that on
 * before_prompt_build B's skip-sentinel short-circuits C's lark-cli fetch.
 * Module A (transcript capture) is still a stub; we use message_received as
 * the unconditional pre-mention-gate hook (inbound_claim doesn't fire for
 * non-bundled plugins on our path).
 */
const pluginEntry = definePluginEntry({
  id: PLUGIN_ID,
  name: 'OpenClaw Feishu Collaboration',
  description:
    'Passive group transcript capture, mention-based reply gate, cross-bot @-back, and graduated loop guard for Feishu/Lark.',
  register(api: any) {
    // eslint-disable-next-line no-console
    console.log(`${LOG_PREFIX} skel:register fired`);
    registerReplyGate(api);
    registerContextInject(api);
    registerCrossBot(api);
  },
});

export default pluginEntry;
