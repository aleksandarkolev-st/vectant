# Agent Expertise Directory

Status: implemented on `feat/agent-expertise-directory`, live-stack proven 2026-08-26.
Companion to: `docs/MULTI_HUMAN_MULTI_AGENT_SHARED_SESSION_PROOF_PLAN.md` (Workstream C).

## Problem

CodeSite already shares discoveries, leads, skills, and handoffs through
relevance-routed durable inboxes. What it could not answer was **"who knows
this?"** — when an agent hits a question about a path, symbol, or contract, its
only options were blind broadcast (RFI to every peer) or silently redoing
research another agent had already done. Both waste the scarcest resource in a
multi-agent session: attention.

## Feature

Five pieces, all provider-agnostic (the same control-plane contracts serve
agents and the signed-in project operator):

1. **Derived expertise index** (`synthi/src/lib/codesite/agentExpertise.js`).
   Expertise is *inferred from evidence the control plane already persists* —
   never self-declared, never hardcoded:
   - transaction read/write sets and observed sets (weight 3 write / 2 read)
   - typed semantic refs on transactions (symbols/contracts)
   - execution-plan routes (weight 1.5)
   - knowledge-item references (weight 2) and authorship (weight 1)
   Scores decay with a 14-day half-life so stale experts sink. The routing
   inputs are cached per project and loaded without a fixed row-count cutoff;
   the active policy version travels with each result. Ranking is deterministic
   (score desc, session id asc) and never returns the asker.

2. **`synthi_codesite_find_experts`** — agent-bound MCP tool + HTTP endpoint
   `GET .../agent-sessions/:id/experts?paths=...&symbols=...&contracts=...`.
   Returns ranked peers with callsign, provider, score, last-interaction, and
   evidence refs (`plan_route:<planId>`, `transaction_write:<txnId>`, …) so the
   answer is auditable, not vibes. The response also carries the active
   expertise policy version so score changes remain explainable across deploys.

3. **Routed questions with reusable answers** — new `agent_question` knowledge
   kind:
   - `synthi_codesite_ask_expert_question` / `POST .../questions` derives
     suggested experts from the same index when the asker does not pin any;
     unrouted broadcast questions are refused at policy level
     (`knowledge_question_experts_or_unrouted_required`) unless explicitly
     allowed.
   - Routing lands a durable `impact_notice` inbox item on each expert
     (reuses `buildKnowledgeDeliveryPlan` + `persistKnowledgeAndImpacts`).
   - The expert answers through the existing inbox respond endpoint with
     `action:"answer"`; the answer text is persisted onto the question record,
     the question becomes `answered` shared knowledge, and the asker receives a
     durable `agent_question_answered` inbox notice.
   - Identical re-asks dedupe on asker + references (existing dedupe key), so
     the next agent with the same question finds the answered thread via
     `get_shared_knowledge` without interrupting anyone.

4. **Answer feedback and corrections** — reviewers can mark an answered
   question `useful`, `needs_correction`, or `not_useful`. Feedback is stored
   as an ordinary `CodeSiteEvent` so it follows the existing durable event-log
   and artifact-sync path; no second feedback table or migration is required.
   Ranking keeps only the newest verdict from each reviewer for a question and
   credits the resulting positive/negative signal to the agent that answered
   it. An asker or human reviewer never receives expertise credit merely for
   submitting feedback.

5. **CodeSite operator UI** — the Expertise section in the Operations panel
   searches by arbitrary project paths, symbols, and contracts; lists open or
   answered project questions; lets an authorized human answer an open
   question; and records feedback on an answered one. The view uses the
   versioned expertise policy for feedback choices, renders only safe API
   projections, and refreshes from server state after mutations.

## API surface

