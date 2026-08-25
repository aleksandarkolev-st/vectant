---
area: packages
generated: 2026-08-25
files: 33
---

# File Index — packages (33 files)

Kinds: source/config: 20, test: 13


## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `packages/atomic-orchestrator/package.json` | 234 | JSON data (package.json) |
| `packages/atomic-orchestrator/src/execution-lifecycle.js` | 6 | defines `cheapestValidator` |
| `packages/atomic-orchestrator/src/index.js` | 1 | Provider-neutral lifecycle for atomic changes. |

## test

| File | Bytes | Note |
|---|---|---|
| `packages/atomic-orchestrator/src/index.test.js` | 8 | import { describe, expect, it } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `packages/atomic-orchestrator/src/task-planning.js` | 9 | defines `normalizedId` |
| `packages/mcp-hub/index.d.ts` | 1 | defines `listTools` |
| `packages/mcp-hub/package.json` | 413 | JSON data (package.json) |

## test

| File | Bytes | Note |
|---|---|---|
| `packages/mcp-hub/src/__tests__/client.test.js` | 4 | ── Mock the MCP SDK client + transports ─────────────────────────────── |
| `packages/mcp-hub/src/__tests__/guardedFetch.test.js` | 4 | Minimal Response-like stub: only the bits guardedFetch touches (status + headers.get). |
| `packages/mcp-hub/src/__tests__/helpers.test.js` | 4 | import { describe, it, expect } from 'vitest'; |
| `packages/mcp-hub/src/__tests__/ssrfGuard.test.js` | 2 | import { describe, it, expect } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `packages/mcp-hub/src/client.js` | 3 | Normalized error envelope. */ |
| `packages/mcp-hub/src/guardedFetch.js` | 2 | DNS-rebinding & redirect-safe fetch for the External MCP Client hub. |
| `packages/mcp-hub/src/helpers.js` | 2 | RFC 7230 token charset */ |
| `packages/mcp-hub/src/index.js` | 218 | export { listTools, callTool, testConnection } from './client.js'; |
| `packages/mcp-hub/src/ssrfGuard.js` | 4 | Error with a stable `code` so callers can map to a normalized envelope. */ |
| `packages/programs-mcp/README.md` | 3 | @synthi/programs-mcp |
| `packages/programs-mcp/package.json` | 770 | JSON data (package.json) |

## test

| File | Bytes | Note |
|---|---|---|
| `packages/programs-mcp/src/__tests__/drift.test.js` | 1 | The backend is the source of truth. This package copies a few constants/rules |
| `packages/programs-mcp/src/__tests__/generateClient.test.js` | 2 | import { describe, expect, it, vi } from 'vitest'; |
| `packages/programs-mcp/src/__tests__/hostEscape.test.js` | 1003 | import { describe, expect, it } from 'vitest'; |
| `packages/programs-mcp/src/__tests__/manifestSpec.test.js` | 1 | import { describe, expect, it } from 'vitest'; |
| `packages/programs-mcp/src/__tests__/roundtrip.test.js` | 2 | End-to-end: a real MCP client talks to the server over the SDK's in-memory |
| `packages/programs-mcp/src/__tests__/server.test.js` | 597 | Smoke test: imports the real MCP SDK (hoisted) and asserts the glue builds. |
| `packages/programs-mcp/src/__tests__/tools.test.js` | 2 | import { describe, expect, it } from 'vitest'; |
| `packages/programs-mcp/src/__tests__/validate.test.js` | 3 | import { describe, expect, it } from 'vitest'; |

## source/config

| File | Bytes | Descriptor |
|---|---|---|
| `packages/programs-mcp/src/generateClient.js` | 2 | @fileoverview Delegate vectant.programs.json generation to a configured Vectant |
| `packages/programs-mcp/src/hostEscape.js` | 1 | @fileoverview Host-escape ruleset — a standalone copy of the denylist the |
| `packages/programs-mcp/src/index.js` | 812 | @fileoverview stdio entry point for the vectant-programs-mcp server. Register |
| `packages/programs-mcp/src/manifestSpec.js` | 5 | @fileoverview Single source of truth for the vectant.programs.json reference |
| `packages/programs-mcp/src/server.js` | 1 | @fileoverview Thin MCP glue: binds the dependency-light PROGRAMS_TOOLS to the |
| `packages/programs-mcp/src/tools.js` | 3 | @fileoverview The three vectant.programs.json MCP tools, as dependency-light |
| `packages/programs-mcp/src/validate.js` | 4 | @fileoverview Advisory vectant.programs.json validator. Mirrors the rules of |


---
[[Repository Map]] · [[00 Home|🏠 Home]]
