# Community-App Hosting — Phase 2 (AI Auto-Approve / Triage) Implementation Plan

> **For agentic workers:** TDD task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add an advisory AI risk-review layer that can auto-approve low-risk community submissions (and route everything else to the existing manual queue), without ever becoming a load-bearing security control.

**Architecture:** After the Phase-1 hard gates + CVE scan pass, a new `scanning → ai_review` step (behind `PROGRAM_AI_REVIEW_ENABLED`, default OFF) calls a new Python ai-engine endpoint `POST /programs/risk-review` (Gemini via the existing `get_provider()`), which returns `{risk_score, flags[], rationale}`. The JS `aiReviewer` is **fail-closed**: any error/timeout/malformed response → high risk → manual queue. A conservative decision rule auto-approves only when `risk_score ≤ threshold` AND there are no sensitive scopes AND zero flags; auto-approval reuses the exact same digest re-host + manifest-pin + publish path as a human approval (actor = `system`).

**Tech Stack:** Next.js (vitest) for `aiReviewer` + orchestrator wiring; Python 3.11 FastAPI ai-engine (`get_provider().ask_llm`, pytest in `ai-backend/ai-engine/test/`).

**Decisions (locked with user):** full cross-service (build the Python endpoint now); conservative auto-approve (flag OFF by default; sensitive scopes = `network.outbound`, `workspace.files.write`, `ports.expose`).

---

## Safety invariants (each test-pinned)

- AI is **never load-bearing**: hard gates + CVE scan still run first and unchanged; AI only decides *auto-approve vs. manual* among already-clean submissions.
- `aiReviewer` **fails closed**: endpoint down / non-200 / malformed JSON / timeout → treated as high risk → `pending_review` (never auto-approved).
- Auto-approve is **conservative**: requires `risk_score ≤ threshold` AND no sensitive scope AND no flags. Anything else → manual.
- Flag **OFF by default** (`PROGRAM_AI_REVIEW_ENABLED`): behaves exactly like Phase 1 until explicitly enabled.
- Auto-approval uses the **same** re-host-by-digest + pin + publish path as human approval (no separate, weaker path).
- Stored `aiRiskJson` is **redacted** in public/member responses (allow-list: `riskScore` + `flags`, never raw provider text in member views).

---

## File structure

**New (Python, ai-engine):**
- `ai-backend/ai-engine/program_review.py` — `async def assess_program_risk(payload, provider=None) -> dict`. Builds the prompt, calls `provider.ask_llm(...)`, parses + normalizes JSON, fail-closed.
- `ai-backend/ai-engine/test/test_program_review.py` — pytest, fake provider (no real Gemini).

**Modified (Python):**
- `ai-backend/ai-engine/main.py` — add `POST /programs/risk-review` (pydantic request → `assess_program_risk(get_provider())`).

**New (JS):**
- `synthi/src/lib/programs/aiReviewer.js` — `assessSubmission(...)` (HTTP client, fail-closed) + `aiDecision(...)` (conservative rule) + `SENSITIVE_SCOPES`.
- `synthi/src/lib/programs/__tests__/aiReviewer.test.js`.

**Modified (JS):**
- `synthi/src/lib/programs/reviewOrchestrator.js` — wire `ai_review` step + auto-approve; extract shared `rehostAndPublish` helper.
- `synthi/src/lib/programs/__tests__/reviewOrchestrator.test.js` — add Phase-2 cases.
- `synthi/src/lib/programs/store.js` — `toReviewQueueItem` adds redacted `aiSummary`.
- `synthi/src/lib/programs/__tests__/store.test.js` — assert `aiSummary` + no raw leak.
- `synthi/.env.example` — document `PROGRAM_AI_REVIEW_ENABLED` (+ note it calls the ai-engine).

**Test commands:**
- JS: `cd synthi; $env:TEMP='D:\synthi-tmp';$env:TMP='D:\synthi-tmp';$env:TMPDIR='D:\synthi-tmp'; npx vitest run <filter> --pool=forks --no-file-parallelism --maxWorkers=1`
- Python: `cd ai-backend/ai-engine; python -m pytest test/test_program_review.py -q` (and `python -m py_compile program_review.py main.py`).

