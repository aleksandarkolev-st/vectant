# Agent Dojo Release Gate Runbook

This runbook explains how to prove the mature Agent Dojo release gates without
turning missing external systems into fake local evidence.

The source of truth for gate definitions is:

```text
mcp/synthi-mcp/scripts/dojo-release-gate-manifest.mjs
```

The source of truth for a specific run is the runner report and evidence
manifest produced by:

```powershell
node mcp/synthi-mcp/scripts/dojo-release-gate-runner.mjs --scope enterprise-release --execute --continue-on-failure
```

## Local Gate Baseline

For a full local enterprise gate run using the current local Postgres and Docker
fixtures, set the local-only release inputs first:

```powershell
$env:SYNTHI_DOJO_POSTGRES_TEST_URL='postgres://synthi:password@127.0.0.1:15432/synthi'
$env:NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS='1'
$env:AI_ENGINE_HOST_PORT='8081'
$env:POSTGRES_HOST_PORT='15432'
$env:SYNTHI_DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_PATH="$PWD\tmp\dojo-hosted-runtime-gateway-release-observation\hosted-runtime-gateway-release-observation.json"
node mcp/synthi-mcp/scripts/dojo-release-gate-runner.mjs --scope enterprise-release --execute --continue-on-failure
node mcp/synthi-mcp/scripts/dojo-release-gate-verify.mjs --release-gate-run-report tmp/dojo-release-gate-runner/dojo-release-gate-runner-report.json --release-gate-run-evidence tmp/dojo-release-gate-runner/dojo-release-gate-runner.evidence.json
```

This proves the runnable local gates. It does not prove hosted CDP, deployed MCP
host conformance, real managed-key signing, live chaos, or a real soak session
unless those external inputs are configured.

## Fail-Closed Missing-Env Audit

Use this command before claiming a release candidate. It turns missing required
environment into failed gate results instead of skipped gates:

```powershell
node mcp/synthi-mcp/scripts/dojo-release-gate-runner.mjs --scope enterprise-release --dry-run --fail-on-missing-env --out-dir tmp/dojo-release-gate-runner-enterprise-missing-env-audit
```

With the local-only inputs above set, the only remaining blockers should be
external release gates. The report must have:

```text
ok=false
promotion_ready=false
failed > 0 when external release inputs are absent
```

## External Release Inputs

These gates require real deployed or long-running systems. Do not satisfy them
with loopback URLs, inline fake signers, generated sample observations, or
fixture-only artifacts.

