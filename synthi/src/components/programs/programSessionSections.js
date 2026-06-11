const ACTIVE_STATES = new Set(['starting', 'running', 'restarting']);
const RESTARTABLE_STATES = new Set(['stopped', 'crashed']);

function sessionTimestamp(session) {
  const value = session?.endedAt || session?.updatedAt || session?.startedAt || session?.createdAt || null;
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function isActiveProgramSession(session) {
  return ACTIVE_STATES.has(String(session?.state || '').toLowerCase());
}

export function canRestartProgramSession(session) {
  return RESTARTABLE_STATES.has(String(session?.state || '').toLowerCase());
}

export function buildProgramSessionSections(sessions, { recentLimit = 6 } = {}) {
  const ordered = [...(Array.isArray(sessions) ? sessions : [])].sort(
    (left, right) => sessionTimestamp(right) - sessionTimestamp(left),
  );

  const running = [];
  const recent = [];

  for (const session of ordered) {
    if (isActiveProgramSession(session)) {
      running.push(session);
      continue;
    }

    recent.push(session);
  }

  return {
    running,
    recent: recent.slice(0, recentLimit),
  };
}

export function formatProgramSessionAge(session, now = Date.now()) {
  const value = session?.endedAt || session?.updatedAt || session?.startedAt || session?.createdAt || null;
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatProgramSessionPorts(session) {
  const ports = Array.isArray(session?.activePorts) ? session.activePorts : [];
  if (!ports.length) {
    return null;
  }

  return ports.join(', ');
}