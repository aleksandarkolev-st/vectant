#!/usr/bin/env bash
# Build + run the Swing a11y fixture. The worker's Java runtime path can
# execute the resulting .class directly once the a11y bridge provider is
# wired; standalone this is useful for manual testing and for
# tests/e2e/*.sh scripts to spin up the fixture without Docker.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${here}"

javac CounterSwing.java

if [[ "${1:-}" == "run" ]]; then
  # Ask the toolkit to publish a11y events on startup so providers that
  # read the accessible tree see a stable initial snapshot.
  java \
    -Djavax.accessibility.assistive_technologies= \
    -Djavax.accessibility.screen_magnifier_present=false \
    CounterSwing
fi
