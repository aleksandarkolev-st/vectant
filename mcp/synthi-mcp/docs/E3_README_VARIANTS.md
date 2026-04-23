# E3 README Variants — pre-drafted

**Purpose.** Ultraplan §Phase-0.5 E3 asks the spike to measure
`claude_api` p99 latency under realistic load (100 parallel
`synthi_locate` calls, 10 iterations) and decide whether `claude_api`
stays the recommended server-side default, flips to `agent_side` for
interactive loops, or goes marginal (ship with caveat). To avoid a
two-day documentation cascade when the data lands, both README variants
are drafted here. Picking is a 5-minute splice.

Our current shipped state (2026-04-18):

- **Default** `SYNTHI_VISION_BACKEND=agent_side` — no API key, agent's
  own LLM does the grounding, matches the Figma/GitHub MCP pattern.
  (Agent-side cost comes out of the user's existing Claude
  subscription, not the MCP's credentials.)
- **Opt-ins** `claude_api` + `gemini_api` — peer options for users who
  want server-side caching + centralised cost metrics.

E3's output influences which **opt-in** backend we recommend first
when an opt-in is appropriate, and whether `agent_side` stays the
unqualified default.

---

## Variant A — "claude_api fast enough, stays as primary opt-in"

Triggered when E3 finds `claude_api` p99 < 2.5 s OR when it lands
marginal (2.5–5 s) but wins on accuracy/consistency against `gemini_api`.

Splice location: `README.md` § **Vision backend** → **Where `claude_api`
/ `gemini_api` earn their keep** paragraph.

```markdown
**Recommended opt-in backend: `claude_api`.** If you want server-side
grounding + the MCP's `(content_hash, description_hash)` cache across
turns, start with `SYNTHI_VISION_BACKEND=claude_api`. Live E3 measured
p99 < 2.5 s (N=100 parallel calls); `gemini_api` is available as a
cheaper alternative on tight-loop workloads (`gemini-2.5-flash` at
~10× lower cost-per-million-tokens than `claude-opus`) but with
slightly higher variance on detailed / text-heavy UIs — pick the
vendor that matches your workload.
```

And in the env-var table description, the `SYNTHI_VISION_MODEL`
default stays at `claude-opus-4-7`.

---

## Variant B — "claude_api too slow for interactive loops"

Triggered when E3 finds `claude_api` p99 > 5 s AND `gemini_api` p99 is
materially lower (> 200 ms margin).

Splice location: same paragraph as above; also consider bumping
`SYNTHI_VISION_MODEL` to `claude-sonnet-4-6` as a fallback for users
who want to stay on Claude but accept the lower-accuracy tier.

```markdown
**Recommended opt-in backend: `gemini_api`.** For interactive agent
loops against a live session, the MCP's `claude_api` path measured p99
> 5 s on a 100-parallel `synthi_locate` workload (Live E3, 2026-MM-DD).
Start with `SYNTHI_VISION_BACKEND=gemini_api` + `SYNTHI_GEMINI_MODEL=
gemini-2.5-flash` for the best latency/cost tradeoff; `claude_api` is
still supported for batch / non-interactive workloads where higher p99
is acceptable. `agent_side` (no API key) remains a fine choice for
vision-capable hosts.
```

Additionally: add a "**Interactive loops**" subsection under **Vision
backend** with the recommendation in bold, because the degradation is
surprising enough to warrant dedicated prose.

---

## Variant C — marginal (2.5–5 s), stays claude_api with caveat

Triggered when E3 lands in the 2.5–5 s band.

Splice location: append to Variant A's paragraph.

```markdown
**Tight-loop caveat.** Live E3 measured `claude_api` p99 at 2.5–5 s
under the 100-parallel stress workload (2026-MM-DD). For agent loops
that touch `synthi_locate` more than ~10 times per minute, either (a)
switch to `SYNTHI_VISION_BACKEND=gemini_api` + `gemini-2.5-flash` for
a ~5× better tail, or (b) lean harder on handles + `reuse_handle` so
successive calls hit the `(content_hash, description_hash)` cache.
```

---

## Operator notes

- The "five-minute splice" claim only holds if the paragraph + env-var
  table + tool description are all kept in sync. When you splice,
  grep for `SYNTHI_VISION_MODEL` + `SYNTHI_VISION_BACKEND` + `Vision
  backend` to find every touch point.
- E3 findings go into `PHASE_0_5_FINDINGS.md` §E3 Results row; the
  verdict column (`commit` / `falsify` / `marginal`) determines which
  variant above to splice. Don't re-write the README prose in the
  findings doc — keep all draft prose here and link from findings.
- After splicing, **delete** the stale variants from this file so the
  repo doesn't carry two "current truths" side by side.

---

## Pre-flight checklist (when running Live E3)

- [ ] `docker-compose up -d` — full stack running.
- [ ] `counter_sdl2` fixture compiled + session created.
- [ ] `ANTHROPIC_API_KEY` + `GEMINI_API_KEY` both set in the MCP's env.
- [ ] Run spike harness: `SPIKE_MODE=live npm run spike:E3`
      (spins up 100 parallel `synthi_locate` calls against the fixture).
- [ ] Capture p50/p95/p99 per backend; record in `PHASE_0_5_FINDINGS.md`.
- [ ] Apply the matching variant above; delete the others from this
      file.

Related experiments (run before deciding):

- **E2b** — region-pHash vs full-frame vs `agent_side` on an animated
  UI; informs whether the cache gains justify the vendor-call cost.
- **E4** — 30-minute Claude Code loop with mixed tools; sets the p50/p95
  hourly cost projection used for phase-2 quota defaults.
