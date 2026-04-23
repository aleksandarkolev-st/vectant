/**
 * Spawner dispatcher — picks the right workspace-worker lifecycle backend.
 *
 *   process → child_process.spawn of the worker binary (bare-metal dev)
 *   local   → dockerode over /var/run/docker.sock (docker-compose dev)
 *   k8s     → @kubernetes/client-node (cloud / GKE)
 *
 * Selection precedence:
 *   1. SPAWNER_MODE env var: "process" | "local" | "k8s"
 *   2. KUBERNETES_SERVICE_HOST present → k8s
 *   3. Default                         → process
 *
 * All backends expose the same surface so server.js doesn't care which
 * one it's talking to.  We default to `process` for bare-metal dev —
 * pick `local` explicitly via SPAWNER_MODE when running inside compose,
 * since Docker Desktop machines have /var/run/docker.sock even when the
 * developer is running collab-server directly on the host.
 */

function pickMode() {
  const explicit = String(process.env.SPAWNER_MODE || '').trim().toLowerCase();
  if (explicit === 'process' || explicit === 'local' || explicit === 'k8s') {
    return explicit;
  }
  if (process.env.KUBERNETES_SERVICE_HOST) return 'k8s';
  return 'process';
}

const mode = pickMode();
const moduleForMode = {
  k8s: './workspacePodSpawner',
  local: './localWorkerSpawner',
  process: './processWorkerSpawner',
};
const impl = require(moduleForMode[mode]);

console.log(`[Spawner] Using ${mode} backend`);

module.exports = Object.assign({ mode }, impl);
