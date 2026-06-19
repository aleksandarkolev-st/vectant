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

## External Blocker Playbooks

Run these playbooks only against real release-candidate infrastructure. The
commands below are intentionally strict: if a required external dependency is
missing, the gate should fail instead of silently substituting local evidence.

### 1. Hosted Browser Workflow E2E

**Gate:** `workflow_e2e_hosted`

**Prerequisites:**

- A hosted browser runtime with a CDP endpoint reachable from this machine.
- The endpoint is not `localhost`, `127.0.0.1`, `::1`, or a forwarded local
  port when claiming production evidence.
- The hosted runtime can reach the target app origin and the MCP server.
- Fresh MCP evidence verification is enabled.

**Command:**

```powershell
$env:SYNTHI_HOSTED_BROWSER_CDP_URL='wss://<hosted-runtime>/devtools/browser/<session>'
$env:SYNTHI_WORKFLOW_PIPELINE_VERIFY_FRESH_MCP='1'
$env:SYNTHI_WORKFLOW_PIPELINE_TIMEOUT_MS='300000'
npm --prefix mcp/synthi-mcp run live:browser:workflow-pipeline
```

**Expected evidence:**

- Workflow pipeline summary reports zero failed checks.
- Generated workflow scripts execute against the hosted runtime.
- Fresh MCP evidence records are present.
- The summary states hosted attach was used and local attach was not used.
- Generated artifacts do not contain fixed forwarded-port literals.

**Common failures:**

- CDP URL is loopback or a local tunnel.
- Hosted runtime cannot reach the workspace origin.
- `SYNTHI_WORKFLOW_PIPELINE_VERIFY_FRESH_MCP` is missing.
- Existing cached MCP artifacts are reused instead of fresh evidence.

### 2. Private Tool Acceptance, Stdio And Codex Clients

**Gates:** `private_tool_stdio_acceptance`,
`private_tool_codex_acceptance`

**Prerequisites:**

- Same hosted CDP endpoint requirements as workflow E2E.
- Private workflow tool generation is configured for the target app.
- The target app is reachable from the hosted runtime.
- Proof-gated Dojo execution path is available.

**Commands:**

```powershell
$env:SYNTHI_HOSTED_BROWSER_CDP_URL='wss://<hosted-runtime>/devtools/browser/<session>'
npm --prefix mcp/synthi-mcp run live:browser:private-tool-stdio
npm --prefix mcp/synthi-mcp run live:browser:private-tool-codex
```

**Expected evidence:**

- Strict schema client can call the generated tool.
- Raw backing tool invocation respects the Dojo proof gate.
- Proof capsule path succeeds through the MCP client.
- Generated private tool manifest validates.

**Common failures:**

- Private tool was generated against local browser state.
- Hosted runtime has no authenticated session or wrong workspace cookies.
- Proof capsule is missing, already used, revoked, or scoped to another
  workspace.
- Strict client rejects a schema that a permissive local client accepted.

### 3. Deployed MCP Host Conformance

**Gate:** `dojo_mcp_host_conformance`

**Prerequisites:**

- A deployed MCP host endpoint that is not loopback.
- External control-plane store is enabled for the deployed host.
- External proof signing is enabled for the deployed host.
- Bridge token enforcement is enabled.
- Local CDP leakage is blocked.
- Skill listing filters by licensed caller permissions.

**Command:**

```powershell
$env:SYNTHI_DOJO_MCP_HOST_URL='https://<deployed-mcp-host>'
$env:SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_CONTROL_PLANE_STORE='1'
$env:SYNTHI_DOJO_MCP_CONFORMANCE_EXTERNAL_PROOF_SIGNING='1'
$env:SYNTHI_DOJO_MCP_CONFORMANCE_BRIDGE_TOKEN_REQUIRED='1'
$env:SYNTHI_DOJO_MCP_CONFORMANCE_NO_LOCAL_CDP_LEAKAGE='1'
$env:SYNTHI_DOJO_MCP_CONFORMANCE_LICENSED_SKILL_FILTERING='1'
npm --prefix mcp/synthi-mcp run live:dojo:mcp-host-conformance
```

**Expected evidence:**

- Tool manifest is signed and validates.
- Host lists only authorized licensed competencies for the caller.
- Direct raw backing tools are hidden or blocked.
- Proof-gated execution path works through the deployed host.
- Revoked proof, revoked tool, or revoked license fails closed.
- Old proof cannot call a newer license version.

**Common failures:**

- Host points to a loopback URL or local MCP process.
- Store is process-local, so revocation does not propagate.
- The host accepts unsigned manifests.
- Caller authorization is evaluated after tool exposure rather than before.

### 4. Deployed Private Tool Host Conformance

**Gates:** `private_tool_stdio_host_conformance`,
`private_tool_codex_host_conformance`

**Prerequisites:**

- Hosted CDP endpoint is non-loopback.
- Private workflow tool store is external and encrypted.
- Store key is provided through release secret management.
- Tool scope is explicit and tenant/workspace bounded.
- Acceptance target URL is the deployed target app, not a local fixture.

**Commands:**

```powershell
$env:SYNTHI_HOSTED_BROWSER_CDP_URL='wss://<hosted-runtime>/devtools/browser/<session>'
$env:SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE='\\<external-store>\private-tools.enc.json'
$env:SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY='<release-secret-key>'
$env:SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE='<tenant>/<workspace>/<app-release>'
$env:SYNTHI_PRIVATE_TOOL_ACCEPTANCE_TARGET_URL='https://<target-app-origin>'
npm --prefix mcp/synthi-mcp run live:browser:private-tool-host-conformance
npm --prefix mcp/synthi-mcp run live:browser:private-tool-codex-host-conformance
```

