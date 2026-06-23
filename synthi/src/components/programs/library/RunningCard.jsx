'use client';

import { Square, RotateCcw } from 'lucide-react';
import { PROGRAM_STYLE } from '../programTokens';
import { canRestartProgramSession, formatProgramSessionPorts, isActiveProgramSession } from '../programSessionSections';
import ProgramThumbnail from './ProgramThumbnail';

// Per-state tone: only a running session glows green; stopped is muted, crashed is red.
const STATE_TONE = {
  running: { dot: 'var(--accent-success)', pillFg: '#bfe7cf', pillBg: 'rgba(74,222,128,0.14)' },
  crashed: { dot: '#ff5757', pillFg: '#ffc4c4', pillBg: 'rgba(255,87,87,0.14)' },
  stopped: { dot: 'var(--text-dim)', pillFg: 'var(--text-secondary)', pillBg: 'var(--bg-elevated)' },
};

function toneFor(session, active) {
  if (active) return STATE_TONE.running;
  return STATE_TONE[String(session?.state || '').toLowerCase()] || STATE_TONE.stopped;
}

function sessionSubtitle(session) {
  return session?.id ? `Session ${String(session.id).slice(0, 8)}` : 'Session';
}

export default function RunningCard({ session, slug, programName, onOpen, onStop, onRestart }) {
  const active = isActiveProgramSession(session);
  const ports = formatProgramSessionPorts(session);
  const canRestart = canRestartProgramSession(session);
  const tone = toneFor(session, active);
  const title = programName || session?.title || 'Program';
  const btn = { ...PROGRAM_STYLE.ghostButton, fontSize: '10px', padding: '3px 9px', cursor: 'pointer' };

  return (
    <div
      data-testid={`session-card-${session.id}`}
      style={{ ...(active ? PROGRAM_STYLE.runningShell : PROGRAM_STYLE.surfaceCard), padding: '9px' }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="block truncate" style={{ color: 'var(--text-primary)', fontSize: '13px' }}>{title}</span>
          <span className="block truncate" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{sessionSubtitle(session)}</span>
        </span>
        <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: tone.dot, boxShadow: active ? `0 0 7px ${tone.dot}` : 'none', flexShrink: 0 }} />
      </div>

      {active && session?.webGui ? (
        <div className="mt-2" data-testid={`thumb-${session.id}`}>
          <ProgramThumbnail slug={slug} port={session.webPort || null} />
        </div>
      ) : null}

      <div className="flex items-center gap-2 mt-2">
        <span style={{ fontSize: '9px', color: tone.pillFg, background: tone.pillBg, borderRadius: '5px', padding: '2px 7px' }}>
          {String(session?.state || 'running')}
        </span>
        {ports ? <span style={{ color: 'var(--text-secondary)', fontSize: '10px' }}>:{ports}</span> : null}
        <span className="flex-1" />
        {active ? (
          <button type="button" data-testid={`running-open-${session.id}`} onClick={() => onOpen(session)} style={{ ...btn, color: 'var(--text-primary)' }}>Open</button>
        ) : null}
        {active ? (
          <button type="button" data-testid={`running-stop-${session.id}`} onClick={() => onStop(session)} style={btn}>
            <span className="inline-flex items-center gap-1"><Square className="w-3 h-3" /> Stop</span>
          </button>
        ) : canRestart ? (
          <button type="button" data-testid={`running-restart-${session.id}`} onClick={() => onRestart(session)} style={btn}>
            <span className="inline-flex items-center gap-1"><RotateCcw className="w-3 h-3" /> Restart</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