---

## Task P2-1: Python `assess_program_risk` (fail-closed risk assessor)

**Files:**
- Create: `ai-backend/ai-engine/program_review.py`
- Test: `ai-backend/ai-engine/test/test_program_review.py`

- [ ] **Step 1: Write the failing test**

```python
import asyncio
import json
import pytest
from program_review import assess_program_risk


class FakeProvider:
    def __init__(self, reply=None, exc=None):
        self._reply = reply
        self._exc = exc
        self.calls = []

    async def ask_llm(self, code="", lang="", prompt=None, mode=None, **kwargs):
        self.calls.append({"prompt": prompt, "mode": mode})
        if self._exc:
            raise self._exc
        return self._reply


PAYLOAD = {
    "manifest": {"packageId": "tool", "runtimeType": "container", "permissions": ["program.launch"], "launch": "docker run reg.io/me/tool:1"},
    "scan_summary": {"decisiveCves": [], "severityCounts": {"HIGH": 0}},
    "source_image_ref": "reg.io/me/tool:1",
    "description": "a db client",
}


def test_parses_clean_low_risk_json():
    prov = FakeProvider(reply=json.dumps({"risk_score": 0.1, "flags": [], "rationale": "looks fine"}))
    out = asyncio.run(assess_program_risk(PAYLOAD, provider=prov))
    assert out["risk_score"] == 0.1
    assert out["flags"] == []
    assert "rationale" in out
    # prompt was sent verbatim (rule_translate mode → structured JSON)
    assert prov.calls[0]["mode"] == "rule_translate"


def test_extracts_json_from_fenced_block():
    prov = FakeProvider(reply='```json\n{"risk_score": 0.4, "flags": ["network"], "rationale": "calls out"}\n```')
    out = asyncio.run(assess_program_risk(PAYLOAD, provider=prov))
    assert out["risk_score"] == 0.4
    assert out["flags"] == ["network"]


def test_failclosed_on_unparseable_reply():
    prov = FakeProvider(reply="not json at all")
    out = asyncio.run(assess_program_risk(PAYLOAD, provider=prov))
    assert out["risk_score"] == 1.0
    assert "ai_unavailable" in out["flags"]


def test_failclosed_on_provider_exception():
    prov = FakeProvider(exc=RuntimeError("gemini down"))
    out = asyncio.run(assess_program_risk(PAYLOAD, provider=prov))
    assert out["risk_score"] == 1.0
    assert "ai_unavailable" in out["flags"]


def test_clamps_and_coerces_out_of_range_score():
    prov = FakeProvider(reply=json.dumps({"risk_score": 5, "flags": "oops", "rationale": 123}))
    out = asyncio.run(assess_program_risk(PAYLOAD, provider=prov))
    assert out["risk_score"] == 1.0          # clamped to [0,1]
    assert isinstance(out["flags"], list)    # coerced
    assert isinstance(out["rationale"], str)
```

- [ ] **Step 2: Run → fail** (`ModuleNotFoundError: program_review`)

Run: `cd ai-backend/ai-engine; python -m pytest test/test_program_review.py -q`

- [ ] **Step 3: Implement**

