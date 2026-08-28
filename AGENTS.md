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
- No architecture, API, language, engine, or framework class may be declared
  permanently unsupported. When mechanics are opaque, emit versioned
  capability and boundary requirements, attempt generic instrumentation,
  interposition, or AI-assisted synthesis, and keep the particular edit
  fail-closed until those synthesized boundaries are independently observed.
  The architecture label itself is never a blocker or proof result.
- Model support through versioned, identity-free execution capabilities and
  compose obligations from observed mechanics. New projects must not require a
  new success branch. A new mechanism may extend the generic capability schema
  only with corresponding fail-closed verifier obligations.
- Send every project through the same discovery, classification, boundary
  synthesis, compile, load, epoch publication, dispatch, oracle, and ledger
  pipeline. Opaque mechanisms must receive generic probe/app-hook synthesis;
  missing evidence produces precise refusal gaps, never fabricated success.
- User code must not be required to emit Synthi records, import a Synthi SDK, or
  implement a predetermined callback. Proof records are internal observations
  produced from discovered build and runtime mechanics by instrumentation,
  interposition, or independently verified AI-synthesized probes. A serialized
  application claim is never an observed runtime boundary.
- Never require a user's program to conform to Synthi naming, layout, control
  flow, hook, loop, event, build, or framework conventions. Integration must be
  attached to the program that already exists, without a project-specific shim
  or manual rewrite. For an unfamiliar target, invoke the existing AI agent to
  propose discovery probes, boundaries, and adapter code, then compile, execute,
  and independently verify those proposals before they can affect acceptance.
- The product target is transparent universal operation across arbitrary user
  projects. Treat every newly encountered mechanism as a capability-discovery
  and synthesis problem, not a new hardcoded scenario. "Flawless" means no
  false success, silent fallback, hidden restart, or unreported limitation: if
  the required runtime evidence cannot yet be observed, keep that edit
  fail-closed with the exact missing observation while continuing the generic
  synthesis path; never label the architecture itself unsupported.
- Treat every user-authored program representation and execution topology as an
  open composition of discovered capabilities. No fixed list of file forms,
  runtimes, schedulers, command models, output encodings, or state concepts may
  define eligibility. The system must bind changed artifacts to observed
  execution and verifier-consumed output bytes using capability IDs and schemas
  derived from the target, not categories embedded in Synthi source code.
- State requirements are an open set of dependencies discovered from observed
  dataflow. Require only dependencies proven relevant to the changed output,
  and bind each required dependency's identity or content across the update.
- AI output is proposal material only. Compiler/build metadata, runtime traces,
  same-process identity, artifact hashes, epoch/dispatch linkage, and output
  oracle bytes must independently verify every accepted field.
- Use the AI agent for open-ended discovery and synthesis on unfamiliar source
  trees: it may propose capability facts, output dependencies, fission
  boundaries, instrumentation, and adapter code. Feed those proposals through
  the same identity-free capability obligations and independent compiler/runtime
  verifiers as every other candidate; never add a project-shaped success path.
- Prefer the smallest generic capability or obligation that captures an
  observed mechanic. Renderer terms such as camera, swapchain, TAA, denoiser,
  engine, framework, or API names may be optional observed metadata, but must
  not become universal fields or acceptance gates. Do not create another schema
  or adapter branch when an existing open-vocabulary capability plus evidence
  binding can express the mechanic.
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
- Before each commit, audit the staged diff for name-based authority,
  scenario-shaped fixtures in production decisions, duplicated proof schemas,
  and unnecessary abstractions. Do not commit until that audit is clean.
- Before each commit, explicitly prove that the change expresses a generic
  discovered mechanic rather than a project, scenario, renderer, architecture,
  test, or edge-case shortcut. Check that arbitrary unfamiliar projects enter
  the same path, that user code gains no new conformance requirement, and that
  adding a new corpus target would not require another production success
  branch. If any of those checks fail, redesign the patch before committing it.
