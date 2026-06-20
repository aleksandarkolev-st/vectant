#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <rendered-kubernetes-manifest.yaml>" >&2
  exit 2
fi

RENDERED="$1"

if [[ ! -s "${RENDERED}" ]]; then
  echo "Rendered manifest is missing or empty: ${RENDERED}" >&2
  exit 1
fi

require_text() {
  local label="$1"
  local text="$2"
  if ! grep -Fq -- "${text}" "${RENDERED}"; then
    echo "Dojo release render is missing ${label}: ${text}" >&2
    exit 1
  fi
}

reject_text() {
  local label="$1"
  local text="$2"
  if grep -Fq -- "${text}" "${RENDERED}"; then
    echo "Dojo release render contains forbidden ${label}: ${text}" >&2
    exit 1
  fi
}

require_text "Dojo MCP deployment/service/backend" "name: dojo-mcp-host"
require_text "Dojo MCP ingress path" "path: /dojo/mcp"
require_text "Dojo release ExternalSecret" "name: synthi-dojo-release-secrets"
require_text "Dojo MCP bearer secret binding" "key: synthi-dojo-mcp-bearer-token"
require_text "managed proof signing command secret binding" "key: synthi-dojo-proof-signing-command"
require_text "managed proof signing URI secret binding" "key: synthi-dojo-proof-signing-managed-key-uri"
require_text "hosted browser CDP secret binding" "key: synthi-dojo-hosted-browser-cdp-url"
require_text "private workflow tool store secret binding" "key: synthi-private-workflow-tool-store-file"

require_text "collab ingress path" "path: /collab"
require_text "signaling ingress path" "path: /signal"
require_text "gateway ingress path" "path: /gateway"
require_text "frontend ingress path" "path: /"
require_text "preview wildcard ingress host" "host: '*.preview.vectant.dev'"
require_text "preview service route" "name: collab-preview"

reject_text "placeholder image tag" "build-tag-required"

echo "Dojo release render guard passed for ${RENDERED}"
