/**
 * Spawner dispatcher — picks the right workspace-worker lifecycle backend.
 *
 *   local  → dockerode over /var/run/docker.sock (docker-compose dev)
 *   k8s    → @kubernetes/client-node (cloud / GKE)
 *
 * Selection precedence:
 *   1. SPAWNER_MODE env var: "local" | "k8s"
 *   2. KUBERNETES_SERVICE_HOST present  → k8s
 *   3. Default                          → local
 *
 * Both backends export the same surface so server.js doesn't care which
 * one it's talking to.
 */

function pickMode() {
  const explicit = String(process.env.SPAWNER_MODE || '').trim().toLowerCase();
  if (explicit === 'local' || explicit === 'k8s') return explicit;
  if (process.env.KUBERNETES_SERVICE_HOST) return 'k8s';
  return 'local';
}

const mode = pickMode();
const impl = mode === 'k8s'
  ? require('./workspacePodSpawner')
  : require('./localWorkerSpawner');

console.log(`[Spawner] Using ${mode} backend`);

module.exports = Object.assign({ mode }, impl);
