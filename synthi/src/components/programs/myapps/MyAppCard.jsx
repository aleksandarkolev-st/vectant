'use client';

/** Human label + colour per review state (the autonomous pipeline's surface). */
const STATE_LABEL = {
  submitted: { text: 'Queued', tone: '#a0a0a8' },
  scanning: { text: 'Scanning', tone: '#c9a227' },
  ai_review: { text: 'AI review', tone: '#c9a227' },
  pending_review: { text: 'Awaiting human review', tone: '#c9a227' },
  approved: { text: 'Approving', tone: '#3a8' },
  rehosting: { text: 'Publishing', tone: '#3a8' },
  published: { text: 'Live', tone: '#2faa55' },
  rejected: { text: 'Rejected', tone: '#d9534f' },
};

/**
 * One publisher app: package id, live status badge, redacted scan + AI summary,
 * and per-state actions (Submit update always; Unpublish only when live).
 */
export default function MyAppCard({ sub, onSubmitUpdate, onUnpublish }) {
  const s = STATE_LABEL[sub.reviewState] || { text: sub.reviewState, tone: '#a0a0a8' };
  const cveCount = sub.scanSummary ? (sub.scanSummary.decisiveCves || []).length : null;
  const ai = sub.aiSummary || null;
  return (
    <div data-testid="my-app-card" style={{ padding: 12, borderRadius: 8, background: 'var(--bg-panel, #0d0d12)', display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <strong style={{ fontSize: 13 }}>{sub.packageId || '(unnamed)'}</strong>
        <span style={{ color: s.tone, fontSize: 12 }}>{s.text}</span>
      </div>
      {cveCount != null ? (
        <div style={{ fontSize: 12, opacity: 0.75 }}>CVEs (≥ threshold): {cveCount}</div>
      ) : null}
      {ai ? (
        <div style={{ fontSize: 12, opacity: 0.75 }}>
          AI risk: {ai.riskScore ?? '—'}
          {(ai.flags || []).length ? ` · flags: ${ai.flags.join(', ')}` : ''}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button type="button" onClick={() => onSubmitUpdate(sub)}>Submit update</button>
        {sub.reviewState === 'published' ? (
          <button type="button" onClick={() => onUnpublish(sub.packageId)}>Unpublish</button>
        ) : null}
      </div>
    </div>
  );
}
