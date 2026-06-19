'use client';

import { Link2 } from 'lucide-react';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
  boxSizing: 'border-box',
  overflow: 'hidden',
};

const headerStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  borderBottom: '1px solid var(--border-subtle)',
  padding: '12px 16px',
};

const recordListStyle = {
  display: 'grid',
  gap: 0,
};

const recordCardStyle = {
  display: 'grid',
  gap: 8,
  borderBottom: '1px solid var(--border-subtle)',
  padding: '12px 16px',
  minWidth: 0,
};

const recordHeaderStyle = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  minWidth: 0,
};

export default function EvidenceLedgerChain({ ledger }) {
  const records = ledger?.records || [];
  return (
    <section className="rounded-md border" style={panelStyle} data-testid="evidence-ledger-chain">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3" style={headerStyle}>
        <div className="min-w-0" style={{ minWidth: 0 }}>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Link2 size={15} aria-hidden="true" />
            Evidence Ledger
          </h2>
          <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{ledger?.ledgerId || 'no-ledger-id'}</p>
        </div>
        <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{records.length} records</span>
      </div>
      {records.length ? (
        <div className="divide-y" style={recordListStyle}>
          {records.map((record, index) => (
            <article
              key={record.recordId}
              className="grid gap-2 px-4 py-3 text-xs"
              style={{
                ...recordCardStyle,
                borderBottom: index === records.length - 1 ? '0' : recordCardStyle.borderBottom,
              }}
            >
              <div className="flex items-start justify-between gap-3" style={recordHeaderStyle}>
                <div className="min-w-0" style={{ minWidth: 0 }}>
                  <h3 className="truncate text-sm font-semibold" style={{ margin: 0, overflowWrap: 'anywhere' }}>{record.kind}</h3>
                  <p className="mt-1 truncate" style={{ color: 'var(--text-muted)', margin: '4px 0 0', overflowWrap: 'anywhere' }}>{record.recordId}</p>
                </div>
                <span className="rounded-md border px-2 py-1" style={{ ...panelStyle, flexShrink: 0 }}>{record.redaction}</span>
              </div>
              <Detail label="Ref" value={record.ref || 'Not recorded'} />
              <Detail label="Hash" value={shortDigest(record.hash)} />
              <Detail label="Previous" value={shortDigest(record.previousHash) || 'root'} />
              <Detail label="Claims" value={record.claimIds.join(', ') || 'None'} />
            </article>
          ))}
        </div>
      ) : (
        <div className="p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>No evidence records are reported.</div>
      )}
    </section>
  );
}

function Detail({ label, value }) {
  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-3" style={{ display: 'grid', gridTemplateColumns: '76px minmax(0, 1fr)', gap: 12, minWidth: 0 }}>
      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="min-w-0 truncate text-right" style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere', textAlign: 'right', wordBreak: 'break-word' }}>{value}</dd>
    </div>
  );
}

function shortDigest(value) {
  if (!value) return '';
  const text = String(value);
  if (text.length <= 16) return text;
  return `${text.slice(0, 10)}...${text.slice(-6)}`;
}
