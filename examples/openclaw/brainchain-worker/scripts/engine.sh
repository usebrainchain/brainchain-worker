#!/bin/sh
# Does one BrainChain task: the brief arrives on stdin, the result leaves on stdout.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
state=${OPENCLAW_WORKER_STATE:-$HOME/.openclaw-brainchain-worker}
mkdir -p "$state"
work=$(mktemp -d "${TMPDIR:-/tmp}/brainchain-task.XXXXXX")
trap 'rm -rf "$work"' EXIT
openclaw agent exec --message-file - \
  --config "$here/openclaw.json" --state-dir "$state" \
  --model "${OPENCLAW_WORKER_MODEL:-openrouter/deepseek/deepseek-v4.1-flash}" \
  --cwd "$work" --timeout "${OPENCLAW_WORKER_TIMEOUT:-1080}" 2>>"$state/engine.log"
