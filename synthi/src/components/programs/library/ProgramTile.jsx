'use client';

import { Wrench } from 'lucide-react';
import { PROGRAM_STYLE } from '../programTokens';

function shortName(packageId) {
  return String(packageId || 'program').split('/').pop();
}

export default function ProgramTile({ install, canManage, scaffoldable, onLaunch, onScaffold }) {
  const launch = () => canManage && onLaunch(install);
  return (
    <div
      style={{ ...PROGRAM_STYLE.surfaceCard, padding: '10px 7px' }}
      className="flex flex-col items-center gap-1.5 text-center"
    >
      <div style={{ ...PROGRAM_STYLE.iconPlate, width: '32px', height: '32px' }} className="flex items-center justify-center" />
      <span style={{ color: 'var(--text-primary)', fontSize: '11px' }} className="truncate max-w-full">{shortName(install.packageId)}</span>
      <span style={{ color: 'var(--text-muted)', fontSize: '9px' }}>v{install.version}</span>
      {canManage ? (
        <div className="flex items-center gap-1 mt-1">
          {scaffoldable ? (
            <button
              type="button"
              data-testid={`scaffold-${install.id}`}
              onClick={() => onScaffold(install)}
              style={{ ...PROGRAM_STYLE.ghostButton, fontSize: '10px', padding: '3px 7px', cursor: 'pointer' }}
            >
              <span className="inline-flex items-center gap-1"><Wrench className="w-3 h-3" /> Set up</span>
            </button>
          ) : null}
          <button
            type="button"
            data-testid={`launch-install-${install.id}`}
            onClick={launch}
            style={{ ...PROGRAM_STYLE.primaryButton, fontSize: '10px', padding: '4px 12px', cursor: 'pointer' }}
          >
            Launch
          </button>
        </div>
      ) : null}
    </div>
  );
}
