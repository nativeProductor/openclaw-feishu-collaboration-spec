// `openclaw` is a peer dependency provided by the host at runtime.
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

// Re-export config schema for downstream tooling. Currently unused at runtime
// (host plugin config is validated by openclaw.plugin.json's JSON Schema).
export { FeishuCollabConfig } from './config.js';

const PLUGIN_ID = 'feishu-collab';
const LOG_PREFIX = `[${PLUGIN_ID}]`;

/**
 * Skeleton hook handlers. Every handler is a pure no-op that logs once when
 * fired so we can verify plumbing end-to-end. Modules A/B/C/D will replace
 * these stubs with real logic; do not add business code here.
 *
 * Hook list by future module:
 *   Module A (Capture):       inbound_claim       — sees ALL group msgs pre mention-gate
 *   Module B (Reply Gate):    before_prompt_build — return skip when mention-only fails
 *   Module C (Context Inject):before_prompt_build — inject recent N msgs (shares hook with B)
 *   Module D (Cross-bot @):   llm_output + agent_end — rewrite reply + loop-guard reset
 *   (debug observability)     message_received    — what crossed the mention gate
 */
const SKEL_HOOKS = [
  'inbound_claim',
  'message_received',
  'before_prompt_build',
  'llm_output',
  'before_agent_finalize',
  'agent_end',
] as const;

type SkelHookName = (typeof SKEL_HOOKS)[number];

function makeSkelHandler(name: SkelHookName) {
  // Handler signature varies per hook (modify vs void). Returning `undefined`
  // is the universal "no modification / no claim" signal, satisfying every
  // hook type the SDK declares.
  return async (_event: unknown, _ctx?: unknown): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`${LOG_PREFIX} skel:${name} fired`);
  };
}

const pluginEntry = definePluginEntry({
  id: PLUGIN_ID,
  name: 'OpenClaw Feishu Collaboration',
  description:
    'Skeleton — registers all six lifecycle hooks the upcoming Module A/B/C/D implementations will use. Each handler is a logging no-op.',
  register(api: any) {
    // eslint-disable-next-line no-console
    console.log(`${LOG_PREFIX} skel:register fired`);
    for (const hookName of SKEL_HOOKS) {
      // `api.on` is typed with a discriminated union over PluginHookName; the
      // skeleton's uniform handler returns void for every hook, so the loose
      // `any` binding above is fine.
      api.on(hookName, makeSkelHandler(hookName));
    }
  },
});

export default pluginEntry;