| Gate | Required inputs | What it proves |
|---|---|---|
| `workflow_e2e_hosted` | `SYNTHI_HOSTED_BROWSER_CDP_URL`, `SYNTHI_WORKFLOW_PIPELINE_VERIFY_FRESH_MCP=1` | Hosted browser workflow path runs outside local CDP and exports fresh MCP evidence. |
| `private_tool_stdio_acceptance` | `SYNTHI_HOSTED_BROWSER_CDP_URL` | Strict stdio MCP client can execute proof-gated private tool flow against hosted runtime. |
| `private_tool_codex_acceptance` | `SYNTHI_HOSTED_BROWSER_CDP_URL` | Codex-style client can execute proof-gated private tool flow without local browser leakage. |
| `dojo_mcp_host_conformance` | `SYNTHI_DOJO_MCP_HOST_URL`, `SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_CONTROL_PLANE_STORE`, `SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_PROOF_SIGNING`, `SYNTHI_DOJO_MCP_CONFORMANCE_BRIDGE_TOKEN_REQUIRED`, `SYNTHI_DOJO_MCP_CONFORMANCE_NO_LOCAL_CDP_LEAKAGE`, `SYNTHI_DOJO_MCP_CONFORMANCE_LICENSED_SKILL_FILTERING` | Non-loopback MCP host lists and dispatches only governed competencies. |
| `private_tool_stdio_host_conformance` | `SYNTHI_HOSTED_BROWSER_CDP_URL`, `SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE`, `SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY`, `SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE`, `SYNTHI_PRIVATE_TOOL_ACCEPTANCE_TARGET_URL` | Deployed private tool host path works with external store and strict schema. |
| `private_tool_codex_host_conformance` | `SYNTHI_HOSTED_BROWSER_CDP_URL`, `SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE`, `SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY`, `SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE`, `SYNTHI_PRIVATE_TOOL_ACCEPTANCE_TARGET_URL` | Deployed Codex private tool path works without shell-only shortcuts. |
| `dojo_managed_key_signing_self_check` | `SYNTHI_DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_PATH` from the managed-key observation script | Proof signing is backed by a configured managed signing service and public verifier material. |
| `dojo_live_chaos` | `SYNTHI_CHAOS_ENABLE_LIVE=1`, `SYNTHI_CHAOS_BROWSER_CRASH_COMMAND_JSON`, `SYNTHI_CHAOS_EVIDENCE_STORE_UNAVAILABLE_COMMAND_JSON`, `SYNTHI_CHAOS_POSTGRES_RESTART_PROOF_COMMAND_JSON`, `SYNTHI_CHAOS_PROOF_SIGNING_OUTAGE_COMMAND_JSON`, `SYNTHI_CHAOS_REDIS_RESTART_COMMAND_JSON`, `SYNTHI_CHAOS_SIGNALING_PARTITION_COMMAND_JSON`, `SYNTHI_CHAOS_WORKER_KILL_COMMAND_JSON` | Real worker, Redis, Postgres, browser, evidence-store, and proof-signing failure modes fail closed. |
| `soak_performance` | `SYNTHI_SESSION_ID`, `SOAK_DURATION_MIN>=60` | Long-running live session stays within latency, memory, leak, false-allow, and false-block budgets. |

## Managed-Key Observation

The managed-key release observation must be produced from a real managed signer
command and public verification key:

```powershell
$env:SYNTHI_DOJO_PROOF_SIGNING_PROVIDER='managed-key-service'
$env:SYNTHI_DOJO_PROOF_SIGNING_KEY_ID='<managed-key-id>'
$env:SYNTHI_DOJO_PROOF_SIGNING_MANAGED_KEY_URI='<kms-or-hsm-key-uri>'
$env:SYNTHI_DOJO_PROOF_SIGNING_COMMAND='<signer-command>'
$env:SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM='<public-ed25519-pem>'
npm --prefix mcp/synthi-mcp run proof:dojo:managed-key-signing:observe
```

The observation script refuses to run when these values are absent. That is
intentional; a local self-check is not release evidence for managed KMS/HSM
custody.

## Live Chaos

List live hooks:

```powershell
npm --prefix mcp/synthi-mcp run chaos:dojo:live:list
```

Run only after the deployment operator provides real command arrays:

```powershell
$env:SYNTHI_CHAOS_ENABLE_LIVE='1'
$env:SYNTHI_CHAOS_REDIS_RESTART_COMMAND_JSON='["<cmd>","<arg>"]'
npm --prefix mcp/synthi-mcp run chaos:dojo:live
```

Each command env var must be a JSON argv array. The runner executes commands
with `shell: false` and records stdout/stderr digests.

## Soak

Run the legacy live soak only against a real live session:

```powershell
$env:SYNTHI_SESSION_ID='<live-session-id>'
$env:SOAK_DURATION_MIN='60'
npm --prefix mcp/synthi-mcp run soak
```

The release verifier expects zero runtime leaks, zero proof replay false allows,
zero false-block rate, and valid tool latency/memory budgets.

## Verifier Rule

A release candidate is not complete until the verifier covers the release
sections:

```powershell
node mcp/synthi-mcp/scripts/dojo-release-gate-verify.mjs --release-candidate --require-complete-release-gate-coverage
```

If a required artifact is missing, stale, fixture-only, or self-check-only where
release evidence is required, the verifier must fail.
