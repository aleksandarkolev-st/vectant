'use client';

import { Command, RefreshCw, ExternalLink, Play, Store } from 'lucide-react';
import { PROGRAM_STYLE } from '../programTokens';
import { buildProgramSessionSections } from '../programSessionSections';
import RunningCard from './RunningCard';
import ProgramTile from './ProgramTile';

function SectionLabel({ children, count }) {
  return (
    <div className="flex items-center justify-between" style={PROGRAM_STYLE.sectionLabel}>
      <span>{children}</span>
      {typeof count === 'number' ? <span style={PROGRAM_STYLE.countChip}>{count}</span> : null}
    </div>
  );
}

export default function LibraryView({
  canManage, slug, sessions, installs, detected, loading,
  onOpenStore, onRefresh, onOpenSession, onStop, onRestart,
  onLaunchInstall, onScaffold, onLaunchDetected, scaffoldableIds = [],
}) {
  const { running } = buildProgramSessionSections(sessions);

  return (
    <div className="flex flex-col h-full min-h-0" style={{ color: 'var(--text-primary)' }}>
      <div className="flex items-center justify-between px-3 py-2" style={PROGRAM_STYLE.header}>
        <span className="flex items-center gap-2" style={PROGRAM_STYLE.headerTitle}>
          <Command className="w-3.5 h-3.5" /> Programs
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="open-store"
            onClick={onOpenStore}
            className="inline-flex items-center gap-1.5 cursor-pointer"
            style={{ fontSize: '10px', color: '#c6b8ff', border: '1px solid var(--border-medium)', borderRadius: '7px', padding: '3px 8px' }}
          >
            Store <ExternalLink className="w-3 h-3" />
          </button>
          <button type="button" onClick={onRefresh} title="Refresh" className="cursor-pointer" style={{ color: 'var(--text-muted)' }}>
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-3">
        {canManage && detected ? (
          <div data-testid="detected-program" className="flex items-center justify-between gap-3 rounded-lg px-3 py-2"
            style={{ ...PROGRAM_STYLE.surfaceCard, borderColor: 'color-mix(in srgb, var(--accent-primary) 35%, var(--border-subtle))' }}>
            <div className="min-w-0">
              <div style={{ fontSize: '13px' }}>Detected in this repo</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{detected.source}</div>
            </div>
            <button type="button" data-testid="launch-detected" onClick={onLaunchDetected}
              className="inline-flex items-center gap-1 cursor-pointer" style={{ ...PROGRAM_STYLE.primaryButton, fontSize: '11px', padding: '5px 10px' }}>
              <Play className="w-3.5 h-3.5" /> Run
            </button>
          </div>
        ) : null}

        <section className="flex flex-col gap-2">
          <SectionLabel count={running.length}>Running</SectionLabel>
          {loading ? (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading…</div>
          ) : running.length === 0 ? (
            <div className="rounded-lg px-3 py-4" style={{ ...PROGRAM_STYLE.surfaceCard, fontSize: '12px', color: 'var(--text-muted)' }}>Nothing running.</div>
          ) : (
            running.map((s) => (
              <RunningCard key={s.id} session={s} slug={slug} onOpen={onOpenSession} onStop={onStop} onRestart={onRestart} />
            ))
          )}
        </section>

        <section className="flex flex-col gap-2">
          <SectionLabel count={installs.length}>Installed</SectionLabel>
          <div className="grid grid-cols-2 gap-2">
            {installs.map((install) => (
              <ProgramTile
                key={install.id}
                install={install}
                canManage={canManage}
                scaffoldable={scaffoldableIds.includes(install.packageId)}
                onLaunch={onLaunchInstall}
                onScaffold={onScaffold}
              />
            ))}
            <button
              type="button"
              data-testid="browse-store-tile"
              onClick={onOpenStore}
              className="flex flex-col items-center justify-center gap-1.5 cursor-pointer"
              style={{ border: '1px dashed var(--border-medium)', borderRadius: '10px', padding: '10px 7px', color: 'var(--text-secondary)' }}
            >
              <span className="flex items-center justify-center" style={{ width: '32px', height: '32px', borderRadius: '9px', background: 'linear-gradient(135deg, rgba(162,61,255,0.28), rgba(61,109,255,0.28))', color: '#c6b8ff' }}>
                <Store className="w-4 h-4" />
              </span>
              <span style={{ fontSize: '11px' }}>Browse store</span>
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
