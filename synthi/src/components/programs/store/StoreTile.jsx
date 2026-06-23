'use client';

import { ShieldCheck, Download } from 'lucide-react';
import { PROGRAM_STYLE, BRAND_GRADIENT } from '../programTokens';

export default function StoreTile({ item, canManage, onInstall, onOpenDetail }) {
  const name = item.displayName || item.packageId;
  const meta = item.verified ? `${item.installCount || 0} installs` : `community · ${item.installCount || 0}`;
  return (
    <div
      data-testid={`marketplace-item-${item.packageId}`}
      style={{ ...PROGRAM_STYLE.surfaceCard, padding: '10px' }}
      className="flex flex-col gap-1.5"
    >
      <div className="flex items-start justify-between">
        <button type="button" onClick={() => onOpenDetail(item)} className="cursor-pointer" style={{ ...PROGRAM_STYLE.iconPlate, width: '30px', height: '30px' }} aria-label={`Open ${name}`} />
        {item.verified ? (
          <span data-testid={`verified-badge-${item.packageId}`} aria-label="Verified"
            className="inline-flex items-center" style={{ background: BRAND_GRADIENT, borderRadius: '5px', padding: '2px 4px', color: '#fff' }}>
            <ShieldCheck className="w-2.5 h-2.5" />
          </span>
        ) : null}
      </div>
      <button type="button" onClick={() => onOpenDetail(item)} className="text-left cursor-pointer min-w-0">
        <div className="truncate" style={{ color: 'var(--text-primary)', fontSize: '12px' }}>{name}</div>
        <div style={{ color: 'var(--text-muted)', fontSize: '9px' }}>{meta}</div>
      </button>
      {canManage ? (
        <button
          type="button"
          data-testid={`install-published-${item.packageId}`}
          onClick={() => onInstall(item)}
          className="inline-flex items-center justify-center gap-1 cursor-pointer"
          style={{ ...PROGRAM_STYLE.ghostButton, color: 'var(--text-primary)', fontSize: '10px', padding: '4px' }}
        >
          <Download className="w-3 h-3" /> Install
        </button>
      ) : null}
    </div>
  );
}
