'use client';

import { Link2 } from 'lucide-react';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function EvidenceLedgerChain({ ledger }) {
  const records = ledger?.records || [];
  return (
    <section className="rounded-md border" style={panelStyle} data-testid="evidence-ledger-chain">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Link2 size={15} aria-hidden="true" />
            Evidence Ledger
          </h2>
          <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{ledger?.ledgerId || 'no-ledger-id'}</p>
        </div>
        <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{records.length} records</span>
      </div>
      {records.length ? (
        <>
          <div className="divide-y md:hidden" style={{ borderColor: 'var(--border-subtle)' }}>
            {records.map((record) => (
              <article key={record.recordId} className="grid gap-2 px-4 py-3 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold">{record.kind}</h3>
                    <p className="mt-1 truncate" style={{ color: 'var(--text-muted)' }}>{record.recordId}</p>
                  </div>
                  <span className="rounded-md border px-2 py-1" style={panelStyle}>{record.redaction}</span>
                </div>
                <Detail label="Ref" value={record.ref || 'Not recorded'} />
                <Detail label="Hash" value={shortDigest(record.hash)} />
                <Detail label="Previous" value={shortDigest(record.previousHash) || 'root'} />
                <Detail label="Claims" value={record.claimIds.join(', ') || 'None'} />
              </article>
            ))}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <table className="min-w-full table-fixed text-left text-xs">
              <thead style={{ color: 'var(--text-muted)' }}>
                <tr className="border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                  <th className="w-44 px-4 py-3 font-medium">Record</th>
                  <th className="w-28 px-4 py-3 font-medium">Kind</th>
                  <th className="px-4 py-3 font-medium">Reference</th>
                  <th className="w-36 px-4 py-3 font-medium">Hash</th>
                  <th className="w-32 px-4 py-3 font-medium">Redaction</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.recordId} className="border-b last:border-b-0" style={{ borderColor: 'var(--border-subtle)' }}>
                    <td className="px-4 py-3">
                      <div className="truncate font-medium">{record.recordId}</div>
                      <div className="mt-1 truncate" style={{ color: 'var(--text-muted)' }}>{shortDigest(record.previousHash) || 'root'}</div>
                    </td>
                    <td className="truncate px-4 py-3">{record.kind}</td>
                    <td className="truncate px-4 py-3">{record.ref || 'Not recorded'}</td>
                    <td className="truncate px-4 py-3">{shortDigest(record.hash)}</td>
                    <td className="truncate px-4 py-3">{record.redaction}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>No evidence records are reported.</div>
      )}
    </section>
  );
}

function Detail({ label, value }) {
  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-3">
      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="min-w-0 truncate text-right">{value}</dd>
    </div>
  );
}

function shortDigest(value) {
  if (!value) return '';
  const text = String(value);
  if (text.length <= 16) return text;
  return `${text.slice(0, 10)}...${text.slice(-6)}`;
}