| Surface | Detail |
| --- | --- |
| `GET /api/workspace/:slug/codesite/agent-sessions/:id/experts` | agent-token auth, `codesite.context.read`; query `paths`/`symbols`/`contracts`/`limit` (1–10) |
| `POST /api/workspace/:slug/codesite/agent-sessions/:id/questions` | agent-token auth, `codesite.knowledge.write`; body `{title, summary, references, urgency?, suggested_expert_agent_session_ids?, allow_unrouted?}` |
| `POST .../agent-sessions/:id/inbox/:itemId/respond` | widened for questions: `answer` (requires answer text), `claim`, `defer`, `dismiss`; works through the impact_notice wrapper |
| `GET /api/workspace/:slug/codesite/projects/:id/experts` | ordinary project-member auth for the operator UI; same path/symbol/contract query and derived ranking |
| `POST /api/workspace/:slug/codesite/projects/:id/questions/:knowledgeId/answer` | ordinary project-member auth; records a human answer and notifies the asking agent when one exists |
| `POST /api/workspace/:slug/codesite/projects/:id/knowledge/:knowledgeId/feedback` | ordinary project-member auth; stores a useful/correction/not-useful verdict in the event log |
| CodeSite Operations → Expertise | browser UI for project expert search, unanswered questions, human responses, and answer feedback |
| `POST .../agent-sessions/:id/knowledge/:knowledgeId/feedback` | agent-token auth, `codesite.knowledge.write`; same feedback contract |
| MCP | `synthi_codesite_find_experts`, `synthi_codesite_ask_expert_question` (agent-bound, environment identity only) |
| Events | `agent_question_asked`, `agent_question_answered`, and `agent_question_feedback_submitted` on the causal timeline |

## Security / privacy posture

- Questions ride the existing coordination bus: redaction scan, private-key
  material rejection, project-scoped visibility, dedupe.
- Answer actions are validated against the *underlying* question kind even when
  delivered through an `impact_notice` wrapper; status transitions target the
  source question, not the wrapper.
- Stored answered questions stay visible to the asker via wrapper
  `sourceKnowledgeItemId` admission in `visibleKnowledgeRowsForSession`.
- Artifact projection tolerates stored unrouted questions (creation-time policy
  still refuses new unrouted questions).

- Feedback events are project-scoped and bounded by the versioned expertise
  policy; repeated feedback from one reviewer replaces its ranking effect by
  latest-event selection rather than accumulating reputation indefinitely.

## Validation evidence (2026-08-26)

- Unit: synthi vitest 166 passed (expertise lib 12, policy incl. question kind,
  responses, events, routing, controlPlane, artifacts); MCP vitest 59 passed;
  `tsc --noEmit` clean.
- Live stack (docker compose, real HTTP, real scoped agent tokens, distinct
  owner users alice/ben): `tmp/live-expertise-proof.sh` — **ALL EXPERTISE
  PROOFS PASSED**: auth wall 401; derived expert ranking (writer/plan-holder
  ranked, asker excluded); question routed to derived expert; duplicate re-ask
  deduped; expert answered via own credential; answer visible to asker as
  shared knowledge (`maxTurnRate` text present); durable
  `agent_question_answered` notice in asker inbox; both timeline events
  present. Independent subagent reproduced the full flow (21-request
  transcript in `.visual-proof/expertise-live-transcript-*.json`, all four
  assertions true).
- UI: CodeSite Operations panel renders in the browser (screenshot
  `.visual-proof/ui-1-chrome-codesite-panel-404-state.png`); the Expertise
  section is workspace-scoped and must be viewed under a workspace the
  signed-in user belongs to (e.g. `/workspace/acme-chan-fuzz/codesite`), not
  the service-token-only `acme-proof` workspace.

## Bugs found and fixed during live proving (each its own commit)

1. `f24a680b6` — answer actions rejected because validation used the wrapper
   kind; validate through the underlying question kind and resolve the asker
   via `sourceKnowledgeItemId`.
2. `bc4af0646` — answered questions invisible to the asker; admit wrapper
   source ids in visibility filtering.
3. `41c1fc18f` — answer rewrite clobbered question identity
   (`fromAgentSessionId`/suggestions nulled), breaking artifact-sync
   revalidation; merge into the question's own payload instead.
4. `7ee6c39d5` — projection revalidation reset `answerText`; carry stored
   answer fields through.