```python
"""Community-app submission risk review (Phase 2, advisory).

Calls the configured LLM provider (Gemini via get_provider) to score a
submission that has ALREADY passed the Phase-1 hard gates + CVE scan. This is
advisory only — never a load-bearing security control. Fail-closed: any
provider/parse failure returns max risk so the orchestrator routes to manual
review rather than auto-approving on a degraded signal.
"""

from __future__ import annotations

import json
import re
from typing import Any, Mapping, Optional

from llm.providers import get_provider

_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)
_OBJ_RE = re.compile(r"\{.*\}", re.DOTALL)

_FAIL_CLOSED = {"risk_score": 1.0, "flags": ["ai_unavailable"], "rationale": "AI review unavailable; routed to manual review."}

_PROMPT = """You are a security reviewer for a marketplace of community apps that run \
inside an isolated per-user sandbox. The app below already passed automated hard gates \
(manifest schema, scope allow-list, host-escape rejection) and a CVE scan. Assess the \
RESIDUAL risk of auto-publishing it without a human reviewer.

Return ONLY a JSON object: {{"risk_score": <float 0..1>, "flags": [<short strings>], "rationale": "<one sentence>"}}.
risk_score 0 = clearly safe, 1 = clearly dangerous. Add a flag for anything suspicious \
(obfuscation, data exfiltration hints, crypto-mining, deceptive metadata, over-broad behavior).

Manifest:
{manifest}

CVE scan summary:
{scan_summary}

Publisher description:
{description}
"""


def _build_prompt(payload: Mapping[str, Any]) -> str:
    return _PROMPT.format(
        manifest=json.dumps(payload.get("manifest") or {}, ensure_ascii=False)[:8000],
        scan_summary=json.dumps(payload.get("scan_summary") or {}, ensure_ascii=False)[:2000],
        description=str(payload.get("description") or "")[:2000],
    )


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


def _normalize(obj: dict) -> dict:
    try:
        score = float(obj.get("risk_score"))
    except (TypeError, ValueError):
        score = 1.0
    score = max(0.0, min(1.0, score))
    flags = obj.get("flags")
    flags = [str(f) for f in flags] if isinstance(flags, list) else []
    rationale = obj.get("rationale")
    rationale = rationale if isinstance(rationale, str) else str(rationale or "")
    return {"risk_score": score, "flags": flags, "rationale": rationale[:1000]}


async def assess_program_risk(payload: Mapping[str, Any], provider: Optional[Any] = None) -> dict:
    """Score a submission. Fail-closed (max risk) on any provider/parse failure."""
    prov = provider or get_provider()
    try:
        reply = await prov.ask_llm(code="", lang="json", prompt=_build_prompt(payload), mode="rule_translate")
    except Exception:  # noqa: BLE001 — advisory layer must never raise into the gate
        return dict(_FAIL_CLOSED)
    obj = _extract_json(reply)
    if obj is None:
        return dict(_FAIL_CLOSED)
    return _normalize(obj)
```

- [ ] **Step 4: Run → pass** (5 tests). Also `python -m py_compile program_review.py`.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/HP/source/repos/synthi-ide" add ai-backend/ai-engine/program_review.py ai-backend/ai-engine/test/test_program_review.py
git -C "C:/Users/HP/source/repos/synthi-ide" commit -m "feat(ai-engine): community-app risk assessor (fail-closed, advisory)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task P2-2: Python `POST /programs/risk-review` endpoint

**Files:**
- Modify: `ai-backend/ai-engine/main.py`

- [ ] **Step 1: Add the test** (append to `test/test_program_review.py`)

```python
def test_endpoint_module_exposes_route_handler():
    # The route is a thin wrapper; we test the handler function directly to avoid
    # importing the full FastAPI app (heavy deps). main.programs_risk_review must
    # delegate to assess_program_risk and return its dict.
    import main
    assert hasattr(main, "programs_risk_review")
```

- [ ] **Step 2: Run → fail** (`AttributeError: programs_risk_review`)

- [ ] **Step 3: Implement** — add to `main.py` (near other route defs; mirror existing `@app.post` + pydantic style):

```python
from program_review import assess_program_risk

class ProgramRiskRequest(BaseModel):
    manifest: dict
    scan_summary: Optional[dict] = None
    source_image_ref: Optional[str] = None
    description: Optional[str] = None

@app.post("/programs/risk-review")
async def programs_risk_review(req: ProgramRiskRequest):
    return await assess_program_risk({
        "manifest": req.manifest,
        "scan_summary": req.scan_summary,
        "source_image_ref": req.source_image_ref,
        "description": req.description,
    })
```

(`BaseModel`/`Optional` are already imported in main.py — verify; if not, add `from pydantic import BaseModel` / `from typing import Optional`.)

- [ ] **Step 4: Run → pass**; `python -m py_compile main.py`.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/HP/source/repos/synthi-ide" add ai-backend/ai-engine/main.py ai-backend/ai-engine/test/test_program_review.py
git -C "C:/Users/HP/source/repos/synthi-ide" commit -m "feat(ai-engine): POST /programs/risk-review endpoint

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task P2-3: JS `aiReviewer` (client + conservative decision)

