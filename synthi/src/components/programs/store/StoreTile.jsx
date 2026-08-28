'use client';

import { ShieldCheck, Download, CreditCard, Check } from 'lucide-react';
import { PROGRAM_STYLE, BRAND_GRADIENT } from '../programTokens';
import ProgramIcon from '../ProgramIcon';

function formatPrice(cents, currency) {
  if (typeof cents !== 'number') return '';
  const cur = (currency || 'EUR').toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${cur}`;
  }
}

export default function StoreTile({ item, canManage, onInstall, onBuy, onOpenDetail }) {
  const name = item.displayName || item.packageId;
  const meta = item.verified ? `${item.installCount || 0} installs` : `community · ${item.installCount || 0}`;
  const paid = !!item.isPaid;
  const owned = !!item.entitled;
  const priceLabel = paid ? formatPrice(item.price?.priceCents, item.price?.currency) : '';
  return (
    <div
      data-testid={`marketplace-item-${item.packageId}`}
      style={{ ...PROGRAM_STYLE.surfaceCard, padding: '10px' }}
      className="flex flex-col gap-1.5"
    >
      <div className="flex items-start justify-between">
        <button type="button" onClick={() => onOpenDetail(item)} className="cursor-pointer" aria-label={`Open ${name}`}>
          <ProgramIcon packageId={item.packageId} size={30} />
        </button>
        <div className="flex items-center gap-1">
          {paid ? (
            <span data-testid={`price-badge-${item.packageId}`}
              style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: '5px', padding: '2px 5px', color: 'var(--text-primary)', fontSize: '9px' }}>
              {owned ? 'Owned' : priceLabel}
            </span>
          ) : null}
          {item.verified ? (
            <span data-testid={`verified-badge-${item.packageId}`} aria-label="Verified"
              className="inline-flex items-center" style={{ background: BRAND_GRADIENT, borderRadius: '5px', padding: '2px 4px', color: '#fff' }}>
              <ShieldCheck className="w-2.5 h-2.5" />
            </span>
          ) : null}
        </div>
      </div>
      <button type="button" onClick={() => onOpenDetail(item)} className="text-left cursor-pointer min-w-0">
        <div className="truncate" style={{ color: 'var(--text-primary)', fontSize: '12px' }}>{name}</div>
        <div style={{ color: 'var(--text-muted)', fontSize: '9px' }}>{meta}</div>
      </button>
      {canManage ? (
        paid && !owned ? (
          <button
            type="button"
            data-testid={`buy-published-${item.packageId}`}
            onClick={() => onBuy(item)}
            className="inline-flex items-center justify-center gap-1 cursor-pointer"
            style={{ ...PROGRAM_STYLE.ghostButton, color: 'var(--text-primary)', fontSize: '10px', padding: '4px' }}
          >
            <CreditCard className="w-3 h-3" /> Buy {priceLabel}
          </button>
        ) : (
          <button
            type="button"
            data-testid={`install-published-${item.packageId}`}
            onClick={() => onInstall(item)}
            className="inline-flex items-center justify-center gap-1 cursor-pointer"
            style={{ ...PROGRAM_STYLE.ghostButton, color: 'var(--text-primary)', fontSize: '10px', padding: '4px' }}
          >
            {owned ? <Check className="w-3 h-3" /> : <Download className="w-3 h-3" />} Install
          </button>
        )
      ) : null}
    </div>
  );
}
