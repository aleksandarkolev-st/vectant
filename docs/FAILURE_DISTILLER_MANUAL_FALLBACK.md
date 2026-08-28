# Failure Distiller manual fallback

Use this runbook when an automated proof gate cannot run locally (for example,
Docker is unavailable or browser control is not connected). It supplements, but
does not replace, the [Failure Distiller plan](FAILURE_DISTILLER_AGENT_FEATURE_IMPROVED.md)
and the [Vivarium plan](AGENT_DOJO_FULL_MATURE_VIVARIUM_CORTEX_PLAN.md).

## Rule of operation

Never promote a capsule, patch, benchmark result, or support claim based on a
manual observation alone. Mark it `manual_verified` and retain the evidence.
Automated validation remains required before release promotion.

## Human procedure

1. Freeze the source revision and record the failing command, runtime/lockfile
   identity, declared oracle/signature, and execution budget.
2. Run the original failure in a disposable worktree. Save its command, exit
   status, bounded output digest, signature, and stability count.
3. Run the capsule from its editable overlay; make a small repair there and
   retain the unified diff. Do not edit the original workspace.
4. Validate that patch in the original disposable worktree. The original
   failing command is mandatory; run any affected checks discovered from the
   workflow and touched packages.
5. If Vivarium is involved, reset and run the synthetic world. Accept it only
   when its predicate and signature match the original-world evidence. Record
   the reset/run evidence in the shared ledger.
6. Save an immutable evidence bundle: revision, capsule ID, commands,
   timestamps, image digest (if used), outputs/digests, screenshots or browser
   trace, patch, and each pass/fail decision.

## Required manual security checks

- Docker: inspect the exact command before running. It must use an allowlisted
  `@sha256:` image, `--pull=never`, `--network=none`, a read-only `/workspace`,
  bounded tmpfs, and resource limits. Attempt writes to a source file, `.git`,
  and capsule artifacts; all must fail and their hashes must remain unchanged.
- Browser: capture the consented, source-linked workflow with
  `synthi_failure_browser_workflow_capture`; it rejects workflows that are not
  eligible for `ciIsolated` replay. Replay the stated route, state, viewport,
  and device and retain a trace/screenshot for baseline, reduced capsule, and
  original-world patch validation.
- Stop immediately on any mutation outside the disposable worktree, an unknown
  image/closure edge, ambient dependency/path leakage, or signature mismatch.

## Decision record

| Gate | Pass condition | On failure |
| --- | --- | --- |
| Baseline | Declared stability policy passes | `unstable_baseline` |
| Reduction | Each retained/removal decision has evidence | `budget_not_tested` or rerun |
| Patch | Original-world command and signature pass | do not promote |
| Vivarium | Reset/run and oracle equivalence pass | do not promote |
| Isolation | Mutation and network-denial checks pass | `unsafe_external_boundary` |

Attach the evidence bundle to the relevant ledger entry and issue/PR. A human
sign-off is evidence of review, not a substitute for a missing automated test.