**Files:**
- Create: `synthi/src/lib/programs/aiReviewer.js`
- Test: `synthi/src/lib/programs/__tests__/aiReviewer.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, expect, it, vi } from 'vitest';
import { assessSubmission, aiDecision, SENSITIVE_SCOPES } from '../aiReviewer';

const cfg = (over = {}) => ({ runtimeType: 'container', permissions: ['program.launch'], launch: 'docker run x', ...over });

describe('assessSubmission', () => {
  it('returns the parsed risk assessment from the client', async () => {
    const client = vi.fn().mockResolvedValue({ risk_score: 0.1, flags: [], rationale: 'fine' });
    const out = await assessSubmission({ config: cfg(), scanSummary: { decisiveCves: [] }, description: 'd' }, { client });
    expect(out).toEqual({ riskScore: 0.1, flags: [], rationale: 'fine' });
    expect(client).toHaveBeenCalledTimes(1);
  });

  it('fails closed (max risk) when the client throws', async () => {
    const client = vi.fn().mockRejectedValue(new Error('engine down'));
    const out = await assessSubmission({ config: cfg() }, { client });
    expect(out.riskScore).toBe(1);
    expect(out.flags).toContain('ai_unavailable');
  });

  it('fails closed when the client returns a malformed shape', async () => {
    const client = vi.fn().mockResolvedValue({ nope: true });
    const out = await assessSubmission({ config: cfg() }, { client });
    expect(out.riskScore).toBe(1);
    expect(out.flags).toContain('ai_unavailable');
  });
});

describe('aiDecision (conservative)', () => {
  const threshold = 0.3;
  it('auto-approves low risk + safe scopes + no flags', () => {
    expect(aiDecision({ riskScore: 0.1, flags: [] }, cfg({ permissions: ['program.launch'] }), { threshold })).toBe('auto_approve');
  });
  it('routes to manual when a sensitive scope is present', () => {
    expect(SENSITIVE_SCOPES).toContain('network.outbound');
    expect(aiDecision({ riskScore: 0.1, flags: [] }, cfg({ permissions: ['program.launch', 'network.outbound'] }), { threshold })).toBe('manual');
  });
  it('routes to manual when risk exceeds threshold', () => {
    expect(aiDecision({ riskScore: 0.9, flags: [] }, cfg(), { threshold })).toBe('manual');
  });
  it('routes to manual when any flag is present', () => {
    expect(aiDecision({ riskScore: 0.0, flags: ['obfuscation'] }, cfg(), { threshold })).toBe('manual');
  });
});
```

- [ ] **Step 2: Run → fail** (module missing)

- [ ] **Step 3: Implement**

```js
/**
 * @fileoverview Phase-2 advisory AI risk review for community submissions.
 * Server-side: calls the ai-engine directly over HTTP (like the agent/shadow
 * routes) — NOT via the frontend gateway. Fail-closed: any error/malformed
 * reply → max risk so the orchestrator routes to manual review. The AI is never
 * a load-bearing security control; hard gates + CVE scan run first, unchanged.
 */

import { withInternalAiAuth } from '@/lib/internalAiAuth';

const AI_ENGINE_BASE = (process.env.CODE_INTEL_URL || process.env.AI_ENGINE_URL || 'http://localhost:8000').replace(/\/$/, '');
const DEFAULT_THRESHOLD = Number(process.env.PROGRAM_AI_RISK_THRESHOLD) || 0.3;

/** Scopes that always force a human review even on a low AI score (conservative). */
export const SENSITIVE_SCOPES = ['network.outbound', 'workspace.files.write', 'ports.expose'];

const FAIL_CLOSED = { riskScore: 1, flags: ['ai_unavailable'], rationale: 'AI review unavailable; routed to manual review.' };

/** Default client: POST the submission to the ai-engine risk-review endpoint. */
async function defaultClient(payload) {
  const res = await fetch(`${AI_ENGINE_BASE}/programs/risk-review`, {
    method: 'POST',
    headers: withInternalAiAuth({ 'content-type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`risk-review ${res.status}`);
  return res.json();
}

/** Assess a submission. Fail-closed on any error/malformed reply. */
export async function assessSubmission({ config, scanSummary = null, sourceImageRef = null, description = '' }, { client = defaultClient } = {}) {
  try {
    const raw = await client({ manifest: config, scan_summary: scanSummary, source_image_ref: sourceImageRef, description });
    const riskScore = Number(raw?.risk_score);
    if (!Number.isFinite(riskScore)) return { ...FAIL_CLOSED };
    return {
      riskScore: Math.max(0, Math.min(1, riskScore)),
      flags: Array.isArray(raw.flags) ? raw.flags.map(String) : [],
      rationale: typeof raw.rationale === 'string' ? raw.rationale : '',
    };
  } catch {
    return { ...FAIL_CLOSED };
  }
}

/** Conservative auto-approve rule: low risk AND no sensitive scope AND no flags. */
export function aiDecision({ riskScore, flags = [] }, config, { threshold = DEFAULT_THRESHOLD } = {}) {
  const perms = Array.isArray(config?.permissions) ? config.permissions : [];
  const hasSensitive = perms.some((p) => SENSITIVE_SCOPES.includes(p));
  if (riskScore <= threshold && flags.length === 0 && !hasSensitive) return 'auto_approve';
  return 'manual';
}
```

