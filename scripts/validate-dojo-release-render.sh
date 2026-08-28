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

reject_resource() {
  local kind="$1"
  local name="$2"
  if awk -v kind="${kind}" -v name="${name}" '
    BEGIN { doc = ""; found = 0 }
    function flush() {
      if (doc ~ "(^|\n)[[:space:]]*kind:[[:space:]]*" kind "([[:space:]]|\n)" &&
          doc ~ "(^|\n)[[:space:]]*name:[[:space:]]*" name "([[:space:]]|\n)") {
        found = 1
      }
      doc = ""
    }
    /^---[[:space:]]*$/ { flush(); next }
    { doc = doc $0 "\n" }
    END { flush(); exit found ? 0 : 1 }
  ' "${RENDERED}"; then
    echo "Dojo release render contains forbidden ${kind}/${name}" >&2
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
require_text "hosted browser sidecar" "name: hosted-browser"
require_text "hosted browser same-pod CDP URL" 'value: http://127.0.0.1:$(SYNTHI_HOSTED_BROWSER_CDP_PORT)'
require_text "hosted browser same-pod topology" "value: same-pod"
require_text "runtime hosted browser CDP target template" "SYNTHI_HOSTED_BROWSER_CDP_TARGET_TEMPLATE: http://{runtimeId}.synthi.svc.cluster.local:{cdpPort}"
require_text "runtime hosted browser CDP topology" "SYNTHI_HOSTED_BROWSER_CDP_TOPOLOGY: runtime-service"
require_text "private workflow tool store secret binding" "key: synthi-private-workflow-tool-store-file"
require_text "private workflow tool store key secret binding" "key: synthi-private-workflow-tool-store-key"
require_text "auth checkpoint store key secret binding" "key: synthi-auth-checkpoint-store-key"
require_text "Dojo production enforcement" "SYNTHI_DOJO_PRODUCTION_ENFORCEMENT: \"1\""
require_text "Dojo durable store requirement" "SYNTHI_DOJO_REQUIRE_DURABLE_STORE: \"1\""
require_text "Dojo external control-plane store" "SYNTHI_DOJO_CONTROL_PLANE_STORE: postgres"
require_text "Dojo external signing requirement" "SYNTHI_DOJO_REQUIRE_EXTERNAL_SIGNING: \"1\""
require_text "Dojo evidence ledger requirement" "SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER: \"1\""
require_text "Dojo external evidence ledger store" "SYNTHI_DOJO_EVIDENCE_LEDGER_STORE: postgres"
require_text "hosted browser screenshot redaction" "SYNTHI_HOSTED_BROWSER_REDACT_SCREENSHOTS: \"true\""

require_text "collab ingress path" "path: /collab"
require_text "signaling ingress path" "path: /signal"
require_text "gateway ingress path" "path: /gateway"
require_text "frontend ingress path" "path: /"
require_text "preview wildcard ingress host" "host: '*.preview.vectant.dev'"
require_text "preview service route" "name: collab-preview"

reject_text "placeholder image tag" "build-tag-required"
reject_text "in-cluster Redis URL" "redis://redis.synthi.svc.cluster.local:6379"
reject_resource "Deployment" "redis"
reject_resource "Service" "redis"
reject_resource "StatefulSet" "postgres"
reject_resource "Service" "postgres"
reject_resource "NetworkPolicy" "allow-to-redis"
reject_resource "NetworkPolicy" "allow-to-postgres"

echo "Dojo release render guard passed for ${RENDERED}"
