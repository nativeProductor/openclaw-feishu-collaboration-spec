#!/usr/bin/env bash
#
# Bootstrap a local "bot2" OpenClaw instance (project-isolated install) on macOS,
# pinned to a known-good OpenClaw version, with the official @openclaw/feishu
# plugin pre-installed and basic group-friendly policy applied.
#
# This is **dev infrastructure**, not part of the plugin itself. It exists so
# contributors can spin up a second bot quickly to test cross-bot scenarios.
#
# Idempotent: safe to re-run. Re-running archives existing state to a
# timestamped sibling directory.
#
# REQUIRED: copy .env.example -> .env at the project root and fill in your
# Feishu app credentials + Xiaomi MiMo Token-Plan API key before running.

set -euo pipefail

# --- locate project root, source .env -----------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -f "$PROJECT_ROOT/.env" ]]; then
  # shellcheck disable=SC1091
  set -a
  source "$PROJECT_ROOT/.env"
  set +a
else
  cat >&2 <<EOF
ERROR: $PROJECT_ROOT/.env not found.

  cp $PROJECT_ROOT/.env.example $PROJECT_ROOT/.env
  \$EDITOR $PROJECT_ROOT/.env

Then re-run this script.
EOF
  exit 1
fi

# --- required env vars (fail fast if missing) ---------------------------------
: "${FEISHU_APP_ID:?must be set in .env}"
: "${FEISHU_APP_SECRET:?must be set in .env}"
: "${XIAOMI_TOKEN_PLAN_KEY:?must be set in .env}"

# --- optional with defaults ---------------------------------------------------
PROJ_DIR="${BOT2_PROJ_DIR:-$HOME/openclaw-bot2}"
STATE_DIR="${BOT2_STATE_DIR:-$HOME/.openclaw-bot2}"
PROFILE="${BOT2_PROFILE:-bot2}"
GATEWAY_PORT="${BOT2_GATEWAY_PORT:-18889}"
OPENCLAW_VERSION="${OPENCLAW_VERSION:-2026.5.6}"
FEISHU_PLUGIN_VERSION="${FEISHU_PLUGIN_VERSION:-2026.5.6}"
XIAOMI_BASE_URL="${XIAOMI_BASE_URL:-https://token-plan-sgp.xiaomimimo.com/v1}"
PRIMARY_MODEL="${PRIMARY_MODEL:-xiaomi/mimo-v2.5-pro}"

mkdir -p "$PROJ_DIR"
cd "$PROJ_DIR"

echo "==> [1/6] project-local install of openclaw + feishu plugin"
if [[ ! -f package.json ]]; then
  cat > package.json <<JSON
{
  "name": "openclaw-bot2-sandbox",
  "private": true,
  "version": "0.0.0",
  "description": "Project-isolated OpenClaw bot2 install for plugin dev/test"
}
JSON
fi
npm install --no-audit --no-fund \
  --registry=https://registry.npmjs.org \
  "openclaw@$OPENCLAW_VERSION" \
  "@openclaw/feishu@$FEISHU_PLUGIN_VERSION" 2>&1 | tail -5

OC="$PROJ_DIR/node_modules/.bin/openclaw"
echo "    -> openclaw binary: $OC"
"$OC" --version

echo "==> [2/6] archive any pre-existing $STATE_DIR"
if [[ -d "$STATE_DIR" ]]; then
  ARCH="${STATE_DIR}.archived-$(date +%s)"
  mv "$STATE_DIR" "$ARCH"
  echo "    archived to $ARCH"
fi

echo "==> [3/6] onboard (non-interactive, xiaomi auth, daemon installed)"
"$OC" --profile "$PROFILE" onboard \
  --non-interactive --accept-risk \
  --mode local --flow quickstart \
  --gateway-bind loopback --gateway-auth token --gateway-port "$GATEWAY_PORT" \
  --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_TOKEN_PLAN_KEY" \
  --install-daemon \
  --skip-channels --skip-search --skip-ui \
  --daemon-runtime node --node-manager npm \
  --json | tail -25

echo "==> [4/6] install @openclaw/feishu plugin (npm spec, public registry; required for trust auto-load)"
NPM_CONFIG_REGISTRY=https://registry.npmjs.org \
  "$OC" --profile "$PROFILE" plugins install "@openclaw/feishu@$FEISHU_PLUGIN_VERSION" 2>&1 | tail -5

echo "==> [5/6] patch config (feishu creds, xiaomi token-plan endpoint, V2.5 catalog, open policies)"
"$OC" --profile "$PROFILE" config patch --stdin --replace-path models.providers.xiaomi.models <<PATCH
{
  models: {
    providers: {
      xiaomi: {
        baseUrl: '$XIAOMI_BASE_URL',
        api: 'openai-completions',
        timeoutSeconds: 300,
        models: [
          { id: 'mimo-v2.5-pro', name: 'Xiaomi MiMo V2.5 Pro', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1048576, maxTokens: 8192 },
          { id: 'mimo-v2.5', name: 'Xiaomi MiMo V2.5', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 8192 },
          { id: 'mimo-v2-pro', name: 'Xiaomi MiMo V2 Pro', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1048576, maxTokens: 8192 },
          { id: 'mimo-v2-omni', name: 'Xiaomi MiMo V2 Omni', reasoning: true, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 8192 }
        ]
      }
    }
  },
  agents: {
    defaults: {
      model: { primary: '$PRIMARY_MODEL' },
      models: { '$PRIMARY_MODEL': { alias: 'Xiaomi' } }
    }
  },
  channels: {
    feishu: {
      enabled: true,
      defaultAccount: 'default',
      appId: '$FEISHU_APP_ID',
      appSecret: '$FEISHU_APP_SECRET',
      dmPolicy: 'open',
      allowFrom: ['*'],
      groupPolicy: 'open',
      groupAllowFrom: ['*'],
      streaming: true,
      blockStreaming: false
    }
  },
  messages: {
    visibleReplies: 'automatic',
    groupChat: { visibleReplies: 'automatic' }
  }
}
PATCH

echo "==> [6/6] restart LaunchAgent + verify"
launchctl unload "$HOME/Library/LaunchAgents/ai.openclaw.$PROFILE.plist" 2>/dev/null || true
sleep 2
launchctl load "$HOME/Library/LaunchAgents/ai.openclaw.$PROFILE.plist"
sleep 6

echo
echo "--- health ---"
"$OC" --profile "$PROFILE" health 2>&1 | tail -10
echo
echo "--- channel status ---"
"$OC" --profile "$PROFILE" channels status --channel feishu 2>&1 | tail -10
echo
echo "--- smoke test (xiaomi inference) ---"
"$OC" --profile "$PROFILE" infer model run --model "$PRIMARY_MODEL" --prompt "Reply with only the two characters: ok" 2>&1 | tail -10

echo
echo "==> done. Use \"$OC --profile $PROFILE <cmd>\" for bot2 ops."
