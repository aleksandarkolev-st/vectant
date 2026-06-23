export const PROGRAM_LAUNCH_SCOPE = 'program.launch';

export function normalizeGrantScopes(value) {
  const scopes = Array.isArray(value) ? value : [];
  return [...new Set(scopes.map((scope) => String(scope || '').trim()).filter(Boolean))];
}

// A DB session can keep an active state long after its runtime is gone (idle-cull,
// collab-server restart, crash). These are the states we reconcile to "stopped" when
// no live runtime session backs the row.
const ACTIVE_SESSION_STATES = new Set(['starting', 'running', 'restarting']);

export function mergeProgramSession(session, runtimeSession = null) {
  if (!session) {
    return null;
  }

  const merged = {
    ...session,
    activePorts: Array.isArray(runtimeSession?.activePorts) ? [...runtimeSession.activePorts] : [],
    webPort: runtimeSession?.webPort ?? null,
    // Slice 1 (real programs): the live runtime session carries its sysbox scope;
    // surface it so ProgramSessionPanel builds /runtime/<scope>/port/N preview URLs.
    runtimeScope: runtimeSession?.runtimeScope ?? null,
    lastHealthState: runtimeSession?.healthState ?? session.lastHealthState ?? null,
  };

  if (runtimeSession?.state) {
    merged.state = runtimeSession.state;
  } else if (!runtimeSession && ACTIVE_SESSION_STATES.has(String(session.state || '').toLowerCase())) {
    // Orphan reconciliation: no live runtime backs this active row → it's a zombie.
    // Present it as stopped so the panel never shows a perpetual "running"/"starting".
    merged.state = 'stopped';
  }

  return merged;
}

export function sanitizeProgramEvent(event) {
  if (!event) {
    return event;
  }

  const data = event.data && typeof event.data === 'object' ? { ...event.data } : event.data;
  if (data && typeof data === 'object') {
    delete data.command;
    delete data.commandPreview;
    delete data.env;
    delete data.launchRequest;
    delete data.secret;
    delete data.secrets;
  }

  return {
    ...event,
    data,
  };
}

export function sortProgramEvents(events) {
  return [...events].sort((left, right) => {
    const leftTs = typeof left?.createdAt === 'number' ? left.createdAt : Date.parse(left?.createdAt || '') || 0;
    const rightTs = typeof right?.createdAt === 'number' ? right.createdAt : Date.parse(right?.createdAt || '') || 0;
    return leftTs - rightTs;
  });
}