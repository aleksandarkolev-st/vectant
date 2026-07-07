# AI-Assisted Manifest Authoring — Implementation Plan

> **For agentic workers:** TDD, task-by-task, one commit each. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A "Generate manifest" button (Gemini → preview → save) plus making the ai-engine aware of `vectant.programs.json`.

**Architecture:** Reuse the review-gate patterns. A new ai-engine endpoint generates a manifest from workspace context (files passed as text, stateless — like `program_review.py`). A Next.js route gathers context via a new collab-server `/context` endpoint, calls the engine, and validates with `parseProgramManifest`. A preview dialog lets the user edit; Save re-validates server-side and writes `vectant.programs.json` via the scaffold path (extended with `overwrite`). Feature B injects a manifest reference into `prompts.py`.

**Test commands:** JS — `cd synthi; $env:TEMP='D:\synthi-tmp';$env:TMP='D:\synthi-tmp';$env:TMPDIR='D:\synthi-tmp'; npx vitest run <filter> --pool=forks --no-file-parallelism --maxWorkers=1`. Collab-server — `node --test --test-timeout=20000 "C:/Users/HP/source/repos/synthi-ide/backend/collab-server/__tests__/<file>.test.js"`. Python — `cd ai-backend/ai-engine; python test/<file>.py`.

---

## PHASE A — Generate button

### Task A1: ai-engine manifest generator + endpoint

**Files:** Create `ai-backend/ai-engine/program_manifest_gen.py`, `ai-backend/ai-engine/test/test_program_manifest_gen.py`; Modify `ai-backend/ai-engine/main.py`.

- [ ] **Step 1: Write the failing test** (unittest, stdlib-runnable + pytest-compatible)

```python
import asyncio, json, os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from program_manifest_gen import generate_manifest


class FakeProvider:
    def __init__(self, reply=None, exc=None):
        self._reply, self._exc, self.calls = reply, exc, []
    async def ask_llm(self, code="", lang="", prompt=None, mode=None, **kw):
        self.calls.append({"prompt": prompt, "mode": mode})
        if self._exc:
            raise self._exc
        return self._reply


PAYLOAD = {"files": {"package.json": '{"scripts":{"dev":"next dev"}}'}, "workspace_name": "team"}
MANIFEST = {"packageId": "team-app", "version": "1.0.0", "runtimeType": "web", "launch": "npm run dev", "ports": [3000], "permissions": ["program.launch"]}


class GenerateManifestTest(unittest.TestCase):
    def test_returns_parsed_manifest(self):
        prov = FakeProvider(reply=json.dumps(MANIFEST))
        out = asyncio.run(generate_manifest(PAYLOAD, provider=prov))
        self.assertEqual(out["manifest"]["packageId"], "team-app")
        self.assertEqual(prov.calls[0]["mode"], "rule_translate")

    def test_extracts_json_from_fence(self):
        prov = FakeProvider(reply="```json\n" + json.dumps(MANIFEST) + "\n```")
        out = asyncio.run(generate_manifest(PAYLOAD, provider=prov))
        self.assertEqual(out["manifest"]["runtimeType"], "web")

    def test_failclosed_on_unparseable(self):
        out = asyncio.run(generate_manifest(PAYLOAD, provider=FakeProvider(reply="sorry, no idea")))
        self.assertIn("error", out)
        self.assertNotIn("manifest", out)

    def test_failclosed_on_exception(self):
        out = asyncio.run(generate_manifest(PAYLOAD, provider=FakeProvider(exc=RuntimeError("down"))))
        self.assertIn("error", out)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run → fail** (`python test/test_program_manifest_gen.py`).

- [ ] **Step 3: Implement `program_manifest_gen.py`** (reuse the `program_review.py` extract/lazy-provider shape)

```python
"""Generate a vectant.programs.json manifest from workspace context (Gemini).

Import-light (lazy get_provider) so unit tests with a fake provider need no
Gemini SDK. Fail-closed: any provider/parse failure returns {"error": ...} rather
than a partial/garbage manifest. The Next.js caller re-validates the result with
parseProgramManifest before ever offering or saving it.
"""

from __future__ import annotations
import json, re
from typing import Any, Mapping, Optional

_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)
_OBJ_RE = re.compile(r"\{.*\}", re.DOTALL)

