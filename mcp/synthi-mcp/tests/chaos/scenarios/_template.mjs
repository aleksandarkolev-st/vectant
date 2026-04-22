//
// _template.mjs — shape every chaos scenario conforms to.
//
// Copy this file to a concrete scenario name (e.g. `worker_kill.mjs`),
// populate the lifecycle hooks, and the runner picks it up automatically.
// Files starting with `_` are skipped so this template never runs.
//
// A scenario is one deterministic reproduction. Keep setup + inject
// tight enough that the assertion phase can attribute any failure to
// this scenario's induced fault rather than to environmental flakiness.
// If a scenario needs multiple faults, each gets its own file.
//

export default {
  /**
   * Short identifier surfaced in the runner output. Convention: snake_case
   * matching the filename (minus .mjs).
   */
  name: "_template",

  /**
   * One-sentence description of the induced fault + the invariant the
   * scenario checks. Shown in the runner's `--list` output.
   */
  description: "Template — not runnable. Replace this stub when you land a real scenario.",

  /**
   * Lifecycle:
   *   1. `setup(ctx)`    — spin up the target stack, attach the MCP,
   *                        arrive at a known-good baseline.
   *   2. `inject(ctx)`   — induce the fault (tc-netem, SIGKILL, etc.).
   *   3. `assert(ctx)`   — exercise the MCP + worker and verify the
   *                        correctness ladder surfaced the expected
   *                        error with the expected evidence.
   *   4. `cleanup(ctx)`  — release resources regardless of outcome.
   *                        Must be idempotent and tolerate partial setup.
   *
   * The runner calls `scenario.run(ctx)` — this default implementation
   * calls the four hooks in order with try/finally around cleanup so a
   * failing assertion still runs cleanup. Override `run` if your
   * scenario needs a non-linear flow (e.g., chaos during setup).
   */
  async run(ctx) {
    await this.setup(ctx);
    try {
      await this.inject(ctx);
      await this.assert(ctx);
    } finally {
      await this.cleanup(ctx);
    }
  },

  async setup(/* ctx */) {
    throw new Error("unimplemented: copy _template.mjs and fill in setup()");
  },

  async inject(/* ctx */) {
    throw new Error("unimplemented: copy _template.mjs and fill in inject()");
  },

  async assert(/* ctx */) {
    throw new Error("unimplemented: copy _template.mjs and fill in assert()");
  },

  async cleanup(/* ctx */) {
    // Idempotent teardown. It's fine for cleanup to run when setup() never
    // succeeded — guard against null state rather than assuming setup ran.
  },
};
