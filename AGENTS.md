# Repository Agent Invariants

## Universal GPU HMR

These rules apply to every GPU HMR implementation, validator, test, report, and
documentation change in this repository.

- Do not branch acceptance, success, routing, proof obligations, or adapter
  behavior on project, repository, target, profile, fixture, library, scenario,
  engine, or backend names. Names are test-corpus metadata only.
- Do not reject an architecture because its name is absent from a closed enum or
  normalize an unfamiliar API to an unsupported catch-all. Architecture labels
  are open-vocabulary metadata; every target enters generic capability
  discovery and boundary synthesis, and only observed mechanics or missing
  evidence may produce a precise fail-closed outcome for a particular edit.
- Model support through versioned, identity-free execution capabilities and
  compose obligations from observed mechanics. New projects must not require a
  new success branch. A new mechanism may extend the generic capability schema
  only with corresponding fail-closed verifier obligations.
- Send every project through the same discovery, classification, boundary
  synthesis, compile, load, epoch publication, dispatch, oracle, and ledger
  pipeline. Opaque mechanisms must receive generic probe/app-hook synthesis;
  missing evidence produces precise refusal gaps, never fabricated success.
- AI output is proposal material only. Compiler/build metadata, runtime traces,
  same-process identity, artifact hashes, epoch/dispatch linkage, and output
  oracle bytes must independently verify every accepted field.
- A project-specific shim, source rewrite, precompiled fixture, log message,
  screenshot path, serialized success flag, or profile declaration cannot
  satisfy GPU HMR acceptance.
- Visual proof must decode and validate actual before/after/diff bytes, reject
  blank, stale, transparent, temporally ambiguous, or unrelated captures, and
  bind the accepted image to the changed artifact, epoch, dispatch, process,
  output target, and deterministic capture controls. Compute proof must bind
  raw readback bytes and schema to the same runtime chain.
- Exercise cold source-first behavior on ordinary source trees and build files,
  including large and unfamiliar projects. Test-corpus coverage should include
  realistic rendering, pre-recorded/indirect command systems, opaque engines,
  WebGPU/DirectX-style pipelines, ROCm neural-network workloads, and large ML
  infrastructure without granting those corpus names proof authority.
- Record per-test monotonic timings for first visible output, first output-ready
  signal, dispatch-to-output proof, proof finalization, and total validator wall
  time. Timing telemetry never authorizes GPU HMR success.
- Validate on the available AMD RX 9070 XT path. Do not substitute CUDA-only
  coverage for the requested environment.
- Universal means architecture-neutral discovery and proof, not unconditional
  success. Claim success only for a target whose strict same-process ledger is
  closed; otherwise fail closed with the exact missing capability or evidence.

## Change Discipline

- Keep each logically separate patch or fix in its own commit.
- Stage explicit files only. Preserve unrelated user and concurrent-agent
  changes in a dirty worktree.
- Use subagents for bounded parallel work and independent adversarial review,
  choosing model/effort according to task difficulty.