_PROMPT = """You author Vectant program manifests. Given a workspace's key files, emit ONE \
JSON object for `vectant.programs.json` describing how to run this project as a program.

Schema: {{"packageId": kebab-case id, "version": "x.y.z", "displayName": str, \
"description": str, "runtimeType": one of web|cli|tui|background|gui|container, \
"install": [shell commands], "launch": "shell command", "ports": [ints], \
"permissions": subset of ["program.launch","workspace.files.read","workspace.files.write","network.outbound","ports.expose"]}}.
Rules: infer runtimeType + ports from the files (a web dev server → "web" + its port; a CLI → "cli"). \
NEVER use --privileged, --cap-add, --security-opt, --device, or mount docker.sock / host paths. \
Return ONLY the JSON object, no prose.

Workspace: {name}
Files:
{files}
"""


def _build_prompt(payload: Mapping[str, Any]) -> str:
    files = payload.get("files") or {}
    blob = "\n\n".join(f"=== {n} ===\n{str(c)[:4000]}" for n, c in list(files.items())[:12])
    return _PROMPT.format(name=str(payload.get("workspace_name") or "workspace"), files=blob[:16000])


def _extract_json(text: str) -> Optional[dict]:
    if not isinstance(text, str):
        return None
    for rx in (_FENCE_RE, _OBJ_RE):
        m = rx.search(text)
        if m:
            try:
                obj = json.loads(m.group(1) if rx is _FENCE_RE else m.group(0))
                if isinstance(obj, dict):
                    return obj
            except (ValueError, TypeError):
                continue
    return None


async def generate_manifest(payload: Mapping[str, Any], provider: Optional[Any] = None) -> dict:
    if provider is None:
        from llm.providers import get_provider
        provider = get_provider()
    try:
        reply = await provider.ask_llm(code="", lang="json", prompt=_build_prompt(payload), mode="rule_translate")
    except Exception:  # noqa: BLE001
        return {"error": "generation_unavailable"}
    obj = _extract_json(reply)
    if obj is None:
        return {"error": "unparseable_manifest"}
    return {"manifest": obj}
```

- [ ] **Step 4: Add the endpoint to `main.py`** (near `/programs/risk-review`)

```python
from program_manifest_gen import generate_manifest

class ProgramManifestGenRequest(BaseModel):
    files: dict
    workspace_name: Optional[str] = None

@app.post("/programs/generate-manifest")
async def programs_generate_manifest(req: ProgramManifestGenRequest):
    return await generate_manifest({"files": req.files, "workspace_name": req.workspace_name})
```

- [ ] **Step 5: Run → pass** (`python test/test_program_manifest_gen.py`) + `python -m py_compile program_manifest_gen.py main.py`.
- [ ] **Step 6: Commit** `feat(ai-engine): vectant.programs.json manifest generator + endpoint`

---

### Task A2: collab-server `/context` read + scaffold `overwrite`

**Files:** Create `backend/collab-server/contextFiles.js`, `backend/collab-server/__tests__/contextFiles.test.js`; Modify `backend/collab-server/scaffold.js`, `backend/collab-server/server.js`, and `scaffold`'s test.

- [ ] **Step 1: Write the failing tests** (`__tests__/contextFiles.test.js`, node:test)

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readContextFiles } = require('../contextFiles');
const { applyScaffoldFiles } = require('../scaffold');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-')); }

test('readContextFiles returns only the present allow-listed files', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'package.json'), '{"name":"x"}');
  fs.writeFileSync(path.join(d, 'README.md'), '# hi');
  fs.writeFileSync(path.join(d, 'secret.txt'), 'nope');
  const files = readContextFiles(d);
  assert.equal(files['package.json'], '{"name":"x"}');
  assert.equal(files['README.md'], '# hi');
  assert.ok(!('secret.txt' in files));
});

test('applyScaffoldFiles overwrite:true replaces an existing file', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'vectant.programs.json'), 'OLD');
  const skip = applyScaffoldFiles(d, [{ path: 'vectant.programs.json', contents: 'NEW' }]);
  assert.deepEqual(skip.skipped, ['vectant.programs.json']); // default: only-missing
  const over = applyScaffoldFiles(d, [{ path: 'vectant.programs.json', contents: 'NEW' }], { overwrite: true });
  assert.deepEqual(over.written, ['vectant.programs.json']);
  assert.equal(fs.readFileSync(path.join(d, 'vectant.programs.json'), 'utf8'), 'NEW');
});

test('overwrite still rejects path traversal', () => {
  assert.throws(() => applyScaffoldFiles(tmp(), [{ path: '../evil', contents: 'x' }], { overwrite: true }), /path_escape/);
});
```