- [ ] **Step 4: Run → pass** (7 tests).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/HP/source/repos/synthi-ide" add synthi/src/lib/programs/aiReviewer.js synthi/src/lib/programs/__tests__/aiReviewer.test.js
git -C "C:/Users/HP/source/repos/synthi-ide" commit -m "feat(programs): AI reviewer client + conservative auto-approve decision (fail-closed)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task P2-4: Wire `ai_review` into the orchestrator (flag-gated, shared publish path)

**Files:**
- Modify: `synthi/src/lib/programs/reviewOrchestrator.js`
- Test: `synthi/src/lib/programs/__tests__/reviewOrchestrator.test.js`

- [ ] **Step 1: Add failing tests** (append; extend the `deps` factory in `beforeEach` with the new injectables `aiReview`, `aiDecide`, and `aiEnabled`)

In the existing `beforeEach`, extend `deps`:

```js
    aiReview: vi.fn().mockResolvedValue({ riskScore: 0.1, flags: [], rationale: 'fine' }),
    aiDecide: vi.fn().mockReturnValue('auto_approve'),
    aiEnabled: false,
```

New describe block:

```js
describe('submitForReview — Phase 2 AI layer', () => {
  const base = { workspaceSlug: 'team', config: containerConfig, sourceImageRef: 'reg.io/me/tool:1', submittedByUserId: 'u1' };

  it('flag OFF → pending_review, AI not called (Phase-1 behavior preserved)', async () => {
    deps.aiEnabled = false;
    const res = await submitForReview(base, deps);
    expect(res.reviewState).toBe('pending_review');
    expect(deps.aiReview).not.toHaveBeenCalled();
  });

  it('flag ON + auto_approve → ai_review → published (reuses re-host + publish)', async () => {
    deps.aiEnabled = true;
    deps.aiDecide.mockReturnValue('auto_approve');
    deps.store.getReviewVersionById.mockResolvedValue({
      id: 'ver1', version: '1.0.0', reviewState: 'pending_review', submittedByUserId: 'u1', sourceImageRef: 'reg.io/me/tool:1',
      manifestJson: JSON.stringify(containerConfig), program: { id: 'prog1', publisher: 'team', packageId: '@team/tool' },
    });
    const res = await submitForReview(base, deps);
    expect(res.reviewState).toBe('published');
    expect(deps.store.transitionReview).toHaveBeenCalledWith('ver1', expect.objectContaining({ fromState: 'scanning', toState: 'ai_review' }));
    expect(deps.reHost).toHaveBeenCalled();
    expect(deps.store.publishApprovedVersion).toHaveBeenCalled();
  });

  it('flag ON + manual decision → pending_review (stores aiRiskJson)', async () => {
    deps.aiEnabled = true;
    deps.aiDecide.mockReturnValue('manual');
    const res = await submitForReview(base, deps);
    expect(res.reviewState).toBe('pending_review');
    expect(deps.reHost).not.toHaveBeenCalled();
    const aiTransition = deps.store.transitionReview.mock.calls.find((c) => c[1].toState === 'pending_review');
    expect(aiTransition[1].patch.aiRiskJson).toContain('riskScore');
  });

  it('flag ON + AI fails closed (high risk) → manual', async () => {
    deps.aiEnabled = true;
    deps.aiReview.mockResolvedValue({ riskScore: 1, flags: ['ai_unavailable'], rationale: 'down' });
    deps.aiDecide.mockReturnValue('manual');
    const res = await submitForReview(base, deps);
    expect(res.reviewState).toBe('pending_review');
  });
});
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement** — refactor `reviewOrchestrator.js`:

  1. Add to `defaultDeps()`: `aiReview: assessSubmission`, `aiDecide: aiDecision`, `aiEnabled: process.env.PROGRAM_AI_REVIEW_ENABLED === 'true'` and import `{ assessSubmission, aiDecision } from './aiReviewer'`.
  2. Extract the re-host+pin+publish tail of `approveSubmission` into a shared helper:

```js
async function rehostAndPublish(row, config, actorUserId, deps) {
  const { store, reHost, target, pin } = deps;
  let hostedImageDigest = null;
  let publishedConfig = config;
  if (IMAGE_RUNTIME_TYPES.has(config.runtimeType) && row.sourceImageRef) {
    const dst = target({ publisher: row.program.publisher, packageId: config.packageId });
    const { ref, digest } = await reHost(row.sourceImageRef, dst, {});
    hostedImageDigest = digest;
    publishedConfig = pin(config, row.sourceImageRef, ref);
  }
  await store.publishApprovedVersion(row.id, {
    programId: row.program.id, version: row.version, actorUserId,
    hostedImageDigest, publishedManifestJson: JSON.stringify(publishedConfig),
  });
  return { versionId: row.id, reviewState: 'published', hostedImageDigest };
}
```

  Update `approveSubmission` to: `transition pending_review→approved→rehosting` then `return rehostAndPublish(row, JSON.parse(row.manifestJson), adminUserId, deps)`.

  3. In `submitForReview`, replace the two `scanning → pending_review` transitions with a shared tail that runs the AI step when enabled. After a clean scan (or no-image clean path), call:

```js
  return finishAfterScan(version.id, { workspaceSlug, config, sourceImageRef, scanSummary }, deps);
