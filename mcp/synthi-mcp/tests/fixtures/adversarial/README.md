# adversarial fixture

Ultraplan §Fixtures calls for a prompt-injection + WM_CLASS spoof test
fixture that exercises the phase-1 security primitives end-to-end.
This fixture renders an "Ignore previous instructions" banner, emits
injection bait on stderr (which the worker routes to the build-log
data channel → MCP injection heuristic), and attempts to claim the
X11 `WM_CLASS` of VSCode.

## Observable signals

| Signal | Producer | Consumer |
|---|---|---|
| `security` event `injection_suspected` | `src/security/injection.ts` matches one of the 7 canonical patterns in emitted stderr | `prompt_injection.test.ts` |
| `security` event `wm_class_mismatch` | Worker's `/proc/<pid>/exe` hash vs. the spoofed WM_CLASS | `wm_class_spoof.test.ts` |
| Red danger banner + dark "terminal" scene | Rendered every frame | Visual confirmation on manual QA |

## Used by

- `tests/integration/prompt_injection.test.ts` (to be written)
- `tests/integration/wm_class_spoof.test.ts` (to be written)
- Manual QA — paste the source into a new session and confirm the
  security events appear within a few seconds of attach.

## Notes

- The fixture uses only SDL2 (no SDL_ttf, no extra assets) so it
  compiles under the same `UNIVERSAL_SPLIT_PROMPT` path as `counter/`
  and `particle_demo/`.
- The WM_CLASS spoof uses `SDL_VIDEO_X11_WMCLASS` + a matching window
  title so naive classifiers (title-match-only) succeed at being
  fooled. The worker's fingerprint check is what rejects the claim.
- Re-emits the injection bait every ~5 s so agents that attach after
  startup still observe it in the event log within one scrape.