- [ ] **Step 2: Run → fail** (`node --test --test-timeout=20000 "C:/Users/HP/source/repos/synthi-ide/backend/collab-server/__tests__/contextFiles.test.js"`).

- [ ] **Step 3: Create `contextFiles.js`**

```js
const fs = require('fs');
const path = require('path');

// Curated files that help the model infer how to run a project. Read-only; never
// returns anything outside this allow-list.
const CONTEXT_FILES = [
  'package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml',
  'Dockerfile', 'docker-compose.yml', 'compose.yaml', 'compose.yml',
  '.devcontainer/devcontainer.json', 'devcontainer.json',
  'README.md', 'README',
];

/** Read the present allow-listed context files under cwd → { name: contents }. */
function readContextFiles(cwd) {
  const root = path.resolve(cwd);
  const out = {};
  for (const name of CONTEXT_FILES) {
    const file = path.join(root, name);
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        out[name] = fs.readFileSync(file, 'utf8').slice(0, 20000);
      }
    } catch { /* skip unreadable */ }
  }
  return out;
}

module.exports = { readContextFiles, CONTEXT_FILES };
```

- [ ] **Step 4: Add `overwrite` to `applyScaffoldFiles`** — change the signature + the exists-check:

```js
function applyScaffoldFiles(cwd, files, { overwrite = false } = {}) {
  // ...unchanged path guards...
    if (!overwrite && fs.existsSync(target)) {
      skipped.push(rel);
      continue;
    }
  // ...unchanged write...
}
```

- [ ] **Step 5: Add the `/context` route + thread `overwrite` in the scaffold route** (`server.js`)

After the `/detect` route, add:

```js
  // GET /program-runtime/:slug/context → { files:{name:contents} } for AI manifest generation
  const contextMatch = /^\/program-runtime\/([^/]+)\/context$/.exec(programRuntimeUrl.pathname);
  if (contextMatch && req.method === 'GET') {
    const slug = decodeURIComponent(contextMatch[1]);
    const ctxUserId = programRuntimeUrl.searchParams.get('userId') || undefined;
    try {
      const { resolveWorkspaceCwd } = require('./terminalService');
      const { readContextFiles } = require('./contextFiles');
      const cwd = await resolveWorkspaceCwd(slug, ctxUserId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ files: readContextFiles(cwd) }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'context failed' }));
    }
    return;
  }
```

In the scaffold route, forward overwrite: `applyScaffoldFiles(cwd, parsed.files || [], { overwrite: parsed.overwrite === true })`.

- [ ] **Step 6: Run → pass** (contextFiles test; re-run any scaffold test).
- [ ] **Step 7: Commit** `feat(collab-server): workspace /context read + scaffold overwrite flag`

---

### Task A3: Next.js — client, generate route, save route

**Files:** Modify `synthi/src/lib/programs/runtimeClient.js`; Create `synthi/src/lib/programs/manifestGenerator.js`, `.../__tests__/manifestGenerator.test.js`; Create `synthi/src/app/api/workspace/[slug]/programs/generate-manifest/route.js`, `.../manifest/route.js`; Test extend `.../programs/__tests__/programRoutes.test.js`.

- [ ] **Step 1: `manifestGenerator.js` + its test** (mirror `aiReviewer`)

Test:
```js
import { describe, expect, it, vi } from 'vitest';
import { generateManifestFromContext } from '../manifestGenerator';

describe('generateManifestFromContext', () => {
  it('returns the manifest from the client', async () => {
    const client = vi.fn().mockResolvedValue({ manifest: { packageId: 'x', version: '1.0.0' } });
    const out = await generateManifestFromContext({ files: { 'package.json': '{}' }, workspaceName: 'team' }, { client });
    expect(out).toEqual({ packageId: 'x', version: '1.0.0' });
    expect(client).toHaveBeenCalledWith({ files: { 'package.json': '{}' }, workspace_name: 'team' });
  });
  it('returns null when the engine errors or returns no manifest', async () => {
    expect(await generateManifestFromContext({ files: {}, workspaceName: 't' }, { client: vi.fn().mockResolvedValue({ error: 'x' }) })).toBeNull();
    expect(await generateManifestFromContext({ files: {}, workspaceName: 't' }, { client: vi.fn().mockRejectedValue(new Error('down')) })).toBeNull();
  });
});
```

