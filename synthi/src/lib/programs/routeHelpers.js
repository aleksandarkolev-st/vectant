export const PROGRAM_LAUNCH_SCOPE = 'program.launch';

export function normalizeGrantScopes(value) {
  const scopes = Array.isArray(value) ? value : [];
  return [...new Set(scopes.map((scope) => String(scope || '').trim()).filter(Boolean))];
}

export function mergeProgramSession(session, runtimeSession = null) {
  if (!session) {
    return null;
  }

  const merged = {
    ...session,
    activePorts: Array.isArray(runtimeSession?.activePorts) ? [...runtimeSession.activePorts] : [],
    webPort: runtimeSession?.webPort ?? null,
  };

  if (runtimeSession?.state) {
    merged.state = runtimeSession.state;
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