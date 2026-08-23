#!/bin/sh
set -eu

# Credentials arrive through a read-only volume. Each CLI gets a private
# writable copy in tmpfs for sessions/caches; nothing can persist after the
# disposable container exits.
for tool in codex claude hermes; do
  source_dir="/run/agent-credentials/${tool}"
  target_dir="/tmp/${tool}"
  mkdir -p "$target_dir"
  if [ -d "$source_dir" ]; then
    cp -R "$source_dir"/. "$target_dir"/
    chmod -R u+rwX "$target_dir"
  fi
done

exec "$@"
