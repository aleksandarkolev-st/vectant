'use client';

import { PROGRAM_STYLE } from '../programTokens';
import MyAppCard from './MyAppCard';

/**
 * Publisher self-service board: every app this workspace has submitted, with its
 * live review status (the autonomous pipeline's state), the redacted scan + AI
 * summary, and Submit-update / Unpublish actions.
 */
export default function MyAppsView({ submissions = [], onSubmitUpdate, onUnpublish, onRefresh }) {
  if (!submissions.length) {
    return (
      <div style={{ ...PROGRAM_STYLE.panelShell, padding: 16, fontSize: 13, opacity: 0.8 }}>
        You haven’t published any apps yet. Submit one from the Store tab to see it tracked here.
      </div>
    );
  }
  return (
    <div style={{ ...PROGRAM_STYLE.panelShell, padding: 12, display: 'grid', gap: 10, overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, opacity: 0.7 }}>{submissions.length} app(s)</span>
        <button type="button" onClick={onRefresh}>Refresh</button>
      </div>
      {submissions.map((sub) => (
        <MyAppCard key={sub.versionId} sub={sub} onSubmitUpdate={onSubmitUpdate} onUnpublish={onUnpublish} />
      ))}
    </div>
  );
}