```

  where:

```js
async function finishAfterScan(versionId, { config, sourceImageRef, scanSummary }, deps) {
  const { store, aiReview, aiDecide, aiEnabled } = deps;
  if (!aiEnabled) {
    await store.transitionReview(versionId, { fromState: 'scanning', toState: 'pending_review', actorUserId: null });
    return { versionId, reviewState: 'pending_review' };
  }
  const ai = await aiReview({ config, scanSummary, sourceImageRef, description: config.description || '' });
  const aiPatch = { aiRiskJson: JSON.stringify(ai) };
  await store.transitionReview(versionId, { fromState: 'scanning', toState: 'ai_review', actorUserId: null, patch: aiPatch });
  if (aiDecide(ai, config) === 'auto_approve') {
    await store.transitionReview(versionId, { fromState: 'ai_review', toState: 'approved', actorUserId: 'system' });
    await store.transitionReview(versionId, { fromState: 'approved', toState: 'rehosting', actorUserId: 'system' });
    const row = await store.getReviewVersionById(versionId);
    return rehostAndPublish(row, JSON.parse(row.manifestJson), 'system', deps);
  }
  await store.transitionReview(versionId, { fromState: 'ai_review', toState: 'pending_review', actorUserId: null, patch: aiPatch });
  return { versionId, reviewState: 'pending_review' };
}
```

  Thread `scanSummary` from the scan result (the container path already computes `scan.summary`; pass it; the no-image path passes `null`).

- [ ] **Step 4: Run → pass** (existing 8 + 4 new). Also re-run `programs/__tests__/store` is unaffected.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/HP/source/repos/synthi-ide" add synthi/src/lib/programs/reviewOrchestrator.js synthi/src/lib/programs/__tests__/reviewOrchestrator.test.js
git -C "C:/Users/HP/source/repos/synthi-ide" commit -m "feat(programs): wire AI review step into orchestrator (flag-gated auto-approve)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task P2-5: Redact `aiRiskJson` in the review-queue projection + env docs

**Files:**
- Modify: `synthi/src/lib/programs/store.js` (`toReviewQueueItem`)
- Test: `synthi/src/lib/programs/__tests__/store.test.js`
- Modify: `synthi/.env.example`

- [ ] **Step 1: Add failing test** (extend the existing `toReviewQueueItem` test)

```js
  it('includes a redacted aiSummary (riskScore + flags) and never raw provider text in member view', () => {
    const item = toReviewQueueItem({
      id: 'ver1', version: '1.0.0', reviewState: 'ai_review', submittedByUserId: 'u1',
      scanReportJson: '{"decisiveCves":[]}',
      aiRiskJson: '{"riskScore":0.1,"flags":["x"],"rationale":"SENSITIVE-MODEL-TEXT"}',
      program: { packageId: '@team/tool', publisher: 'team' },
    });
    expect(item.aiSummary).toMatchObject({ riskScore: 0.1, flags: ['x'] });
    expect(JSON.stringify(item)).not.toContain('SENSITIVE-MODEL-TEXT'); // rationale not exposed
  });
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement** — in `toReviewQueueItem`, add after `scanSummary`:

