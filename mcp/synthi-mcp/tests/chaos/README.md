# Dojo Chaos Preflight Suite

This directory contains deterministic fault-injection preflight scenarios for
Agent Dojo. The suite is intentionally lighter than the future long-running
Docker/network chaos program, but it is no longer a placeholder: concrete
scenario modules run focused tests and verify evidence from Vitest JSON reports.

## What Runs Today

Current scenarios:

- `api_fault_server` checks synthetic API timeout, partial write, fake visual
  success, validation error, and downstream failure paths.
- `evidence_custody_fail_closed` checks evidence signature absence, graph
  evidence-writer failure, unbacked evidence refs, and ledger-backed checkride
  evidence unavailability.
- `proof_signing_outage` checks external proof signer outages and managed-key
  custody metadata mismatch.
- `source_drift_mid_run` checks source drift license expiry and active graph
  expiry triggers.
- `vivarium_oracle` checks deterministic synthetic fixtures, prompt-injection
  quarantine, oracle classification, fake-success detection, and Evil Twin
  hardening evidence.
- `runtime_preflight_fail_closed` checks hosted-runtime preflight failure and
  proof-not-consumed behavior for production proof-gated dispatch.

Each scenario owns the evidence it requires. The runner fails if a scenario's
focused tests pass but the expected evidence titles are absent from the JSON
report.

## Running

```bash
node tests/chaos/runner.mjs --require-scenarios --json ../../tmp/dojo-chaos-runner/report.json

node tests/chaos/runner.mjs --list

node tests/chaos/runner.mjs --kind live --list

node tests/chaos/runner.mjs --only api_fault_server --iterations 3
```

The Dojo T8 preflight gate also invokes this runner through:

```bash
npm run proof:dojo:chaos-performance:self-check
```

## Report Contract

The runner writes `synthi.chaosRunnerReport.v1` when `--json` is provided.
Each result includes:

- scenario name and description
- iteration number
- pass/fail status
- duration
- focused test files
- Vitest JSON report digest
- stdout/stderr digests
- evidence coverage entries

## Opt-In Live Chaos

Live chaos hooks now exist, but they are never part of the default preflight.
The runner selects deterministic preflight scenarios by default. To list live
hooks:

```bash
node tests/chaos/runner.mjs --kind live --list
```

To execute live hooks, set `SYNTHI_CHAOS_ENABLE_LIVE=1`, select `--kind live`
or `--kind all --include-live`, and provide each hook's command as a JSON argv
array. The runner executes those argv arrays with `shell: false`.

Examples of command env vars:

- `SYNTHI_CHAOS_WORKER_KILL_COMMAND_JSON`
- `SYNTHI_CHAOS_SIGNALING_PARTITION_COMMAND_JSON`
- `SYNTHI_CHAOS_REDIS_RESTART_COMMAND_JSON`
- `SYNTHI_CHAOS_POSTGRES_RESTART_PROOF_COMMAND_JSON`
- `SYNTHI_CHAOS_BROWSER_CRASH_COMMAND_JSON`
- `SYNTHI_CHAOS_EVIDENCE_STORE_UNAVAILABLE_COMMAND_JSON`
- `SYNTHI_CHAOS_PROOF_SIGNING_OUTAGE_COMMAND_JSON`

This keeps destructive Docker/network/service operations external to the repo
and makes live execution an explicit release-operator decision.
