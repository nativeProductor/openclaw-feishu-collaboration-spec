/**
 * Setup-phase entry for OpenClaw.
 *
 * OpenClaw resolves this file (`setup-api.{js,ts,…}` at the plugin's root
 * dir) during the SETUP phase, which runs BEFORE the plugin runtime loads.
 * It's the only place where `registerConfigMigration` can actually affect
 * the current boot — the same API exists on the runtime `register(api)`
 * surface but by the time runtime fires, the host has already evaluated
 * the hooks-access policy and gated our typed hooks.
 *
 * What this fixes: `openclaw plugins install` rewrites
 * `plugins.entries.feishu-collab` on every install and drops the
 * `hooks.allowConversationAccess: true` flag, because that flag is plugin-
 * specific and not part of the default entry shape. Without the flag, the
 * SDK blocks `llm_output` and `agent_end` from firing (see
 * loader-*.js:2755 — "typed hook blocked because non-bundled plugins must
 * set hooks.allowConversationAccess=true"). Module D's @-back and depth
 * bookkeeping then silently no-op.
 *
 * Previously we shipped a `scripts/ensure-hooks.mjs` helper that the user
 * had to run after every `plugins install`. This setup migration replaces
 * that — the host applies it on the first boot after install, the flag is
 * present before plugin runtime, and there's no extra command to type.
 *
 * The helper is kept around as a fallback for environments where the
 * setup-phase doesn't run (older OpenClaw versions, custom installers).
 */

const PLUGIN_ID = 'feishu-collab';

/**
 * Loose typing — the setup-phase api object is internal SDK shape and not
 * cleanly exported as a public type. We only use one method.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SetupApi = any;

/**
 * Setup-phase module shape per the SDK's `resolveRegister`:
 *   if module exposes `{ id, register(api) }` it's accepted.
 * Do NOT wrap with `defineSetupPluginEntry` — that helper returns
 * `{ plugin: ... }` (a Pick wrapper for channel pairing examples) which
 * doesn't match what `resolveRegister` looks for at runtime.
 */
export default {
  id: PLUGIN_ID,
  register(api: SetupApi) {
    if (typeof api.registerConfigMigration !== 'function') {
      // Older SDK without the migration API — no-op; user falls back to
      // running scripts/ensure-hooks.mjs.
      return;
    }
    api.registerConfigMigration((cfg: any) => {
      const entries = cfg?.plugins?.entries ?? {};
      const entry = entries[PLUGIN_ID];
      if (!entry) return null;
      if (entry.hooks?.allowConversationAccess === true) return null;
      const nextEntry = {
        ...entry,
        hooks: { ...(entry.hooks ?? {}), allowConversationAccess: true },
      };
      return {
        config: {
          ...cfg,
          plugins: {
            ...cfg.plugins,
            entries: { ...entries, [PLUGIN_ID]: nextEntry },
          },
        },
        changes: [
          `${PLUGIN_ID}: set hooks.allowConversationAccess=true (required for llm_output/agent_end hooks)`,
        ],
      };
    });
  },
};
