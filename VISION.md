# Synthi MCP — Vision

**Status:** active. Sits above `AGENT_MCP_ULTRAPLAN.md`. Every design decision in the plan is measured against this doc.

---

## What it is

**Synthi MCP is the runtime substrate that lets AI coding agents autonomously develop, run, and verify remote-compiled programs with the same fidelity as a human developer — across any language, any runtime, with observable, auditable behavior a human can trust for hours unattended.**

## Why it matters

Agents today can write code but cannot operate it. They can't see the app they built, click the button they rendered, or know whether their change worked. Synthi MCP closes that loop: it gives agents a first-class interface to running programs — video, structure, sound, state, synchronized control — over a single protocol any MCP-capable client can consume.

The opportunity is bigger than *"let Claude click buttons in a preview."* It is the substrate for autonomous software work on programs that compile and run on Synthi's infrastructure. Every other autonomous coding system today either operates on static repos (no runtime loop) or inside a sandbox they fully control (no generality). We run the program. We stream its state. We can give agents the eyes and synchronization they need to close the develop-run-verify loop on arbitrary code.

## North star

> **Can an agent running in a loop produce reliable software work on this system, for hours, unattended?**

Every design decision is measured against that sentence. Wire compatibility, tool counts, phase labels — tactical. If the answer is yes, details don't matter. If no, no amount of protocol polish saves us.

## Principles

1. **Tiered capability, not monolithic assumption.** Universal surface (pixels, input, perceptual sync) always works — including SDL2/C++/games. Enriched surfaces (a11y trees, DevTools, uiautomator) are advertised per session. Cooperative surfaces (`synthi-probe` — one function, `synthi_label_rect`) exist for guests that opt in. Never pretend one layer is all three.

2. **Server enforces correctness.** Any safety rule whose correctness depends on caller discipline belongs on the server. Agents forget. Prompts forget. Protocols remember.

3. **Semantic first, pixels last.** Agents address UI by description, role, or cooperative label. Coordinate-level tools are escape hatches for runtimes that expose nothing structured — not the primary surface.

4. **Autonomy demands observability.** A human running the session sees every attached agent live — which tool, which arg, which cost, with a one-click kill switch. Agents surface their uncertainty, their rate of progress, and their cost.

5. **Assume adversarial guest content.** Vision-enabled agents see text that may try to redirect them. Focus lock, guest sandboxing, and sensitive-action interstitials are Day-One, not phase-N.

6. **Steal from mature adjacent ecosystems.** Playwright spent a decade turning dumb clicks into compound, auto-waiting, retry-aware actions. We adopt its API shape; we do not re-derive it.

7. **Price everything, from day one.** Per-session usage counters and quotas ship with MVP. Silent polling loops are the default failure mode of autonomous systems; name them before they eat the infra budget.

8. **Version the interface, not the implementation.** Wire protocol, tool surface, and lifecycle enums negotiate on attach. Old agents get restricted projections; new servers speak legacy. Nothing crashes on unknown enum values.

## What success looks like in 6 months

- An agent attached to a Synthi session can pick up a feature request, change code, observe the running app under their changes, iterate visually, and file a PR — in one unattended run.
- The human running the session watches the agent work with full visibility: which actions, which costs, which uncertain moments. One click stops it.
- A second agent working on a different feature shares the same session without fighting for input or redundantly decoding the same video frames.
- Breakage patterns — a flaky HMR, an adversarial guest render, a cross-region latency spike — are visible and recoverable, not silent and fatal.
- New client harnesses plug in with one config line and inherit the full capability surface. Claude Code, Codex, Cursor, Gemini CLI, Windsurf — all in scope.

## Non-goals

- **A human debugger substitute.** Humans remain the accountable party; this makes agents usable alongside them, not instead of them.
- **A universal remote desktop.** The abstraction level is UI automation (Playwright/Appium), not VNC.
- **A prompt-engineering framework.** We ship primitives; agent harnesses ship strategies.

## What this vision does not guarantee

It does not guarantee agents will produce good software without human oversight. It guarantees they have the primitives to do so; the remainder is the agent harness's job and the human reviewer's job.