**Expected evidence:**

- External private tool store is used.
- Runtime URL is non-loopback.
- Strict stdio and Codex-style clients both execute the proof path.
- Raw backing tool path is blocked outside Dojo dispatcher context.

**Common failures:**

- Store file is local temp output.
- Store key does not decrypt generated tools across processes.
- Target URL points to a local dev app.
- Codex client path relies on shell-only behavior not present in hosted MCP.

### 5. Managed-Key Proof Signing Observation

**Gate:** `dojo_managed_key_signing_self_check`

**Prerequisites:**

- Real managed signing key exists in KMS/HSM or managed signing service.
- A signer command can sign the provided payload without exposing private key
  material.
- Public Ed25519 verification key is exported or discoverable.
- The signer identity and key URI are release scoped.

**Command:**

```powershell
$env:SYNTHI_DOJO_PROOF_SIGNING_PROVIDER='managed-key-service'
$env:SYNTHI_DOJO_PROOF_SIGNING_KEY_ID='<managed-key-id>'
$env:SYNTHI_DOJO_PROOF_SIGNING_MANAGED_KEY_URI='<kms-or-hsm-key-uri>'
$env:SYNTHI_DOJO_PROOF_SIGNING_COMMAND='<signer-command>'
$env:SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM='<public-ed25519-pem>'
npm --prefix mcp/synthi-mcp run proof:dojo:managed-key-signing:observe
```

Use the generated observation path in the release gate runner:

```powershell
$env:SYNTHI_DOJO_MANAGED_KEY_SIGNING_RELEASE_OBSERVATION_PATH='<path-from-observe-output>'
node mcp/synthi-mcp/scripts/dojo-release-gate-runner.mjs --scope enterprise-release --execute --continue-on-failure
```

**Expected evidence:**

- Observation records provider, key ID, managed key URI, public key fingerprint,
  signed payload digest, and verification result.
- Verification succeeds with public key material outside the signing command.
- No private key or local fallback secret appears in artifacts.

**Common failures:**

- Signer command is a local fixture or inline private key wrapper.
- Public key does not match the managed key.
- Provider or key URI is missing, so the observation cannot prove custody.
- Observation file is stale relative to the release run.

### 6. Live Chaos

**Gate:** `dojo_live_chaos`

**Prerequisites:**

- Release candidate deployment has isolated test tenant/workspace data.
- Operators provide command arrays for each live failure hook.
- Each command is safe for the target environment and reversible.
- Monitoring confirms unsafe actions fail closed during each outage.

List required hooks:

```powershell
npm --prefix mcp/synthi-mcp run chaos:dojo:live:list
```

Run with real command arrays:

```powershell
$env:SYNTHI_CHAOS_ENABLE_LIVE='1'
$env:SYNTHI_CHAOS_BROWSER_CRASH_COMMAND_JSON='["<cmd>","<arg>"]'
$env:SYNTHI_CHAOS_EVIDENCE_STORE_UNAVAILABLE_COMMAND_JSON='["<cmd>","<arg>"]'
$env:SYNTHI_CHAOS_POSTGRES_RESTART_PROOF_COMMAND_JSON='["<cmd>","<arg>"]'
$env:SYNTHI_CHAOS_PROOF_SIGNING_OUTAGE_COMMAND_JSON='["<cmd>","<arg>"]'
$env:SYNTHI_CHAOS_REDIS_RESTART_COMMAND_JSON='["<cmd>","<arg>"]'
$env:SYNTHI_CHAOS_SIGNALING_PARTITION_COMMAND_JSON='["<cmd>","<arg>"]'
$env:SYNTHI_CHAOS_WORKER_KILL_COMMAND_JSON='["<cmd>","<arg>"]'
npm --prefix mcp/synthi-mcp run chaos:dojo:live
```

**Expected evidence:**

- Live chaos report is written to `tmp/dojo-chaos-runner/live-chaos-runner.report.json`.
- Each scenario records command argv, stdout/stderr digests, start and end time,
  and pass/fail classification.
- Unsafe actions fail closed.
- Evidence records are not partially accepted.
- Proof is not consumed for failed preflight.
- Recovery path is visible after the injected failure ends.

**Common failures:**

- A command env var is a string shell command instead of a JSON argv array.
- Command targets the wrong namespace, container, or service.
- Failure injection succeeds but no Dojo action is attempted during the outage.
- Recovery is not verified after the failure.

### 7. Soak And Performance

**Gate:** `soak_performance`

**Prerequisites:**

- A real live session exists and can run long enough for soak.
- `SOAK_DURATION_MIN` is at least `60`.
- Runtime metrics collection is enabled.
- Test tenant has enough data to exercise proof validation, graph execution,
  evidence append, and browser session lifecycle repeatedly.

**Command:**

```powershell
$env:SYNTHI_SESSION_ID='<live-session-id>'
$env:SOAK_DURATION_MIN='60'
npm --prefix mcp/synthi-mcp run soak
```

**Expected evidence:**

- Soak report covers the full requested duration.
- Proof validation p95 stays inside budget.
- Graph node execution p95 stays inside budget.
- Evidence append p95 stays inside budget.
- Browser session leak count is zero.
- Proof replay false allow count is zero.
- False block rate stays within release budget.
- Memory growth has no leak trend.

**Common failures:**

- Session ID points to an expired or local session.
- Duration is below 60 minutes.
- Metrics are collected only at startup or shutdown, not across the run.
- Long-running browser sessions are not cleaned up.

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
