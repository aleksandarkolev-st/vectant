export function dockerSnapshotFromInspect(raw, containerName) {
  if (!raw) return { container: containerName, available: false, reason: 'docker_inspect_empty' };
  let info;
  try {
    const parsed = JSON.parse(String(raw));
    info = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (err) {
    return {
      container: containerName,
      available: false,
      reason: 'docker_inspect_parse_failed',
      error: err?.message ?? String(err),
    };
  }
  if (!info || typeof info !== 'object') {
    return { container: containerName, available: false, reason: 'docker_inspect_missing_object' };
  }
  const state = info.State ?? {};
  const labels = info.Config?.Labels ?? {};
  return {
    container: containerName,
    name: String(info.Name ?? '').replace(/^\//, '') || containerName,
    id: info.Id ?? null,
    config_image: info.Config?.Image ?? null,
    image_id: info.Image ?? null,
    status: state.Status ?? null,
    pid: state.Pid ?? null,
    started_at: state.StartedAt ?? null,
    finished_at: state.FinishedAt ?? null,
    restart_count: info.RestartCount ?? null,
    oom_killed: state.OOMKilled ?? null,
    exit_code: state.ExitCode ?? null,
    compose_project: labels['com.docker.compose.project'] ?? null,
    compose_service: labels['com.docker.compose.service'] ?? null,
    compose_container_number: labels['com.docker.compose.container-number'] ?? null,
    available: true,
  };
}

export async function dockerContainerSnapshot(containerName, { execText, timeoutMs = 30000 } = {}) {
  if (typeof execText !== 'function') {
    throw new TypeError('dockerContainerSnapshot requires an execText function');
  }
  const raw = await execText('docker', ['inspect', containerName], timeoutMs).catch(() => null);
  return dockerSnapshotFromInspect(raw, containerName);
}

export function validationCommandMetadata({
  cwd = process.cwd(),
  argv = process.argv,
  env = process.env,
  envKeys = [],
} = {}) {
  const selectedEnv = {};
  for (const key of envKeys) {
    selectedEnv[key] = env[key] ?? '';
  }
  return {
    cwd,
    argv: Array.isArray(argv) ? [...argv] : [],
    env: selectedEnv,
  };
}
