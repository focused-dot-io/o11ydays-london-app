#!/usr/bin/env bash
# Codespace onCreateCommand: runs once, when the container is created (or rebuilt).
#
# onCreateCommand, not postCreateCommand, on purpose: Codespaces prebuilds run onCreateCommand and
# updateContentCommand, but never postCreateCommand (that one runs at every Codespace creation).
# As postCreateCommand this script cost ~60 s per Codespace even with a prebuild ready (npm ci 8 s,
# the three CLIs 45 s); as onCreateCommand it is baked into the prebuild and a Codespace opens in
# seconds. Without a prebuild (any branch but checkpoint-0) it still runs at creation, as before.
# The app itself is started by scripts/codespace-start.sh (postStartCommand), via `npm run dev`.
set -euo pipefail

# 1. The app's dependencies, exactly as locked.
npm ci

# 2. The three coding-agent CLIs, pinned so every attendee gets the same versions.
npm i -g @anthropic-ai/claude-code@2.1.287 @openai/codex@0.160.0 @google/gemini-cli@0.62.0

# 3. The workshop starts on checkpoint-0. If the Codespace opened on main with nothing changed,
#    move to checkpoint-0. Never touches a branch you chose or work you have started.
if [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "main" ] && [ -z "$(git status --porcelain)" ]; then
  if git fetch origin checkpoint-0 2>/dev/null; then
    git checkout -B checkpoint-0 origin/checkpoint-0
  else
    echo "note: no checkpoint-0 branch on origin yet; staying on main (later: npm run catchup -- 0)"
  fi
fi
