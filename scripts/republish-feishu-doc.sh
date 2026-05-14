#!/usr/bin/env bash
# Re-publish docs/INTRO-zh.md to the Feishu cloud doc.
#
# First time: creates a new doc, prints the URL.
# Subsequent: edit .feishu-doc-id at project root with the doc_id, then
# this script updates that existing doc instead of creating duplicates.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ID_FILE="$PROJECT_ROOT/.feishu-doc-id"

: "${OPENCLAW_HOME:=$HOME/.openclaw-bot2}"
: "${LARK_PROFILE:=bot2}"

export OPENCLAW_HOME

INTRO_REL="docs/INTRO-zh.md"
[[ -f "$PROJECT_ROOT/$INTRO_REL" ]] || { echo "missing $PROJECT_ROOT/$INTRO_REL"; exit 1; }

# lark-cli's @file syntax requires a relative path under the cwd.
cd "$PROJECT_ROOT"

if [[ -f "$ID_FILE" ]]; then
  DOC_ID=$(<"$ID_FILE")
  echo "==> updating existing doc $DOC_ID"
  lark-cli --profile "$LARK_PROFILE" docs +update \
    --as bot \
    --doc "$DOC_ID" \
    --markdown "@$INTRO_REL" \
    --mode overwrite 2>&1 | tail -10
else
  echo "==> creating new doc"
  RES=$(lark-cli --profile "$LARK_PROFILE" docs +create \
    --as bot \
    --title "OpenClaw Feishu Collaboration — 项目介绍" \
    --markdown "@$INTRO_REL")
  echo "$RES" | tail -10
  DOC_ID=$(echo "$RES" | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["doc_id"])' 2>/dev/null || true)
  if [[ -n "$DOC_ID" ]]; then
    echo "$DOC_ID" > "$ID_FILE"
    echo "==> saved doc_id to $ID_FILE"
  fi
fi
