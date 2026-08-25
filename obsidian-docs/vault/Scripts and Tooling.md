# Scripts and Tooling

> Annotated inventory of the repo's tooling directories. The full per-file doc catalog lives in [[Docs and Tooling]].

## scripts/ (24 files)

| Area | Scripts | Purpose |
|---|---|---|
| Build | `build-oauth-relay-extension.mjs`, `build-node-polyfills.js` (synthi) | Extension zip; browser polyfill bundling |
| GPU HMR proofs | `proof:*` npm-script matrix in synthi (`dojo-visual-proof.mjs`, `shadow-card-visual-proof.mjs`, `ghost-mode-visual-proof.mjs`) | Decoded visual before/after/diff proof runs |
| Codesite proofs | `codesite:proof:verify`, `codesite:proof:full-workflow`, `codesite:proof:runway-occupancy`, `codesite:proof:quarantine-review` | Governance-gate live acceptance |
| Maintenance | `compact-vhdx.ps1`, `count_files_loc.ps1`, `list-sources.ps1` (root) | Windows/Docker disk + LOC housekeeping |

## e2e/ — Playwright

`playwright.config.ts` at repo root drives `e2e/` specs against the compose stack (`@playwright/test` devDep). Baseline screenshots under `.scratch-playwright/screenshots-baseline/`.

## tests/

- `tests/security/` — boundary/egress security suites.
- Per-service suites: collab-server `__tests__/`, synthi vitest (`src/**/*.test.{js,jsx}`), mcp `tests/unit/`, packages `__tests__/`.
- Run: host pytest equivalent is `py -3.12 -m pytest`; JS suites via each package's runner.

## probe/synthi-probe

Cooperative enriched-tier C library — injected observation surface for runtime probes (pairs with worker safety modules).

## Validation doctrine (project law)

- Static/unit tests alone NEVER count as validation.
- Every acceptance-affecting change needs **runtime execution + decoded visual before/after/diff proof** through the changed path on the RX 9070 XT (gfx1201), plus an adversarial input exercising the fixed gap.
- Breadth: hundreds of generated live scenarios (500+ for GPU HMR universal acceptance).
- Every validation run records agent-edit→verify and human-edit→visual wall times (see [[GPU HMR System]] §9).
- Zero hardcoding: fixtures derived from env/git, never inline literals.
- Each bug-class fix lands as a separate commit.

## Evidence locations

- `tmp/codesite-*-proof/` — 208-entry flagship governance proof suite
- `.visual-proof/`, `screenshots/` — visual captures
- docs/THERAPEUTIC_TOMOGRAPHY_RELEASE_EVIDENCE.json — release evidence manifest

Full tables: [[Docs and Tooling]] §11–12 · [[00 Home|🏠 Home]]
