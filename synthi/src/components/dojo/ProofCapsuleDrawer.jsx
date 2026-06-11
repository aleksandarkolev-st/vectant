'use client';

import { KeyRound, ShieldCheck } from 'lucide-react';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function ProofCapsuleDrawer({ proof, requirements = [] }) {
  if (!proof) {
    return (
      <section className="rounded-md border p-4" style={panelStyle} data-testid="proof-capsule-drawer-empty">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck size={15} aria-hidden="true" />
          Proof Capsule
        </h2>
        <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>No proof capsule has been issued for this skill.</p>
      </section>
    );
  }

  const claims = proof.evidenceClaims?.length
    ? proof.evidenceClaims
    : requirements.map((claim) => ({ claim, status: 'required', satisfied: false, evidenceRecordIds: [] }));

  return (
    <section className="rounded-md border p-4" style={panelStyle} data-testid="proof-capsule-drawer">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck size={15} aria-hidden="true" />
            Proof Capsule
          </h2>
          <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{proof.capsuleId || 'unissued'}</p>
        </div>
        <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{proof.status || 'unknown'}</span>
      </div>

      <dl className="mt-4 grid gap-2 text-xs">
        <InfoRow label="Action" value={proof.requestedAction || 'Not recorded'} />
        <InfoRow label="Replay" value={proof.replayState || 'unused'} />
        <InfoRow label="Expires" value={proof.expiresAt ? String(proof.expiresAt).slice(0, 19) : 'Not recorded'} />
        <InfoRow label="Substrate" value={proof.substrate || 'Not recorded'} />
        <InfoRow label="Key" value={proof.keyId || proof.signatureAlgorithm || 'Not recorded'} />
      </dl>

      {proof.revocationReason ? (
        <div className="mt-3 rounded-md border px-3 py-2 text-xs" style={{ borderColor: 'var(--border-subtle)', color: 'var(--accent-warning)' }}>
          {proof.revocationReason}
        </div>
      ) : null}

      <section className="mt-4">
        <h3 className="mb-2 text-xs font-semibold">Evidence Claims</h3>
        {claims.length ? (
          <div className="grid gap-2">
            {claims.map((claim) => (
              <div key={claim.claim} className="rounded-md border p-3 text-xs" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate font-semibold">{claim.claim}</span>
                  <span>{claim.satisfied ? 'satisfied' : claim.status || 'required'}</span>
                </div>
                {claim.evidenceRecordIds?.length ? (
                  <div className="mt-1 truncate" style={{ color: 'var(--text-muted)' }}>{claim.evidenceRecordIds.join(', ')}</div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No evidence claims recorded</p>
        )}
      </section>

      <section className="mt-4">
        <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold">
          <KeyRound size={13} aria-hidden="true" />
          Validation Timeline
        </h3>
        {proof.validationTimeline?.length ? (
          <ol className="grid gap-2">
            {proof.validationTimeline.map((event, index) => (
              <li key={`${event.label}-${index}`} className="rounded-md border px-3 py-2 text-xs" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="font-semibold">{event.label || event.status}</div>
                <div className="mt-1" style={{ color: 'var(--text-muted)' }}>
                  {[event.status, event.at ? String(event.at).slice(0, 19) : ''].filter(Boolean).join(' / ')}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No validation events recorded</p>
        )}
      </section>
    </section>
  );
}

function InfoRow({ label, value }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3">
      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium">{value}</dd>
    </div>
  );
}
