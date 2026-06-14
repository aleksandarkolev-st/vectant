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

## Future Live Chaos

The mature release plan still calls for slower live chaos scenarios such as
worker kill, signaling partition, Redis restart, Postgres restart during proof
validation, and browser crash. Those should land as additional scenario modules
using the same runner contract, with environment-gated live requirements instead
of replacing the deterministic preflight.
