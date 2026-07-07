/**
 * @fileoverview Phase-2 advisory AI risk review for community submissions.
 * Server-side: calls the ai-engine directly over HTTP (like the agent/shadow
 * routes) — NOT via the frontend gateway. Fail-closed: any error/malformed
 * reply → max risk so the orchestrator routes to manual review. The AI is never
 * a load-bearing security control; hard gates + CVE scan run first, unchanged.
 */

import { withInternalAiAuth } from '@/lib/internalAiAuth';

const AI_ENGINE_BASE = (process.env.CODE_INTEL_URL || process.env.AI_ENGINE_URL || 'http://localhost:8000').replace(/\/$/, '');
// Two thresholds: ≤ low → auto-approve (clean); ≥ high → auto-reject (dangerous).
const DEFAULT_LOW = Number(process.env.PROGRAM_AI_RISK_THRESHOLD) || 0.3;
const DEFAULT_HIGH = Number(process.env.PROGRAM_AI_REJECT_THRESHOLD) || 0.7;

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

/**
 * Three-way autonomous decision (precedence: approve → reject → manual).
 * Auto-approve only when clearly safe; auto-reject when clearly dangerous (high
 * risk OR a concrete suspicion flag); everything else (the uncertain middle, or
 * any sensitive scope) is left for a human. The AI is advisory — hard gates +
 * CVE scan already ran first, and this never overrides a static reject.
 * @returns {'auto_approve'|'auto_reject'|'manual'}
 */
export function aiDecision({ riskScore, flags = [] }, config, { lowThreshold = DEFAULT_LOW, highThreshold = DEFAULT_HIGH } = {}) {
  const perms = Array.isArray(config?.permissions) ? config.permissions : [];
  const hasSensitive = perms.some((p) => SENSITIVE_SCOPES.includes(p));
  const hasFlags = Array.isArray(flags) && flags.length > 0;
  if (riskScore <= lowThreshold && !hasFlags && !hasSensitive) return 'auto_approve';
  if (riskScore >= highThreshold || hasFlags) return 'auto_reject';
  return 'manual';
}
