#!/usr/bin/env bash
# Re-publish docs/INTRO-zh.md to a Feishu cloud doc owned by the user.
#
# Uses the GLOBAL lark-cli profile (the user's own "Claude drugger"-style
# personal bot bound to their Feishu account), NOT the per-OpenClaw-workspace
# profile. This is because:
#   1. Docs created with bot identity have inconvenient permissions
#      (the bot owns them; the human user can't manage them).
#   2. The bot binding under ~/.openclaw-bot2 is bot-only and lacks
#      docs:permission.member:create.
# The right surface for Feishu cloud doc work is the user-bound profile.
#
# First time: creates a new doc, prints the URL, caches doc_id locally.
# Subsequent: updates the cached doc in place via mode=overwrite.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ID_FILE="$PROJECT_ROOT/.feishu-doc-id"

# Make sure we do NOT inherit a stale OPENCLAW_HOME (would re-target the
# bot-only workspace).
unset OPENCLAW_HOME

INTRO_REL="docs/INTRO-zh.md"
[[ -f "$PROJECT_ROOT/$INTRO_REL" ]] || { echo "missing $PROJECT_ROOT/$INTRO_REL"; exit 1; }

# lark-cli's @file syntax requires a relative path under the cwd.
cd "$PROJECT_ROOT"

if [[ -f "$ID_FILE" ]]; then
  DOC_ID=$(<"$ID_FILE")
  echo "==> updating existing doc $DOC_ID as user (祁峰)"
  lark-cli docs +update \
    --as user \
    --doc "$DOC_ID" \
    --markdown "@$INTRO_REL" \
    --mode overwrite 2>&1 | tail -10
else
  echo "==> creating new doc as user (祁峰)"
  RES=$(lark-cli docs +create \
    --as user \
    --title "OpenClaw Feishu Collaboration — 项目介绍" \
    --markdown "@$INTRO_REL")
  echo "$RES" | tail -15
  # Strip leading [deprecated] notice line(s) before JSON parse.
  DOC_ID=$(echo "$RES" | sed -n '/^{/,$p' | python3 -c 'import json,sys
try:
  print(json.load(sys.stdin)["data"]["doc_id"])
except Exception as e:
  pass' 2>/dev/null || true)
  if [[ -n "$DOC_ID" ]]; then
    echo "$DOC_ID" > "$ID_FILE"
    echo "==> saved doc_id to $ID_FILE"
  fi
fi
