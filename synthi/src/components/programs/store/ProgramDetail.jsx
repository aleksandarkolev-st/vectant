'use client';

import { ArrowLeft, ShieldCheck, Download } from 'lucide-react';
import { PROGRAM_STYLE, BRAND_GRADIENT } from '../programTokens';

export default function ProgramDetail({ item, requestedScopes = [], busy, onInstall, onApprove, onBack }) {
  const name = item.displayName || item.packageId;
  const needsConsent = requestedScopes.length > 0;
  return (
    <div className="flex flex-col h-full min-h-0" style={{ color: 'var(--text-primary)' }}>
      <div className="flex items-center gap-2 px-3 py-2" style={PROGRAM_STYLE.header}>
        <button type="button" data-testid="detail-back" onClick={onBack} className="cursor-pointer" style={{ color: 'var(--text-secondary)' }}><ArrowLeft className="w-4 h-4" /></button>
        <span style={{ fontSize: '13px' }} className="truncate">{name}</span>
        {item.verified ? <span aria-label="Verified" className="inline-flex items-center" style={{ background: BRAND_GRADIENT, borderRadius: '5px', padding: '2px 5px', color: '#fff' }}><ShieldCheck className="w-3 h-3" /></span> : null}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-3">
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{item.description || 'No description.'}</div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          v{item.latestVersion} · {item.verified ? 'verified by vectant' : 'community'} · runs hosted in your workspace
        </div>

        {needsConsent ? (
          <div data-testid="consent-prompt" className="rounded-lg px-3 py-3 flex flex-col gap-2"
            style={{ ...PROGRAM_STYLE.surfaceCard, borderColor: 'color-mix(in srgb, var(--accent-primary) 35%, var(--border-subtle))' }}>
            <div className="flex items-center gap-2" style={{ fontSize: '13px' }}>
              <ShieldCheck className="w-4 h-4" style={{ color: 'var(--attention-purple)' }} /> Permission consent required
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>This program requests:</div>
            <ul className="flex flex-wrap gap-1.5">
              {requestedScopes.map((s) => (
                <li key={s} style={{ fontSize: '11px', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)', borderRadius: '6px', padding: '2px 6px' }}>{s}</li>
              ))}
            </ul>
            <button type="button" data-testid="approve-consent" disabled={busy} onClick={() => onApprove(item, requestedScopes)}
              className="inline-flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
              style={{ ...PROGRAM_STYLE.primaryButton, fontSize: '11px', padding: '5px 10px' }}>
              <ShieldCheck className="w-3 h-3" /> {busy ? 'Approving…' : 'Approve & install'}
            </button>
          </div>
        ) : (
          <button type="button" data-testid="detail-install" disabled={busy} onClick={() => onInstall(item)}
            className="inline-flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
            style={{ ...PROGRAM_STYLE.primaryButton, fontSize: '12px', padding: '7px 12px' }}>
            <Download className="w-4 h-4" /> {busy ? 'Installing…' : 'Install'}
          </button>
        )}
      </div>
    </div>
  );
}
