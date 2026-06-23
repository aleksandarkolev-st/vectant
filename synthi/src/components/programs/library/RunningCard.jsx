'use client';

import { Square, RotateCcw } from 'lucide-react';
import { PROGRAM_STYLE } from '../programTokens';
import { canRestartProgramSession, formatProgramSessionPorts } from '../programSessionSections';
import ProgramThumbnail from './ProgramThumbnail';

function shortLabel(session) {
  return session?.title || (session?.id ? `Session ${String(session.id).slice(0, 8)}` : 'Program');
}

export default function RunningCard({ session, slug, onOpen, onStop, onRestart }) {
  const ports = formatProgramSessionPorts(session);
  const canRestart = canRestartProgramSession(session);
  const btn = { ...PROGRAM_STYLE.ghostButton, fontSize: '10px', padding: '3px 9px', cursor: 'pointer' };

  return (
    <div style={{ ...PROGRAM_STYLE.runningShell, padding: '9px' }}>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 min-w-0" style={{ color: 'var(--text-primary)', fontSize: '13px' }}>
          <span className="truncate">{shortLabel(session)}</span>
        </span>
        <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'var(--accent-success)', boxShadow: '0 0 7px var(--accent-success)' }} />
      </div>

      {session?.webGui ? (
        <div className="mt-2">
          <ProgramThumbnail slug={slug} port={session.webPort || null} />
        </div>
      ) : null}

      <div className="flex items-center gap-2 mt-2">
        <span style={{ fontSize: '9px', color: '#bfe7cf', background: 'rgba(74,222,128,0.14)', borderRadius: '5px', padding: '2px 7px' }}>
          {String(session?.state || 'running')}
        </span>
        {ports ? <span style={{ color: 'var(--text-secondary)', fontSize: '10px' }}>:{ports}</span> : null}
        <span className="flex-1" />
        <button type="button" data-testid={`running-open-${session.id}`} onClick={() => onOpen(session)} style={{ ...btn, color: 'var(--text-primary)' }}>Open</button>
        {canRestart ? (
          <button type="button" data-testid={`running-restart-${session.id}`} onClick={() => onRestart(session)} style={btn}>
            <span className="inline-flex items-center gap-1"><RotateCcw className="w-3 h-3" /> Restart</span>
          </button>
        ) : (
          <button type="button" data-testid={`running-stop-${session.id}`} onClick={() => onStop(session)} style={btn}>
            <span className="inline-flex items-center gap-1"><Square className="w-3 h-3" /> Stop</span>
          </button>
        )}
      </div>
    </div>
  );
}
