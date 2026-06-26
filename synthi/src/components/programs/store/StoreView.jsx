'use client';

import { useMemo, useState } from 'react';
import { Store, ArrowLeft, Search, FileInput, UploadCloud } from 'lucide-react';
import { PROGRAM_STYLE } from '../programTokens';
import FilterStrip from './FilterStrip';
import StoreTile from './StoreTile';
import ProgramDetail from './ProgramDetail';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'databases', label: 'Databases' },
  { id: 'api', label: 'API tools' },
  { id: 'dev', label: 'Dev servers' },
  { id: 'gui', label: 'Desktop GUIs' },
  { id: 'community', label: 'Community' },
];

export default function StoreView({
  canManage, marketplace, query, onQueryChange, onBack,
  onInstallManifest, onPublish, onInstallPublished,
  requestedScopes, consentItem, busy, onApprove,
}) {
  const [activeFilter, setActiveFilter] = useState('all');
  const [selected, setSelected] = useState(null);

  const detailItem = consentItem || selected;
  const filtered = useMemo(() => {
    if (activeFilter === 'community') return marketplace.filter((m) => !m.verified);
    return marketplace;
  }, [marketplace, activeFilter]);

  if (detailItem) {
    return (
      <ProgramDetail
        item={detailItem}
        requestedScopes={consentItem ? requestedScopes : []}
        busy={busy}
        onInstall={(item) => onInstallPublished(item)}
        onApprove={(item, scopes) => onApprove(item, scopes)}
        onBack={() => setSelected(null)}
      />
    );
  }

  const action = { ...PROGRAM_STYLE.ghostButton, fontSize: '10px', padding: '6px 10px', color: 'var(--text-secondary)', cursor: 'pointer' };

  return (
    <div className="flex flex-col h-full min-h-0" style={{ color: 'var(--text-primary)' }}>
      <div className="flex items-center gap-2 px-3 py-2" style={PROGRAM_STYLE.header}>
        <button type="button" data-testid="store-back" onClick={onBack} className="cursor-pointer" style={{ color: 'var(--text-secondary)' }}><ArrowLeft className="w-4 h-4" /></button>
        <span className="flex items-center gap-2" style={{ fontSize: '14px' }}><Store className="w-4 h-4" style={{ color: '#c6b8ff' }} /> Store</span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-3">
        <div className="flex items-center gap-2 px-2.5 py-2" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: '8px' }}>
          <Search className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search programs"
            className="flex-1 bg-transparent outline-none"
            style={{ fontSize: '12px', color: 'var(--text-primary)' }}
          />
        </div>

        {canManage ? (
          <div className="flex gap-2">
            <button type="button" data-testid="install-from-manifest" onClick={onInstallManifest} style={{ ...action, flex: 1 }} className="inline-flex items-center justify-center gap-1.5">
              <FileInput className="w-3.5 h-3.5" /> Install from manifest
            </button>
            <button type="button" data-testid="publish-program" onClick={onPublish} style={action} className="inline-flex items-center gap-1.5">
              <UploadCloud className="w-3.5 h-3.5" /> Publish
            </button>
          </div>
        ) : null}

        <FilterStrip items={FILTERS} activeId={activeFilter} onSelect={setActiveFilter} />

        {filtered.length === 0 ? (
          <div className="rounded-lg px-3 py-4" style={{ ...PROGRAM_STYLE.surfaceCard, fontSize: '12px', color: 'var(--text-muted)' }}>No programs match.</div>
        ) : (
          <div className="grid grid-cols-2 gap-2.5">
            {filtered.map((item) => (
              <StoreTile
                key={item.packageId}
                item={item}
                canManage={canManage}
                onInstall={(it) => onInstallPublished(it)}
                onOpenDetail={(it) => setSelected(it)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