Module:
```js
import { withInternalAiAuth } from '@/lib/internalAiAuth';

const AI_ENGINE_BASE = (process.env.CODE_INTEL_URL || process.env.AI_ENGINE_URL || 'http://localhost:8000').replace(/\/$/, '');

async function defaultClient(payload) {
  const res = await fetch(`${AI_ENGINE_BASE}/programs/generate-manifest`, {
    method: 'POST',
    headers: withInternalAiAuth({ 'content-type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`generate-manifest ${res.status}`);
  return res.json();
}

/** Ask the ai-engine to draft a manifest from workspace files. null on any failure. */
export async function generateManifestFromContext({ files, workspaceName }, { client = defaultClient } = {}) {
  try {
    const raw = await client({ files: files || {}, workspace_name: workspaceName });
    return raw && raw.manifest && typeof raw.manifest === 'object' ? raw.manifest : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: `runtimeClient.js`** — add `fetchWorkspaceContext` + thread `overwrite` in `scaffoldProgram`:

```js
export async function fetchWorkspaceContext(workspaceSlug, userId = '') {
  const query = userId ? `?userId=${encodeURIComponent(userId)}` : '';
  const data = await requestJson(`/program-runtime/${encodeURIComponent(workspaceSlug)}/context${query}`);
  return (data && data.files) || {};
}
```
and in `scaffoldProgram({ workspaceSlug, userId = '', files = [], overwrite = false })` add `overwrite` to the JSON body.

- [ ] **Step 3: Routes + failing route tests** (extend `programRoutes.test.js`)

Add to hoisted `h`: `generateManifestFromContext: vi.fn()`, `fetchWorkspaceContext: vi.fn()`, `scaffoldProgram` (already), `parseOk` helper. Mock `@/lib/programs/manifestGenerator` → `{ generateManifestFromContext: h.generateManifestFromContext }`, extend the `runtimeClient` mock with `fetchWorkspaceContext: h.fetchWorkspaceContext`. Import `POST as POST_GEN from '../generate-manifest/route.js'`, `POST as POST_SAVE from '../manifest/route.js'`.

```js
describe('POST /programs/generate-manifest', () => {
  it('generates + validates a manifest (owner/admin)', async () => {
    h.fetchWorkspaceContext.mockResolvedValue({ 'package.json': '{}' });
    h.generateManifestFromContext.mockResolvedValue({ packageId: 'web', version: '1.0.0', runtimeType: 'web', launch: 'npm run dev', ports: [3000], permissions: ['program.launch'] });
    const res = await POST_GEN(req('http://x/api/workspace/team/programs/generate-manifest', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.manifest.packageId).toBe('web');
  });
  it('returns valid:false + errors for an invalid generated manifest', async () => {
    h.fetchWorkspaceContext.mockResolvedValue({});
    h.generateManifestFromContext.mockResolvedValue({ packageId: '../evil', version: '1.0.0', launch: 'x' });
    const res = await POST_GEN(req('http://x/api/workspace/team/programs/generate-manifest', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(200);
    expect((await res.json()).valid).toBe(false);
  });
  it('502 when the engine returns nothing', async () => {
    h.fetchWorkspaceContext.mockResolvedValue({});
    h.generateManifestFromContext.mockResolvedValue(null);
    const res = await POST_GEN(req('http://x/api/workspace/team/programs/generate-manifest', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(502);
  });
  it('rejects a plain member (403)', async () => {
    h.canWrite.mockResolvedValue(false);
    const res = await POST_GEN(req('http://x/api/workspace/team/programs/generate-manifest', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
  });
});

describe('POST /programs/manifest (save)', () => {
  const good = { packageId: 'web', version: '1.0.0', runtimeType: 'web', launch: 'npm run dev', ports: [3000], permissions: ['program.launch'] };
  it('re-validates + writes vectant.programs.json (overwrite)', async () => {
    h.scaffoldProgram.mockResolvedValue({ written: ['vectant.programs.json'], skipped: [] });
    const res = await POST_SAVE(req('http://x/api/workspace/team/programs/manifest', { manifest: good }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(200);
    const passed = h.scaffoldProgram.mock.calls[0][0];
    expect(passed.overwrite).toBe(true);
    expect(passed.files[0].path).toBe('vectant.programs.json');
  });
  it('422 (never writes) for an invalid manifest', async () => {
    const res = await POST_SAVE(req('http://x/api/workspace/team/programs/manifest', { manifest: { packageId: '../evil', version: '1.0.0', launch: 'x' } }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(422);
    expect(h.scaffoldProgram).not.toHaveBeenCalled();
  });
  it('rejects a plain member (403)', async () => {
    h.canWrite.mockResolvedValue(false);
    const res = await POST_SAVE(req('http://x/api/workspace/team/programs/manifest', { manifest: good }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
  });
});
```

`generate-manifest/route.js`:
```js
import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import { fetchWorkspaceContext } from '@/lib/programs/runtimeClient';
import { generateManifestFromContext } from '@/lib/programs/manifestGenerator';
import { parseProgramManifest, ProgramManifestError } from '@/lib/programs/manifest';

export const runtime = 'nodejs';

export async function POST(_req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const files = await fetchWorkspaceContext(slug, actor.workspaceUserId).catch(() => ({}));
  const manifest = await generateManifestFromContext({ files, workspaceName: slug });
  if (!manifest) return NextResponse.json({ error: 'generation_failed' }, { status: 502 });
  try {
    const parsed = parseProgramManifest(manifest);
    return NextResponse.json({ manifest: parsed, valid: true });
  } catch (err) {
    if (err instanceof ProgramManifestError) {
      return NextResponse.json({ manifest, valid: false, errors: [{ code: err.code, field: err.field, message: err.message }] });
    }
    return NextResponse.json({ manifest, valid: false, errors: [{ code: 'invalid_manifest', message: String(err?.message || err) }] });
  }
}
```

`manifest/route.js` (save):
```js
import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import { scaffoldProgram } from '@/lib/programs/runtimeClient';
import { parseProgramManifest, ProgramManifestError } from '@/lib/programs/manifest';

export const runtime = 'nodejs';

// POST /api/workspace/:slug/programs/manifest  { manifest }
// Owner/admin: re-validate then write vectant.programs.json (overwrite). Fail-closed.
export async function POST(req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  let body = {};
  try { body = (await req.json()) || {}; } catch { body = {}; }
  let normalized;
  try {
    normalized = parseProgramManifest(body.manifest);
  } catch (err) {
    if (err instanceof ProgramManifestError) {
      return NextResponse.json({ error: 'manifest_invalid', code: err.code, field: err.field, message: err.message }, { status: 422 });
    }
    return NextResponse.json({ error: 'manifest_invalid', message: String(err?.message || err) }, { status: 422 });
  }
  try {
    const result = await scaffoldProgram({
      workspaceSlug: slug,
      userId: actor.workspaceUserId,
      files: [{ path: 'vectant.programs.json', contents: JSON.stringify(normalized, null, 2) }],
      overwrite: true,
    });
    return NextResponse.json({ written: result?.written || [] });
  } catch (error) {
    return NextResponse.json({ error: 'save_failed', message: error?.message || 'save failed' }, { status: 502 });
  }
}
```

- [ ] **Step 4: Run → pass** (`npx vitest run manifestGenerator programRoutes`).
- [ ] **Step 5: Commit** `feat(programs): generate-manifest + save-manifest routes (validated, owner-only)`

---

### Task A4: Frontend — dialog + button + client + panel wiring

**Files:** Create `synthi/src/components/programs/GenerateManifestDialog.jsx`, `.../__tests__/generateManifestDialog.test.jsx`; Modify `programsClient.js`, `store/StoreView.jsx`, `ProgramsPanel.jsx`, both panel test mocks.

- [ ] **Step 1: `GenerateManifestDialog` test** (jsdom, react-dom convention) — asserts it renders the prettified manifest in an editable textarea, Save calls `onSave` with the edited text parsed, Cancel calls `onCancel`, and an invalid-JSON edit disables Save / shows an error. (Full test mirrors `firstPublishTutorial.test.jsx` structure.)

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `GenerateManifestDialog.jsx`** — a modal (like `FirstPublishTutorial`): a `<textarea data-testid="manifest-editor">` seeded with `JSON.stringify(manifest, null, 2)`; local state tracks the text + a parse error; `Save` (`data-testid="manifest-save"`) parses the text and calls `onSave(parsed)` (disabled when unparseable); `Cancel` calls `onCancel`. Shows `errors` from the generate response as a hint.

- [ ] **Step 4: `programsClient.js`** — add:
```js
export async function generateManifest(workspaceSlug) {
  return request(`${programsBase(workspaceSlug)}/generate-manifest`, { method: 'POST', body: JSON.stringify({}) });
}
export async function saveWorkspaceManifest(workspaceSlug, manifest) {
  return request(`${programsBase(workspaceSlug)}/manifest`, { method: 'POST', body: JSON.stringify({ manifest }) });
}
```

- [ ] **Step 5: `StoreView.jsx`** — add a `Generate manifest` button (`data-testid="generate-manifest"`, owner/admin block, calls `onGenerate`) beside "Install from manifest"; add `onGenerate` to the prop list.

- [ ] **Step 6: `ProgramsPanel.jsx`** — import `GenerateManifestDialog`, `generateManifest`, `saveWorkspaceManifest`; add `genManifest` state (`{ manifest, errors } | null`); `handleGenerate` (toast "Generating…", call `generateManifest`, set `genManifest`, on failure toast); pass `onGenerate={handleGenerate}` to `StoreView`; render `<GenerateManifestDialog open={!!genManifest} manifest={genManifest?.manifest} errors={genManifest?.errors} onCancel={() => setGenManifest(null)} onSave={handleSaveManifest} />`; `handleSaveManifest(manifest)` calls `saveWorkspaceManifest`, toasts, closes.

- [ ] **Step 7:** Add `generateManifest` + `saveWorkspaceManifest` to BOTH panel test client mocks (so the imports resolve). Run → pass (`npx vitest run programsPanel storeView generateManifestDialog`).
- [ ] **Step 8: Commit** `feat(programs): Generate-manifest button + preview/save dialog`

---

## PHASE B — ai-engine manifest awareness

### Task B1: manifest reference in `prompts.py`

**Files:** Modify `ai-backend/ai-engine/prompts.py`; Test `ai-backend/ai-engine/test/test_manifest_reference.py`.

- [ ] **Step 1: Test** — assert the base prompt builder output contains the manifest reference (the `vectant.programs.json` marker + `runtimeType` + a scope name). Use the same stdlib-unittest + sys.path pattern; call the base prompt builder (`build_prompt` or the system-instructions constant) and assert the substring.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — add a concise `VECTANT_MANIFEST_REFERENCE` constant (schema + one worked example, ~15 lines) to `prompts.py` and append it to the base system instructions so every engine call carries it. Keep it short (token cost).

- [ ] **Step 4: Run → pass** + `python -m py_compile prompts.py`.
- [ ] **Step 5: Commit** `feat(ai-engine): teach the AI about vectant.programs.json (prompt reference)`

---

## Verification
- [ ] `npx vitest run programs manifestGenerator generateManifestDialog processPendingRoute --pool=forks --no-file-parallelism --maxWorkers=1` → green.
- [ ] `node --test --test-timeout=20000 "C:/Users/HP/source/repos/synthi-ide/backend/collab-server/__tests__/contextFiles.test.js"` → green.
- [ ] `python test/test_program_manifest_gen.py` + `python test/test_manifest_reference.py` → OK; `python -m py_compile program_manifest_gen.py main.py prompts.py`.
- [ ] `node --check` the 2 new Next.js routes.
- [ ] Invariant map: save re-validates fail-closed (programRoutes 422 test), generate returns-even-if-invalid (valid:false test), owner-only (403 tests), overwrite explicit (scaffold overwrite test), gen fail-closed (Python + manifestGenerator null tests).

## Self-review
- **Spec coverage:** generator+endpoint (A1), context read + overwrite (A2), generate/save routes + client (A3), dialog+button (A4), prompt awareness (B1). All spec components mapped.
- **Type consistency:** `generate_manifest(payload,provider)→{manifest}|{error}`; `generateManifestFromContext({files,workspaceName},{client})→manifest|null`; `fetchWorkspaceContext(slug,userId)→{name:content}`; `scaffoldProgram({...,overwrite})`; routes return `{manifest,valid,errors?}` / `{written}`.
- **Out of scope:** external synthi-mcp tool, app scaffolding, streaming/refine chat.
- **Follow-up:** the synthi-mcp tool exposing the schema over MCP (separate repo).