```js
    aiSummary: (() => {
      const ai = parseJsonText(row.aiRiskJson, null);
      return ai ? { riskScore: ai.riskScore ?? null, flags: Array.isArray(ai.flags) ? ai.flags : [] } : null;
    })(),
```

  And document the flag in `synthi/.env.example` (under the community-app section):

```
# Phase 2: enable the advisory AI auto-approve/triage layer (calls the ai-engine
# POST /programs/risk-review). Default off ⇒ every clean submission goes to the
# manual queue (Phase-1 behavior). Auto-approve is conservative (low risk + no
# sensitive scopes + no flags). PROGRAM_AI_RISK_THRESHOLD tunes the cutoff (default 0.3).
# PROGRAM_AI_REVIEW_ENABLED=false
# PROGRAM_AI_RISK_THRESHOLD=0.3
```

- [ ] **Step 4: Run → pass**

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/HP/source/repos/synthi-ide" add synthi/src/lib/programs/store.js synthi/src/lib/programs/__tests__/store.test.js synthi/.env.example
git -C "C:/Users/HP/source/repos/synthi-ide" commit -m "feat(programs): redacted aiSummary in review queue + document PROGRAM_AI_REVIEW_ENABLED

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task P2-6: Full verification

- [ ] **Step 1: JS suite** — `npx vitest run programs --pool=forks --no-file-parallelism --maxWorkers=1` → all green (incl. aiReviewer + orchestrator Phase-2 + store).
- [ ] **Step 2: Python** — `cd ai-backend/ai-engine; python -m pytest test/test_program_review.py -q` → green; `python -m py_compile program_review.py main.py`.
- [ ] **Step 3: Invariant map** — confirm each Phase-2 safety invariant → its passing test (fail-closed: aiReviewer + orchestrator; conservative: aiDecision; flag-off: orchestrator; shared publish path: orchestrator auto_approve reuses rehostAndPublish; redaction: store).
- [ ] **Step 4: Final commit if any tweaks.**

---

## Self-review

- **Spec coverage:** `aiReviewer` (P2-1/2/3), state-machine `ai_review` + auto-approve/triage (P2-4), calibration knobs (`PROGRAM_AI_REVIEW_ENABLED` off-by-default + `PROGRAM_AI_RISK_THRESHOLD`) (P2-3/5). Manual queue + hard gates + scan unchanged from Phase 1.
- **Type consistency:** `assessSubmission(...) → {riskScore,flags,rationale}`; `aiDecision({riskScore,flags}, config, {threshold}) → 'auto_approve'|'manual'`; Python `assess_program_risk(payload, provider) → {risk_score,flags,rationale}`; orchestrator injectables `aiReview/aiDecide/aiEnabled`.
- **Out of scope:** model fine-tuning, multi-provider, calibration dashboards.
- **Known follow-up:** end-to-end verification against a live ai-engine (needs `GEMINI_API_KEY` + running service) — unit-tested here via injected fake provider/client.
