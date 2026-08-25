const http = require('http');
const WebSocket = require('ws');
require('dotenv').config();
const runtimeWorkspaceUmask = String(process.env.SYNTHI_RUNTIME_WORKSPACE_UMASK || '');
if (/^(?:0?[0-7]{3,4})$/.test(runtimeWorkspaceUmask)) {
  // Per-workspace repositories are setgid to the rootless runtime group. Keep
  // new collaboration writes group-writable for that isolated peer only.
  process.umask(Number.parseInt(runtimeWorkspaceUmask, 8));
}
const Y = require('yjs');
const fileIndex = require('./fileIndex');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const crypto = require('crypto');
const gcsSync = require('./gcsSync');
const { createTerminalWSS, createHeadlessSession, activeSessions: terminalSessions, broadcastToAll: terminalBroadcast, getAvailableShells, resolveWorkspaceCwd } = require('./terminalService');
const { createAgentSessionAttachService } = require('./agentSessionAttachService');
const {
  createRuntimeObservationPublisher,
} = require('./runtimeObservationPublisher');
const { createProgramRuntimeManager } = require('./programRuntimeManager');
const { createContinuousFlushService } = require('./continuousFlushService');
const proxyService = require('./proxyService');
const { createRuntimeManager } = require('./workspaceRuntimeContainer');
const { handleEnsureRuntime } = require('./ensureRuntime');
const { createContainerPortMonitor } = require('./containerPortMonitor');
const { isSysboxRuntimeEnabled } = require('./runtimePodSpec');
const { runtimeRunOnce, runtimeExecOnce, createRuntimePodProgram, codeSiteProgramRuntimeTarget, codeSiteProgramRuntimeLaunchMode, pickRuntimeScopeForSlug } = require('./runtimePodTerminal');
const { createContainerPortProxy } = require('./containerPortProxy');
const config = require('./config');
const gitService = require('./gitService');
const {
  COMMAND_SCOPES,
  authorizeCollabGatewayRequest,
  authorizeTerminalGatewayRequest,
  hasTrustedInternalToken,
  requireCollabGatewayAuth,
} = require('./collabGatewayAuth');
const {
  codeSiteGitActionAttempts,
  shouldRunCodeSiteGitBoundary,
} = require('./codesiteGitPolicy');
const repoCache = require('./repoCache');
const sessionManager = require('./SessionManager');
const { extractSessionContext, requireGitActionPermission, wsRequirePermission, wsDenyAction, wsAttachContext } = require('./permissionMiddleware');
const { acquireStagingLock, releaseStagingLock, pauseWatcher, resumeWatcher, registerChangeListener } = require('./fsWatcherService');
const shadowContinuousProducer = require('./shadowContinuousProducer');
const { LRUCache } = require('lru-cache');
const ySweetBridge = require('./ySweetBridge');
const { withTelemetry, getMetrics, resetMetrics, getEventLoopBlockCount } = require('./perfTelemetry');
const sseService = require('./sseService');
const persistence = require('./persistence');
const logger = require('./logger').child({ component: 'collab' });
const workspacePrepManager = require('./workspacePrepManager');
const { ensureRuntimeFilesystem } = require('./runtimeFilesystem');
const { createWorkspaceInstructionProjectionRuntime } = require('./workspaceInstructionProjectionRuntime');
const {
  prepareFileContentForIdeWrite,
  presentFileContentForIde,
  presentFileTreeForIde,
  shouldReconcileInstructionProjection,
} = require('./workspaceInstructionProjectionCollabAdapter');
const codeSiteActivityRegistry = require('./codesiteActivityRegistry');
const {
  assertCodeSiteWorkspaceMutationAllowedAsync,
  guardCodeSiteHostSurface,
  withCodeSiteBoundaryContext,
} = require('./codesiteActiveBoundary');
const workspaceInstructionProjectionRuntime = createWorkspaceInstructionProjectionRuntime({ logger });
const {
  configuredControlPlaneBaseUrl,
  trustedControlPlaneBaseUrl,
} = require('./codesiteControlPlaneTrust');
const {
  handleCodeSiteActivityRequest,
} = require('./codesiteActivityEndpoint');
const {
  handleCodeSiteReadinessRequest,
} = require('./codesiteReadiness');
const {
  handleCodeSiteDeploymentStatusRequest,
} = require('./codesiteDeploymentStatus');
const {
  codeSiteContextFromRequest,
  createCodeSiteOverlayWorkspace,
  codeSiteQuarantineReplayPlan,
  codeSiteRuntimeEnv,
  codeSiteRuntimeMetadata,
  createCodeSiteFS,
  createCodeSiteQuarantineWorkspace,
  deriveLineProvenanceFromContentChange,
  enforceCodeSiteWriteAllowed,
  enforceCodeSiteWritesAllowed,
  finalizeCodeSiteQuarantineWorkspace,
  isCodeSiteCommitBlockedError,
  isCodeSiteDeniedError,
  listCodeSiteQuarantineManifests,
  normalizeRepoRelativePath,
  readCodeSiteQuarantineManifest,
} = require('./codesiteFs');

function queueHeadlessCommandStart(ptyProcess, command) {
  const isWin = require('os').platform() === 'win32';
  const promptPattern = isWin ? /PS [^\r\n]*>/ : /[$#]\s*$/;
  let promptBuffer = '';
  let commandSent = false;
  let promptCheckInterval = null;
  let promptWaitTimeout = null;
  let resolveCommandStarted;

  const commandStartedPromise = new Promise((resolve) => {
    resolveCommandStarted = resolve;
  });

  const promptDisposable = ptyProcess.onData((data) => {
    if (commandSent) {
      return;
    }

    promptBuffer = `${promptBuffer}${data}`.slice(-16_384);
    if (promptPattern.test(promptBuffer)) {
      sendCommand();
    }
  });

  function cleanup() {
    if (promptCheckInterval) {
      clearInterval(promptCheckInterval);
      promptCheckInterval = null;
    }
    if (promptWaitTimeout) {
      clearTimeout(promptWaitTimeout);
      promptWaitTimeout = null;
    }
    try { promptDisposable.dispose?.(); } catch (_) {}
  }

  function sendCommand() {
    if (commandSent) {
      return;
    }

    commandSent = true;
    cleanup();
    ptyProcess.write(`${command}\r`);
    resolveCommandStarted();
  }

  promptCheckInterval = setInterval(() => {
    if (!commandSent && promptPattern.test(promptBuffer)) {
      sendCommand();
    }
  }, 100);
  if (typeof promptCheckInterval.unref === 'function') {
    promptCheckInterval.unref();
  }

  promptWaitTimeout = setTimeout(() => {
    if (!commandSent) {
      logger.info({ commandPreview: command.slice(0, 120) }, 'Prompt not detected, sending command anyway');
      sendCommand();
    }
  }, 1000);
  if (typeof promptWaitTimeout.unref === 'function') {
    promptWaitTimeout.unref();
  }

  ptyProcess.onExit(() => {
    if (!commandSent) {
      cleanup();
      resolveCommandStarted();
    }
  });

  return { commandStartedPromise };
}

// ── Container runtime (hybrid Phase 1) ───────────────────────────────────────
// ENABLE_CONTAINER_RUNTIME keeps the original opt-in behavior for ordinary
// terminals/programs. ENABLE_CODESITE_DOCKER_RUNTIME is default-on because active
// CodeSite managed sessions need a real Docker overlay boundary instead of a
// host-shell fallback.
const ENABLE_CONTAINER_RUNTIME = process.env.ENABLE_CONTAINER_RUNTIME === '1';
const ENABLE_CODESITE_DOCKER_RUNTIME = process.env.ENABLE_CODESITE_DOCKER_RUNTIME !== '0';
const ENABLE_WORKSPACE_RUNTIME = ENABLE_CONTAINER_RUNTIME || ENABLE_CODESITE_DOCKER_RUNTIME;
const workspaceRuntime = ENABLE_WORKSPACE_RUNTIME
  ? createRuntimeManager({
      docker: new (require('dockerode'))({
        socketPath: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock',
      }),
      logger,
    })
  : null;
const containerPortProxy = ENABLE_WORKSPACE_RUNTIME
  ? createContainerPortProxy({
      // Resolve the running runtime-container host for a slug. Dev is effectively
      // single-user per workspace, but CodeSite overlay sessions carry runtime
      // identity options, so ask the manager for explicit live session metadata.
      resolveHost: (slug) => {
        const sessions = typeof workspaceRuntime.listRuntimeSessions === 'function'
          ? workspaceRuntime.listRuntimeSessions()
          : [];
        const match = sessions.find((session) => session.slug === slug && session.mode === 'readwrite')
          || sessions.find((session) => session.slug === slug);
        return match?.host || null;
      },
      // Stream auto-login: hand the proxy the per-session KasmVNC credential so it
      // injects Authorization: Basic for webGui desktop streams (DBeaver/Postman).
      // Invoked at request time, after managedProgramRuntime is initialized.
      resolveStreamAuth: (slug, port) => managedProgramRuntime.resolveStreamAuth(slug, port),
    })
  : null;

// Phase 2b — detect ports opened by servers INSIDE the runtime container (e.g.
// `npm run dev` from the in-app terminal) and push the live set to the frontend
// Ports panel. Reads /proc/net/tcp[6] via runOnce; broadcasts over notifyWss.
const containerPortMonitor = ENABLE_WORKSPACE_RUNTIME
  ? createContainerPortMonitor({
      // Active runtime containers. Overlay sessions include runtimeOptions so
      // runOnce addresses the same isolated container identity.
      listContainers: () => (typeof workspaceRuntime.listRuntimeSessions === 'function'
        ? workspaceRuntime.listRuntimeSessions().map((session) => ({
            slug: session.slug,
            userId: session.userId,
            runtimeOptions: session.runtimeOptions || {},
          }))
        : []),
      runOnce: (slug, userId, argv, runtimeOptions) => workspaceRuntime.runOnce(slug, userId, argv, runtimeOptions),
      onPortsChanged: (slug, _userId, ports) => broadcastContainerPorts(slug, ports),
      logger,
    })
  : null;

// Slice 4 — detect ports opened INSIDE the per-workspace Sysbox runtime POD
// (k8s-exec /proc/net/tcp[6]) and surface them at /runtime/<scope>/port/<N>. Dark:
// only when RUNTIME_BACKEND=sysbox-pod. Reuses the same monitor (parse/baseline);
// the key is (slug, runtimeScope) — slug routes the broadcast, scope addresses the pod.
const runtimePortMonitor = isSysboxRuntimeEnabled()
  ? createContainerPortMonitor({
      listContainers: async () => {
        const sp = require('./spawner');
        if (typeof sp.listActiveRuntimeSessions !== 'function') return [];
        const sessions = await sp.listActiveRuntimeSessions();
        return sessions.map((s) => ({ slug: s.slug || s.runtimeScope, userId: s.runtimeScope }));
      },
      runOnce: (_slug, runtimeScope, argv) => runtimeRunOnce(runtimeScope, argv),
      onPortsChanged: (slug, runtimeScope, ports) => {
        broadcastRuntimePorts(slug, runtimeScope, ports);
        // Slice 1 (real programs): also light up the App/Ports surfaces of any
        // managed program session running in THIS runtime pod (scoped attribution).
        try { managedProgramRuntime.recomputeRuntimeScopePorts(runtimeScope, ports); }
        catch (err) { logger.warn({ err }, 'recomputeRuntimeScopePorts failed'); }
      },
      logger,
    })
  : null;

const managedProgramRuntime = createProgramRuntimeManager({
  activeSessions: terminalSessions,
  logger,
  onSessionEvent: (event) => {
    try {
      runtimeObservationPublisher.handleRuntimeEvent(event);
    } catch (_) { /* never let telemetry break the runtime */ }
  },
  getActivePorts: () => proxyService.getActivePorts(),
  launchRuntime: async ({ sessionId, workspaceSlug, userId, env, title, command, runtimeType, metadata, codesiteContext, activeWorkspacePath }) => {
    // Slice 1 (real programs): `container` programs route into the per-workspace
    // Sysbox runtime POD when the backend is on (its own validated, isolated
    // dockerd — precedence), else the dev-hybrid runtime container, else fail loud.
    // Everything else keeps the existing shared-collab headless PTY path.
    const codeSiteHybridAvailable = Boolean(workspaceRuntime) && Boolean(ENABLE_CONTAINER_RUNTIME || ENABLE_CODESITE_DOCKER_RUNTIME);
    const nonCodeSiteHybridAvailable = Boolean(workspaceRuntime) && ENABLE_CONTAINER_RUNTIME;
    const hasHybrid = codesiteContext?.active ? codeSiteHybridAvailable : nonCodeSiteHybridAvailable;
    const { target } = codeSiteProgramRuntimeTarget({
      codeSiteContext: codesiteContext,
      runtimeType,
      sysboxEnabled: isSysboxRuntimeEnabled(),
      hasHybrid,
    });
    if (target === 'sysbox-pod') {
      const sessions = typeof spawner.listActiveRuntimeSessions === 'function'
        ? await spawner.listActiveRuntimeSessions()
        : [];
      const runtimeScope = pickRuntimeScopeForSlug(sessions, workspaceSlug);
      if (!runtimeScope) throw new Error('runtime_pod_not_ready');
      return createRuntimePodProgram({ runtimeScope, workspaceSlug, userId, command, env });
    }
    if (target === 'hybrid') {
      let codeSiteQuarantine = null;
      let runtimeOptions = {};
      try {
        if (codesiteContext?.active) {
          await ensureRuntimeFilesystem({
            workspaceSlug,
            filesystemUserId: userId,
            runtimeScope: '',
            reason: 'program_runtime_hybrid',
            codesiteContext,
          });
          const cwd = await resolveWorkspaceCwd(workspaceSlug, userId);
          codeSiteQuarantine = await createCodeSiteOverlayWorkspace(codesiteContext, cwd, {
            operation: 'program-runtime',
            baseDir: codeSiteRuntimeQuarantineBaseDir(cwd),
          });
          runtimeOptions = {
            codesiteContext,
            codeSiteBaseRoot: codeSiteQuarantine?.baseRoot || codeSiteQuarantine?.originalCwd || '',
            codeSiteOverlayRoot: codeSiteQuarantine?.root || '',
            codeSiteOverlayUpperRoot: codeSiteQuarantine?.upperRoot || '',
            codeSiteOverlayWorkRoot: codeSiteQuarantine?.workRoot || '',
            codeSiteOverlayId: codeSiteQuarantine?.overlayId || codeSiteQuarantine?.quarantineId || '',
          };
        }
        await workspaceRuntime.ensureRuntimeContainer(workspaceSlug, userId, runtimeOptions);
        // The rootless dockerd inside the runtime container takes ~15-25s to be
        // ready; wait for it so the program's first `docker ...` command doesn't
        // race a not-yet-listening daemon.
        const ready = await workspaceRuntime.waitForRuntimeReady(workspaceSlug, userId, runtimeOptions);
        if (!ready) {
          const error = new Error('codesite_runtime_overlay_unavailable');
          error.code = 'CODESITE_RUNTIME_OVERLAY_UNAVAILABLE';
          throw error;
        }
        const handle = await workspaceRuntime.execInRuntime(workspaceSlug, userId, {
          command,
          env,
          tty: true,
          ...runtimeOptions,
        });
        return attachCodeSiteRuntimeQuarantineFinalizer(handle, codesiteContext, codeSiteQuarantine, {
          operation: 'program-runtime',
        });
      } catch (err) {
        if (codeSiteQuarantine) {
          await finalizeCodeSiteQuarantineWorkspace(codesiteContext, codeSiteQuarantine, {
            tool: 'program_runtime',
          }).catch((finalizeErr) => {
            logger.warn('codesite_program_runtime_quarantine_cleanup_failed', { err: finalizeErr?.message || finalizeErr });
          });
        }
        throw err;
      }
    }
    if (target === 'unavailable') {
      // container requested but no runtime exists — do NOT run in the docker-less
      // headless PTY (DOCKER_HOST is scrubbed there); surface a clear error.
      throw new Error('container_runtime_unavailable');
    }
    const runtime = await createHeadlessSession(sessionId, workspaceSlug, userId, 120, 30, title, {
      env,
      codesite: metadata?.codesite || null,
      codesiteContext,
      activeWorkspacePath,
    });
    const { commandStartedPromise } = queueHeadlessCommandStart(runtime.ptyProcess, command);
    return {
      ...runtime,
      commandStartedPromise,
    };
  },
});

// Continuous editor→disk flush: keep /workspace current for a running
// container/webGui program (e.g. DBeaver) that reads the same files as the
// editor, reusing flushWorkspaceDocsToDisk. Periodic while a session is active
// (self-terminating via the manager's session state) + prompt on save. Tracks
// only container/webGui sessions; env-gated (SYNTHI_CONTINUOUS_FLUSH_ENABLED /
// SYNTHI_FLUSH_INTERVAL_MS / SYNTHI_FLUSH_DEBOUNCE_MS) so it is a no-op otherwise.
const continuousFlush = createContinuousFlushService({
  flushFn: (slug, userId, scope) => flushWorkspaceDocsToDisk(slug, userId, scope),
  isSessionActive: (sessionId) =>
    managedProgramRuntime.getManagedSession(sessionId)?.state === 'running',
});

// ── User block list (in-memory) ──────────────────────────────────────────────
// blockedBy: userId → Set<blockedUserId>
// If user A blocks user B, blockedBy.get(A) contains B.
// This means B cannot: see A in presence, invite A, or join A's workspace.
const blockedBy = new Map();

let fetchFunc = null;
if (typeof fetch === 'function') {
  fetchFunc = fetch;
} else {
  try {
    fetchFunc = require('node-fetch');
  } catch (e) {
    fetchFunc = null;
  }
}

const CODE_INTEL_URL = config.CODE_INTEL_URL;

const PORT = config.PORT;

function normalizeBaseUrl(value, fallback) {
  const raw = String(value || fallback || '').trim();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

function publicAppBaseUrl() {
  return normalizeBaseUrl(
    process.env.SYNTHI_PUBLIC_APP_URL || process.env.SYNTHI_APP_URL,
    'http://localhost:3000',
  );
}

function internalAppBaseUrl() {
  return normalizeBaseUrl(
    process.env.SYNTHI_APP_INTERNAL_URL || process.env.SYNTHI_APP_URL,
    'http://localhost:3000',
  );
}

function makeInviteLink({ sessionId, inviteToken, roomCode, slug }) {
  const style = String(process.env.SYNTHI_INVITE_LINK_STYLE || 'slug').trim().toLowerCase();
  const useSlugPath = style !== 'legacy' && slug;
  const url = new URL(
    useSlugPath ? `/${encodeURIComponent(slug)}` : `/collab/${encodeURIComponent(sessionId)}`,
    publicAppBaseUrl(),
  );
  if (useSlugPath) url.searchParams.set('collab', sessionId);
  url.searchParams.set('token', inviteToken);
  if (roomCode) url.searchParams.set('code', roomCode);
  return url.toString();
}

// PERF: Bounded LRU cache replaces unbounded Map to prevent memory leak and
// GC pauses on long-running servers with many files.  1000 entries covers the
// active working set; 5-minute TTL evicts stale entries automatically.
const fileHashCache = new LRUCache({ max: 1000, ttl: 5 * 60 * 1000 }); // docName -> { hash, timestamp }

// Revert cooldown: after invalidateDocsForSlug, reject stale sync (save)
// requests for a short window.  Key = "slug:filePath", value = timestamp.
const revertCooldowns = new Map();
const REVERT_COOLDOWN_MS = 3000; // 3 seconds

// Files whose last GCS backup failed after all retries.  When set, the disk
// write succeeded but the durable off-site backup did not.  We track this so
// the client UI can surface a "backup degraded" indicator and so successive
// save attempts can emit status-change events (degraded → ok) as conditions
// recover.  Key = "slug:filePath", value = { at, error }.
// Bounded to prevent unbounded memory growth in long-running servers; stale
// entries expire after 24h since disk is the source of truth once recovered.
const gcsBackupDegraded = new LRUCache({ max: 10_000, ttl: 24 * 60 * 60 * 1000 });

// Periodically garbage-collect expired cooldowns so the map doesn't grow
// unboundedly on long-running servers.
setInterval(() => {
  if (revertCooldowns.size === 0) return;
  const now = Date.now();
  for (const [key, ts] of revertCooldowns) {
    if (now - ts > REVERT_COOLDOWN_MS * 2) revertCooldowns.delete(key);
  }
}, 30_000); // every 30 seconds

// ── Rate limiting + Origin allowlist ─────────────────────────────────────────
// Lightweight fixed-window token bucket keyed by IP (or IP + user).  Intended
// to stop accidental floods and casual abuse of public session endpoints;
// a real gateway/WAF is expected in production.
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new LRUCache({ max: 20_000, ttl: RATE_WINDOW_MS * 2 });

function checkRateLimit(key, limit) {
  const now = Date.now();
  const slot = Math.floor(now / RATE_WINDOW_MS);
  const bucketKey = `${slot}:${key}`;
  const count = (rateBuckets.get(bucketKey) || 0) + 1;
  rateBuckets.set(bucketKey, count);
  return count <= limit;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Parse comma-separated list once at startup.
const ALLOWED_ORIGINS = String(process.env.COLLAB_ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

/**
 * Enforce that non-GET/OPTIONS requests come from a trusted Origin, to block
 * casual CSRF.  If COLLAB_ALLOWED_ORIGINS is unset the server accepts any
 * origin (legacy behaviour) but still rejects cross-site requests that arrive
 * with an Origin header pointing at a different scheme+host than the request.
 *
 * Returns true if the request should proceed; false if the caller should
 * stop processing (the response is already written).
 */
function enforceOrigin(req, res) {
  if (req.method === 'GET' || req.method === 'OPTIONS') return true;
  const origin = req.headers.origin;
  // Same-origin browser requests from fetch() always include an Origin header;
  // server-to-server calls typically do not.  Require Origin for unsafe methods
  // so browser clients can't forge them from another tab.
  if (!origin) {
    // Allow if an explicit cross-service bypass header is configured, to
    // support service-to-service calls in trusted networks.
    if (hasTrustedInternalToken(req, { config })) {
      return true;
    }
    // When no allowlist is configured we keep legacy permissive behaviour.
    if (ALLOWED_ORIGINS.length === 0) return true;
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'origin_required' }));
    return false;
  }
  if (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(origin)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'origin_forbidden' }));
    return false;
  }
  return true;
}

function isLocalControlPlaneBypass() {
  return Boolean(
    config.SYNTHI_WORKSPACE_AUTH_BYPASS &&
    !process.env.KUBERNETES_SERVICE_HOST &&
    process.env.NODE_ENV !== 'production'
  );
}

function requireInternalControlPlaneToken(req, res) {
  if (hasTrustedInternalToken(req, { config }) || isLocalControlPlaneBypass()) {
    return true;
  }
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'forbidden', detail: 'internal token required' }));
  return false;
}

/**
 * Rate-limit guard.  If over budget, writes a 429 and returns false.
 * Scope keys help separate sensitive endpoints (knock, invite) from cheap ones.
 */
function rateLimitGuard(req, res, scope, limitPerMin) {
  const key = `${scope}:${clientIp(req)}`;
  if (checkRateLimit(key, limitPerMin)) return true;
  res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' });
  res.end(JSON.stringify({ error: 'rate_limited', scope }));
  return false;
}

function applyCollabGatewayAuthIdentity(parsed, auth) {
  if (!parsed || !auth || auth.source !== 'gateway') return parsed;
  if (auth.workspaceUserId) parsed.userId = auth.workspaceUserId;
  if (auth.filesystemUserId) parsed.filesystemUserId = auth.filesystemUserId;
  else if (auth.workspaceUserId && !parsed.filesystemUserId) parsed.filesystemUserId = auth.workspaceUserId;
  if (auth.runtimeScope) parsed.runtimeScope = auth.runtimeScope;
  if (auth.collabSessionId) parsed.collabSessionId = auth.collabSessionId;
  return parsed;
}

function requireCommandGatewayAuth(req, res, { slug, parsed, requiredScope = COMMAND_SCOPES.EXEC } = {}) {
  const auth = requireCollabGatewayAuth(req, res, {
    slug,
    parsed,
    requiredScope,
    config,
    sessionManager,
  });
  if (!auth) return null;
  applyCollabGatewayAuthIdentity(parsed, auth);
  return auth;
}

// Track which slugs have been hydrated from GCS this boot.
// Solves the case where a repo directory exists (e.g. from a prior run or
// background indexer) but its contents are stale/partial.  On first access
// per server lifetime we always call initRepo() which is idempotent (checks
// for .git before re-initialising) and merges GCS contents via downloadGcsToRepo().
// Keyed by "slug" for slug-level hydration and "slug:userId" for per-user repos.
const hydratedSlugs = new Set();
const purgedLegacyRooms = new Set();

/** Build a hydration key — includes userId when present. */
function hydrationKey(slug, userId) {
  return userId ? `${slug}:${userId}` : slug;
}

async function purgeLegacyRoomState(slug, filePath) {
  const legacyDoc = `workspace:${slug}:${filePath}`;
  if (purgedLegacyRooms.has(legacyDoc)) return;
  purgedLegacyRooms.add(legacyDoc);

  try {
    fileHashCache.delete(legacyDoc);
  } catch (_) {}
}

/**
 * Compute MD5 hash of content for change detection
 */
function computeHash(content) {
  return crypto.createHash('md5').update(content || '').digest('hex');
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueArray(values) {
  return [...new Set(arrayValue(values).filter(Boolean))];
}

function codeSiteWriteEvidence(payload = {}, derivedLineProvenance = []) {
  const explicitLineProvenance = arrayValue(
    payload.lineProvenance
    || payload.line_provenance
    || payload.hunks
    || payload.lineAnchors
    || payload.line_anchors,
  );
  return {
    lineProvenance: [...explicitLineProvenance, ...arrayValue(derivedLineProvenance)],
    evidenceRefs: arrayValue(payload.evidenceRefs || payload.evidence_refs),
    processAncestry: arrayValue(payload.processAncestry || payload.process_ancestry),
  };
}

function sha256TextDigest(value) {
  return sha256BufferDigest(Buffer.from(String(value ?? ''), 'utf8'));
}

function sha256BufferDigest(buffer) {
  return `sha256:${crypto.createHash('sha256').update(buffer || Buffer.alloc(0)).digest('hex')}`;
}

function decodeQuarantineReplayContent(change) {
  if (change.replayOperation === 'delete') {
    return { operation: 'delete', buffer: null, text: null, digest: null };
  }
  if (change.replayOperation === 'write_binary' || typeof change.afterBase64 === 'string') {
    const buffer = Buffer.from(String(change.afterBase64 || ''), 'base64');
    return { operation: 'write_binary', buffer, text: null, digest: sha256BufferDigest(buffer) };
  }
  const text = String(change.afterText ?? '');
  const buffer = Buffer.from(text, 'utf8');
  return { operation: 'write_text', buffer, text, digest: sha256BufferDigest(buffer) };
}

async function workspaceFileExists(repoRoot, filePath) {
  try {
    const relPath = normalizeRepoRelativePath(filePath);
    await fsPromises.stat(path.join(repoRoot, relPath));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.message === 'path_escape' || error?.message === 'path_required') {
      return false;
    }
    return false;
  }
}

async function readWorkspaceFileBuffer(repoRoot, filePath) {
  try {
    const relPath = normalizeRepoRelativePath(filePath);
    return await fsPromises.readFile(path.join(repoRoot, relPath));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.message === 'path_escape' || error?.message === 'path_required') {
      return null;
    }
    return null;
  }
}

function validateQuarantineReplayBase(change, currentBuffer, currentExists) {
  const currentDigest = currentBuffer ? sha256BufferDigest(currentBuffer) : null;
  const nextContent = decodeQuarantineReplayContent(change);
  const afterDigest = nextContent.digest;
  if (change.afterDigest && afterDigest && change.afterDigest !== afterDigest) {
    return {
      ok: false,
      reasonCodes: ['quarantine_replay_after_digest_mismatch'],
      currentDigest,
      afterDigest,
    };
  }
  if (change.afterDigest && nextContent.operation === 'delete' && change.afterDigest !== null) {
    return {
      ok: false,
      reasonCodes: ['quarantine_replay_delete_after_digest_mismatch'],
      currentDigest,
      afterDigest,
    };
  }
  if (change.beforeExists === false && currentExists) {
    return {
      ok: false,
      reasonCodes: ['quarantine_replay_base_exists'],
      currentDigest,
      afterDigest,
    };
  }
  if (change.beforeExists === true && !currentExists) {
    return {
      ok: false,
      reasonCodes: ['quarantine_replay_base_missing'],
      currentDigest,
      afterDigest,
    };
  }
  if (typeof change.beforeText === 'string') {
    const currentContent = currentBuffer ? currentBuffer.toString('utf8') : '';
    return currentExists && currentContent === change.beforeText
      ? { ok: true, currentDigest, afterDigest, operation: nextContent.operation, nextContent }
      : {
        ok: false,
        reasonCodes: ['quarantine_replay_base_mismatch'],
        currentDigest,
        expectedDigest: sha256TextDigest(change.beforeText),
        afterDigest,
      };
  }
  if (typeof change.beforeBase64 === 'string') {
    const expectedBuffer = Buffer.from(change.beforeBase64, 'base64');
    return currentExists && currentBuffer && currentBuffer.equals(expectedBuffer)
      ? { ok: true, currentDigest, afterDigest, operation: nextContent.operation, nextContent }
      : {
        ok: false,
        reasonCodes: ['quarantine_replay_base_mismatch'],
        currentDigest,
        expectedDigest: sha256BufferDigest(expectedBuffer),
        afterDigest,
      };
  }
  if (change.beforeDigest) {
    return currentDigest === change.beforeDigest
      ? { ok: true, currentDigest, afterDigest, operation: nextContent.operation, nextContent }
      : {
        ok: false,
        reasonCodes: ['quarantine_replay_base_mismatch'],
        currentDigest,
        expectedDigest: change.beforeDigest,
        afterDigest,
      };
  }
  if (nextContent.operation === 'delete') {
    return {
      ok: false,
      reasonCodes: ['quarantine_replay_delete_base_evidence_required'],
      currentDigest,
      afterDigest,
    };
  }
  if (String(change.kind || '').toLowerCase() === 'created' && currentExists) {
    return {
      ok: false,
      reasonCodes: ['quarantine_replay_base_exists'],
      currentDigest,
      afterDigest,
    };
  }
  return { ok: true, currentDigest, afterDigest, operation: nextContent.operation, nextContent };
}

function selectedQuarantinePathSet(parsed = {}) {
  const requestedPaths = new Set(arrayValue(parsed.paths || parsed.selectedPaths || parsed.selected_paths)
    .map((item) => {
      try { return normalizeRepoRelativePath(item); } catch (_) { return null; }
    })
    .filter(Boolean));
  if (!requestedPaths.size) {
    const error = new Error('missing_selected_paths');
    error.code = 'MISSING_SELECTED_PATHS';
    throw error;
  }
  return requestedPaths;
}

function selectedQuarantineChanges(manifest, parsed = {}, requestedPaths = null) {
  const selectedPaths = requestedPaths || selectedQuarantinePathSet(parsed);
  const changes = arrayValue(manifest?.changes);
  return changes.filter((change) => selectedPaths.has(change.path || change.quarantineEvidence?.path));
}

function quarantineManifestEventDetails(manifest = {}) {
  const changes = arrayValue(manifest.changes).map((change) => {
    const evidence = change.quarantineEvidence || {};
    return {
      path: change.path || evidence.path || null,
      kind: change.kind || evidence.kind || null,
      beforeDigest: change.beforeDigest || evidence.beforeDigest || null,
      afterDigest: change.afterDigest || evidence.afterDigest || null,
      evidenceRef: evidence.evidenceRef || change.evidenceRef || null,
      quarantineId: change.quarantineId || evidence.quarantineId || manifest.quarantineId || null,
    };
  }).filter((change) => change.path);
  return {
    manifestPaths: uniqueArray(changes.map((change) => change.path)),
    manifestChanges: changes,
    manifestChangeCount: changes.length,
    symlinkSanitization: manifest.symlinkSanitization || null,
  };
}

async function codeSiteQuarantineStorageForRequest(slug, filesystemUserId, runtimeScope, reason, codeSiteContext = null, options = {}) {
  if (options.ensureRuntime !== false) {
    await ensureRuntimeFilesystem({
      workspaceSlug: slug,
      filesystemUserId,
      runtimeScope,
      reason,
      codesiteContext: codeSiteContext?.active ? codeSiteContext : null,
    });
  }
  const cwd = await resolveWorkspaceCwd(slug, filesystemUserId);
  const baseDir = codeSiteRuntimeQuarantineBaseDir(cwd)
    || path.join(require('os').tmpdir(), 'synthi-codesitefs-quarantine');
  return {
    cwd,
    baseDir,
    repoRoot: gitService.getEffectiveRepoPath(slug, filesystemUserId),
  };
}

async function prepareCodeSiteQuarantineReplayPlan({
  slug,
  changes,
  repoRoot,
  effectiveUserId,
  evidenceRefs = [],
  processAncestry = [],
  ancestryLabel = 'collab-server:codesitefs-quarantine-replay',
}) {
  const replayPlan = codeSiteQuarantineReplayPlan(changes);
  const rejected = [...replayPlan.rejected];
  const prepared = [];
  if (!replayPlan.changes.length && !rejected.length) {
    rejected.push({
      ok: false,
      index: null,
      path: null,
      reasonCodes: ['quarantine_replay_no_changes_selected'],
    });
  }
  if (rejected.length) {
    return { replayPlan, prepared, rejected };
  }
  for (const change of replayPlan.changes) {
    const currentBuffer = await readWorkspaceFileBuffer(repoRoot, change.path);
    const currentContent = currentBuffer ? currentBuffer.toString('utf8') : '';
    const currentExists = await workspaceFileExists(repoRoot, change.path);
    const validation = validateQuarantineReplayBase(change, currentBuffer, currentExists);
    const changeEvidenceRefs = uniqueArray([
      ...arrayValue(evidenceRefs),
      ...arrayValue(change.evidenceRefs),
      change.evidenceRef,
    ]);
    const changeProcessAncestry = uniqueArray([
      ...arrayValue(processAncestry),
      ancestryLabel,
    ]);
    if (!validation.ok) {
      rejected.push({
        ok: false,
        index: change.index,
        path: change.path,
        kind: change.kind,
        reasonCodes: validation.reasonCodes,
        currentDigest: validation.currentDigest,
        expectedDigest: validation.expectedDigest || change.beforeDigest || null,
        afterDigest: validation.afterDigest || change.afterDigest || null,
        evidenceRef: change.evidenceRef,
        quarantineId: change.quarantineId || null,
      });
      continue;
    }
    const lineProvenance = quarantineReplayLineProvenance(change, currentContent, validation, {
      evidenceRefs: changeEvidenceRefs,
      processAncestry: changeProcessAncestry,
    });
    prepared.push({
      change,
      operation: validation.operation,
      currentContent,
      currentBuffer,
      currentExists,
      validation,
      evidenceRefs: changeEvidenceRefs,
      processAncestry: changeProcessAncestry,
      lineProvenance,
    });
  }
  return { replayPlan, prepared, rejected };
}

function quarantineReplayLineProvenance(change, currentContent, validation, options = {}) {
  if (validation.operation === 'write_text' || validation.operation === 'delete') {
    return deriveLineProvenanceFromContentChange(
      change.path,
      currentContent,
      validation.operation === 'delete' ? '' : validation.nextContent.text,
      {
        evidenceRefs: options.evidenceRefs,
        processAncestry: options.processAncestry,
        promptSummary: validation.operation === 'delete'
          ? 'Apply reviewed CodeSiteFS quarantine delete'
          : 'Apply reviewed CodeSiteFS quarantine text change',
        reasonRef: `quarantine-review-apply:${change.evidenceRef || change.path}`,
      },
    );
  }
  return [{
    filePath: change.path,
    startLine: 1,
    endLine: 1,
    lineAnchor: `${change.path}#L1-L1`,
    reasonRef: `quarantine-review-apply:${change.evidenceRef || change.path}`,
    evidenceRefs: options.evidenceRefs,
    processAncestry: options.processAncestry,
    promptSummary: 'Apply reviewed CodeSiteFS quarantine binary change',
  }];
}

function quarantineReplayAttempt(item) {
  return {
    path: item.change.path,
    kind: 'quarantine-review-apply',
    tool: item.operation === 'delete' ? 'file_delete' : 'file_write',
    evidenceRefs: item.evidenceRefs,
    processAncestry: item.processAncestry,
    lineProvenance: item.lineProvenance,
  };
}

async function applyQuarantineReplayItem(slug, item, effectiveUserId) {
  if (item.operation === 'delete') {
    await withTelemetry('fs:delete', () => gitService.deleteFile(slug, item.change.path, effectiveUserId));
    return;
  }
  const nextContent = item.validation.nextContent;
  await withTelemetry('fs:write', () => gitService.writeFile(
    slug,
    item.change.path,
    item.operation === 'write_binary' ? nextContent.buffer : nextContent.text,
    effectiveUserId,
  ));
}

function quarantineReplayAppliedRecord(item) {
  return {
    path: item.change.path,
    kind: item.change.kind,
    operation: item.operation,
    beforeDigest: item.validation.currentDigest,
    afterDigest: item.validation.afterDigest,
    evidenceRef: item.change.evidenceRef,
    lineProvenanceCount: item.lineProvenance.length,
  };
}

function codeSiteControlPlaneBaseUrl(context = {}) {
  const workspaceSlug = context.workspaceSlug || context.slug || '';
  if (context.controlPlaneUrl) {
    return trustedControlPlaneBaseUrl(context.controlPlaneUrl, workspaceSlug, {
      controlPlaneTrusted: context.controlPlaneTrusted,
    });
  }
  return configuredControlPlaneBaseUrl(workspaceSlug);
}

async function recordCodeSiteQuarantineTimelineEvent(context, eventType, body = {}) {
  if (!context?.active || !context.transactionId) return null;
  const baseUrl = codeSiteControlPlaneBaseUrl(context);
  if (!baseUrl || typeof fetch !== 'function') return null;
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  const token = context.authToken || process.env.SYNTHI_CODESITE_TOKEN;
  const cookie = context.cookie || process.env.SYNTHI_CODESITE_COOKIE;
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${baseUrl}/transactions/${encodeURIComponent(context.transactionId)}/quarantine-events`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...body,
      eventType,
    }),
  });
  const text = await response.text().catch(() => '');
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (_) {
    parsed = { raw: text };
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: parsed.error || parsed.message || 'codesite_quarantine_event_failed',
    };
  }
  return parsed.event || parsed;
}

async function readWorkspaceFileForLineProvenance(slug, filePath, userId) {
  try {
    return await gitService.readFile(slug, filePath, userId);
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    return '';
  }
}

async function deriveCodeSiteLineProvenance(slug, filePath, nextContent, userId, options = {}) {
  if (typeof nextContent !== 'string') return [];
  const previousContent = typeof options.previousContent === 'string'
    ? options.previousContent
    : await readWorkspaceFileForLineProvenance(slug, filePath, userId);
  return deriveLineProvenanceFromContentChange(filePath, previousContent, nextContent, {
    evidenceRefs: options.evidenceRefs,
    processAncestry: options.processAncestry,
    promptSummary: options.promptSummary,
    reasonRef: options.reasonRef,
  });
}

/**
 * Build a deterministic Yjs room/doc name.
 * v2 format:
 *   workspace:<slug>:user:<encodedUserId>:<filePath>
 *   workspace:<slug>:session:<sessionId>:<filePath>
 * legacy v1 format (read-only compatibility):
 *   workspace:<slug>:<filePath>
 *
 * Direct-access model: userId takes priority over sessionId because
 * guests now share the host's user-scoped rooms, not session-scoped rooms.
 */
function buildDocName(slug, filePath, { userId = null, sessionId = null } = {}) {
  const safePath = filePath || 'root';
  if (userId) {
    return `workspace:${slug}:user:${encodeURIComponent(String(userId))}:${safePath}`;
  }
  if (sessionId) {
    return `workspace:${slug}:session:${sessionId}:${safePath}`;
  }
  return `workspace:${slug}:${safePath}`;
}

/**
 * Parse a Yjs room/doc name.
 */
function parseDocName(docName) {
  if (!docName || !docName.startsWith('workspace:')) return null;

  const body = docName.slice('workspace:'.length);
  const firstColon = body.indexOf(':');
  if (firstColon <= 0) return null;

  const slug = body.slice(0, firstColon);
  const remainder = body.slice(firstColon + 1);

  if (remainder.startsWith('user:')) {
    const afterTag = remainder.slice('user:'.length);
    const userSep = afterTag.indexOf(':');
    if (userSep <= 0) return null;
    const encodedUserId = afterTag.slice(0, userSep);
    const filePath = afterTag.slice(userSep + 1);
    if (!filePath) return null;
    return {
      slug,
      filePath,
      scopeType: 'user',
      userId: decodeURIComponent(encodedUserId),
      sessionId: null,
      isLegacy: false,
    };
  }

  if (remainder.startsWith('session:')) {
    const afterTag = remainder.slice('session:'.length);
    const sessionSep = afterTag.indexOf(':');
    if (sessionSep <= 0) return null;
    const sessionId = afterTag.slice(0, sessionSep);
    const filePath = afterTag.slice(sessionSep + 1);
    if (!filePath) return null;
    return {
      slug,
      filePath,
      scopeType: 'session',
      sessionId,
      userId: null,
      isLegacy: false,
    };
  }

  // Legacy v1 room (workspace:<slug>:<filePath>)
  return {
    slug,
    filePath: remainder,
    scopeType: 'legacy',
    userId: null,
    sessionId: null,
    isLegacy: true,
  };
}

function resolveEffectiveUserForDoc(parsed, fallbackUserId = null) {
  if (!parsed) return fallbackUserId || null;
  if (parsed.scopeType === 'user') return parsed.userId || fallbackUserId || null;
  if (parsed.scopeType === 'session') {
    const session = parsed.sessionId ? sessionManager.getSession(parsed.sessionId) : null;
    return session?.hostId || fallbackUserId || null;
  }
  return fallbackUserId || null;
}

function getWsQueryParams(reqUrl) {
  try {
    const params = new URLSearchParams((reqUrl || '').split('?')[1] || '');
    return {
      userId: params.get('userId') || null,
      sessionId: params.get('sessionId') || null,
    };
  } catch (_) {
    return { userId: null, sessionId: null };
  }
}

function validateDocAccess(parsedDoc, { userId, sessionId }) {
  if (!parsedDoc) return { ok: false, status: 400, reason: 'invalid_doc_name' };
  if (!userId) return { ok: false, status: 401, reason: 'user_required' };

  if (parsedDoc.scopeType === 'session') {
    if (!sessionId || sessionId !== parsedDoc.sessionId) {
      return { ok: false, status: 403, reason: 'session_mismatch' };
    }
    const session = sessionManager.getSession(sessionId);
    if (!session) return { ok: false, status: 404, reason: 'session_not_found' };
    if (session.slug !== parsedDoc.slug) {
      return { ok: false, status: 403, reason: 'session_slug_mismatch' };
    }
    if (!sessionManager.checkPermission(sessionId, userId, 'canEdit')) {
      return { ok: false, status: 403, reason: 'edit_permission_required' };
    }
    return { ok: true };
  }

  if (parsedDoc.scopeType === 'user') {
    // Owner of this user-scoped room → always allowed
    if (parsedDoc.userId === userId) {
      return { ok: true };
    }
    // Guest accessing the host's user-scoped room (direct-access model):
    // the connecting user must be an actual registered guest of a session
    // owned by parsedDoc.userId, pointing at the same slug, AND hold the
    // canEdit permission.  We explicitly re-verify guest membership rather
    // than relying on checkPermission alone so that an attacker cannot
    // access another host's room by smuggling a sessionId they aren't part
    // of.
    const verify = (session, verifiedSessionId) => {
      if (!session) return null;
      if (session.status && session.status !== 'active') return null;
      if (session.hostId !== parsedDoc.userId) return null;
      if (session.slug !== parsedDoc.slug) return null;
      // Guests can be a Map (internal) or Array (serialized) — support both.
      let isGuest = false;
      if (session.guests instanceof Map) {
        isGuest = session.guests.has(userId);
      } else if (Array.isArray(session.guests)) {
        isGuest = session.guests.some(g => g && g.guestId === userId);
      }
      if (!isGuest) return null;
      if (!sessionManager.checkPermission(verifiedSessionId, userId, 'canEdit')) {
        return { ok: false, status: 403, reason: 'edit_permission_required' };
      }
      return { ok: true };
    };

    if (sessionId) {
      const session = sessionManager.getSession(sessionId);
      const r = verify(session, sessionId);
      if (r) return r;
    }
    // Also check if the user is a guest anywhere whose host matches the room
    const hostInfo = sessionManager.getHostForGuest(userId);
    if (hostInfo && hostInfo.hostId === parsedDoc.userId && hostInfo.slug === parsedDoc.slug) {
      const guestSessionId = hostInfo.sessionId;
      const session = sessionManager.getSession(guestSessionId);
      const r = verify(session, guestSessionId);
      if (r) return r;
    }
    return { ok: false, status: 403, reason: 'user_scope_mismatch' };
  }

  // Legacy rooms are denied in strict per-user mode.
  return { ok: false, status: 410, reason: 'legacy_room_unsupported' };
}

/**
 * Get the actual file content from disk.
 * When userId is provided, reads from the per-user repo; otherwise falls
 * back to the slug-level repo.
 */
async function getActualFileContent(slug, filePath, userId, options = {}) {
  try {
    return await gitService.readFile(slug, filePath, userId, options);
  } catch (e) {
    console.log(`[Collab] Could not read file ${slug}/${filePath}:`, e.code || e.message);
    return null;
  }
}

/**
 * Canonical text type name used by the Monaco client binding.
 * All server-side logic must use this consistently.
 */
const YTEXT_TYPE = 'monaco';

/**
 * Get content from a Yjs document's canonical text type.
 */
function getYDocContent(ydoc) {
  try {
    const text = ydoc.getText(YTEXT_TYPE);
    return text.length > 0 ? text.toString() : '';
  } catch (e) {
    return '';
  }
}

// ─── Y-Sweet handles CRDT relay + persistence ───────────────────────────────
// ValidatingPersistence, y-websocket, and LevelDB have been replaced by
// Y-Sweet (a standalone Yrs/Rust CRDT server). The collab server is now
// stateless: REST API + git + terminal + GCS file sync + sessions.
//
// flushDocToDisk() is retained as a lightweight helper that writes content
// to disk + GCS when the client explicitly saves (the 'sync' REST action
// already passes content in the request body).

/**
 * Write file content to the scoped git working tree + GCS.
 * Called from the 'sync' REST action (explicit save).
 *
 * @param {string} docName – Yjs room name (workspace:slug:user:uid:path)
 * @param {{ contentOverride?: string }} options
 */
async function flushDocToDisk(docName, options = {}) {
  const parsed = parseDocName(docName);
  if (!parsed) return;

  const { slug, filePath, userId: docUserId, sessionId: docSessionId } = parsed;
  let effectiveUserId = docUserId || null;

  if (docSessionId && !effectiveUserId) {
    const session = sessionManager.getSession(docSessionId);
    if (!session) throw new Error(`Session ${docSessionId} not found for doc ${docName}`);
    effectiveUserId = session.hostId;
  }
  if (!effectiveUserId) throw new Error(`Refusing unscoped flush for doc ${docName}`);

  // Content is always provided by the client via the 'sync' REST body.
  // Fallback: read from Y-Sweet if not provided (pre-stage flush).
  let content = typeof options.contentOverride === 'string'
    ? options.contentOverride
    : null;

  if (content == null) {
    content = await ySweetBridge.readDocContent(docName);
  }
  if (content == null) return;
  // The CRDT and durable editor backup keep user-visible bytes. A passive
  // instruction projection adds a terminal-only block only at disk-write time.
  const diskContent = typeof options.physicalContentOverride === 'string'
    ? options.physicalContentOverride
    : content;

  // 1. GCS sync (durable store)
  if (config.GCS_SYNC_ON_FLUSH && gcsSync && typeof gcsSync.isGcsConfigured === 'function' && gcsSync.isGcsConfigured()) {
    try {
      await gcsSync.syncFileToGcs(slug, filePath, content, effectiveUserId);
      // Clear any previous degraded-backup marker on success
      if (gcsBackupDegraded.delete(`${slug}:${filePath}`)) {
        broadcastBackupStatus(slug, filePath, 'ok', { userId: effectiveUserId });
      }
    } catch (e) {
      // All retries exhausted — user's local disk write succeeded but the
      // durable GCS backup failed.  Surface this as a structured warning
      // so the client can show a "backup degraded" indicator, and emit
      // telemetry so operators can diagnose systemic outages.
      console.error(`[Collab Flush] GCS sync exhausted retries for ${slug}/${filePath}:`, e?.message || e);
      gcsBackupDegraded.set(`${slug}:${filePath}`, { at: Date.now(), error: e?.message || String(e) });
      broadcastBackupStatus(slug, filePath, 'degraded', {
        userId: effectiveUserId,
        reason: e?.message || 'gcs_sync_failed',
      });
    }
  }

  // 2. Disk write to the scoped repo (atomic via temp+rename, with verification)
  // Seed a pre-edit baseline snapshot the first time we save a file, so the
  // version history always contains the point you can "go back to the
  // original" from.  Without this, the very first saved version IS already
  // the user's edited content, and there's nothing to revert to.
  //
  // ORDER MATTERS: we MUST read the prior disk content BEFORE calling
  // gitService.writeFile, otherwise the read sees the freshly-written new content
  // and `prior === content` short-circuits the baseline seed.  An earlier
  // version relied on gitService.syncFile() happening in the caller, which
  // broke this ordering and meant the very first saved version was always
  // the edited content with nothing to revert to.
  const repoPath = gitService.getEffectiveRepoPath(slug, effectiveUserId);
  const fullPath = path.join(repoPath, filePath);
  let priorContent = '';
  try {
    const prior = await fsPromises.readFile(fullPath, 'utf8');
    priorContent = prior;
    if (prior !== diskContent) {
      const priorHash = computeHash(prior);
      const existingCount = await persistence.countFileVersions(slug, filePath);
      if (existingCount === 0) {
        await persistence.saveFileVersion(slug, filePath, {
          userId: effectiveUserId,
          sessionId: docSessionId || null,
          hash: priorHash,
          content: prior,
          ts: Date.now() - 1,
        });
      }
    }
  } catch (err) {
    // File didn't exist yet (brand new file) or unreadable — nothing to snapshot.
    if (err && err.code !== 'ENOENT') {
      logger.warn('version_baseline_read_failed', { slug, filePath }, err);
    }
  }
  const derivedLineProvenance = deriveLineProvenanceFromContentChange(filePath, priorContent, diskContent, {
    evidenceRefs: options.evidenceRefs,
    processAncestry: options.processAncestry,
    promptSummary: 'Yjs save flushed to disk',
    reasonRef: `yjs_flush:${filePath}`,
  });
  await runCodeSiteMutationBoundary(options.codesiteContext, {
    operation: 'yjs_flush',
    tool: 'file_write',
    attempts: [{
      path: filePath,
      kind: 'yjs_flush',
      tool: 'file_write',
      ...codeSiteWriteEvidence(options, derivedLineProvenance),
    }],
  }, async () => gitService.writeFile(slug, filePath, diskContent, effectiveUserId), {
    repoRoot: repoPath,
    workspaceSlug: slug,
  });

  // Update hash cache
  fileHashCache.set(docName, { hash: computeHash(content), timestamp: Date.now() });

  // Optional: code-intel indexing
  if (config.CODE_INTEL_AUTO_INDEX && fetchFunc && CODE_INTEL_URL) {
    try {
      fetchFunc(`${CODE_INTEL_URL}/code-intel/index/file`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.AI_BACKEND_AUTH_TOKEN ? { 'x-synthi-internal-token': config.AI_BACKEND_AUTH_TOKEN } : {}),
        },
        body: JSON.stringify({ workspace_path: slug, file_path: filePath }),
      }).catch(() => {});
    } catch (_) { /* non-fatal */ }
  }

  broadcastGitStatusChanged(slug, filePath, { userId: effectiveUserId, sessionId: docSessionId || null });
  broadcastFileSaved(slug, filePath, { userId: effectiveUserId, sessionId: docSessionId || null });

  // Record a durable save-point: an append-only activity entry plus a
  // versioned snapshot of the content.  Both land in Redis when available
  // (see persistence.js), so users can see who saved when and recover
  // overwritten content even after Monaco's local undo is gone.
  const contentHash = computeHash(content);
  persistence.logFileEvent(slug, filePath, {
    kind: 'saved',
    userId: effectiveUserId,
    sessionId: docSessionId || null,
    hash: contentHash,
    size: Buffer.byteLength(content, 'utf8'),
  });
  persistence.saveFileVersion(slug, filePath, {
    userId: effectiveUserId,
    sessionId: docSessionId || null,
    hash: contentHash,
    content,
  });

  logger.info('file_saved', {
    slug,
    filePath,
    userId: effectiveUserId,
    sessionId: docSessionId || null,
    size: content.length,
  });
}

const workspaceManager = require('./workspaceManager');
const spawner = require('./spawner');

// ── In-memory userId → displayName cache ──────────────────────────────────
// Populated from Yjs awareness state changes so that REST endpoints can
// resolve human-readable names in O(1) instead of iterating all docs.
const userDisplayNameCache = new Map(); // Map<userId, { name: string, avatar: string }>

/**
 * Update the display name cache from a doc's awareness states.
 * Called whenever a Yjs doc's awareness changes.
 */
function refreshUserNameCache(awareness) {
  if (!awareness) return;
  for (const [, state] of awareness.getStates()) {
    if (state?.user?.id && state.user.name) {
      userDisplayNameCache.set(String(state.user.id), {
        name: state.user.name,
        avatar: state.user.image || '',
      });
    }
  }
}

/**
 * Invalidate all active Yjs documents for a workspace slug.
 * Called after git operations that modify files on disk (checkout, pull, discard).
 * This ensures the next WebSocket connection for each file triggers a fresh
 * bindState with the new disk content.
 *
 * @param {string} slug - Workspace slug
 * @param {string[]} [filePaths] - Specific file paths to invalidate. If empty/null, invalidates ALL docs for the slug.
 */

/**
 * Validate a client-provided file path to prevent path-traversal attacks.
 * Returns the normalized path or throws on invalid input.
 * Rules:
 *  - Must be a non-empty string
 *  - No null bytes
 *  - After normalization, must not start with / or contain ..
 *  - Must not contain backslashes (Windows-style traversal)
 */
function validateFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('filePath is required and must be a non-empty string');
  }
  if (filePath.includes('\0')) {
    throw new Error('filePath must not contain null bytes');
  }
  // Normalize to forward slashes and resolve . / ..
  const normalized = path.posix.normalize(filePath.replace(/\\/g, '/'));
  if (normalized.startsWith('/') || normalized.startsWith('..') || normalized.includes('/../')) {
    throw new Error(`filePath traversal rejected: ${filePath}`);
  }
  return normalized;
}

function writeCodeSiteDenied(res, err) {
  res.writeHead(err.status || 403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: 'codesite_write_denied',
    message: err.message,
    event: err.event,
  }));
}

function codeSiteEnforceOptions(context, options = {}) {
  if (!context?.active || context.mode === 'monitor') return options;
  return {
    ...options,
    requireAuthoritativeContext: true,
  };
}

async function runCodeSiteMutationBoundary(context, operation, applyFn, options = {}) {
  await assertCodeSiteWorkspaceMutationAllowedAsync(options.workspaceSlug || context?.workspaceSlug, context, operation, {
    surface: options.surface || operation.operation || operation.kind,
    controlPlaneUrl: options.controlPlaneUrl || context?.controlPlaneUrl,
    controlPlaneTrusted: options.controlPlaneTrusted || context?.controlPlaneTrusted,
    fetch: options.fetch || options.codesiteFetch || options.codeSiteFetch,
    authToken: options.authToken || context?.authToken,
    cookie: options.cookie || context?.cookie,
  });
  const codesiteFs = createCodeSiteFS(context, codeSiteEnforceOptions(context, options));
  return withCodeSiteBoundaryContext(
    context,
    () => codesiteFs.run(operation, applyFn, options),
    {
      operation: operation.operation || operation.kind || options.surface || 'workspace_mutation',
      source: 'collab-server',
    },
  );
}

async function runCodeSiteGitMutationBoundary(context, action, attempts, applyFn, options = {}) {
  return runCodeSiteMutationBoundary(context, {
    operation: `git:${action}`,
    tool: attempts?.[0]?.tool || 'git_worktree',
    attempts,
  }, applyFn, options);
}

function codeSiteProvisioningAttempt(kind) {
  return {
    path: '**',
    kind,
    tool: 'git_provisioning',
  };
}

async function enforceCodeSiteProvisioningAllowed(context, kind, options = {}) {
  await assertCodeSiteWorkspaceMutationAllowedAsync(options.workspaceSlug || context?.workspaceSlug, context, codeSiteProvisioningAttempt(kind), {
    surface: kind,
    controlPlaneUrl: options.controlPlaneUrl || context?.controlPlaneUrl,
    controlPlaneTrusted: options.controlPlaneTrusted || context?.controlPlaneTrusted,
    fetch: options.fetch || options.codesiteFetch || options.codeSiteFetch,
    authToken: options.authToken || context?.authToken,
    cookie: options.cookie || context?.cookie,
  });
  if (!context?.active) return null;
  return enforceCodeSiteWriteAllowed(
    context,
    codeSiteProvisioningAttempt(kind),
    codeSiteEnforceOptions(context, options),
  );
}

function codeSiteArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function codeSiteProvisioningOptions(context, options = {}) {
  return {
    ...codeSiteEnforceOptions(context, options),
    codesiteContext: context,
    evidenceRefs: [
      ...codeSiteArray(options.evidenceRefs),
      'collab:git-provisioning',
    ],
    processAncestry: [
      ...codeSiteArray(options.processAncestry),
      'collab-server:git-provisioning',
    ],
  };
}

function codeSiteGitServiceOptions(context, action, options = {}) {
  return {
    ...codeSiteEnforceOptions(context, options),
    codesiteContext: context,
    evidenceRefs: [
      ...codeSiteArray(options.evidenceRefs),
      `collab:git:${action}`,
    ],
    processAncestry: [
      ...codeSiteArray(options.processAncestry),
      `collab-server:git:${action}`,
    ],
  };
}

function needsCodeSiteUserRepoProvisioning(slug, userId) {
  if (!userId) return false;
  try {
    return !gitService.isUserRepoInitialized(slug, userId);
  } catch (_) {
    return true;
  }
}

function runtimeCodeSiteContext(req, parsed = {}, extra = {}) {
  return codeSiteContextFromRequest(req, parsed, {
    workspaceSlug: extra.workspaceSlug,
    actorUserId: extra.actorUserId || parsed.userId || parsed.actorUserId || '',
    effectiveUserId: extra.effectiveUserId || parsed.filesystemUserId || parsed.userId || '',
  });
}

async function readJsonRequestBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (!body.trim()) return {};
  return JSON.parse(body);
}

function writeJsonResponse(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function runtimeCodeSiteEnv(context, processAncestry) {
  return codeSiteRuntimeEnv(context, { processAncestry });
}

function codeSiteRuntimeQuarantineBaseDir(cwd) {
  const dataRoot = process.env.DATA_ROOT || process.env.WORKSPACE_DATA_VOLUME_ROOT || '';
  if (dataRoot) return path.posix.join(path.posix.resolve(dataRoot), 'codesitefs-quarantine');
  if (cwd) return path.join(path.dirname(cwd), '.synthi', 'codesitefs-quarantine');
  return path.join(require('os').tmpdir(), 'synthi-codesitefs-quarantine');
}

function attachCodeSiteRuntimeQuarantineFinalizer(handle, codeSiteContext, quarantine, details = {}) {
  if (!handle || !quarantine) return handle;
  let finalized = false;
  const finalize = async (extra = {}) => {
    if (finalized) return null;
    finalized = true;
    return finalizeCodeSiteQuarantineWorkspace(codeSiteContext, quarantine, {
      tool: 'program_runtime',
      ...details,
      ...extra,
    });
  };
  return {
    ...handle,
    codesiteQuarantine: quarantine,
    finalizeCodeSiteQuarantine: finalize,
    stop: async () => {
      let stopError = null;
      try { handle.stop?.(); } catch (err) { stopError = err; }
      const result = await finalize({ reason: 'runtime_stop' });
      if (stopError) throw stopError;
      return result;
    },
  };
}

function writeCodeSiteRuntimeBlocked(res, codeSiteMetadata, surface) {
  res.writeHead(409, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: 'codesite_runtime_quarantine_unavailable',
    message: 'CodeSite runtime blocked: this runtime target cannot mount a transaction quarantine workspace.',
    surface,
    codesite: codeSiteMetadata,
  }));
}

function writeCodeSiteManagedContextRequired(res, codeSiteMetadata, surface) {
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: 'codesite_managed_context_required',
    message: 'Managed agent runtime requests require an active CodeSite transaction before they can execute against a workspace.',
    surface,
    codesite: codeSiteMetadata,
  }));
}

function requiresCodeSiteManagedRuntimeContext(context) {
  return Boolean(context?.managedAgent && !context.transactionId);
}

function guardCodeSiteRuntimeHostSurface(slug, context, surface) {
  return guardCodeSiteHostSurface({
    workspaceSlug: slug,
    context,
    surface,
    operation: {
      operation: surface,
      tool: 'raw_terminal',
      attempts: [{ path: '**', tool: 'raw_terminal' }],
    },
  });
}

/**
 * Force-flush any in-memory Yjs document content for a specific file to disk.
 * Called before selective staging (git apply) so the patch always matches the
 * actual file on disk, preventing "patch does not apply" errors caused by
 * unflushed editor changes.
 *
 * @param {string} slug - workspace slug
 * @param {string} filePath - file path within the repo
 * @param {object} scope - { userId, sessionId } for doc name matching
 */
async function flushYjsDocForFile(slug, filePath, scope = {}) {
  if (!slug || !filePath) return;

  // Read current CRDT content from Y-Sweet and write to the git worktree.
  // This ensures the on-disk content matches the editor state before git ops.
  const docName = buildDocName(slug, filePath, scope);
  // Prefer the LIVE editor doc: the frontend syncs to the yjsWsServer relay, so
  // its in-memory room holds the authoritative (incl. unsaved) content. Y-Sweet
  // is not in the editor's sync path, so it's only a fallback for docs that
  // aren't currently open.
  let content = require('./yjsWsServer').getRoomText(docName);
  if (content == null) content = await ySweetBridge.readDocContent(docName);
  if (content == null) return;

  const effectiveUser = scope.userId || null;
  if (!effectiveUser) return;

  const repoPath = gitService.getEffectiveRepoPath(slug, effectiveUser);
  if (!fs.existsSync(repoPath)) return;

  const fullPath = path.join(repoPath, filePath);
  const previousContent = await readWorkspaceFileForLineProvenance(slug, filePath, effectiveUser);
  const derivedLineProvenance = deriveLineProvenanceFromContentChange(filePath, previousContent, content, {
    evidenceRefs: scope.evidenceRefs,
    processAncestry: scope.processAncestry,
    promptSummary: 'Yjs pre-stage flush to disk',
    reasonRef: `yjs_flush:${filePath}`,
  });
  await runCodeSiteMutationBoundary(scope.codesiteContext, {
    operation: 'yjs_flush',
    tool: 'file_write',
    attempts: [{
      path: filePath,
      kind: 'yjs_flush',
      tool: 'file_write',
      ...codeSiteWriteEvidence(scope, derivedLineProvenance),
    }],
  }, async () => {
    await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
    await fsPromises.writeFile(fullPath, content, 'utf-8');
  }, {
    repoRoot: repoPath,
    workspaceSlug: slug,
  });
  fileHashCache.set(docName, { hash: computeHash(content), timestamp: Date.now() });
  console.log(`[Collab] Pre-stage flush via Y-Sweet: ${filePath} (${content.length} chars)`);
}

/**
 * Flush a workspace's LIVE editor docs to disk before a server-side consumer
 * reads the working tree (a `container`/`web` program's `docker build .` /
 * `npm install`). The frontend syncs edits to the yjsWsServer relay, so the
 * authoritative (incl. unsaved) content is its in-memory rooms — NOT Y-Sweet
 * and NOT necessarily disk. We enumerate the open rooms for this workspace and
 * flush each via flushYjsDocForFile (which reads the room first). Only
 * currently-open docs need flushing; closed docs were already written on save.
 * @returns {Promise<number>} number of docs flushed
 */
async function flushWorkspaceDocsToDisk(slug, userId, scope = {}) {
  if (!slug || !userId) return 0;
  const prefix = `workspace:${slug}:user:${encodeURIComponent(String(userId))}:`;
  const docNames = require('./yjsWsServer').listRoomNames().filter((n) => n.startsWith(prefix));
  let flushed = 0;
  for (const docName of docNames) {
    const filePath = docName.slice(prefix.length);
    try { validateFilePath(filePath); } catch { continue; } // skip unsafe paths
    try {
      await flushYjsDocForFile(slug, filePath, { userId, codesiteContext: scope.codesiteContext });
      flushed += 1;
    } catch (e) {
      logger.warn('workspace_doc_flush_failed', { slug, filePath }, e);
    }
  }
  if (flushed) logger.info('workspace_docs_flushed', { slug, userId, count: flushed });
  return flushed;
}

async function invalidateDocsForSlug(slug, filePaths = null, scope = {}) {
  // Y-Sweet owns doc persistence — we no longer hold Yjs docs in-process.
  // Invalidation now means:
  //   1. Clear the hash cache so subsequent reads re-check disk.
  //   2. Broadcast a 'doc-invalidated' notification via notifyWss so
  //      connected frontends destroy their Y.Docs and reconnect to
  //      Y-Sweet with fresh state.
  //   3. Set revert cooldowns to reject stale in-flight save requests.
  const prefix = `workspace:${slug}:`;

  // Clear hash cache entries for affected files
  for (const key of fileHashCache.keys()) {
    if (!key.startsWith(prefix)) continue;
    if (filePaths && filePaths.length > 0) {
      const parsed = parseDocName(key);
      if (parsed && !filePaths.includes(parsed.filePath)) continue;
    }
    fileHashCache.delete(key);
  }

  // Broadcast invalidation to frontends via notification WebSocket.
  // Clients listen for 'doc-invalidated' and destroy + reconnect their Y.Docs.
  if (notifyWss) {
    const message = JSON.stringify({
      type: 'doc-invalidated',
      slug,
      filePaths: filePaths || [],
      scope,
    });
    notifyWss.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN && ws._slug === slug && _matchesNotifyScope(ws, scope)) {
        try { ws.send(message); } catch (_) {}
      }
    });
  }

  // Set revert cooldown for affected paths
  const now = Date.now();
  const affectedPaths = filePaths && filePaths.length > 0 ? filePaths : [];
  for (const fp of affectedPaths) {
    revertCooldowns.set(`${slug}:${fp}`, now);
    // Best-effort: log the revert to the file activity stream.  No version
    // snapshot — the disk is the source of truth post-revert and is
    // already captured in the previous 'saved' entry.
    persistence.logFileEvent(slug, fp, {
      kind: 'reverted',
      userId: scope?.userId || null,
      sessionId: scope?.sessionId || null,
    });
  }

  if (filePaths) {
    logger.info('docs_invalidated', { slug, files: filePaths.length, paths: filePaths });
  } else {
    logger.info('docs_invalidated', { slug, files: 'all' });
  }
}

/**
 * Broadcast a file-tree-changed event to notification WebSocket clients
 * for a specific workspace slug. Clients should re-fetch the file tree.
 */
function broadcastFileTreeChanged(slug, scope = {}) {
  if (!slug || !notifyWss) return;
  const message = JSON.stringify({ type: 'file-tree-changed', slug, scope });
  notifyWss.clients.forEach((ws) => {
    // Only send to clients subscribed to this slug
    if (ws.readyState === WebSocket.OPEN && ws._slug === slug && _matchesNotifyScope(ws, scope)) {
      try { ws.send(message); } catch (_) {}
    }
  });
  console.log(`[Collab] Broadcast file-tree-changed for slug ${slug}`);
}

/**
 * Broadcast a git-status-changed event to notification WebSocket clients.
 * Sent after auto-flush writes to disk so frontends can immediately refresh
 * Source Control instead of waiting for the next poll or debounce timer.
 * Debounced per-slug (500ms) to avoid spamming during rapid typing.
 *
 * @param {string} slug - workspace slug
 * @param {string} [filePath] - optional file path that triggered the change
 */
const _gitStatusBroadcastTimers = new Map();
function _makeScopeKey(scope = {}) {
  return `${scope.sessionId || ''}|${scope.userId || ''}`;
}

function _matchesNotifyScope(ws, scope = {}) {
  if (!scope) return true;
  // Direct-access model: match by sessionId OR userId.
  // Both host and guest notification WS clients should receive events.
  if (scope.sessionId && ws._sessionId === scope.sessionId) return true;
  if (scope.userId && ws._userId === scope.userId) return true;

  // If scope has a userId that is a session host, also match guests in that session.
  // This ensures guests receive file-saved / git-status-changed events when the
  // room key is user-scoped (workspace:{slug}:user:{hostId}:{path}) and sessionId is null.
  if (scope.userId && sessionManager) {
    const hostSessionId = sessionManager.hostIndex.get(scope.userId);
    if (hostSessionId) {
      const session = sessionManager.sessions.get(hostSessionId);
      if (session && session.status === 'active') {
        // Match the WS client if they are a guest in this session
        if (session.guests.has(ws._userId)) return true;
      }
    }
  }

  // If scope has no filters, broadcast to all
  if (!scope.sessionId && !scope.userId) return true;
  return false;
}

function _resolveNotifyUserId(scope = {}) {
  if (scope.userId) return scope.userId;
  if (scope.sessionId) {
    const session = sessionManager.getSession(scope.sessionId);
    return session?.hostId || null;
  }
  return null;
}

/**
 * Broadcast a file-saved event to notification WebSocket clients.
 * Sent after flushDocToDisk so all collaborators can sync their
 * saved/unsaved state — the other client's Redux savedContent updates
 * to match currentContent, clearing the unsaved indicator.
 */
function broadcastFileSaved(slug, filePath, scope = {}) {
  // A running container/webGui program reads /workspace from disk — flush the
  // workspace's live editor docs so this save (and any sibling unsaved edits)
  // become visible to it. No-op unless such a session is active for this slug.
  continuousFlush.notifySave(slug);
  if (!slug || !notifyWss) return;
  const message = JSON.stringify({ type: 'file-saved', slug, filePath, scope });
  notifyWss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN && ws._slug === slug && _matchesNotifyScope(ws, scope)) {
      try { ws.send(message); } catch (_) {}
    }
  });
  // Also push via SSE so polling-free clients receive the event
  sseService.emitFileSaved(slug, filePath);
}

/**
 * Broadcast the live set of forwardable ports detected inside a workspace's
 * runtime container. The frontend Ports panel renders these at
 * /wsport/<slug>/<port>/. Workspace-wide (no per-user scope filtering).
 */
function broadcastContainerPorts(slug, ports) {
  if (!slug || !notifyWss) return;
  const message = JSON.stringify({ type: 'container-ports', slug, ports: Array.isArray(ports) ? ports : [] });
  notifyWss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN && ws._slug === slug) {
      try { ws.send(message); } catch (_) {}
    }
  });
}

/**
 * Broadcast the live set of forwardable ports detected inside a workspace's Sysbox
 * runtime POD (Slice 4). Routed to the workspace's clients by slug; carries the
 * runtimeScope so the frontend builds /runtime/<scope>/port/<N> preview URLs.
 */
function broadcastRuntimePorts(slug, runtimeScope, ports) {
  if (!slug || !notifyWss) return;
  const message = JSON.stringify({ type: 'runtime-ports', slug, runtimeScope, ports: Array.isArray(ports) ? ports : [] });
  notifyWss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN && ws._slug === slug) {
      try { ws.send(message); } catch (_) {}
    }
  });
}

/**
 * Broadcast a backup-status event when the durable off-site backup (GCS) for
 * a file transitions between healthy and degraded.  Lets the UI show a
 * "backup degraded" warning so users aren't misled into thinking a save
 * succeeded end-to-end when only the local disk write landed.
 *
 * @param {string} slug
 * @param {string} filePath
 * @param {'ok'|'degraded'} status
 * @param {{ userId?: string, sessionId?: string, reason?: string }} [scope]
 */
function broadcastBackupStatus(slug, filePath, status, scope = {}) {
  if (!slug || !notifyWss) return;
  const { reason, ...notifyScope } = scope || {};
  const message = JSON.stringify({
    type: 'backup-status',
    slug,
    filePath,
    status,
    reason: reason || null,
    scope: notifyScope,
  });
  notifyWss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN && ws._slug === slug && _matchesNotifyScope(ws, notifyScope)) {
      try { ws.send(message); } catch (_) {}
    }
  });
}

function broadcastGitStatusChanged(slug, filePath, scope = {}, { immediate = false, snapshot = null } = {}) {
  if (!slug || !notifyWss) return;
  const send = async () => {
    let resolvedSnapshot = snapshot;
    if (!resolvedSnapshot) {
      const notifyUserId = _resolveNotifyUserId(scope);
      resolvedSnapshot = await gitService.invalidateStatusCache(slug, notifyUserId, { scheduleRefresh: true });
    }
    const message = JSON.stringify({ type: 'git-status-changed', slug, filePath, scope, snapshot: resolvedSnapshot || null });
    notifyWss.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN && ws._slug === slug && _matchesNotifyScope(ws, scope)) {
        try { ws.send(message); } catch (_) {}
      }
    });
  };
  if (immediate) {
    // Explicit user actions (pull, checkout, discard, etc.) — send immediately
    const timerKey = `${slug}|${_makeScopeKey(scope)}`;
    if (_gitStatusBroadcastTimers.has(timerKey)) {
      clearTimeout(_gitStatusBroadcastTimers.get(timerKey));
      _gitStatusBroadcastTimers.delete(timerKey);
    }
    void send();
    // Also push via SSE
    sseService.emitGitStatusChanged(slug, filePath);
    return;
  }
  // Auto-flush / background changes — debounce per-slug (500ms)
  const timerKey = `${slug}|${_makeScopeKey(scope)}`;
  if (_gitStatusBroadcastTimers.has(timerKey)) {
    clearTimeout(_gitStatusBroadcastTimers.get(timerKey));
  }
  _gitStatusBroadcastTimers.set(timerKey, setTimeout(() => {
    _gitStatusBroadcastTimers.delete(timerKey);
    void send();
    sseService.emitGitStatusChanged(slug, filePath);
  }, 500));
}

registerChangeListener(({ slug, rootDir, events }) => {
  gitService.handleFilesystemEvents({ slug, rootDir, events }).then((result) => {
    if (!result?.bundle || !result.slug) return;
    const scope = result.userId ? { userId: result.userId } : {};
    broadcastGitStatusChanged(result.slug, undefined, scope, {
      immediate: true,
      snapshot: result.bundle,
    });
  }).catch((err) => {
    console.warn('[Collab] Git cache refresh from fs watcher failed:', err?.message || err);
  });
});

// ── Out-of-band write detection ────────────────────────────────────────────
// When an AI agent, terminal process, or any non-editor writer modifies a
// file on disk, the Yjs CRDT snapshot held by Y-Sweet becomes stale.  If we
// don't invalidate, the next client to open that file will see the stale
// Yjs content in Monaco while Redux reports the fresh disk content — a
// split-brain where the file appears "unsaved" with the pre-agent content.
//
// Fix: for each fs-watcher event, compare the current disk hash against the
// hash we recorded after the last editor-initiated write.  If they differ,
// invalidate the Yjs doc so connected clients refetch the new content.
//
// Self-initiated saves are skipped automatically: flushDocToDisk() updates
// fileHashCache with the new hash before the fs-watcher event fires, so
// the hashes already match.
registerChangeListener(async ({ slug, rootDir, events }) => {
  if (!slug || !Array.isArray(events) || events.length === 0) return;
  // `bulk` is emitted when too many events fired at once (e.g. npm install).
  // Invalidating every doc for the slug is overkill; skip.
  if (events.length === 1 && events[0]?.path === '/' && events[0]?.kind === 'bulk') return;

  const scope = gitService._inferScopeFromRepoPath
    ? gitService._inferScopeFromRepoPath(rootDir, slug)
    : { slug, userId: null };
  const userId = scope?.userId || null;

  const invalidated = [];
  for (const ev of events) {
    if (!ev || ev.kind === 'dir') continue;
    const filePath = ev.path;
    if (!filePath) continue;
    // Our own atomic writes use a hidden temp file that's immediately
    // renamed into place.  Skip it — the rename event on the real path
    // will fire separately and we'll reconcile via hash-compare there.
    if (/\.synthi-tmp\.[0-9a-f]+$/.test(filePath) || /\/\.[^/]*\.synthi-tmp\./.test('/' + filePath)) continue;
    const docName = buildDocName(slug, filePath, { userId });
    try {
      if (ev.kind === 'deleted') {
        if (fileHashCache.has(docName)) {
          fileHashCache.delete(docName);
          invalidated.push(filePath);
        }
        continue;
      }
      const fullPath = path.join(rootDir, filePath);
      let content;
      try {
        content = await fsPromises.readFile(fullPath, 'utf8');
      } catch (_) {
        // File vanished between event and read — treat as deleted
        fileHashCache.delete(docName);
        invalidated.push(filePath);
        continue;
      }
      const diskHash = computeHash(content);
      const cached = fileHashCache.get(docName);
      if (cached && cached.hash === diskHash) continue; // editor-initiated write — already in sync
      // Update the cache so subsequent fs events don't re-trigger.
      fileHashCache.set(docName, { hash: diskHash, timestamp: Date.now() });
      invalidated.push(filePath);
    } catch (err) {
      console.warn(`[Collab] Out-of-band diff check failed for ${filePath}:`, err?.message || err);
    }
  }

  if (invalidated.length === 0) return;
  console.log(`[Collab] Out-of-band write detected for slug ${slug}:`, invalidated);
  const notifyScope = userId ? { userId } : {};
  try {
    await invalidateDocsForSlug(slug, invalidated, notifyScope);
  } catch (err) {
    console.warn('[Collab] invalidateDocsForSlug failed after out-of-band write:', err?.message || err);
  }
});

/**
 * Broadcast a file-reverted event to all notification clients for a slug.
 * Clients should reset their Monaco editor model for the given file(s)
 * to prevent stale dirty content from being re-flushed into the Yjs doc.
 *
 * @param {string} slug - workspace slug
 * @param {string[]} filePaths - file paths that were reverted (empty = all files)
 */
function broadcastFileReverted(slug, filePaths = [], scope = {}) {
  if (!slug) return; // Guard against falsy slug to avoid mismatched broadcasts
  if (!notifyWss) return; // Server not yet initialized
  const message = JSON.stringify({ type: 'file-reverted', slug, filePaths, scope });
  notifyWss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN && ws._slug === slug && _matchesNotifyScope(ws, scope)) {
      try { ws.send(message); } catch (_) {}
    }
  });
  console.log(`[Collab] Broadcast file-reverted for slug ${slug}, files:`, filePaths.length ? filePaths : '*');
  // Also push via SSE
  sseService.emitFileReverted(slug, filePaths);
}

/**
 * Clear local cache state for a document.
 * Y-Sweet owns persistence — this just clears the hash cache entry
 * so subsequent reads re-validate against disk.
 *
 * @param {string} docName - The document name (room key)
 */
async function clearDocumentPersistence(docName) {
  fileHashCache.delete(docName);
  console.log('[Collab] Cleared local cache for document:', docName);
}

// ── TURN credential cache (Cloudflare Calls) ────────────────────────────────
// Reuses the same Cloudflare credential until 80% of the TTL has elapsed,
// avoiding an extra HTTP round-trip on most create_peer() calls.
let _turnCache = null; // { iceServers, expiresAt }
const TURN_REFRESH_MARGIN = 0.2; // refresh when 80% of TTL elapsed

async function getTurnCredentials() {
  const { CLOUDFLARE_TURN_TOKEN_ID, CLOUDFLARE_TURN_API_TOKEN, TURN_CREDENTIAL_TTL } = config;

  // Not configured → local TURN if available, else STUN-only fallback.
  if (!CLOUDFLARE_TURN_TOKEN_ID || !CLOUDFLARE_TURN_API_TOKEN) {
    const localUrl = process.env.LOCAL_TURN_URL;
    const localUser = process.env.LOCAL_TURN_USERNAME;
    const localCred = process.env.LOCAL_TURN_CREDENTIAL;
    if (localUrl && localUser && localCred) {
      return [
        { urls: ['stun:stun.l.google.com:19302'] },
        { urls: [localUrl], username: localUser, credential: localCred },
      ];
    }
    return [{ urls: ['stun:stun.l.google.com:19302'] }];
  }

  // Serve from cache when still fresh enough.
  if (_turnCache) {
    const remaining = _turnCache.expiresAt - Date.now();
    if (remaining > TURN_CREDENTIAL_TTL * 1000 * TURN_REFRESH_MARGIN) {
      return _turnCache.iceServers;
    }
  }

  const cfRes = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${CLOUDFLARE_TURN_TOKEN_ID}/credentials/generate`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLOUDFLARE_TURN_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL }),
    },
  );

  if (!cfRes.ok) {
    const text = await cfRes.text().catch(() => '');
    throw new Error(`Cloudflare TURN API ${cfRes.status}: ${text}`);
  }

  const data = await cfRes.json();
  const cf = data.iceServers;

  const iceServers = [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    {
      urls: Array.isArray(cf.urls) ? cf.urls : [cf.urls],
      username: cf.username,
      credential: cf.credential,
    },
  ];

  _turnCache = { iceServers, expiresAt: Date.now() + TURN_CREDENTIAL_TTL * 1000 };
  return iceServers;
}

const server = http.createServer(async (req, res) => {
  // Strip /collab or /collab/ prefix if passed by ingress, but preserve the
  // public mount prefix so preview HTML can rewrite absolute asset URLs back
  // through the externally visible proxy route.
  const originalUrl = req.url || '/';
  const collabMountMatch = originalUrl.match(/^\/collab(?=\/|$)/);
  req._synthiExternalMountPrefix = collabMountMatch ? '/collab' : '';
  req.url = originalUrl.replace(/^\/collab(?=\/|$)/, '');
  if (!req.url.startsWith('/')) req.url = '/' + req.url;

  // Wildcard preview hosts (p<port>-rt-*.preview.vectant.dev) are user app
  // traffic, not collab API traffic. Route them into the reverse proxy before
  // app-level CORS/origin checks so POSTs, HMR, and absolute root assets work.
  if (proxyService.isPreviewHostRequest(req)) {
    proxyService.proxyHttpRequest(req, res);
    return;
  }

  // CORS headers — must echo the exact Origin (not '*') when credentials are included
  const requestOrigin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', requestOrigin || '*');
  if (requestOrigin) res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-user-id, x-session-id, x-user-name, x-user-email, x-runtime-scope, x-runtime-fs-user-id, x-synthi-internal-token, x-collab-internal-token');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Origin check — blocks naive cross-site POSTs for all mutating routes.
  if (!enforceOrigin(req, res)) return;

  // ========================================================================
  // TURN CREDENTIALS — /turn-credentials
  // Internal endpoint for workers (Option B) to fetch short-lived
  // Cloudflare Calls TURN credentials. Cached server-side so we avoid
  // hitting Cloudflare on every create_peer().
  // ========================================================================
  // ========================================================================
  // SPAWNER WEBHOOK — /api/spawner/session-ended
  // Called by the signaling server when all peers disconnect from a session.
  // ========================================================================
  if (req.url === '/api/spawner/session-ended') {
    if (!requireInternalControlPlaneToken(req, res)) return;
    return spawner.handleSessionEnded(req, res);
  }

  // ========================================================================
  // SESSION LIFECYCLE — /api/session/:sessionId/lifecycle (GET)
  // Uniform view of warming / ready / running / hibernated / migrating /
  // crashed / terminated state. Consumed by the MCP (synthi_attach,
  // synthi_health) + operator UIs. Source of truth is the spawner's own
  // lifecycleSnapshot — advisory state is layered in sessionLifecycle.js.
  // ========================================================================
  const lifecycleGet = req.url.match(/^\/api\/session\/([^/]+)\/lifecycle$/);
  if (lifecycleGet && req.method === 'GET') {
    const sessionId = decodeURIComponent(lifecycleGet[1]);
    try {
      const snapshot = spawner.lifecycleSnapshot
        ? await spawner.lifecycleSnapshot(sessionId)
        : { session_id: sessionId, state: 'unknown', tracked: false };
      // Slice 5: ride the Sysbox runtime pod's coarse state alongside the worker's.
      // Self-gated → returns {skipped} when sysbox is dark, so the response is
      // byte-identical unless RUNTIME_BACKEND=sysbox-pod is on.
      if (spawner.runtimeLifecycleSnapshot && snapshot && typeof snapshot === 'object') {
        const rt = await spawner.runtimeLifecycleSnapshot(sessionId);
        if (rt && !rt.skipped) snapshot.runtime = rt;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot));
    } catch (e) {
      console.error('[Lifecycle] snapshot failed:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ========================================================================
  // SESSION LIFECYCLE — /api/session/:sessionId/warm (POST)
  // Pre-warm a hibernated / fresh session. Body: {user_id?}. Returns
  // {state:"warming"|"ready", estimated_ready_at?} immediately; caller
  // polls /lifecycle for progress.
  // ========================================================================
  const warmMatch = req.url.match(/^\/api\/session\/([^/]+)\/warm$/);
  if (warmMatch && req.method === 'POST') {
    if (!spawner.warm) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'warm_not_supported_for_spawner_mode' }));
      return;
    }
    const sessionId = decodeURIComponent(warmMatch[1]);
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed = {};
    if (body) {
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end('Invalid JSON'); return; }
    }
    try {
      const snapshot = await spawner.warm(sessionId, parsed.user_id || parsed.userId || 'warm_trigger', parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot));
    } catch (e) {
      console.error('[Lifecycle] warm failed:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ========================================================================
  // SESSION LIFECYCLE — /api/session/:sessionId/migrate (POST)
  // Record a migrating-state transition so the MCP can surface it on the
  // next `synthi_attach` / `synthi_health` poll. Body: {target?, reason?}.
  // No actual pod relocation happens here in phase 1 — this is the hook
  // an operator / orchestrator calls to flag the MCP.
  // ========================================================================
  const migrateMatch = req.url.match(/^\/api\/session\/([^/]+)\/migrate$/);
  if (migrateMatch && req.method === 'POST') {
    const sessionId = decodeURIComponent(migrateMatch[1]);
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed = {};
    if (body) {
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end('Invalid JSON'); return; }
    }
    try {
      const lifecycle = require('./sessionLifecycle');
      const snapshot = lifecycle.markMigrating(
        sessionId,
        parsed.target || null,
        parsed.reason || null
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session_id: sessionId, ...snapshot }));
    } catch (e) {
      console.error('[Lifecycle] migrate failed:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ========================================================================
  // SPAWNER — /api/spawner/ensure
  // Called by the frontend to ensure a workspace pod exists.
  // Body: { session_id, user_id }
  // ========================================================================
  if (req.url === '/api/spawner/ensure' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end('Invalid JSON'); return; }
    const { session_id, user_id } = parsed;
    if (!session_id || !user_id) { res.writeHead(400); res.end('Missing session_id or user_id'); return; }
    try {
      const workspaceSlug = parsed.workspace_slug || parsed.workspaceSlug || '';
      const runtimeKind = parsed.runtime_kind || parsed.runtimeKind || '';
      const filesystemUserId =
        parsed.filesystemUserId ||
        parsed.filesystem_user_id ||
        parsed.fsUserId ||
        user_id;
      if (workspaceSlug) {
        await ensureRuntimeFilesystem({
          workspaceSlug,
          filesystemUserId,
          runtimeScope: session_id,
          reason: 'spawner_ensure',
        });
      }
      const result = await spawner.ensurePod(session_id, user_id, {
        workspaceSlug,
        runtimeKind,
        filesystemUserId,
      });
      // Sysbox runtime pod (dark): bring up the per-workspace container engine
      // alongside the worker. Fire-and-forget + self-gated on RUNTIME_BACKEND, so
      // it's a no-op unless the flag is on and never blocks/breaks the worker
      // session. Only the k8s spawner exposes spawnRuntimePod.
      if (typeof spawner.spawnRuntimePod === 'function') {
        Promise.resolve(
          spawner.spawnRuntimePod(session_id, user_id, { workspaceSlug, runtimeKind, filesystemUserId }),
        ).catch((err) => console.error('[Spawner] spawnRuntimePod failed:', err && err.message ? err.message : err));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('[Spawner] ensurePod failed:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ========================================================================
  // SPAWNER — /api/spawner/touch
  // Heartbeat to keep a workspace pod alive. Body: { session_id }
  // ========================================================================
  if (req.url === '/api/spawner/touch' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end('Invalid JSON'); return; }
    if (!parsed.session_id) { res.writeHead(400); res.end('Missing session_id'); return; }
    try {
      await spawner.touch(parsed.session_id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      console.error('[Spawner] touch failed:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ========================================================================
  // SPAWNER — /api/spawner/release
  // Explicitly stop the caller's current runtime. This complements the idle
  // culler so users can free a pod/container immediately.
  // Body: { session_id | runtimeScope, reason? }
  // ========================================================================
  if (req.url === '/api/spawner/release' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch { res.writeHead(400); res.end('Invalid JSON'); return; }

    const sessionId = parsed.session_id || parsed.runtimeScope || '';
    const headerScope = String(req.headers['x-runtime-scope'] || '').trim();
    if (!sessionId || typeof sessionId !== 'string') {
      res.writeHead(400);
      res.end('Missing session_id');
      return;
    }
    if (headerScope && headerScope !== sessionId) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'runtime_scope_mismatch' }));
      return;
    }

    try {
      const reason = parsed.reason || 'explicit_release';
      await spawner.teardown(sessionId, { reason });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, session_id: sessionId, reason }));
    } catch (e) {
      console.error('[Spawner] release failed:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url === '/turn-credentials' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    try {
      const iceServers = await getTurnCredentials();
      res.writeHead(200);
      res.end(JSON.stringify({ iceServers }));
    } catch (e) {
      console.error('[TURN] Credential fetch failed:', e.message);
      // Degrade to STUN-only so the worker isn't completely blocked.
      res.writeHead(200);
      res.end(JSON.stringify({
        iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
        _fallback: true,
        _error: e.message,
      }));
    }
    return;
  }

  // ========================================================================
  // ========================================================================
  // CONTAINER REVERSE PROXY — /wsport/<slug>/<N>/... → <runtime-container>:<N>
  // Additive, workspace-scoped path for `container`-type programs whose ports
  // bind inside a per-workspace runtime container (not collab's localhost).
  // The global /port/<N>/ path below is left untouched.
  // ========================================================================
  if (req.url.startsWith('/wsport/')) {
    if (containerPortProxy) {
      containerPortProxy.proxyHttp(req, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'container_runtime_disabled' }));
    }
    return;
  }

  // REVERSE PROXY — /port/<N>/... or /runtime/<scope>/port/<N>/...
  // Enables in-IDE preview of running dev servers (Next.js, Vite, etc.)
  // ========================================================================
  if (req.url.startsWith('/port/') || req.url.startsWith('/runtime/')) {
    proxyService.proxyHttpRequest(req, res);
    return;
  }

  // GET /preview-url — resolve localhost terminal links to the canonical
  // production preview URL. The client cannot compute the rt-* HMAC itself.
  if (req.method === 'GET' && (req.url === '/preview-url' || req.url.startsWith('/preview-url?'))) {
    proxyService.handlePreviewUrlRequest(req, res);
    return;
  }

  // POST /runtime-callback — replay a browser localhost OAuth callback into
  // the correct runtime pod, where the CLI's loopback listener is running.
  if (req.url === '/runtime-callback' || req.url.startsWith('/runtime-callback?')) {
    proxyService.handleRuntimeCallbackRequest(req, res);
    return;
  }

  // GET /ports — list active dev-server ports
  if (req.method === 'GET' && (req.url === '/ports' || req.url.startsWith('/ports?'))) {
    if (!requireInternalControlPlaneToken(req, res)) return;
    proxyService.handlePortsStatus(req, res);
    return;
  }

  const codeSiteActivityMatch = new URL(req.url, `http://${req.headers.host}`).pathname.match(/^\/codesite\/activity\/([^/]+)$/);
  if (codeSiteActivityMatch) {
    const slug = decodeURIComponent(codeSiteActivityMatch[1]);
    await handleCodeSiteActivityRequest(slug, req, res, {
      activityRegistry: codeSiteActivityRegistry,
      readJsonRequestBody,
      writeJsonResponse,
    });
    return;
  }

  if (req.url === '/codesite/readiness' && req.method === 'GET') {
    await handleCodeSiteReadinessRequest(req, res);
    return;
  }

  if (req.url === '/codesite/deployment-status') {
    await handleCodeSiteDeploymentStatusRequest(req, res, {
      probeOverlayCapability: workspaceRuntime?.probeOverlayCapability,
      probeRuntimeEventAdapter: () => runtimeObservationPublisher.reportHealth(),
    });
    return;
  }

  // Debug endpoint to check collab server state
  if (req.url === '/debug/status' && req.method === 'GET') {
    if (!requireInternalControlPlaneToken(req, res)) return;
    const status = {
      server: 'running',
      persistence: 'Y-Sweet',
      ySweetUrl: config.YSWEET_URL,
      fileHashCacheSize: fileHashCache.size,
      fileHashes: Object.fromEntries(
        Array.from(fileHashCache.entries()).map(([k, v]) => [k, { 
          hash: v.hash.substring(0, 8), 
          timestamp: new Date(v.timestamp).toISOString() 
        }])
      ),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
    return;
  }

  const workspacePrepMatch = new URL(req.url, `http://${req.headers.host}`).pathname.match(/^\/api\/workspace\/([^/]+)\/prepare$/);
  if (workspacePrepMatch) {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const slug = decodeURIComponent(workspacePrepMatch[1]);
    const userId = req.headers['x-user-id'] || urlObj.searchParams.get('userId') || null;
    const sessionId = req.headers['x-session-id'] || urlObj.searchParams.get('sessionId') || null;
    const effectiveUserId = sessionId && userId
      ? sessionManager.getEffectiveUserId(userId, sessionId)
      : userId;
    const prepCodeSiteData = Object.fromEntries(urlObj.searchParams.entries());
    const prepCodeSiteContext = codeSiteContextFromRequest(req, prepCodeSiteData, {
      workspaceSlug: slug,
      actorUserId: userId || null,
      effectiveUserId: effectiveUserId || null,
    });
    const prepCodeSiteEnforcement = codeSiteEnforceOptions(prepCodeSiteContext);

    if (req.method === 'GET') {
      const status = await workspacePrepManager.getWorkspacePrepStatus(slug, effectiveUserId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    if (req.method === 'POST') {
      if (sessionId && userId && !sessionManager.checkPermission(sessionId, userId, 'canFileOps')) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'permission_denied',
          message: 'Workspace preparation requires canFileOps permission.',
        }));
        return;
      }

      const hKey = hydrationKey(slug, effectiveUserId);
      if (!hydratedSlugs.has(hKey)) {
        try {
          if (!effectiveUserId || needsCodeSiteUserRepoProvisioning(slug, effectiveUserId)) {
            await enforceCodeSiteProvisioningAllowed(prepCodeSiteContext, 'workspace-prepare:auto-init', prepCodeSiteEnforcement);
          }
          await gitService.initRepo(
            slug,
            null,
            effectiveUserId,
            null,
            codeSiteProvisioningOptions(prepCodeSiteContext, {
              evidenceRefs: ['collab:workspace-prepare:auto-init'],
              processAncestry: ['collab-server:workspace-prepare'],
            }),
          );
        } catch (e) {
          if (e?.code === 'CODESITE_WRITE_DENIED') {
            writeCodeSiteDenied(res, e);
            return;
          }
          throw e;
        }
        hydratedSlugs.add(hKey);
      }

      const force = /^(1|true|yes)$/i.test(String(urlObj.searchParams.get('force') || ''));
      try {
        await enforceCodeSiteProvisioningAllowed(prepCodeSiteContext, 'workspace-prepare', prepCodeSiteEnforcement);
      } catch (e) {
        if (e?.code === 'CODESITE_WRITE_DENIED') {
          writeCodeSiteDenied(res, e);
          return;
        }
        throw e;
      }
      let status;
      try {
        status = await workspacePrepManager.ensureWorkspacePrepared(slug, effectiveUserId, {
          force,
          trigger: 'workspace_prepare_api',
          codesiteContext: prepCodeSiteContext,
        });
      } catch (e) {
        if (e?.code === 'CODESITE_WORKSPACE_PREP_REQUIRES_ISOLATION') {
          res.writeHead(e.status || 409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: e.code,
            message: e.message,
          }));
          return;
        }
        throw e;
      }
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }
  }

  // ========================================================================
  // SSE ENDPOINT — /sse/:slug — Server-Sent Events for real-time push
  // Replaces HTTP polling for git-status, file-tree-changed, presence, etc.
  // ========================================================================
  if (req.url.startsWith('/sse/') && req.method === 'GET') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const slug = urlObj.pathname.split('/')[2];
    const userId = req.headers['x-user-id'] || urlObj.searchParams.get('userId') || null;
    if (!slug) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing slug', usage: '/sse/:slug?userId=...' }));
      return;
    }
    sseService.handleSSEConnection(req, res, slug, userId);
    return;
  }

  // ========================================================================
  // TELEMETRY ENDPOINT — /telemetry/metrics — Performance metrics snapshot
  // ========================================================================
  if (req.url === '/telemetry/metrics' && req.method === 'GET') {
    if (!requireInternalControlPlaneToken(req, res)) return;
    const metrics = getMetrics();
    const elBlocks = getEventLoopBlockCount();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ metrics, eventLoopBlocks: elBlocks, timestamp: Date.now() }, null, 2));
    return;
  }

  // POST /telemetry/reset — Reset performance counters
  if (req.url === '/telemetry/reset' && req.method === 'POST') {
    if (!requireInternalControlPlaneToken(req, res)) return;
    resetMetrics();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Metrics reset' }));
    return;
  }

  // SSE stats endpoint
  if (req.url === '/sse/stats' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sseService.getStats()));
    return;
  }
  
  // Debug endpoint to validate a specific file
  if (req.url.startsWith('/debug/validate/') && req.method === 'GET') {
    if (!requireInternalControlPlaneToken(req, res)) return;
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const parts = urlObj.pathname.split('/');
    // /debug/validate/:slug/:filePath
    const slug = parts[3];
    const filePath = parts.slice(4).join('/');
    
    if (!slug || !filePath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing slug or filePath' }));
      return;
    }
    
    const debugUserId = req.headers['x-user-id'] || urlObj.searchParams.get('userId') || null;
    const debugSessionId = req.headers['x-session-id'] || urlObj.searchParams.get('sessionId') || null;
    const docName = buildDocName(slug, filePath, { userId: debugUserId, sessionId: debugSessionId });
    const actualContent = await getActualFileContent(slug, filePath, debugUserId);
    const cachedHash = fileHashCache.get(docName);
    
    const result = {
      docName,
      actualFile: actualContent !== null ? {
        exists: true,
        length: actualContent.length,
        hash: computeHash(actualContent).substring(0, 8),
        preview: actualContent.substring(0, 200),
      } : { exists: false },
      cachedHash: cachedHash ? {
        hash: cachedHash.hash.substring(0, 8),
        timestamp: new Date(cachedHash.timestamp).toISOString(),
      } : null,
      valid: cachedHash && actualContent !== null 
        ? cachedHash.hash === computeHash(actualContent) 
        : null,
    };
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result, null, 2));
    return;
  }

  // ========================================================================
  // FILE CONTENT ENDPOINT - Used by AI backend for Container-First analysis
  // ========================================================================
  // GET /file-content/:slug/:filePath - Returns file content from disk (Source of Truth)
  if (req.url.startsWith('/file-content/') && req.method === 'GET') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const parts = urlObj.pathname.split('/');
    // /file-content/:slug/:filePath (filePath can contain slashes)
    const slug = parts[2];
    const filePath = parts.slice(3).join('/');
    
    if (!slug || !filePath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing slug or filePath', usage: '/file-content/:slug/:filePath' }));
      return;
    }
    
    console.log(`[Collab] FILE-CONTENT request: slug=${slug}, path=${filePath}`);
    
    // Extract optional userId for per-user repo support
    const userId = req.headers['x-user-id'] || urlObj.searchParams.get('userId') || null;
    const fileContentCodeSiteData = Object.fromEntries(urlObj.searchParams.entries());
    const fileContentCodeSiteContext = codeSiteContextFromRequest(req, fileContentCodeSiteData, {
      workspaceSlug: slug,
      actorUserId: userId || null,
      effectiveUserId: userId || null,
    });
    const fileContentCodeSiteEnforcement = codeSiteEnforceOptions(fileContentCodeSiteContext);

    try {
      // Ensure repo exists and (when configured) hydrate from GCS before reading.
      // Use hydratedSlugs so we re-hydrate once per boot even if the dir exists.
      const hKey = hydrationKey(slug, userId);
      if (!hydratedSlugs.has(hKey)) {
        try {
          if (!userId || needsCodeSiteUserRepoProvisioning(slug, userId)) {
            await enforceCodeSiteProvisioningAllowed(fileContentCodeSiteContext, 'file-content:auto-init', fileContentCodeSiteEnforcement);
          }
          await gitService.initRepo(
            slug,
            null,
            userId,
            null,
            codeSiteProvisioningOptions(fileContentCodeSiteContext, {
              evidenceRefs: ['collab:file-content:auto-init'],
              processAncestry: ['collab-server:file-content'],
            }),
          );
          hydratedSlugs.add(hKey);
        } catch (e) {
          if (e?.code === 'CODESITE_WRITE_DENIED') {
            writeCodeSiteDenied(res, e);
            return;
          }
          if (gcsSync && typeof gcsSync.isGcsConfigured === 'function' && gcsSync.isGcsConfigured()) {
            console.warn('[Collab] FILE-CONTENT auto-init failed for slug:', slug, e?.message || e);
          }
        }
      }

      const content = await getActualFileContent(slug, filePath, userId, {
        codesiteContext: fileContentCodeSiteContext,
        ...fileContentCodeSiteEnforcement,
        operation: 'file-content',
        tool: 'file_read',
        evidenceRefs: ['collab:file-content'],
        processAncestry: ['collab-server:file-content'],
      });
      if (content === null) {
        console.log(`[Collab] FILE-CONTENT: File not found: ${slug}/${filePath}`);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found', slug, filePath }));
        return;
      }
      
      console.log(`[Collab] FILE-CONTENT: Returning ${content.length} chars for ${slug}/${filePath}`);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
    } catch (e) {
      console.error(`[Collab] FILE-CONTENT error:`, e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read file', detail: e.message }));
    }
    return;
  }

  // ========================================================================
  // AVAILABLE-SHELLS ENDPOINT — List shells available on this system
  // ========================================================================
  // GET /available-shells
  // Returns: { shells: [{ key, label, executable }], default: string }
  if (req.url === '/available-shells' && req.method === 'GET') {
    if (!requireInternalControlPlaneToken(req, res)) return;
    const shells = getAvailableShells();
    const { getDefaultShell } = require('./terminalService');
    const defaultShell = getDefaultShell();
    // Determine which key matches the default shell
    const defaultKey = shells.find(s => defaultShell.includes(s.executable))?.key || shells[0]?.key || 'powershell';
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ shells, default: defaultKey }));
    return;
  }

  const programRuntimeUrl = new URL(req.url, `http://${req.headers.host}`);
  const programRuntimeMatch = /^\/program-runtime\/([^/]+)\/sessions(?:\/([^/]+)(?:\/(stop|restart|events))?)?$/.exec(programRuntimeUrl.pathname);
  if (programRuntimeMatch) {
    const runtimeSlug = decodeURIComponent(programRuntimeMatch[1]);
    const runtimeSessionId = programRuntimeMatch[2] ? decodeURIComponent(programRuntimeMatch[2]) : null;
    const runtimeAction = programRuntimeMatch[3] || null;
    const runtimeSession = runtimeSessionId ? managedProgramRuntime.getManagedSession(runtimeSessionId) : null;

    if (runtimeSessionId && (!runtimeSession || runtimeSession.workspaceSlug !== runtimeSlug)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Managed program session not found' }));
      return;
    }

    if (!runtimeSessionId && req.method === 'GET') {
      const sessions = managedProgramRuntime
        .listManagedSessions()
        .filter((session) => session.workspaceSlug === runtimeSlug);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions }));
      return;
    }

    if (runtimeSessionId && !runtimeAction && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session: runtimeSession }));
      return;
    }

    if (runtimeSessionId && runtimeAction === 'events' && req.method === 'GET') {
      const events = managedProgramRuntime.listManagedSessionEvents(runtimeSessionId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ events }));
      return;
    }

    if (runtimeSessionId && runtimeAction === 'stop' && req.method === 'POST') {
      const session = await managedProgramRuntime.stopManagedSession(runtimeSessionId, { reason: 'user_stop' });
      continuousFlush.unregisterSession(runtimeSessionId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session }));
      return;
    }

    if (runtimeSessionId && runtimeAction === 'restart' && req.method === 'POST') {
      const session = await managedProgramRuntime.restartManagedSession(runtimeSessionId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session }));
      return;
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // POST /program-runtime/:slug/launch-program  { sessionId, userId?, title?, config }
  // Launch an installed program from its NormalizedProgramConfig recipe (Phase 2).
  const launchProgramMatch = /^\/program-runtime\/([^/]+)\/launch-program$/.exec(programRuntimeUrl.pathname);
  if (launchProgramMatch && req.method === 'POST') {
    const slug = decodeURIComponent(launchProgramMatch[1]);
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
    if (!requireCommandGatewayAuth(req, res, { slug, parsed, requiredScope: COMMAND_SCOPES.EXEC })) {
      return;
    }

    const config = parsed && typeof parsed.config === 'object' ? parsed.config : null;
    const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId.trim() : '';
    if (!config || !sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing config or sessionId' }));
      return;
    }

    try {
      const actorUserId = parsed.userId || '';
      const codeSiteContext = runtimeCodeSiteContext(req, parsed, {
        workspaceSlug: slug,
        actorUserId,
        effectiveUserId: parsed.filesystemUserId || actorUserId,
      });
      const codeSiteMetadata = codeSiteRuntimeMetadata(codeSiteContext);
      try {
        guardCodeSiteRuntimeHostSurface(slug, codeSiteContext, 'program-runtime:launch-program');
      } catch (err) {
        writeCodeSiteDenied(res, err);
        return;
      }
      if (requiresCodeSiteManagedRuntimeContext(codeSiteContext)) {
        writeCodeSiteManagedContextRequired(res, codeSiteMetadata, 'program-runtime:launch-program');
        return;
      }
      const launchConfig = codeSiteMetadata
        ? {
          ...config,
          env: {
            ...(config.env || {}),
            ...runtimeCodeSiteEnv(codeSiteContext, ['collab-server', 'program-runtime:launch-program']),
          },
        }
        : config;
      const launchMode = codeSiteProgramRuntimeLaunchMode({
        codeSiteContext,
        runtimeType: launchConfig.runtimeType || 'cli',
        sysboxEnabled: isSysboxRuntimeEnabled(),
        hasHybrid: Boolean(workspaceRuntime && (ENABLE_CONTAINER_RUNTIME || ENABLE_CODESITE_DOCKER_RUNTIME)),
      });
      if (launchMode === 'block-runtime' || launchMode === 'block-host') {
        writeCodeSiteRuntimeBlocked(res, codeSiteMetadata, 'program-runtime:launch-program');
        return;
      }
      // Reconcile the working tree from Y-Sweet first: a program's install/launch
      // (docker build ., npm install) reads files from disk, but unsaved editor
      // content lives only in Y-Sweet until flushed. Without this the build sees
      // stale/empty files (e.g. an unsaved Dockerfile or package.json).
      await flushWorkspaceDocsToDisk(slug, actorUserId, { codesiteContext }).catch((e) =>
        logger.warn('workspace_flush_before_launch_failed', { slug }, e));
      const session = await managedProgramRuntime.launchManagedProgram({
        sessionId,
        workspaceSlug: slug,
        userId: actorUserId,
        title: parsed.title || null,
        config: launchConfig,
        metadata: codeSiteMetadata
          ? {
            packageId: config.packageId || null,
            version: config.version || null,
            source: config.source || null,
            codesite: codeSiteMetadata,
          }
          : null,
        codesiteContext: codeSiteContext.active ? codeSiteContext : null,
      });
      // Container/webGui programs read /workspace from disk for their whole
      // lifetime — keep the editor's content flushed there while this session runs.
      continuousFlush.registerSession({
        sessionId,
        slug,
        userId: actorUserId,
        config: launchConfig,
        codesiteContext: codeSiteContext.active ? codeSiteContext : null,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Program launch failed' }));
    }
    return;
  }

  // POST /program-runtime/:slug/exec  { command, timeout? }
  // One-shot, non-interactive command exec inside the workspace's Sysbox runtime
  // pod (where its own dockerd lives, so `docker ...` works). Routed by
  // workspaceSlug → runtimeScope (never a user id). Returns
  // { runtimeScope, stdout, stderr, exitCode, timedOut }. Used by the PAT-gated
  // MCP `synthi_exec_in_runtime` tool (the in-app AI's command control).
  const execRuntimeMatch = /^\/program-runtime\/([^/]+)\/exec$/.exec(programRuntimeUrl.pathname);
  if (execRuntimeMatch && req.method === 'POST') {
    const slug = decodeURIComponent(execRuntimeMatch[1]);
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
    if (!requireCommandGatewayAuth(req, res, { slug, parsed, requiredScope: COMMAND_SCOPES.EXEC })) {
      return;
    }
    const command = String(parsed.command || '').trim();
    if (!command) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing command' }));
      return;
    }
    const codeSiteContext = runtimeCodeSiteContext(req, parsed, {
      workspaceSlug: slug,
      actorUserId: parsed.userId || '',
      effectiveUserId: parsed.filesystemUserId || parsed.userId || '',
    });
    const codeSiteMetadata = codeSiteRuntimeMetadata(codeSiteContext);
    try {
      try {
        guardCodeSiteRuntimeHostSurface(slug, codeSiteContext, 'program-runtime:exec');
      } catch (err) {
        writeCodeSiteDenied(res, err);
        return;
      }
      if (requiresCodeSiteManagedRuntimeContext(codeSiteContext)) {
        writeCodeSiteManagedContextRequired(res, codeSiteMetadata, 'program-runtime:exec');
        return;
      }
      if (codeSiteContext.active) {
        writeCodeSiteRuntimeBlocked(res, codeSiteMetadata, 'program-runtime:exec');
        return;
      }
      const sessions = typeof spawner.listActiveRuntimeSessions === 'function'
        ? await spawner.listActiveRuntimeSessions()
        : [];
      const runtimeScope = pickRuntimeScopeForSlug(sessions, slug);
      if (!runtimeScope) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'runtime_pod_not_ready' }));
        return;
      }
      const result = await runtimeExecOnce(runtimeScope, command, {
        timeoutMs: Number(parsed.timeout) || 30000,
        env: runtimeCodeSiteEnv(codeSiteContext, ['collab-server', 'program-runtime:exec']),
      });
      console.log(`[RuntimeExec] slug=${slug} runtimeScope=${runtimeScope} exit=${result.exitCode} timedOut=${result.timedOut} cmd=${command.slice(0, 120)}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ runtimeScope, codesite: codeSiteMetadata, ...result }));
    } catch (err) {
      const notReady = err && err.message === 'runtime_pod_not_ready';
      res.writeHead(notReady ? 409 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'runtime exec failed' }));
    }
    return;
  }

  // POST /program-runtime/:slug/ensure-runtime  { userId? }  → pre-warm container
  // Fired by the frontend on workspace mount so the first terminal doesn't eat
  // the rootless-dockerd cold start. Returns immediately (202); the daemon warms
  // in the background.
  const ensureRuntimeMatch = /^\/program-runtime\/([^/]+)\/ensure-runtime$/.exec(programRuntimeUrl.pathname);
  if (ensureRuntimeMatch && req.method === 'POST') {
    const slug = decodeURIComponent(ensureRuntimeMatch[1]);
    let parsed = {};
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      parsed = body ? JSON.parse(body) : {};
    } catch (_) { parsed = {}; }
    try {
      const actorUserId = parsed.userId || '';
      const codeSiteContext = runtimeCodeSiteContext(req, parsed, {
        workspaceSlug: slug,
        actorUserId,
        effectiveUserId: parsed.filesystemUserId || actorUserId,
      });
      const codeSiteMetadata = codeSiteRuntimeMetadata(codeSiteContext);
      try {
        guardCodeSiteRuntimeHostSurface(slug, codeSiteContext, 'program-runtime:ensure-runtime');
      } catch (err) {
        writeCodeSiteDenied(res, err);
        return;
      }
      const { status, body: out } = await handleEnsureRuntime({
        workspaceRuntime,
        slug,
        userId: actorUserId,
        codesiteContext: codeSiteContext.active ? codeSiteContext : null,
        codesiteMetadata: codeSiteMetadata,
      });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (err) {
      logger.warn('ensure_runtime_failed', { slug }, err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ensure_runtime_failed' }));
    }
    return;
  }

  // GET /program-runtime/:slug/manifest  → { found, source, raw }
  // Reads the workspace recipe manifest (vectant.programs.json preferred, else
  // .devcontainer/devcontainer.json). Returns raw bytes for the caller to parse.
  const manifestMatch = /^\/program-runtime\/([^/]+)\/manifest$/.exec(programRuntimeUrl.pathname);
  if (manifestMatch && req.method === 'GET') {
    const slug = decodeURIComponent(manifestMatch[1]);
    // userId is required to resolve a per-user workspace repo (repos/<slug>/<userId>);
    // without it we'd read the shared slug dir and miss the user's manifest.
    const manifestUserId = programRuntimeUrl.searchParams.get('userId') || undefined;
    try {
      const fs = require('fs');
      const path = require('path');
      const { resolveWorkspaceCwd } = require('./terminalService');
      const cwd = await resolveWorkspaceCwd(slug, manifestUserId);
      const candidates = [
        { source: 'vectant.programs.json', file: path.join(cwd, 'vectant.programs.json') },
        { source: 'devcontainer.json', file: path.join(cwd, '.devcontainer', 'devcontainer.json') },
        { source: 'devcontainer.json', file: path.join(cwd, '.devcontainer.json') },
      ];
      let result = { found: false };
      for (const candidate of candidates) {
        if (fs.existsSync(candidate.file)) {
          result = { found: true, source: candidate.source, raw: fs.readFileSync(candidate.file, 'utf8') };
          break;
        }
      }
      // Slice 1 (real programs): report whether a container runtime exists so the
      // frontend imports a devcontainer with an image as a real `container` program.
      const containerRuntimeAvailable = isSysboxRuntimeEnabled() || process.env.ENABLE_CONTAINER_RUNTIME === '1';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...result, containerRuntimeAvailable }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Manifest read failed' }));
    }
    return;
  }

  // GET /program-runtime/:slug/detect → { found, files:{name:raw}, containerRuntimeAvailable }
  // Slice 1 (real programs): probe the workspace for container artifacts
  // (docker-compose / devcontainer / Dockerfile) and report whether a container
  // runtime is available. The frontend (repoDetect) maps the raw bytes → config.
  const detectMatch = /^\/program-runtime\/([^/]+)\/detect$/.exec(programRuntimeUrl.pathname);
  if (detectMatch && req.method === 'GET') {
    const slug = decodeURIComponent(detectMatch[1]);
    const detectUserId = programRuntimeUrl.searchParams.get('userId') || undefined;
    try {
      const fs = require('fs');
      const path = require('path');
      const { resolveWorkspaceCwd } = require('./terminalService');
      const cwd = await resolveWorkspaceCwd(slug, detectUserId);
      const names = [
        'docker-compose.yml', 'compose.yaml', 'compose.yml',
        '.devcontainer/devcontainer.json', '.devcontainer.json', 'devcontainer.json',
        'Dockerfile',
      ];
      const files = {};
      for (const name of names) {
        const file = path.join(cwd, name);
        if (fs.existsSync(file)) files[name] = fs.readFileSync(file, 'utf8');
      }
      const containerRuntimeAvailable = isSysboxRuntimeEnabled() || process.env.ENABLE_CONTAINER_RUNTIME === '1';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ found: Object.keys(files).length > 0, files, containerRuntimeAvailable }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'detect failed' }));
    }
    return;
  }

  // GET /program-runtime/:slug/context → { files:{name:contents} }
  // Curated, read-only workspace files for AI manifest generation (allow-listed).
  const contextMatch = /^\/program-runtime\/([^/]+)\/context$/.exec(programRuntimeUrl.pathname);
  if (contextMatch && req.method === 'GET') {
    const slug = decodeURIComponent(contextMatch[1]);
    const ctxUserId = programRuntimeUrl.searchParams.get('userId') || undefined;
    try {
      const { resolveWorkspaceCwd } = require('./terminalService');
      const { readContextFiles } = require('./contextFiles');
      const cwd = await resolveWorkspaceCwd(slug, ctxUserId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ files: readContextFiles(cwd) }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'context failed' }));
    }
    return;
  }

  // POST /program-runtime/:slug/scaffold  { userId, files:[{path,contents}], overwrite? }
  // Writes starter files into the workspace dir, ONLY when missing. Path-guarded.
  const scaffoldMatch = /^\/program-runtime\/([^/]+)\/scaffold$/.exec(programRuntimeUrl.pathname);
  if (scaffoldMatch && req.method === 'POST') {
    const slug = decodeURIComponent(scaffoldMatch[1]);
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
    try {
      const { resolveWorkspaceCwd } = require('./terminalService');
      const { applyScaffoldFiles } = require('./scaffold');
      const cwd = await resolveWorkspaceCwd(slug, parsed.userId || undefined);
      const codeSiteContext = codeSiteContextFromRequest(req, parsed, {
        workspaceSlug: slug,
        actorUserId: parsed.userId || null,
        effectiveUserId: parsed.userId || null,
      });
      const scaffoldAttempts = await Promise.all((parsed.files || []).map(async (file) => {
        const derivedLineProvenance = await deriveCodeSiteLineProvenance(slug, file?.path, file?.content, parsed.userId || null, {
          evidenceRefs: file?.evidenceRefs || file?.evidence_refs || parsed.evidenceRefs || parsed.evidence_refs,
          processAncestry: file?.processAncestry || file?.process_ancestry || parsed.processAncestry || parsed.process_ancestry,
          promptSummary: 'Program scaffold file write',
          reasonRef: `program-scaffold:${file?.path}`,
        });
        return {
          path: file?.path,
          kind: 'program-scaffold',
          tool: 'file_write',
          ...codeSiteWriteEvidence({ ...parsed, ...file }, derivedLineProvenance),
        };
      }));
      const boundary = await runCodeSiteMutationBoundary(codeSiteContext, {
        operation: 'program-scaffold',
        tool: 'file_write',
        attempts: scaffoldAttempts,
      }, async () => applyScaffoldFiles(cwd, parsed.files || [], { overwrite: parsed.overwrite === true }), { repoRoot: cwd });
      const result = boundary.applyResult;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      if (isCodeSiteDeniedError(err)) {
        writeCodeSiteDenied(res, err);
        return;
      }
      const code = err?.message === 'path_escape' ? 400 : 500;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || 'scaffold failed' }));
    }
    return;
  }

  const quarantineCollectionMatch = /^\/codesitefs\/quarantines\/([^/]+)$/.exec(programRuntimeUrl.pathname);
  if (quarantineCollectionMatch && req.method === 'GET') {
    const slug = decodeURIComponent(quarantineCollectionMatch[1]);
    const actorUserId = programRuntimeUrl.searchParams.get('userId') || (req.headers['x-user-id'] ? String(req.headers['x-user-id']) : '');
    const effectiveUserId = programRuntimeUrl.searchParams.get('filesystemUserId')
      || (req.headers['x-runtime-fs-user-id'] ? String(req.headers['x-runtime-fs-user-id']) : '')
      || actorUserId;
    const runtimeScope = programRuntimeUrl.searchParams.get('runtimeScope') || (req.headers['x-runtime-scope'] ? String(req.headers['x-runtime-scope']) : '');
    const collectionCodeSiteData = Object.fromEntries(programRuntimeUrl.searchParams.entries());
    const collectionCodeSiteContext = runtimeCodeSiteContext(req, collectionCodeSiteData, {
      workspaceSlug: slug,
      actorUserId,
      effectiveUserId,
    });
    try {
      const storage = await codeSiteQuarantineStorageForRequest(slug, effectiveUserId, runtimeScope, 'codesitefs-quarantines-list', collectionCodeSiteContext, {
        ensureRuntime: false,
      });
      const quarantines = await listCodeSiteQuarantineManifests(storage.baseDir, slug, {
        transactionId: programRuntimeUrl.searchParams.get('transactionId') || null,
        status: programRuntimeUrl.searchParams.get('status') || null,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, quarantines }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err?.message || 'codesite_quarantine_list_failed' }));
    }
    return;
  }

  const quarantineRecordMatch = /^\/codesitefs\/quarantines\/([^/]+)\/([^/]+)(?:\/(replay|apply))?$/.exec(programRuntimeUrl.pathname);
  if (quarantineRecordMatch) {
    const slug = decodeURIComponent(quarantineRecordMatch[1]);
    const quarantineId = decodeURIComponent(quarantineRecordMatch[2]);
    const action = quarantineRecordMatch[3] || null;
    let parsed = {};
    if (req.method !== 'GET') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { parsed = JSON.parse(body || '{}'); } catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }
    }
    const headerUserId = req.headers['x-user-id'] ? String(req.headers['x-user-id']) : '';
    const runtimeScope = parsed.runtimeScope
      || programRuntimeUrl.searchParams.get('runtimeScope')
      || (req.headers['x-runtime-scope'] ? String(req.headers['x-runtime-scope']) : '');
    const actorUserId = parsed.userId || parsed.actorUserId || programRuntimeUrl.searchParams.get('userId') || headerUserId || '';
    const effectiveUserId =
      parsed.filesystemUserId ||
      programRuntimeUrl.searchParams.get('filesystemUserId') ||
      (req.headers['x-runtime-fs-user-id'] ? String(req.headers['x-runtime-fs-user-id']) : '') ||
      actorUserId;
    const codeSiteContext = runtimeCodeSiteContext(req, parsed, {
      workspaceSlug: slug,
      actorUserId,
      effectiveUserId,
    });
    const codeSiteMetadata = codeSiteRuntimeMetadata(codeSiteContext);
    try {
      let requestedPaths = null;
      if (action) {
        if (!['replay', 'apply'].includes(action) || req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
          return;
        }
        requestedPaths = selectedQuarantinePathSet(parsed);
        if (action === 'apply' && (!codeSiteContext.active || !codeSiteContext.transactionId)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            error: 'codesite_transaction_required',
            message: 'Applying a quarantine replay requires an active CodeSite transaction.',
            codesite: codeSiteMetadata,
          }));
          return;
        }
        if (action === 'apply' && requiresCodeSiteManagedRuntimeContext(codeSiteContext)) {
          writeCodeSiteManagedContextRequired(res, codeSiteMetadata, 'codesitefs-quarantine-apply');
          return;
        }
      }
      const storage = await codeSiteQuarantineStorageForRequest(slug, effectiveUserId, runtimeScope, `codesitefs-quarantine-${action || 'get'}`, codeSiteContext);
      const quarantine = await readCodeSiteQuarantineManifest(storage.baseDir, slug, quarantineId);
      if (!action && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, quarantine }));
        return;
      }

      const selected = selectedQuarantineChanges(quarantine, parsed, requestedPaths);
      const manifestEventDetails = quarantineManifestEventDetails(quarantine);
      const replay = await prepareCodeSiteQuarantineReplayPlan({
        slug,
        changes: selected,
        repoRoot: storage.repoRoot,
        effectiveUserId,
        evidenceRefs: [
          ...arrayValue(parsed.evidenceRefs || parsed.evidence_refs),
          ...arrayValue(quarantine.evidenceRefs),
        ],
        processAncestry: [
          ...arrayValue(parsed.processAncestry || parsed.process_ancestry),
          ...arrayValue(quarantine.processAncestry),
        ],
        ancestryLabel: action === 'apply'
          ? 'collab-server:codesitefs-quarantine-apply'
          : 'collab-server:codesitefs-quarantine-replay',
      });

      if (action === 'replay') {
        const reviewedEvent = await recordCodeSiteQuarantineTimelineEvent(codeSiteContext, 'quarantine_reviewed', {
          quarantineId,
          paths: replay.prepared.map((item) => item.change.path),
          rejected: replay.rejected,
          evidenceRefs: quarantine.evidenceRefs,
          details: {
            quarantineId,
            selectedChangeCount: selected.length,
            replayableChangeCount: replay.prepared.length,
            rejectedChangeCount: replay.rejected.length,
            ...manifestEventDetails,
          },
        });
        const replayedEvent = await recordCodeSiteQuarantineTimelineEvent(codeSiteContext, 'quarantine_replayed', {
          quarantineId,
          paths: replay.prepared.map((item) => item.change.path),
          rejected: replay.rejected,
          evidenceRefs: quarantine.evidenceRefs,
          details: {
            quarantineId,
            selectedChangeCount: selected.length,
            replayableChangeCount: replay.prepared.length,
            rejectedChangeCount: replay.rejected.length,
            ...manifestEventDetails,
          },
        });
        res.writeHead(replay.rejected.length ? 409 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: replay.rejected.length === 0,
          mode: 'replay',
          quarantine: {
            quarantineId,
            status: quarantine.status,
            transactionId: quarantine.transactionId,
          },
          replay: replay.prepared.map(quarantineReplayAppliedRecord),
          rejected: replay.rejected,
          timelineEvents: {
            reviewed: reviewedEvent,
            replayed: replayedEvent,
          },
          codesite: codeSiteMetadata,
        }));
        return;
      }

      if (replay.rejected.length) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: 'quarantine_replay_stale_or_invalid',
          rejected: replay.rejected,
          codesite: codeSiteMetadata,
        }));
        return;
      }

      const attempts = replay.prepared.map(quarantineReplayAttempt);
      const boundary = await runCodeSiteMutationBoundary(codeSiteContext, {
        operation: 'quarantine-review-apply',
        tool: 'file_write',
        attempts,
      }, async () => {
        const applied = [];
        for (const item of replay.prepared) {
          await applyQuarantineReplayItem(slug, item, effectiveUserId);
          applied.push(quarantineReplayAppliedRecord(item));
        }
        return { applied };
      }, {
        ...codeSiteEnforceOptions(codeSiteContext),
        repoRoot: storage.repoRoot,
      });

      const applied = boundary.applyResult?.applied || [];
      for (const item of applied) {
        if (item.operation === 'delete') {
          broadcastFileReverted(slug, [item.path], { userId: effectiveUserId });
        } else {
          broadcastFileSaved(slug, item.path, { userId: effectiveUserId });
        }
      }
      broadcastFileTreeChanged(slug, { userId: effectiveUserId });
      broadcastGitStatusChanged(slug, undefined, { userId: effectiveUserId }, { immediate: true });
      const timelineEvent = await recordCodeSiteQuarantineTimelineEvent(codeSiteContext, 'quarantine_applied', {
        quarantineId,
        paths: applied.map((item) => item.path),
        evidenceRefs: quarantine.evidenceRefs,
        details: {
          quarantineId,
          applied,
          boundaryPhase: boundary.phase,
          ...manifestEventDetails,
        },
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        quarantine: { quarantineId, status: quarantine.status, transactionId: quarantine.transactionId },
        applied,
        rejected: [],
        timelineEvent,
        codesite: codeSiteMetadata,
        boundary: {
          phase: boundary.phase,
          operation: boundary.operation?.operation || boundary.operation,
          attempts: boundary.attempts.map((attempt) => ({
            path: attempt.path,
            disposition: attempt.disposition,
            eventRecordId: attempt.eventRecord?.id || null,
          })),
          verification: boundary.verification,
        },
      }));
    } catch (err) {
      if (isCodeSiteDeniedError(err)) {
        writeCodeSiteDenied(res, err);
        return;
      }
      if (err?.code === 'MISSING_SELECTED_PATHS') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: 'missing_selected_paths',
          message: 'Replay/apply requires explicit selected quarantine paths.',
          codesite: codeSiteMetadata,
        }));
        return;
      }
      const notFound = err?.code === 'ENOENT';
      console.error('[CodeSiteFS Quarantine] failed:', err?.message || err);
      res.writeHead(notFound ? 404 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: notFound ? 'codesite_quarantine_not_found' : 'codesite_quarantine_failed',
        message: err?.message || 'CodeSite quarantine operation failed',
        detail: {
          action: action || 'get',
          controlPlaneUrl: codeSiteControlPlaneBaseUrl(codeSiteContext),
          hasControlPlaneCookie: Boolean(codeSiteContext.cookie),
        },
        codesite: codeSiteMetadata,
      }));
    }
    return;
  }

  // Compatibility endpoint for callers that already have explicit quarantine
  // evidence packets but not a stored manifest id.
  const quarantineApplyMatch = /^\/codesitefs\/quarantine\/apply\/([^/]+)$/.exec(programRuntimeUrl.pathname);
  if (quarantineApplyMatch && req.method === 'POST') {
    const slug = decodeURIComponent(quarantineApplyMatch[1]);
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const headerUserId = req.headers['x-user-id'] ? String(req.headers['x-user-id']) : '';
    const runtimeScope = parsed.runtimeScope || (req.headers['x-runtime-scope'] ? String(req.headers['x-runtime-scope']) : '');
    const actorUserId = parsed.userId || parsed.actorUserId || headerUserId || '';
    const effectiveUserId =
      parsed.filesystemUserId ||
      (req.headers['x-runtime-fs-user-id'] ? String(req.headers['x-runtime-fs-user-id']) : '') ||
      actorUserId;
    const codeSiteContext = runtimeCodeSiteContext(req, parsed, {
      workspaceSlug: slug,
      actorUserId,
      effectiveUserId,
    });
    const codeSiteMetadata = codeSiteRuntimeMetadata(codeSiteContext);
    if (!codeSiteContext.active || !codeSiteContext.transactionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: 'codesite_transaction_required',
        message: 'Applying a quarantine replay requires an active CodeSite transaction.',
        codesite: codeSiteMetadata,
      }));
      return;
    }
    if (requiresCodeSiteManagedRuntimeContext(codeSiteContext)) {
      writeCodeSiteManagedContextRequired(res, codeSiteMetadata, 'codesitefs-quarantine-apply');
      return;
    }

    try {
      const storage = await codeSiteQuarantineStorageForRequest(slug, effectiveUserId, runtimeScope, 'codesitefs-quarantine-apply', codeSiteContext);
      const replay = await prepareCodeSiteQuarantineReplayPlan({
        slug,
        changes: parsed.changes || parsed.quarantineChanges || parsed.quarantine_changes || parsed.files || [],
        repoRoot: storage.repoRoot,
        effectiveUserId,
        evidenceRefs: parsed.evidenceRefs || parsed.evidence_refs,
        processAncestry: parsed.processAncestry || parsed.process_ancestry,
        ancestryLabel: 'collab-server:codesitefs-quarantine-apply',
      });
      if (replay.rejected.length) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: 'quarantine_replay_stale_or_invalid',
          rejected: replay.rejected,
          codesite: codeSiteMetadata,
        }));
        return;
      }
      const attempts = replay.prepared.map(quarantineReplayAttempt);
      const boundary = await runCodeSiteMutationBoundary(codeSiteContext, {
        operation: 'quarantine-review-apply',
        tool: 'file_write',
        attempts,
      }, async () => {
        const applied = [];
        for (const item of replay.prepared) {
          await applyQuarantineReplayItem(slug, item, effectiveUserId);
          applied.push(quarantineReplayAppliedRecord(item));
        }
        return { applied };
      }, {
        ...codeSiteEnforceOptions(codeSiteContext),
        repoRoot: storage.repoRoot,
      });
      const applied = boundary.applyResult?.applied || [];
      for (const item of applied) {
        if (item.operation === 'delete') {
          broadcastFileReverted(slug, [item.path], { userId: effectiveUserId });
        } else {
          broadcastFileSaved(slug, item.path, { userId: effectiveUserId });
        }
      }
      broadcastFileTreeChanged(slug, { userId: effectiveUserId });
      broadcastGitStatusChanged(slug, undefined, { userId: effectiveUserId }, { immediate: true });
      const timelineEvent = await recordCodeSiteQuarantineTimelineEvent(codeSiteContext, 'quarantine_applied', {
        quarantineId: replay.prepared[0]?.change?.quarantineId || null,
        paths: applied.map((item) => item.path),
        evidenceRefs: parsed.evidenceRefs || parsed.evidence_refs,
        details: { applied, boundaryPhase: boundary.phase },
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        applied,
        rejected: [],
        timelineEvent,
        codesite: codeSiteMetadata,
        boundary: {
          phase: boundary.phase,
          operation: boundary.operation?.operation || boundary.operation,
          attempts: boundary.attempts.map((attempt) => ({
            path: attempt.path,
            disposition: attempt.disposition,
            eventRecordId: attempt.eventRecord?.id || null,
          })),
          verification: boundary.verification,
        },
      }));
    } catch (err) {
      if (isCodeSiteDeniedError(err)) {
        writeCodeSiteDenied(res, err);
        return;
      }
      console.error('[CodeSiteFS Quarantine Apply] failed:', err?.message || err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: 'codesite_quarantine_apply_failed',
        message: err?.message || 'CodeSite quarantine apply failed',
        codesite: codeSiteMetadata,
      }));
    }
    return;
  }

  // EXEC-TERMINAL ENDPOINT — Execute command in a real PTY terminal
  // ========================================================================
  // POST /exec-terminal/:slug  { command: string, timeout?: number }
  // Creates a real PTY session, executes the command, captures output,
  // and keeps the PTY alive so the frontend can connect and see it.
  // Returns: { sessionId, command, output, exitCode, timedOut }
  if (req.url.startsWith('/exec-terminal/') && req.method === 'POST') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const slug = urlObj.pathname.split('/')[2];
    if (!slug) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing workspace slug' }));
      return;
    }

    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
    if (!requireCommandGatewayAuth(req, res, { slug, parsed, requiredScope: COMMAND_SCOPES.EXEC })) {
      return;
    }

    const command = (parsed.command || '').trim();
    if (!command) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing command' }));
      return;
    }

    const timeoutMs = Math.min(Number(parsed.timeout) || 30000, 60000);

    try {
      // Launch via the managed program runtime (tracks output/lifecycle, which
      // the completion-detection below relies on). Carry dev's runtime-scope /
      // filesystem-user identity so the pod path can route on it where active.
      const requestedSessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId.trim() : '';
      const sessionId = requestedSessionId || `ai-${crypto.randomUUID().slice(0, 8)}`;
      const headerUserId = req.headers['x-user-id'] ? String(req.headers['x-user-id']) : '';
      const runtimeScope = parsed.runtimeScope || (req.headers['x-runtime-scope'] ? String(req.headers['x-runtime-scope']) : '');
      const terminalUserId = parsed.userId || headerUserId || '';
      const filesystemUserId =
        parsed.filesystemUserId ||
        (req.headers['x-runtime-fs-user-id'] ? String(req.headers['x-runtime-fs-user-id']) : '') ||
        terminalUserId;
      const launchEnv = parsed.env && typeof parsed.env === 'object' ? parsed.env : {};
      const codeSiteContext = runtimeCodeSiteContext(req, parsed, {
        workspaceSlug: slug,
        actorUserId: terminalUserId,
        effectiveUserId: filesystemUserId,
      });
      const codeSiteMetadata = codeSiteRuntimeMetadata(codeSiteContext);
      try {
        guardCodeSiteRuntimeHostSurface(slug, codeSiteContext, 'exec-terminal');
      } catch (err) {
        writeCodeSiteDenied(res, err);
        return;
      }
      if (requiresCodeSiteManagedRuntimeContext(codeSiteContext)) {
        writeCodeSiteManagedContextRequired(res, codeSiteMetadata, 'exec-terminal');
        return;
      }
      if (codeSiteContext.active) {
        writeCodeSiteRuntimeBlocked(res, codeSiteMetadata, 'exec-terminal');
        return;
      }

      await managedProgramRuntime.launchManagedSession({
        sessionId,
        workspaceSlug: slug,
        userId: terminalUserId,
        command,
        env: {
          ...launchEnv,
          ...runtimeCodeSiteEnv(codeSiteContext, ['collab-server', 'exec-terminal']),
        },
        title: parsed.name || null,
        runtimeScope,
        filesystemUserId,
        activeWorkspacePath: parsed.activeWorkspacePath || '',
        metadata: codeSiteMetadata ? { codesite: codeSiteMetadata } : null,
        codesiteContext: codeSiteContext.active ? codeSiteContext : null,
      });

      const terminalSession = terminalSessions.get(sessionId);
      if (!terminalSession?.pty || !terminalSession.cwd) {
        throw new Error(`Managed runtime ${sessionId} failed to initialize`);
      }

      // Create a real PTY with a known session ID
      const { pty: ptyProcess, cwd } = terminalSession;
      const runtimeHandle = managedProgramRuntime.getManagedRuntime(sessionId);
      const commandStartedPromise = runtimeHandle?.commandStartedPromise || Promise.resolve();

      console.log(`[ExecTerminal] slug=${slug} runtimeScope=${runtimeScope || 'legacy'} fsUser=${filesystemUserId || 'none'} cwd=${cwd} sessionId=${sessionId} cmd=${command.slice(0, 120)}`);

      let commandDone = false;
      let commandSent = false;
      let timedOut = false;

      function getManagedOutput() {
        return managedProgramRuntime.getManagedSession(sessionId)?.output || '';
      }

      const isWin = require('os').platform() === 'win32';
      const promptPattern = isWin ? /PS [^\r\n]*>/ : /[$#]\s*$/;
      commandStartedPromise.then(() => {
        commandSent = true;
        // Start stability checking AFTER the command is sent + a grace period
        // for the command to start producing output.
        setTimeout(startStabilityCheck, 1500);
      });

      // Wait for the command to finish by detecting the shell prompt returning
      // AFTER the command output. Also use a stability fallback.
      function startStabilityCheck() {
        let lastOutputLen = getManagedOutput().length;
        let stableCount = 0;
        const STABLE_THRESHOLD = 4; // 4 consecutive checks × 500ms = 2s of silence
        const CHECK_INTERVAL = 500;
        let promptSeenAfterCmd = false;

        const checkDone = setInterval(() => {
          const output = getManagedOutput();

          // Primary: detect the shell prompt reappearing after command output
          // This means the command finished and the shell is ready for input
          if (commandSent && output.length > lastOutputLen) {
            // Check if the LATEST output chunk contains the prompt
            const recentOutput = output.slice(lastOutputLen);
            if (promptPattern.test(recentOutput)) {
              promptSeenAfterCmd = true;
            }
          }

          if (output.length === lastOutputLen) {
            stableCount++;
          } else {
            stableCount = 0;
            lastOutputLen = output.length;
          }

          // Done when: prompt returned after command output + output stable for 500ms
          // OR: output stable for 2s (fallback for commands that don't return to prompt)
          if ((promptSeenAfterCmd && stableCount >= 1) || stableCount >= STABLE_THRESHOLD || commandDone) {
            clearInterval(checkDone);
            clearTimeout(hardTimeout);
            respond();
          }
        }, CHECK_INTERVAL);
      }

      const hardTimeout = setTimeout(() => {
        timedOut = true;
        respond();
      }, timeoutMs);

      let responded = false;
      async function respond() {
        if (responded) return;
        responded = true;

        const output = getManagedOutput();

        // Extract the command output: find the echoed command and take everything after it
        // up to (but not including) the next shell prompt
        let cleanOutput = output;

        // Try to extract just the command output (between echoed command and next prompt)
        const cmdIndex = output.indexOf(command);
        if (cmdIndex !== -1) {
          // Start after the echoed command + newline
          const afterCmd = output.slice(cmdIndex + command.length).replace(/^\r?\n/, '');
          // Try to strip the trailing prompt
          const promptMatch = afterCmd.match(isWin ? /\r?\nPS [^\r\n]*>\s*$/ : /\r?\n[^\r\n]*[$#]\s*$/);
          cleanOutput = promptMatch
            ? afterCmd.slice(0, promptMatch.index).trim()
            : afterCmd.trim();
        }

        // Try to infer exit code from output (PTY doesn't expose it directly).
        // Heuristic: check for common error patterns that indicate failure.
        const looksLikeError = /\b(error|fatal|not recognized|cannot be loaded|is not a valid|denied|failed|abort)\b/i.test(cleanOutput)
          && !/\b(0 error|no error|fixed|resolved|warning)\b/i.test(cleanOutput);
        const inferredExitCode = looksLikeError ? 1 : 0;

        managedProgramRuntime.refreshManagedSessionPorts(sessionId).catch((portErr) => {
          logger.warn({ err: portErr, sessionId }, 'Failed to refresh managed session ports');
        });

        let quarantine = null;
        const proofSession = terminalSessions.get(sessionId);
        if (proofSession?.codesiteQuarantine) {
          try {
            quarantine = await finalizeCodeSiteQuarantineWorkspace(codeSiteContext, proofSession.codesiteQuarantine, {
              tool: 'raw_terminal',
              cleanup: false,
              resetBaseline: true,
            });
          } catch (err) {
            quarantine = { error: err?.message || 'codesite_quarantine_finalize_failed' };
          }
        }

        console.log(`[ExecTerminal] Done: sessionId=${sessionId} output=${cleanOutput.length}B exitCode=${inferredExitCode}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          sessionId,
          runtimeScope: runtimeScope || null,
          filesystemScoped: Boolean(filesystemUserId),
          codesite: codeSiteMetadata,
          command,
          output: cleanOutput || '(no output)',
          exitCode: inferredExitCode,
          timedOut,
          quarantine,
        }));
      }

      // If the PTY exits before timeout (e.g., single command), respond immediately
      ptyProcess.onExit(({ exitCode }) => {
        commandDone = true;
      });

    } catch (err) {
      console.error('[ExecTerminal] Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }

    return;
  }

  // ========================================================================
  // EXEC-PTY ENDPOINT — Execute command and mirror it to user's terminal
  // ========================================================================
  // POST /exec-pty/:slug  { command: string, timeout?: number }
  // Uses child_process.spawn for reliable, clean stdout/stderr capture,
  // AND writes the command + output to the user's live PTY so they see it.
  if (req.url.startsWith('/exec-pty/') && req.method === 'POST') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const slug = urlObj.pathname.split('/')[2];
    if (!slug) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing workspace slug' }));
      return;
    }

    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
    if (!requireCommandGatewayAuth(req, res, { slug, parsed, requiredScope: COMMAND_SCOPES.EXEC })) {
      return;
    }

    const command = (parsed.command || '').trim();
    if (!command) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing command' }));
      return;
    }

    const timeoutMs = Math.min(Number(parsed.timeout) || 30000, 60000);
    const { resolveWorkspaceCwd } = require('./terminalService');
    const headerUserId = req.headers['x-user-id'] ? String(req.headers['x-user-id']) : '';
    const runtimeScope = parsed.runtimeScope || (req.headers['x-runtime-scope'] ? String(req.headers['x-runtime-scope']) : '');
    const terminalUserId = parsed.userId || headerUserId || '';
    const filesystemUserId =
      parsed.filesystemUserId ||
      (req.headers['x-runtime-fs-user-id'] ? String(req.headers['x-runtime-fs-user-id']) : '') ||
      terminalUserId;
    const codeSiteContext = runtimeCodeSiteContext(req, parsed, {
      workspaceSlug: slug,
      actorUserId: terminalUserId,
      effectiveUserId: filesystemUserId,
    });
    const codeSiteMetadata = codeSiteRuntimeMetadata(codeSiteContext);
    try {
      guardCodeSiteRuntimeHostSurface(slug, codeSiteContext, 'exec-pty');
    } catch (err) {
      writeCodeSiteDenied(res, err);
      return;
    }
    if (requiresCodeSiteManagedRuntimeContext(codeSiteContext)) {
      writeCodeSiteManagedContextRequired(res, codeSiteMetadata, 'exec-pty');
      return;
    }
    let cwd;
    try {
      await ensureRuntimeFilesystem({
        workspaceSlug: slug,
        filesystemUserId,
        runtimeScope,
        reason: 'exec_pty',
        codesiteContext: codeSiteContext,
      });
      cwd = await resolveWorkspaceCwd(slug, filesystemUserId);
    } catch (err) {
      console.error('[ExecPTY] Workspace filesystem preparation failed:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Workspace filesystem preparation failed', detail: err.message }));
      return;
    }
    let codeSiteQuarantine = null;
    if (codeSiteContext.active) {
      try {
        codeSiteQuarantine = await createCodeSiteQuarantineWorkspace(codeSiteContext, cwd, {
          operation: 'exec-pty',
          baseDir: codeSiteRuntimeQuarantineBaseDir(cwd),
        });
        if (codeSiteQuarantine?.cwd) cwd = codeSiteQuarantine.cwd;
      } catch (err) {
        console.error('[ExecPTY] CodeSite quarantine preparation failed:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'CodeSite quarantine preparation failed', detail: err.message }));
        return;
      }
    }

    console.log(`[ExecPTY] slug=${slug} runtimeScope=${runtimeScope || 'legacy'} fsUser=${filesystemUserId || 'none'} cwd=${cwd} cmd=${command.slice(0, 120)}`);

    // Find active PTY session for this workspace to mirror output
    let targetSession = null;
    for (const [, session] of terminalSessions) {
      const sameWorkspace = session.workspaceSlug === slug || (session.cwd && session.cwd.endsWith(slug));
      const sameFilesystem = !filesystemUserId || !session.filesystemUserId || session.filesystemUserId === filesystemUserId;
      if (sameWorkspace && sameFilesystem && session.pty) {
        targetSession = session;
        break;
      }
    }

    // Use child_process.spawn for clean, reliable stdout/stderr capture
    const { spawn } = require('child_process');
    const isWin = require('os').platform() === 'win32';
    const shell = isWin ? 'powershell.exe' : '/bin/bash';
    const shellArgs = isWin ? ['-NoProfile', '-Command', command] : ['-c', command];

    const child = spawn(shell, shellArgs, {
      cwd,
      timeout: timeoutMs,
      env: {
        ...process.env,
        TERM: 'dumb',
        ...runtimeCodeSiteEnv(codeSiteContext, ['collab-server', 'exec-pty']),
      },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const MAX_OUT = 50000;

    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUT) stdout += d.toString(); });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUT) stderr += d.toString(); });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch (_) {}
    }, timeoutMs);

    child.on('close', async (exitCode) => {
      clearTimeout(timer);

      const combinedOutput = stdout + (stderr ? `\n${stderr}` : '');
      let quarantine = null;
      if (codeSiteQuarantine) {
        try {
          quarantine = await finalizeCodeSiteQuarantineWorkspace(codeSiteContext, codeSiteQuarantine, {
            tool: 'raw_terminal',
          });
        } catch (err) {
          quarantine = { error: err?.message || 'codesite_quarantine_finalize_failed' };
        }
      }

      // NOTE: Do NOT write output to the PTY via pty.write() — that sends INPUT
      // which PowerShell/bash interprets as commands, causing errors.
      // The AI chat UI already displays the command output to the user.

      console.log(`[ExecPTY] Done: exitCode=${exitCode} timedOut=${timedOut} stdout=${stdout.length}B`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        command,
        exitCode,
        stdout,
        stderr,
        timedOut,
        usedPty: Boolean(targetSession),
        codesite: codeSiteMetadata,
        quarantine,
      }));
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      console.error('[ExecPTY] Spawn error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });

    return;
  }

  // ========================================================================
  // EXEC ENDPOINT — One-shot command execution for AI tool-calling pipeline
  // ========================================================================
  // POST /exec/:slug  { command: string, timeout?: number }
  if (req.url.startsWith('/exec/') && req.method === 'POST') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const slug = urlObj.pathname.split('/')[2];
    if (!slug) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing workspace slug' }));
      return;
    }

    // Read JSON body
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
    if (!requireCommandGatewayAuth(req, res, { slug, parsed, requiredScope: COMMAND_SCOPES.EXEC })) {
      return;
    }

    const command = (parsed.command || '').trim();
    if (!command) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing command' }));
      return;
    }

    const timeoutMs = Math.min(Number(parsed.timeout) || 30000, 60000);
    const { resolveWorkspaceCwd } = require('./terminalService');
    const headerUserId = req.headers['x-user-id'] ? String(req.headers['x-user-id']) : '';
    const runtimeScope = parsed.runtimeScope || (req.headers['x-runtime-scope'] ? String(req.headers['x-runtime-scope']) : '');
    const terminalUserId = parsed.userId || headerUserId || '';
    const filesystemUserId =
      parsed.filesystemUserId ||
      (req.headers['x-runtime-fs-user-id'] ? String(req.headers['x-runtime-fs-user-id']) : '') ||
      terminalUserId;
    const codeSiteContext = runtimeCodeSiteContext(req, parsed, {
      workspaceSlug: slug,
      actorUserId: terminalUserId,
      effectiveUserId: filesystemUserId,
    });
    const codeSiteMetadata = codeSiteRuntimeMetadata(codeSiteContext);
    try {
      guardCodeSiteRuntimeHostSurface(slug, codeSiteContext, 'exec');
    } catch (err) {
      writeCodeSiteDenied(res, err);
      return;
    }
    if (requiresCodeSiteManagedRuntimeContext(codeSiteContext)) {
      writeCodeSiteManagedContextRequired(res, codeSiteMetadata, 'exec');
      return;
    }
    let cwd;
    try {
      await ensureRuntimeFilesystem({
        workspaceSlug: slug,
        filesystemUserId,
        runtimeScope,
        reason: 'exec',
        codesiteContext: codeSiteContext,
      });
      cwd = await resolveWorkspaceCwd(slug, filesystemUserId);
    } catch (err) {
      console.error('[Exec] Workspace filesystem preparation failed:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Workspace filesystem preparation failed', detail: err.message }));
      return;
    }
    let codeSiteQuarantine = null;
    if (codeSiteContext.active) {
      try {
        codeSiteQuarantine = await createCodeSiteQuarantineWorkspace(codeSiteContext, cwd, {
          operation: 'exec',
          baseDir: codeSiteRuntimeQuarantineBaseDir(cwd),
        });
        if (codeSiteQuarantine?.cwd) cwd = codeSiteQuarantine.cwd;
      } catch (err) {
        console.error('[Exec] CodeSite quarantine preparation failed:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'CodeSite quarantine preparation failed', detail: err.message }));
        return;
      }
    }

    console.log(`[Exec] slug=${slug} runtimeScope=${runtimeScope || 'legacy'} fsUser=${filesystemUserId || 'none'} cwd=${cwd} cmd=${command.slice(0, 120)}`);

    const { spawn } = require('child_process');
    const isWin = require('os').platform() === 'win32';
    const shell = isWin ? 'powershell.exe' : '/bin/bash';
    const shellArgs = isWin ? ['-NoProfile', '-Command', command] : ['-c', command];

    const child = spawn(shell, shellArgs, {
      cwd,
      timeout: timeoutMs,
      env: {
        ...process.env,
        TERM: 'dumb',
        ...runtimeCodeSiteEnv(codeSiteContext, ['collab-server', 'exec']),
      },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const MAX_OUT = 50000;

    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUT) stdout += d.toString(); });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUT) stderr += d.toString(); });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch (_) {}
    }, timeoutMs);

    child.on('close', async (exitCode) => {
      clearTimeout(timer);
      let quarantine = null;
      if (codeSiteQuarantine) {
        try {
          quarantine = await finalizeCodeSiteQuarantineWorkspace(codeSiteContext, codeSiteQuarantine, {
            tool: 'raw_terminal',
          });
        } catch (err) {
          quarantine = { error: err?.message || 'codesite_quarantine_finalize_failed' };
        }
      }
      console.log(`[Exec] Done: exitCode=${exitCode} timedOut=${timedOut} stdout=${stdout.length}B stderr=${stderr.length}B`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ exitCode, stdout, stderr, timedOut, codesite: codeSiteMetadata, quarantine }));
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      console.error('[Exec] Spawn error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });

    return;
  }

  if (req.url.startsWith('/workspaces') && req.method === 'GET') {
      try {
          // Parse query params for owner
          const url = new URL(req.url, `http://${req.headers.host}`);
          const owner = url.searchParams.get('owner');
          const recentOnly = url.searchParams.get('recent') === 'true';
          
          const workspaces = workspaceManager.getWorkspaces(owner, { recentOnly });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(workspaces));
      } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
      }
      return;
  }

  // ========================================================================
  // MIGRATION STATUS — Check/trigger lazy migration for a workspace
  // ========================================================================
  if (req.url.startsWith('/migration/') && (req.method === 'GET' || req.method === 'POST')) {
    const urlParts = req.url.split('/');
    const migAction = urlParts[2]; // 'status' or 'trigger'
    const migSlug = urlParts[3];

    if (!migSlug) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing slug' }));
      return;
    }

    try {
      if (migAction === 'status' && req.method === 'GET') {
        const isLegacy = gitService.isLegacyRepo(migSlug);
        const isMigrated = gitService.isMigratedRepo(migSlug);
        const marker = gitService._readMigrationMarker(migSlug);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ slug: migSlug, isLegacy, isMigrated, marker }));
      } else if (migAction === 'trigger' && req.method === 'POST') {
        console.log(`[Server] Manual migration trigger for: ${migSlug}`);
        const result = await gitService.ensureMigrated(migSlug);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ slug: migSlug, ...result }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unknown migration action' }));
      }
    } catch (e) {
      console.error(`[Migration API] Error for ${migSlug}:`, e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, code: e.code || 'MIGRATION_ERROR' }));
    }
    return;
  }

  // ========================================================================
  // USER BLOCK API — Block/unblock other users
  // ========================================================================

  /**
   * POST /user/block  { userId, blockedUserId }
   * Blocks blockedUserId for userId. The blocked user won't see userId in
   * presence, can't invite them, and can't join their workspace.
   */
  if (req.url === '/user/block' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { userId, blockedUserId } = JSON.parse(body);
        if (!userId || !blockedUserId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'userId and blockedUserId are required' }));
          return;
        }
        if (!blockedBy.has(userId)) blockedBy.set(userId, new Set());
        blockedBy.get(userId).add(blockedUserId);
        logger.info('user_blocked', { userId, blockedUserId });
        // Persist asynchronously — never block the request on storage latency.
        persistence.saveBlock(userId, blockedUserId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  /**
   * POST /user/unblock  { userId, blockedUserId }
   */
  if (req.url === '/user/unblock' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { userId, blockedUserId } = JSON.parse(body);
        if (!userId || !blockedUserId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'userId and blockedUserId are required' }));
          return;
        }
        if (blockedBy.has(userId)) {
          blockedBy.get(userId).delete(blockedUserId);
          if (blockedBy.get(userId).size === 0) blockedBy.delete(userId);
        }
        logger.info('user_unblocked', { userId, blockedUserId });
        persistence.removeBlock(userId, blockedUserId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  /**
   * GET /user/blocked-list?userId=...
   * Returns the list of blocked user IDs for the given user.
   */
  if (req.url.startsWith('/user/blocked-list') && req.method === 'GET') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const userId = urlObj.searchParams.get('userId');
    if (!userId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'userId is required' }));
      return;
    }
    const list = blockedBy.has(userId) ? Array.from(blockedBy.get(userId)) : [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ userId, blockedUsers: list }));
    return;
  }

  // ========================================================================
  // PRESENCE — is a given user currently online?
  //
  //   GET /presence/user/:userId
  //   → { userId, online, inboxPending }
  //
  // Consumers use this to decide whether to show "User is offline, we'll
  // notify them when they return" vs. "Sending invite now...".  inboxPending
  // is how many queued events are waiting for their next connect.
  // ========================================================================
  if (req.url.startsWith('/presence/user/') && req.method === 'GET') {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const userId = decodeURIComponent(urlObj.pathname.split('/')[3] || '');
      if (!userId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'userId is required' }));
        return;
      }
      const online = isUserOnline(userId);
      const inboxPending = online ? 0 : await persistence.peekUserInboxSize(userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ userId, online, inboxPending }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ========================================================================
  // FILE HISTORY + VERSIONS — audit log + server-side undo for saves.
  // Backed by Redis (persistence.js).  Returns an empty list when
  // persistence is disabled.
  //
  //   GET /file-history/:slug?filePath=...&limit=50
  //   GET /file-versions/:slug?filePath=...
  //   GET /file-version/:slug?filePath=...&index=N
  // ========================================================================
  if (req.url.startsWith('/file-history/') && req.method === 'GET') {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const slug = decodeURIComponent(urlObj.pathname.split('/')[2] || '');
      const filePath = urlObj.searchParams.get('filePath') || '';
      const limit = parseInt(urlObj.searchParams.get('limit') || '50', 10);
      if (!slug || !filePath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'slug and filePath are required' }));
        return;
      }
      try { validateFilePath(filePath); }
      catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); return; }
      const events = await persistence.getFileHistory(slug, filePath, limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ slug, filePath, events }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url.startsWith('/file-versions/') && req.method === 'GET') {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const slug = decodeURIComponent(urlObj.pathname.split('/')[2] || '');
      const filePath = urlObj.searchParams.get('filePath') || '';
      if (!slug || !filePath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'slug and filePath are required' }));
        return;
      }
      try { validateFilePath(filePath); }
      catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); return; }
      // Metadata-only listing by default — content retrieval is a separate
      // call so the default response is cheap.
      const versions = await persistence.getFileVersions(slug, filePath, { withContent: false });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ slug, filePath, versions }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url.startsWith('/file-version/') && req.method === 'GET') {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const slug = decodeURIComponent(urlObj.pathname.split('/')[2] || '');
      const filePath = urlObj.searchParams.get('filePath') || '';
      const index = parseInt(urlObj.searchParams.get('index') || '0', 10);
      if (!slug || !filePath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'slug and filePath are required' }));
        return;
      }
      try { validateFilePath(filePath); }
      catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); return; }
      const version = await persistence.getFileVersion(slug, filePath, index);
      if (!version) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'version_not_found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ slug, filePath, index, version }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ========================================================================
  // POST /file-version/restore — rewrite a file back to a stored version.
  //
  // Body: { slug, filePath, index, userId, sessionId? }
  //   - slug + filePath: target file (traversal-checked via realpath)
  //   - index: position in the version list (0 = most recent save-point)
  //   - userId: actor performing the restore
  //   - sessionId: optional. When set, the host's repo is the restore target
  //     and the caller must be the host or a guest with canEdit.
  //
  // Effects: disk rewrite, Y-Sweet CRDT content reset (falls back to doc
  // invalidation if the SDK lacks a write path), new save-point logged,
  // broadcasts file-saved + git-status-changed.
  // ========================================================================
  if (req.url === '/file-version/restore' && req.method === 'POST') {
    if (!rateLimitGuard(req, res, 'file-version-restore', 20)) return;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const { slug, filePath, userId } = payload;
        const sessionId = payload.sessionId || null;
        const index = Number.isFinite(payload.index) ? payload.index : parseInt(payload.index, 10);
        if (!slug || !filePath || !Number.isFinite(index) || index < 0 || !userId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'slug, filePath, index (>=0), userId are required' }));
          return;
        }
        const { isValidUserId, isValidSessionId } = require('./permissionMiddleware');
        if (!isValidUserId(userId)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_userId' }));
          return;
        }
        if (sessionId && !isValidSessionId(sessionId)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_sessionId' }));
          return;
        }
        let normalizedPath;
        try { normalizedPath = validateFilePath(filePath); }
        catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }

        // Resolve which user's repo + CRDT room to rewrite.  Session flows
        // always target the host; solo flows target the caller.
        let targetUserId = userId;
        if (sessionId) {
          const session = sessionManager.getSession(sessionId);
          if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'session_not_found' }));
            return;
          }
          if (session.slug !== slug) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'session_slug_mismatch' }));
            return;
          }
          if (session.hostId !== userId &&
              !sessionManager.checkPermission(sessionId, userId, 'canEdit')) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'edit_permission_required' }));
            return;
          }
          targetUserId = session.hostId;
        }

        const version = await persistence.getFileVersion(slug, normalizedPath, index);
        if (!version) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'version_not_found' }));
          return;
        }
        if (!version.hasContent || typeof version.content !== 'string') {
          // Oversized versions are stored as metadata only.  Hand the
          // caller the hash so they can show "snapshot exists but was too
          // large to keep" rather than silently failing.
          res.writeHead(410, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'version_content_unavailable',
            hash: version.hash || null,
            size: version.size || null,
          }));
          return;
        }

        const content = version.content;
        const docName = buildDocName(slug, normalizedPath, {
          userId: targetUserId,
          sessionId,
        });

        const repoPath = gitService.getEffectiveRepoPath(slug, targetUserId);
        if (!fs.existsSync(repoPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'repo_not_found' }));
          return;
        }
        // Belt-and-braces traversal guard: resolve symlinks inside the
        // repo before writing.  validateFilePath already rejected `..`
        // segments, but a symlink pointing out of the tree is still
        // possible without this check.
        let fullPath;
        try {
          const realRepo = await fsPromises.realpath(repoPath);
          fullPath = path.resolve(realRepo, normalizedPath);
          const rel = path.relative(realRepo, fullPath);
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error('path escapes repo root');
          }
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_repo_path', detail: e.message }));
          return;
        }

        // 1) Disk is authoritative — rewrite it first.
        const codeSiteContext = codeSiteContextFromRequest(req, payload, {
          workspaceSlug: slug,
          actorUserId: userId,
          effectiveUserId: targetUserId,
        });
        await runCodeSiteMutationBoundary(codeSiteContext, {
          operation: 'file-version-restore',
          tool: 'file_write',
          attempts: [{
            path: normalizedPath,
            kind: 'file-version-restore',
            tool: 'file_write',
          }],
        }, async () => gitService.writeFile(slug, normalizedPath, content, targetUserId), { repoRoot: repoPath });

        // 2) Pull the CRDT doc onto the restored content so live editors
        // converge without data loss, then ALWAYS hard-invalidate the doc.
        //
        // A successful resetDocContent alone is not sufficient: a client with
        // the file open may have newer local edits in its Y.Doc that would
        // merge with (rather than replace) the restored state, so the editor
        // keeps showing the unrestored text.  broadcastFileReverted triggers
        // the Editor's synthi:file-reverted handler (Editor.jsx:~2395) which
        // clears the Monaco model and re-fetches from disk; the preceding
        // invalidateDocsForSlug destroys the Y.Doc binding so Monaco can't
        // merge stale CRDT state back in on reconnect.
        let crdtReset = false;
        try {
          crdtReset = await ySweetBridge.resetDocContent(docName, content);
        } catch (err) {
          logger.warn('file_version_restore_crdt_reset_failed', { docName }, err);
          crdtReset = false;
        }
        await invalidateDocsForSlug(slug, [normalizedPath], {
          userId: targetUserId,
          sessionId,
        });

        // 3) Truncate any newer versions — after restore they no longer
        // represent the live timeline.  The entry at `index` becomes the
        // new head (index 0), so the list is: [restored-content, ...older].
        // No duplicate saveFileVersion: the restored content is already
        // the new index 0 by virtue of the trim.
        const restoredHash = computeHash(content);
        const size = Buffer.byteLength(content, 'utf8');
        fileHashCache.set(docName, { hash: restoredHash, timestamp: Date.now() });
        await persistence.truncateVersionsAbove(slug, normalizedPath, index);
        persistence.logFileEvent(slug, normalizedPath, {
          kind: 'restored',
          userId,
          sessionId,
          hash: restoredHash,
          size,
          meta: { fromIndex: index, fromHash: version.hash || null, targetUserId },
        });

        broadcastFileSaved(slug, normalizedPath, { userId: targetUserId, sessionId });
        broadcastGitStatusChanged(slug, normalizedPath, { userId: targetUserId, sessionId });
        // Tell the Editor to hard-refresh its model from disk.  This is the
        // event page.jsx's useSSEEvent(…'file-reverted'…) turns into the
        // 'synthi:file-reverted' DOM event the Editor handler waits for.
        broadcastFileReverted(slug, [normalizedPath], { userId: targetUserId, sessionId });

        logger.info('file_version_restored', {
          slug,
          filePath: normalizedPath,
          index,
          actor: userId,
          sessionId,
          targetUserId,
          hash: restoredHash,
          size,
          crdtReset,
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          slug,
          filePath: normalizedPath,
          index,
          restoredHash,
          size,
          targetUserId,
          docName,
          crdtReset,
        }));
      } catch (e) {
        if (isCodeSiteDeniedError(e)) {
          writeCodeSiteDenied(res, e);
          return;
        }
        logger.error('file_version_restore_failed', {}, e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ========================================================================
  // Y-SWEET TOKEN API — Issue connection tokens for CRDT document rooms
  // ========================================================================
  if (req.url.startsWith('/ysweet/token') && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const { docId } = JSON.parse(body || '{}');
        if (!docId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'docId is required' }));
          return;
        }

        // Defensive: before issuing the token, reconcile the Y-Sweet doc
        // with the authoritative disk content.  If an out-of-band write
        // happened while no one was connected (AI agent on a workspace the
        // user hasn't opened yet; fs-watcher never fired), the fs-watcher
        // invalidation path above won't have run.  Compare hashes and reset
        // the Y-Sweet doc if disk is newer.
        try {
          const parsed = parseDocName(docId);
          if (parsed?.slug && parsed?.filePath) {
            const effectiveUser = resolveEffectiveUserForDoc(parsed, null);
            const diskContent = await getActualFileContent(parsed.slug, parsed.filePath, effectiveUser);
            if (diskContent !== null) {
              const diskHash = computeHash(diskContent);
              const crdtContent = await ySweetBridge.readDocContent(docId);
              const crdtHash = crdtContent == null ? null : computeHash(crdtContent);
              if (crdtHash !== null && crdtHash !== diskHash) {
                console.log(`[Collab Token] Disk/CRDT hash mismatch for ${parsed.filePath} — resetting Y-Sweet doc to disk content`);
                const ok = await ySweetBridge.resetDocContent(docId, diskContent);
                if (!ok) {
                  // Reset unsupported — fall back to broadcast invalidation
                  // so connected clients destroy their Y.Docs.
                  await invalidateDocsForSlug(parsed.slug, [parsed.filePath], effectiveUser ? { userId: effectiveUser } : {});
                }
              }
              fileHashCache.set(docId, { hash: diskHash, timestamp: Date.now() });
            }
          }
        } catch (reconcileErr) {
          console.warn('[Collab Token] Pre-issue reconcile failed:', reconcileErr?.message || reconcileErr);
        }

        const tokenData = await ySweetBridge.getOrCreateToken(docId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tokenData));
      } catch (e) {
        console.error('[Y-Sweet Token] Error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ========================================================================
  // WORKSPACE PRESENCE API — Active users + sessions for a workspace
  // ========================================================================
  if (req.url.startsWith('/workspace-presence/') && req.method === 'GET') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const slug = urlObj.pathname.split('/')[2];
    if (!slug) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'slug is required' }));
      return;
    }

    try {
      // 1) Gather active users from notification WebSocket connections.
      //    Each notification WS client carries _slug, _userId, _userName,
      //    _userImage metadata set during the connection handshake.
      const seen = new Map();
      if (notifyWss) {
        notifyWss.clients.forEach((ws) => {
          if (ws.readyState !== WebSocket.OPEN || ws._slug !== slug) return;
          const uid = ws._userId;
          if (!uid) return;
          if (!seen.has(uid)) {
            seen.set(uid, {
              id: uid,
              name: ws._userName || userDisplayNameCache.get(uid)?.name || 'Anonymous',
              email: ws._userEmail || null,
              color: ws._userColor || '#888',
              image: ws._userImage || userDisplayNameCache.get(uid)?.avatar || null,
              lastActive: Date.now(),
              currentFile: null,
            });
          }
        });
      }
      let activeUsers = Array.from(seen.values());

      // 2) Get active collaboration sessions for this slug
      const sessions = sessionManager.getSessionsForSlug(slug);

      // 3) Filter out blocked users
      const requesterId = urlObj.searchParams.get('userId');
      if (requesterId) {
        const myBlocked = blockedBy.get(requesterId) || new Set();
        activeUsers = activeUsers.filter(u => {
          if (u.id === requesterId) return true;
          if (myBlocked.has(u.id)) return false;
          const theirBlocked = blockedBy.get(u.id);
          if (theirBlocked && theirBlocked.has(requesterId)) return false;
          return true;
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ slug, activeUsers, sessions }));
    } catch (e) {
      console.error('[Workspace Presence] Error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ========================================================================
  // DIRECT COLLABORATION — invite / ask-to-join a user (no pre-existing
  // session required). Sessions are auto-created on demand.
  // ========================================================================

  /**
   * POST /session/invite-user
   * Inviter becomes host (auto-creates session if not already hosting).
   * Sends an invite notification to the target user via notification WS.
   * Target can accept by knocking on the auto-created session.
   */
  if (req.url.startsWith('/session/invite-user') && req.method === 'POST') {
    if (!rateLimitGuard(req, res, 'invite-user', 30)) return;
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { hostId, hostName, hostAvatar, targetUserId, slug } = data;
        if (!hostId || !targetUserId || !slug) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'hostId, targetUserId, and slug are required' }));
          return;
        }

        // Block check: if target blocked host or host blocked target, deny
        const targetBlocked = blockedBy.get(targetUserId);
        const hostBlocked = blockedBy.get(hostId);
        if ((targetBlocked && targetBlocked.has(hostId)) || (hostBlocked && hostBlocked.has(targetUserId))) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cannot invite this user' }));
          return;
        }

        // Auto-create session if needed. Existing sessions must be read
        // through the host-only view so inviteToken is available for links.
        let session = sessionManager.getHostSessionForReconnect(hostId, slug);
        if (!session) {
          session = sessionManager.createSession({
            hostId,
            hostName: hostName || hostId,
            hostAvatar: hostAvatar || '',
            slug,
            worktreePath: '', // resolved at git-op time
            defaultPerms: { canEdit: true, canTerminal: false, canGit: false, canFileOps: true },
          });
        }

        // Track this user as invited so they are auto-admitted on knock
        sessionManager.addInvitedUser(session.id, targetUserId);

        // Deliver the collab-invite to the target user.  If they're online
        // on this slug we send over the notify-WS immediately; if they're
        // offline the event lands in their Redis inbox and pops as a
        // "missed while offline" notification next time they connect.
        const invitePayload = {
          slug,
          sessionId: session.id,
          hostId,
          hostName: hostName || hostId,
          hostAvatar: hostAvatar || '',
          inviteToken: session.inviteToken,
          roomCode: session.roomCode || null,
        };
        deliverToUser(targetUserId, 'collab-invite', invitePayload, { slug })
          .then((r) => logger.info('invite_delivery', { targetUserId, slug, delivered: r.delivered, queued: r.queued }))
          .catch((err) => logger.warn('invite_delivery_failed', { targetUserId, slug }, err));

        const inviteLink = makeInviteLink({
          sessionId: session.id,
          inviteToken: session.inviteToken,
          roomCode: session.roomCode,
          slug,
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          sessionId: session.id,
          inviteToken: session.inviteToken,
          inviteLink,
          roomCode: session.roomCode || null,
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  /**
   * POST /session/join-user
   * Request to join a specific user's workspace.  If the target user
   * doesn't have an active session yet, one is implicitly created for
   * them by the server.  The guest's knock is then forwarded to that
   * session so the target user can accept/deny.
   */
  if (req.url.startsWith('/session/join-user') && req.method === 'POST') {
    if (!rateLimitGuard(req, res, 'join-user', 30)) return;
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { targetUserId, targetUserName, guestId, displayName, avatarUrl, slug } = data;
        if (!targetUserId || !guestId || !slug) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'targetUserId, guestId, and slug are required' }));
          return;
        }

        // Block check: if target blocked guest or guest blocked target, deny
        const targetBlocked = blockedBy.get(targetUserId);
        const guestBlocked = blockedBy.get(guestId);
        if ((targetBlocked && targetBlocked.has(guestId)) || (guestBlocked && guestBlocked.has(targetUserId))) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cannot join this user' }));
          return;
        }

        // Find or auto-create a session for the target user
        let session = sessionManager.getSessionByHost(targetUserId);
        if (!session) {
          // Resolve a human-readable host name: prefer the name provided by
          // the joining guest's UI, then check the in-memory display-name
          // cache (populated from Yjs awareness), and finally fall back to
          // targetUserId.
          let resolvedHostName = targetUserName || '';
          if (!resolvedHostName) {
            const cached = userDisplayNameCache.get(targetUserId);
            if (cached?.name) {
              resolvedHostName = cached.name;
            }
          }
          const cachedAvatar = userDisplayNameCache.get(targetUserId)?.avatar || '';
          session = sessionManager.createSession({
            hostId: targetUserId,
            hostName: resolvedHostName || targetUserId,
            hostAvatar: cachedAvatar,
            slug,
            worktreePath: '',
            defaultPerms: { canEdit: true, canTerminal: false, canGit: false, canFileOps: true },
          });
          // Auto-created sessions are unconfirmed until the host explicitly
          // accepts the first guest.  This prevents the session from showing
          // as "LIVE" in workspace-presence before the host is aware of it.
          session.hostConfirmed = false;
          console.log(`[Session] Auto-created session ${session.id} for host ${targetUserId} (on demand, unconfirmed)`);

          // Notify the target user that a session was auto-created for them
          const autoHostMsg = JSON.stringify({
            type: 'auto-session-created',
            slug,
            sessionId: session.id,
            inviteToken: session.inviteToken,
          });
          // Send to session WS and notification WS
          if (sessionWss) {
            sessionWss.clients.forEach((ws) => {
              if (ws.readyState === WebSocket.OPEN && ws._userId === targetUserId) {
                try { ws.send(autoHostMsg); } catch (_) {}
              }
            });
          }
          if (notifyWss) {
            notifyWss.clients.forEach((ws) => {
              if (ws.readyState === WebSocket.OPEN && ws._slug === slug && ws._userId === targetUserId) {
                try { ws.send(autoHostMsg); } catch (_) {}
              }
            });
          }
        }

        // Knock on the session (may auto-admit if invited)
        const knockResult = sessionManager.knock(session.id, {
          guestId,
          displayName: displayName || guestId,
          avatarUrl: avatarUrl || '',
        });

        const response = {
          success: true,
          sessionId: session.id,
          autoAdmitted: knockResult?.autoAdmitted || false,
          message: knockResult?.autoAdmitted ? 'Auto-admitted (invited user)' : 'Join request sent',
        };
        if (knockResult?.autoAdmitted && knockResult?.guest) {
          response.guest = knockResult.guest;
          response.hostId = session.hostId;
          response.hostName = session.hostName;
          response.slug = session.slug;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ========================================================================
  // SESSION INVITE API — Request to join another user's session
  // ========================================================================

  /**
   * POST /session/join-by-code
   * Join a session using a short room code. Triggers the knock flow
   * (or auto-admit if the host previously invited this user).
   */
  if (req.url.startsWith('/session/join-by-code') && req.method === 'POST') {
    // Stricter budget: room codes are a guessable secret so brute-force
    // attempts need to be throttled aggressively.
    if (!rateLimitGuard(req, res, 'join-by-code', 10)) return;
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { code, guestId, displayName, avatarUrl } = data;
        if (!code || !guestId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'code and guestId are required' }));
          return;
        }
        const session = sessionManager.getSessionByRoomCode(code);
        if (!session) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or expired room code' }));
          return;
        }
        // Block check
        const hostBlocked = blockedBy.get(session.hostId);
        const guestBlocked = blockedBy.get(guestId);
        if ((hostBlocked && hostBlocked.has(guestId)) || (guestBlocked && guestBlocked.has(session.hostId))) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cannot join this session' }));
          return;
        }
        // Knock on the session (may auto-admit if invited)
        const knockResult = sessionManager.knock(session.id, {
          guestId,
          displayName: displayName || guestId,
          avatarUrl: avatarUrl || '',
        });
        const response = {
          success: true,
          sessionId: session.id,
          hostName: session.hostName,
          slug: session.slug,
          autoAdmitted: knockResult?.autoAdmitted || false,
          message: knockResult?.autoAdmitted ? 'Auto-admitted (invited user)' : 'Join request sent',
        };
        if (knockResult?.autoAdmitted && knockResult?.guest) {
          response.guest = knockResult.guest;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url.startsWith('/session/request-join/') && req.method === 'POST') {
    if (!rateLimitGuard(req, res, 'request-join', 30)) return;
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const targetSessionId = urlObj.pathname.split('/')[3];
    if (!targetSessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'sessionId is required' }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { guestId, displayName, avatarUrl } = data;
        if (!guestId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'guestId is required' }));
          return;
        }
        // Reuse knock mechanism — "request to join" is semantically the same
        const knockResult = sessionManager.knock(targetSessionId, { guestId, displayName: displayName || guestId, avatarUrl: avatarUrl || '' });
        const response = {
          success: true,
          autoAdmitted: knockResult?.autoAdmitted || false,
          message: knockResult?.autoAdmitted ? 'Auto-admitted (invited user)' : 'Join request sent',
        };
        if (knockResult?.autoAdmitted && knockResult?.guest) {
          response.guest = knockResult.guest;
          const sess = sessionManager.getSession(targetSessionId);
          response.hostId = sess?.hostId || null;
          response.hostName = sess?.hostName || null;
          response.slug = sess?.slug || null;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ========================================================================
  // SESSION API — Host/Guest "Remote Control" collaboration
  // ========================================================================
  if (req.url.startsWith('/session/') && (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE')) {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const parts = urlObj.pathname.split('/');
    // /session/:action[/:sessionId]
    const action = parts[2];
    const sessionIdParam = parts[3] || null;

    // Per-action rate budgets.  GETs (info, validate-token) get a generous
    // ceiling; write-heavy ops get tighter ones.
    const RATE_BUDGETS = {
      create: 20,
      'validate-token': 60,
      host: 120,
      'workspace-access': 120,
      knock: 30,
      admit: 60,
      deny: 60,
      permissions: 60,
      kick: 30,
      leave: 60,
      terminate: 20,
      info: 120,
      'regenerate-token': 10,
    };
    const budget = RATE_BUDGETS[action];
    if (budget && !rateLimitGuard(req, res, `session:${action}`, budget)) return;

    // sessionId parameter must look like the format emitted by SessionManager
    // (hex, 2*SESSION_ID_LEN chars).  Reject malformed IDs before they reach
    // any manager call — defence-in-depth against injection via URL paths.
    const sessionIdActions = new Set([
      'admit',
      'deny',
      'permissions',
      'kick',
      'leave',
      'terminate',
      'info',
      'regenerate-token',
    ]);
    if (sessionIdActions.has(action) && sessionIdParam && !/^[a-f0-9]{8,64}$/i.test(sessionIdParam)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_session_id_format' }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = body ? JSON.parse(body) : {};
        let result;

        switch (action) {
          case 'create': {
            // POST /session/create — Host creates a new collab session
            const { hostId, hostName, hostAvatar, slug, defaultPerms } = data;
            if (!hostId || !slug) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'hostId and slug are required' }));
              return;
            }
            // Direct-access model: ensure the host's per-user repo exists
            // (guests will share this repo via effectiveUserId mapping).
            // No separate worktree needed — all participants use repos/<slug>/<hostId>/.
            let hostRepoPath = null;
            try {
              const hostRepo = await gitService.ensureUserRepo(slug, hostId);
              hostRepoPath = hostRepo.path;
            } catch (e) {
              console.warn(`[Collab] Could not ensure host repo for session: ${e.message}`);
            }
            const existing = sessionManager.getHostSessionForReconnect(hostId, slug);
            const session = sessionManager.createSession({
              hostId, hostName: hostName || hostId, hostAvatar: hostAvatar || '',
              slug, worktreePath: hostRepoPath || '', defaultPerms,
            });
            result = {
              reused: Boolean(existing && existing.id === session.id),
              sessionId: session.id,
              inviteToken: session.inviteToken,
              worktreePath: session.worktreePath,
              roomCode: session.roomCode || null,
              createdAt: session.createdAt,
              inviteLink: makeInviteLink({
                sessionId: session.id,
                inviteToken: session.inviteToken,
                roomCode: session.roomCode,
                slug,
              }),
            };
            break;
          }

          case 'host': {
            // GET /session/host/:hostId?slug=<workspace>
            const hostId = sessionIdParam ? decodeURIComponent(sessionIdParam) : '';
            const slug = urlObj.searchParams.get('slug') || '';
            if (!hostId) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'hostId is required' }));
              return;
            }
            const session = sessionManager.getHostSessionForReconnect(hostId, slug || null);
            if (!session) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Session not found' }));
              return;
            }
            result = {
              ...session,
              sessionId: session.id,
              inviteLink: makeInviteLink({
                sessionId: session.id,
                inviteToken: session.inviteToken,
                roomCode: session.roomCode,
                slug: session.slug,
              }),
            };
            break;
          }

          case 'workspace-access': {
            // GET /session/workspace-access/:userId?slug=<workspace>
            //
            // Internal-only lookup used by the frontend server to check whether
            // an authenticated caller (identified by their workspaceUserId — see
            // synthi/src/lib/integrations/session.js) is currently the host or an
            // admitted guest of an active collab session for a workspace slug.
            // This is how collab guests get real file access without a Prisma
            // WorkspaceMembership row (see synthi/src/lib/workspaceAccess.js).
            //
            // Must never be reachable without the shared internal token — it
            // would otherwise let anyone probe session membership for an
            // arbitrary userId.
            if (!hasTrustedInternalToken(req, { config })) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'internal_token_required' }));
              return;
            }
            const targetUserId = sessionIdParam ? decodeURIComponent(sessionIdParam) : '';
            const workspaceSlug = urlObj.searchParams.get('slug') || '';
            if (!targetUserId || !workspaceSlug) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'userId and slug are required' }));
              return;
            }
            let access = null;
            for (const session of sessionManager.getSessionsForSlug(workspaceSlug)) {
              if (session.hostId === targetUserId) {
                access = { role: 'host', permissions: { canEdit: true, canFileOps: true, canTerminal: true, canGit: true } };
                break;
              }
              const guest = (session.guests || []).find((g) => g.guestId === targetUserId);
              if (guest) {
                access = { role: 'guest', permissions: { ...guest.permissions } };
                break;
              }
            }
            if (!access) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'No active session for this user in this workspace' }));
              return;
            }
            result = access;
            break;
          }

          case 'validate-token': {
            // GET /session/validate-token?token=xyz
            const token = urlObj.searchParams.get('token') || data.token;
            result = sessionManager.validateToken(token);
            if (!result) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid or expired invite token' }));
              return;
            }
            break;
          }

          case 'knock': {
            // POST /session/knock/:sessionId
            if (!sessionIdParam) { res.writeHead(400); res.end('Missing sessionId'); return; }
            sessionManager.knock(sessionIdParam, data);
            result = { success: true };
            break;
          }

          case 'admit': {
            // POST /session/admit/:sessionId — Host admits a guest
            if (!sessionIdParam) { res.writeHead(400); res.end('Missing sessionId'); return; }
            // Verify the requester is the session host
            const admitCheckSession = sessionManager.getSession(sessionIdParam);
            if (!admitCheckSession) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Session not found' }));
              return;
            }
            if (data.requesterId && data.requesterId !== admitCheckSession.hostId) {
              console.warn(`[Session] Non-host user ${data.requesterId} attempted to admit guest in session ${sessionIdParam}`);
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Only the session host can admit guests' }));
              return;
            }
            const guest = sessionManager.admitGuest(sessionIdParam, data);
            result = { success: true, guest };
            // NOTE: Do NOT broadcastSessionEvent here — admitGuest() emits
            // 'session:guestJoined' which triggers the listener that broadcasts.
            // Calling it here too caused doubled "X joined" toasts.
            break;
          }

          case 'deny': {
            // POST /session/deny/:sessionId
            if (!sessionIdParam) { res.writeHead(400); res.end('Missing sessionId'); return; }
            // Verify the requester is the session host
            const denyCheckSession = sessionManager.getSession(sessionIdParam);
            if (!denyCheckSession) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Session not found' }));
              return;
            }
            if (data.requesterId && data.requesterId !== denyCheckSession.hostId) {
              console.warn(`[Session] Non-host user ${data.requesterId} attempted to deny guest in session ${sessionIdParam}`);
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Only the session host can deny guests' }));
              return;
            }
            sessionManager.denyKnock(sessionIdParam, data.guestId);
            result = { success: true };
            break;
          }

          case 'permissions': {
            // POST /session/permissions/:sessionId — Update guest perms
            if (!sessionIdParam) { res.writeHead(400); res.end('Missing sessionId'); return; }
            const perms = sessionManager.updatePermissions(sessionIdParam, data.guestId, data.permissions);
            result = { success: true, permissions: perms };
            // NOTE: Do NOT broadcastSessionEvent here — updatePermissions() emits
            // 'session:permissionsUpdated' which triggers the listener that broadcasts.
            // Calling it here too caused doubled "permissions updated" toasts.
            break;
          }

          case 'kick': {
            // POST /session/kick/:sessionId
            if (!sessionIdParam) { res.writeHead(400); res.end('Missing sessionId'); return; }
            // Verify the requester is the session host
            const kickCheckSession = sessionManager.getSession(sessionIdParam);
            if (!kickCheckSession) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Session not found' }));
              return;
            }
            if (data.requesterId && data.requesterId !== kickCheckSession.hostId) {
              console.warn(`[Session] Non-host user ${data.requesterId} attempted to kick guest in session ${sessionIdParam}`);
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Only the session host can kick guests' }));
              return;
            }
            sessionManager.removeGuest(sessionIdParam, data.guestId, 'kicked');
            result = { success: true };
            broadcastSessionEvent(sessionIdParam, 'guest:kicked', { guestId: data.guestId });
            break;
          }

          case 'leave': {
            // POST /session/leave/:sessionId  — guest voluntarily leaves
            if (!sessionIdParam) { res.writeHead(400); res.end('Missing sessionId'); return; }
            const guestId = data.guestId || data.userId;
            if (guestId) {
              sessionManager.removeGuest(sessionIdParam, guestId, 'left');
              broadcastSessionEvent(sessionIdParam, 'guest:left', { guestId });
            }
            result = { success: true };
            break;
          }

          case 'terminate': {
            // DELETE /session/terminate/:sessionId
            if (!sessionIdParam) { res.writeHead(400); res.end('Missing sessionId'); return; }
            // NOTE: Do NOT broadcastSessionEvent here — terminateSession() emits
            // 'session:terminated' which triggers the listener that broadcasts.
            // Calling it here too caused doubled "session ended" toasts.
            sessionManager.terminateSession(sessionIdParam);
            result = { success: true };
            break;
          }

          case 'info': {
            // GET /session/info/:sessionId
            if (!sessionIdParam) { res.writeHead(400); res.end('Missing sessionId'); return; }
            result = sessionManager.getSession(sessionIdParam);
            if (!result) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Session not found' }));
              return;
            }
            break;
          }

          case 'regenerate-token': {
            // POST /session/regenerate-token/:sessionId
            if (!sessionIdParam) { res.writeHead(400); res.end('Missing sessionId'); return; }
            const regenResult = sessionManager.regenerateToken(sessionIdParam);
            result = {
              inviteToken: regenResult.inviteToken,
              roomCode: regenResult.roomCode,
              inviteLink: makeInviteLink({
                sessionId: sessionIdParam,
                inviteToken: regenResult.inviteToken,
                roomCode: regenResult.roomCode,
                slug: sessionManager.getSession(sessionIdParam)?.slug,
              }),
            };
            break;
          }

          default:
            res.writeHead(404);
            res.end('Unknown session action');
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        console.error('[Session API] Error:', e.message);
        res.writeHead(e.message.includes('not found') ? 404 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url.startsWith('/git/')) {
    // Parse URL: /git/:slug/:action
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const parts = urlObj.pathname.split('/');
    // parts[0] = '', parts[1] = 'git', parts[2] = slug, parts[3] = action
    const slug = parts[2];
    const action = parts[3];

    if (!slug || !action) {
        res.writeHead(400);
        res.end('Invalid request');
        return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
        try {
            const data = body ? JSON.parse(body) : {};
            // Merge query params into data
            for (const [key, value] of urlObj.searchParams) {
                data[key] = value;
            }

        // Ensure the workspace repo exists for this slug.
        // This avoids REPO_NOT_FOUND for fresh workspaces and allows the server to
        // hydrate from GCS automatically (when configured) without requiring a manual
        // "Initialize Git" click.

            // ── Session permission enforcement ──────────────────────────
            // Extract session context from headers/query and check permissions
            const sessionId = req.headers['x-session-id'] || urlObj.searchParams.get('sessionId');
            const userId    = req.headers['x-user-id']    || urlObj.searchParams.get('userId');

            // ── Direct-access collaboration ─────────────────────────────
            // When a guest is in a session, all their git operations target
            // the HOST's repo.  Resolve the "effective" userId that will be
            // used for repo path resolution and git operations.
            const effectiveUserId = sessionId && userId
              ? sessionManager.getEffectiveUserId(userId, sessionId)
              : userId;
            const allowUnauthenticatedDevGit = config.SYNTHI_WORKSPACE_AUTH_BYPASS && !sessionId && !userId;

            if (effectiveUserId && effectiveUserId !== userId) {
              console.log(`[Collab] Direct-access: guest=${userId} → host=${effectiveUserId} session=${sessionId} action=${action}`);
            }

            const notifyScope = { userId: effectiveUserId || null, sessionId: sessionId || null };
            const bootstrapUserId = effectiveUserId || userId || null;
            const codeSiteContext = codeSiteContextFromRequest(req, data, {
              workspaceSlug: slug,
              actorUserId: userId || null,
              effectiveUserId: effectiveUserId || null,
            });
            const codeSiteEnforcement = codeSiteEnforceOptions(codeSiteContext);
            const codeSiteNotifyScope = {
              ...notifyScope,
              codesiteContext: codeSiteContext,
              ...codeSiteWriteEvidence(data),
            };

            // ── Per-requester token isolation ──────────────────────────
            // Repo path / working tree → effectiveUserId (guest writes
            //   into the host's worktree).
            // Auth tokens → the *real* requesting user, so a guest's PAT
            //   gets stored under their own bucket and doesn't clobber
            //   the host's. If the requester has no token of their own,
            //   we fall back to the host's bucket (keeps today's "guest
            //   borrows host's PAT" behavior working seamlessly).
            const tokenUserId = userId || null;
            const tokenFallbackUserIds = (effectiveUserId && effectiveUserId !== userId)
                ? [effectiveUserId]
                : [];

            // ── Per-requester commit attribution ───────────────────────
            // Headers populated by the frontend from NextAuth. When set,
            // the gitService pins GIT_AUTHOR_*/GIT_COMMITTER_* to these
            // values for the duration of the spawned git process, so a
            // guest's commits land in the host's worktree but show up
            // under the guest's GitHub identity.
            const decodeHeader = (raw) => {
                if (!raw || typeof raw !== 'string') return '';
                // The frontend prefixes non-ASCII values with "b64:" before
                // base64-encoding them. Plain ASCII names are passed through
                // unchanged. This avoids mis-decoding ASCII names that happen
                // to be valid base64 (e.g. "AMKolev22" → garbage bytes).
                if (raw.startsWith('b64:')) {
                    try {
                        return Buffer.from(raw.slice(4), 'base64').toString('utf8').trim();
                    } catch (_) {}
                }
                return raw.trim();
            };
            const reqName  = decodeHeader(req.headers['x-user-name']);
            const reqEmail = decodeHeader(req.headers['x-user-email']);
            const commitIdentity = (reqName || reqEmail)
                ? { name: reqName || null, email: reqEmail || null }
                : null;

            // ── Permission check FIRST ──────────────────────────────────
            // Check permissions BEFORE provisioning repos to prevent
            // unauthorized users from creating per-user repos and corrupting
            // the workspace directory structure.  Even though the frontend
            // redirects unauthorized users away, API calls may fire before
            // the redirect completes, and malicious actors could hit the
            // endpoint directly.
            if (sessionId && userId) {
              const permKey = require('./permissionMiddleware').GIT_ACTION_PERMISSIONS[action];
              if (permKey && !sessionManager.checkPermission(sessionId, userId, permKey)) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  error: 'permission_denied',
                  message: `Action "${action}" requires "${permKey}" permission. Ask the Host for access.`,
                  required: permKey,
                }));
                return;
              }
            } else if (action !== 'init' && action !== 'clone' && !allowUnauthenticatedDevGit) {
              // Require userId for ALL actions (except bootstrapping).
              // Without a userId the server falls back to the slug-level
              // directory which may not be a valid git repo (migrated
              // repos only have _upstream.git and per-user directories).
              if (!effectiveUserId) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  error: 'authentication_required',
                  message: 'A valid userId is required for this action.',
                }));
                return;
              }
            }

        // Use hydratedSlugs so we re-hydrate once per boot even when the dir already
        // exists with partial/stale content (e.g. .code_intel artifacts).
        // Now safe to run AFTER permission check.
        const hKey = hydrationKey(slug, effectiveUserId);
        if (action !== 'clone' && action !== 'init' && !hydratedSlugs.has(hKey)) {
          try {
            // initRepo will mkdir the repo path, init .git, and (when configured)
            // pull the current workspace contents from GCS.
            // Pass effectiveUserId so it also provisions the per-user working tree.
            if (!effectiveUserId || needsCodeSiteUserRepoProvisioning(slug, effectiveUserId)) {
              await enforceCodeSiteProvisioningAllowed(codeSiteContext, 'git:auto-init', codeSiteEnforcement);
            }
            await gitService.initRepo(
              slug,
              null,
              effectiveUserId,
              null,
              codeSiteProvisioningOptions(codeSiteContext, {
                evidenceRefs: ['collab:git:auto-init'],
                processAncestry: ['collab-server:git:auto-init'],
              }),
            );
            hydratedSlugs.add(hKey);
          } catch (e) {
            if (e?.code === 'CODESITE_WRITE_DENIED') {
              writeCodeSiteDenied(res, e);
              return;
            }
            // If init fails, continue so the normal handler can return a structured error.
            if (gcsSync && typeof gcsSync.isGcsConfigured === 'function' && gcsSync.isGcsConfigured()) {
              console.warn('[Collab] auto-init repo failed for slug:', slug, e?.message || e);
            }
          }
        }

            // ── Per-user repo provisioning (mandatory) ──────────────────
            // Ensure the per-user working tree exists for EVERY action (incl.
            // init/clone which now also call ensureUserRepo internally).
            // Guests use the host's repo (effectiveUserId = hostId), so they
            // skip provisioning a separate repo.
            if (effectiveUserId) {
              try {
                if (needsCodeSiteUserRepoProvisioning(slug, effectiveUserId)) {
                  await enforceCodeSiteProvisioningAllowed(codeSiteContext, 'git:ensure-user-repo', codeSiteEnforcement);
                }
                await gitService.ensureUserRepo(
                  slug,
                  effectiveUserId,
                  codeSiteProvisioningOptions(codeSiteContext, {
                    evidenceRefs: ['collab:git:ensure-user-repo'],
                    processAncestry: ['collab-server:git:ensure-user-repo'],
                  }),
                );
                // Pin the per-user repo in the cache so it won't be evicted
                // while this user is actively interacting with the workspace.
                // Unpinning happens when the notification WS disconnects.
                repoCache.pin(slug, effectiveUserId);
              } catch (e) {
                if (e?.code === 'CODESITE_WRITE_DENIED') {
                  writeCodeSiteDenied(res, e);
                  return;
                }
                // For non-clone/init actions this is a real error — the user
                // cannot operate without an isolated repo.
                if (action !== 'clone' && action !== 'init') {
                  console.error(`[Collab] ensureUserRepo FAILED for ${slug}/${effectiveUserId}:`, e.message);
                  res.writeHead(500, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({
                    error: 'user_repo_error',
                    message: `Failed to provision per-user repo for ${effectiveUserId}: ${e.message}`,
                  }));
                  return;
                }
              }
            }

            let result;
            let instructionProjection = null;
            if (shouldReconcileInstructionProjection(action)) {
              try {
                instructionProjection = await workspaceInstructionProjectionRuntime.reconcile({
                  workspaceId: slug,
                  repositoryRoot: gitService.getEffectiveRepoPath(slug, effectiveUserId),
                  activeWorkspacePath: data.activeWorkspacePath || '',
                });
              } catch (projectionError) {
                logger.warn('workspace_instruction_projection_reconcile_failed', {
                  slug, action, message: projectionError?.message || String(projectionError),
                });
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  error: 'workspace_instruction_projection_unavailable',
                  message: 'Workspace instruction projection is temporarily unavailable. Please retry.',
                }));
                return;
              }
            }

            // Validate file paths before processing any action that accepts one.
            // This prevents path-traversal attacks (e.g. "../../etc/passwd").
            const FILE_PATH_ACTIONS = [
              'discard', 'discard-lines', 'stage', 'stage-lines', 'unstage', 'sync',
              'file-content', 'resolve-ours', 'resolve-theirs',
              'mark-resolved', 'conflict-versions', 'read-file', 'write-file',
            ];
            if (FILE_PATH_ACTIONS.includes(action) && data.filePath) {
              try {
                data.filePath = validateFilePath(data.filePath);
              } catch (pathErr) {
                console.warn(`[Collab] Path validation failed for action=${action}:`, pathErr.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'invalid_path', message: pathErr.message }));
                return;
              }
            }

            const codeSiteGitAttempts = codeSiteGitActionAttempts(action, data);
            const codeSiteGitRepoRoot = gitService.getEffectiveRepoPath(slug, effectiveUserId);
            const runGitBoundary = (applyFn) => runCodeSiteGitMutationBoundary(
              codeSiteContext,
              action,
              codeSiteGitAttempts,
              applyFn,
              {
                ...codeSiteEnforcement,
                repoRoot: codeSiteGitRepoRoot,
              },
            );
            if (codeSiteGitAttempts.length && !shouldRunCodeSiteGitBoundary(action)) {
              await enforceCodeSiteWritesAllowed(codeSiteContext, codeSiteGitAttempts, codeSiteEnforcement);
            }

            switch (action) {
                case 'init':
	                {
	                  const boundary = await runGitBoundary(
	                    async () => gitService.initRepo(
	                      slug,
	                      data.remoteUrl,
	                      bootstrapUserId,
	                      tokenUserId,
	                      codeSiteProvisioningOptions(codeSiteContext, {
	                        evidenceRefs: ['collab:git:init'],
	                        processAncestry: ['collab-server:git:init'],
	                      }),
	                    ),
	                  );
	                  result = boundary.applyResult;
	                }
                hydratedSlugs.add(hydrationKey(slug, bootstrapUserId));
                if (data.owner || data.name || data.showInRecent === true || data.addToRecent === true) {
                  workspaceManager.addWorkspace(slug, data.remoteUrl, data.owner, data.name, {
                    showInRecent: data.showInRecent !== false && data.addToRecent !== false,
                    source: data.source || 'create',
                  });
                }
                    break;
                case 'add-remote':
                    {
                      const boundary = await runGitBoundary(
                        async () => gitService.addRemote(
                          slug,
                          data.name,
                          data.url,
                          effectiveUserId,
                          data.token,
                          tokenUserId,
                          codeSiteGitServiceOptions(codeSiteContext, 'add-remote'),
                        ),
                      );
                      result = boundary.applyResult;
                    }
                    break;
                case 'remove-remote':
                    {
                      const boundary = await runGitBoundary(
                        async () => gitService.removeRemote(
                          slug,
                          data.name,
                          effectiveUserId,
                          codeSiteGitServiceOptions(codeSiteContext, 'remove-remote'),
                        ),
                      );
                      result = boundary.applyResult;
                    }
                    break;
                case 'set-remote-url':
                    {
                      const boundary = await runGitBoundary(
                        async () => gitService.setRemoteUrl(
                          slug,
                          data.name,
                          data.url,
                          effectiveUserId,
                          data.token,
                          tokenUserId,
                          codeSiteGitServiceOptions(codeSiteContext, 'set-remote-url'),
                        ),
                      );
                      result = boundary.applyResult;
                    }
                    break;
                case 'remotes':
                    result = await gitService.getRemotes(slug, effectiveUserId);
                    break;
                case 'clone':
	                  {
	                    const boundary = await runGitBoundary(
	                      async () => gitService.cloneRepo(
	                        slug,
	                        data.repoUrl,
	                        data.token,
	                        bootstrapUserId,
	                        tokenUserId,
	                        codeSiteProvisioningOptions(codeSiteContext, {
	                          evidenceRefs: ['collab:git:clone'],
	                          processAncestry: ['collab-server:git:clone'],
	                        }),
	                      ),
	                    );
	                    result = boundary.applyResult;
	                  }
                  hydratedSlugs.add(hydrationKey(slug, bootstrapUserId));
                  // Save metadata locally for the dashboard recent list. Callers can
                  // still opt out explicitly for short-lived internal workspaces.
                  const showInRecent =
                    data.showInRecent !== false &&
                    data.addToRecent !== false;
                  workspaceManager.addWorkspace(slug, data.repoUrl, data.owner, data.name, {
                    showInRecent,
                    source: data.source || 'import',
                  });
                  let workspaceRegistration = {
                    attempted: false,
                    created: false,
                    pending: false,
                  };

                  // Try to create the workspace in the main Synthi app DB so the web UI finds it.
                  // Use the internal app URL when deployed; public invite links use SYNTHI_PUBLIC_APP_URL.
                  const appInternalUrl = internalAppBaseUrl();

                  // Determine fetch function - prefer global fetch (Node 18+), otherwise require node-fetch
                  let fetchFunc = null;
                  if (typeof fetch === 'function') {
                    fetchFunc = fetch;
                  } else {
                    try {
                      fetchFunc = require('node-fetch');
                    } catch (e) {
                      fetchFunc = null;
                    }
                  }

                  if (fetchFunc) {
                    workspaceRegistration.attempted = true;
                    const payload = {
                      name: data.name || slug,
                      slug: slug,
                      repoUrl: data.repoUrl || null
                    };

                    // Retry mechanism
                    const maxAttempts = 3;
                    let attempt = 0;
                    let created = false;
                    while (attempt < maxAttempts && !created) {
                      attempt += 1;
                      try {
                        const res = await fetchFunc(`${appInternalUrl}/api/workspace`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(payload),
                        });

                        if (res.status === 201 || res.status === 409) { // created or already exists are acceptable
                          created = true;
                          console.log(`[Collab] Notified Synthi app to create workspace '${slug}' (status ${res.status})`);
                          break;
                        } else {
                          const txt = await res.text().catch(() => '');
                          console.warn(`[Collab] Synthi app returned ${res.status} creating workspace '${slug}': ${txt}`);
                        }
                      } catch (err) {
                        console.warn(`[Collab] Attempt ${attempt} failed to call Synthi app for workspace creation:`, err?.message || err);
                      }

                      if (!created && attempt < maxAttempts) {
                        // simple exponential backoff
                        await new Promise(r => setTimeout(r, 1000 * attempt));
                      }
                    }

                    if (!created) {
                      const errMsg = `Failed to notify Synthi app to create workspace '${slug}' after ${maxAttempts} attempts.`;
                      console.warn('[Collab]', errMsg);
                      workspaceRegistration.pending = true;
                    }

                    workspaceRegistration.created = created;
                  } else {
                    console.warn('[Collab] Fetch not available - skipping workspace creation in main app. Set SYNTHI_APP_INTERNAL_URL or install node-fetch.');
                    workspaceRegistration.pending = true;
                  }

                  result = {
                    ...result,
                    workspaceRegistration,
                  };
                  broadcastFileTreeChanged(slug, notifyScope);
                  break;
                case 'status':
                    result = await withTelemetry('git:status', () => gitService.getStatus(slug, effectiveUserId));
                    break;
                case 'branches':
                    result = await withTelemetry('git:branches', () => gitService.getBranches(slug, effectiveUserId));
                    break;
                case 'checkout':
                    pauseWatcher(slug);
                    try {
                      const boundary = await runGitBoundary(
                        async () => gitService.checkout(slug, data.branch, data.create, effectiveUserId, data.mode, tokenUserId, tokenFallbackUserIds),
                      );
                      result = boundary.applyResult;
                      // Broadcast BEFORE invalidation so clients destroy stale
                      // Yjs docs before WS close triggers provider reconnect.
                      broadcastFileReverted(slug, [], notifyScope);
                      await invalidateDocsForSlug(slug, null, notifyScope);
                      broadcastFileTreeChanged(slug, notifyScope);
                    } finally {
                      resumeWatcher(slug);
                    }
                    break;
                case 'fetch':
                    {
                      const boundary = await runGitBoundary(
                        async () => withTelemetry('git:fetch', () => gitService.fetch(slug, effectiveUserId, data.token, tokenUserId, tokenFallbackUserIds)),
                      );
                      result = boundary.applyResult;
                    }
                    break;
                case 'commit':
                    result = await withTelemetry('git:commit', () => gitService.commit(
                        slug,
                        data.message,
                        effectiveUserId,
                        data.amend,
                        commitIdentity,
                        {
                          codesiteContext: codeSiteContext,
                          data,
                        },
                    ));
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'stage':
                    {
                      const boundary = await runGitBoundary(async () => {
                        // Acquire staging lock to suppress FS watcher events during staging
                        acquireStagingLock(slug, data.filePath);
                        try {
                          // Force-flush Yjs content to disk before staging
                          await flushYjsDocForFile(slug, data.filePath, codeSiteNotifyScope);
                          return gitService.stageFile(slug, data.filePath, effectiveUserId);
                        } finally {
                          releaseStagingLock(slug, data.filePath);
                        }
                      });
                      result = boundary.applyResult;
                    }
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'stage-all':
                    {
                      const boundary = await runGitBoundary(
                        async () => gitService.stageAll(slug, effectiveUserId),
                      );
                      result = boundary.applyResult;
                    }
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'stage-lines':
                    {
                      const boundary = await runGitBoundary(async () => {
                        // Acquire staging lock to suppress FS watcher events during staging
                        acquireStagingLock(slug, data.filePath);
                        try {
                          // Force-flush Yjs content to disk before patching so the
                          // working tree matches the editor state exactly.
                          await flushYjsDocForFile(slug, data.filePath, codeSiteNotifyScope);
                          return gitService.stageLines(slug, data.filePath, data.patch, effectiveUserId);
                        } finally {
                          releaseStagingLock(slug, data.filePath);
                        }
                      });
                      result = boundary.applyResult;
                    }
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'unstage-lines':
                    {
                      const boundary = await runGitBoundary(async () => {
                        acquireStagingLock(slug, data.filePath);
                        try {
                          await flushYjsDocForFile(slug, data.filePath, codeSiteNotifyScope);
                          return gitService.unstageLines(slug, data.filePath, data.patch, effectiveUserId);
                        } finally {
                          releaseStagingLock(slug, data.filePath);
                        }
                      });
                      result = boundary.applyResult;
                    }
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'discard-lines':
                    {
                      const boundary = await runGitBoundary(async () => {
                        acquireStagingLock(slug, data.filePath);
                        try {
                          await flushYjsDocForFile(slug, data.filePath, codeSiteNotifyScope);
                          return gitService.discardLines(slug, data.filePath, data.patch, effectiveUserId);
                        } finally {
                          releaseStagingLock(slug, data.filePath);
                        }
                      });
                      result = boundary.applyResult;
                    }
                    broadcastFileReverted(slug, data.filePath ? [data.filePath] : [], notifyScope);
                    if (data.filePath) {
                      await invalidateDocsForSlug(slug, [data.filePath], notifyScope);
                    }
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'unstage':
                    {
                      const boundary = await runGitBoundary(async () => {
                        acquireStagingLock(slug, data.filePath);
                        try {
                          return gitService.unstageFile(slug, data.filePath, effectiveUserId);
                        } finally {
                          releaseStagingLock(slug, data.filePath);
                        }
                      });
                      result = boundary.applyResult;
                    }
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'unstage-all':
                    {
                      const boundary = await runGitBoundary(
                        async () => gitService.unstageAll(slug, effectiveUserId),
                      );
                      result = boundary.applyResult;
                    }
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'push':
                    pauseWatcher(slug);
                    try {
                      const boundary = await runGitBoundary(
                        async () => withTelemetry('git:push', () => gitService.push(
                          slug,
                          effectiveUserId,
                          data.token,
                          data.force,
                          tokenUserId,
                          tokenFallbackUserIds,
                          codeSiteGitServiceOptions(codeSiteContext, 'push'),
                        )),
                      );
                      result = boundary.applyResult;
                      broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    } finally {
                      resumeWatcher(slug);
                    }
                    break;
                case 'pull':
                    pauseWatcher(slug);
                    try {
                      const boundary = await runGitBoundary(
                        async () => withTelemetry('git:pull', () => gitService.pull(slug, effectiveUserId, data.token, tokenUserId, tokenFallbackUserIds, commitIdentity)),
                      );
                      result = boundary.applyResult;
                      // Broadcast BEFORE invalidation so clients destroy stale
                      // Yjs docs before WS close triggers provider reconnect.
                      broadcastFileReverted(slug, [], notifyScope);
                      await invalidateDocsForSlug(slug, null, notifyScope);
                      broadcastFileTreeChanged(slug, notifyScope);
                      broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    } finally {
                      resumeWatcher(slug);
                    }
                    break;
                case 'discard':
                    {
                      const boundary = await runGitBoundary(
                        async () => gitService.discardChange(slug, data.filePath, effectiveUserId),
                      );
                      result = boundary.applyResult;
                    }
                    // Broadcast BEFORE invalidation so clients destroy stale
                    // Yjs docs before WS close triggers provider reconnect.
                    broadcastFileReverted(slug, data.filePath ? [data.filePath] : [], notifyScope);
                    if (data.filePath) {
                      await invalidateDocsForSlug(slug, [data.filePath], notifyScope);
                    }
                    broadcastFileTreeChanged(slug, notifyScope);
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'discard-all':
                    pauseWatcher(slug);
                    try {
                      const boundary = await runGitBoundary(
                        async () => gitService.discardAll(slug, effectiveUserId),
                      );
                      result = boundary.applyResult;
                      // Broadcast BEFORE invalidation so clients destroy stale
                      // Yjs docs before WS close triggers provider reconnect.
                      broadcastFileReverted(slug, [], notifyScope);
                      await invalidateDocsForSlug(slug, null, notifyScope);
                      broadcastFileTreeChanged(slug, notifyScope);
                      broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    } finally {
                      resumeWatcher(slug);
                    }
                    break;
                // Merge conflict resolution
                case 'resolve-ours':
                    {
                      const boundary = await runGitBoundary(
                        async () => gitService.resolveConflictOurs(slug, data.filePath, effectiveUserId),
                      );
                      result = boundary.applyResult;
                    }
                    if (data.filePath) {
                      broadcastFileReverted(slug, [data.filePath], notifyScope);
                      await invalidateDocsForSlug(slug, [data.filePath], notifyScope);
                    }
                    break;
                case 'resolve-theirs':
                    {
                      const boundary = await runGitBoundary(
                        async () => gitService.resolveConflictTheirs(slug, data.filePath, effectiveUserId),
                      );
                      result = boundary.applyResult;
                    }
                    if (data.filePath) {
                      broadcastFileReverted(slug, [data.filePath], notifyScope);
                      await invalidateDocsForSlug(slug, [data.filePath], notifyScope);
                    }
                    break;
                case 'mark-resolved':
                    {
                      const boundary = await runGitBoundary(
                        async () => gitService.markResolved(slug, data.filePath, effectiveUserId),
                      );
                      result = boundary.applyResult;
                    }
                    break;
                case 'abort-merge':
                    {
                      const boundary = await runGitBoundary(
                        async () => gitService.abortMerge(slug, effectiveUserId),
                      );
                      result = boundary.applyResult;
                    }
                    broadcastFileReverted(slug, [], notifyScope);
                    await invalidateDocsForSlug(slug, null, notifyScope);
                    broadcastFileTreeChanged(slug, notifyScope);
                    break;
                case 'merge-branch':
                    pauseWatcher(slug);
                    try {
                      const boundary = await runGitBoundary(
                        async () => gitService.mergeBranch(slug, data.branch, effectiveUserId, data.token, tokenUserId, tokenFallbackUserIds, commitIdentity),
                      );
                      result = boundary.applyResult;
                      broadcastFileReverted(slug, [], notifyScope);
                      await invalidateDocsForSlug(slug, null, notifyScope);
                      broadcastFileTreeChanged(slug, notifyScope);
                      broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    } finally {
                      resumeWatcher(slug);
                    }
                    break;
                case 'check-merge-conflicts':
                    // Fetch updates remote-tracking refs, then merge-tree checks in memory.
                    {
                      const boundary = await runGitBoundary(() => gitService.checkMergeConflicts(
                        slug, data.baseBranch, data.headBranch, effectiveUserId, data.token, tokenUserId, tokenFallbackUserIds
                      ));
                      result = boundary.applyResult;
                    }
                    break;
                case 'conflict-versions':
                    result = await gitService.getConflictVersions(slug, data.filePath, effectiveUserId);
                    break;
                case 'diff':
                    result = await withTelemetry('git:diff', () => gitService.getDiff(slug, data.filePath, { parsed: data.parsed, userId: effectiveUserId }));
                    break;
                case 'file-content':
                    const fileContent = await withTelemetry('git:file-content', () => gitService.getFileContent(slug, data.filePath, data.ref, effectiveUserId));
                    result = { content: fileContent };
                    break;
                case 'log':
                    result = await withTelemetry('git:log', () => gitService.getLog(slug, { page: data.page, limit: data.limit, userId: effectiveUserId }));
                    break;
                case 'unpushed':
                    const max = data && data.max ? parseInt(data.max, 10) : 50;
                    result = await gitService.getUnpushedCommits(slug, max, effectiveUserId);
                    break;
                case 'incoming':
                    const incomingMax = data && data.max ? parseInt(data.max, 10) : 50;
                    result = await gitService.getIncomingCommits(slug, incomingMax, effectiveUserId);
                    break;
                case 'blame':
                    result = await gitService.getBlame(slug, data.filePath, effectiveUserId);
                    break;
                // Stash operations
                case 'stash-list':
                    result = await gitService.stashList(slug, effectiveUserId);
                    break;
                case 'stash-push':
                    {
                      const boundary = await runGitBoundary(
                        async () => gitService.stashPush(slug, data.message, effectiveUserId, commitIdentity),
                      );
                      result = boundary.applyResult;
                    }
                    break;
                case 'stash-pop':
                    pauseWatcher(slug);
                    try {
                      const boundary = await runGitBoundary(
                        async () => gitService.stashPop(slug, data.index, effectiveUserId, commitIdentity),
                      );
                      result = boundary.applyResult;
                      broadcastFileReverted(slug, [], notifyScope);
                      await invalidateDocsForSlug(slug, null, notifyScope);
                      broadcastFileTreeChanged(slug, notifyScope);
                    } finally {
                      resumeWatcher(slug);
                    }
                    break;
                case 'stash-apply':
                    pauseWatcher(slug);
                    try {
                      const boundary = await runGitBoundary(
                        async () => gitService.stashApply(slug, data.index, effectiveUserId),
                      );
                      result = boundary.applyResult;
                      broadcastFileReverted(slug, [], notifyScope);
                      await invalidateDocsForSlug(slug, null, notifyScope);
                      broadcastFileTreeChanged(slug, notifyScope);
                    } finally {
                      resumeWatcher(slug);
                    }
                    break;
                case 'stash-drop':
                    {
                      const boundary = await runGitBoundary(
                        async () => gitService.stashDrop(
                          slug,
                          data.index,
                          effectiveUserId,
                          codeSiteGitServiceOptions(codeSiteContext, 'stash-drop'),
                        ),
                      );
                      result = boundary.applyResult;
                    }
                    break;
                case 'interactive-rebase':
                    pauseWatcher(slug);
                    try {
                      const boundary = await runGitBoundary(
                        async () => gitService.interactiveRebase(slug, data.baseCommit, data.operations, effectiveUserId, commitIdentity),
                      );
                      result = boundary.applyResult;
                      broadcastFileReverted(slug, [], notifyScope);
                      await invalidateDocsForSlug(slug, null, notifyScope);
                      broadcastFileTreeChanged(slug, notifyScope);
                      broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    } finally {
                      resumeWatcher(slug);
                    }
                    break;
                case 'rebase-abort':
                    pauseWatcher(slug);
                    try {
                      const boundary = await runGitBoundary(
                        async () => gitService.rebaseAbort(slug, effectiveUserId),
                      );
                      result = boundary.applyResult;
                      broadcastFileReverted(slug, [], notifyScope);
                      await invalidateDocsForSlug(slug, null, notifyScope);
                      broadcastFileTreeChanged(slug, notifyScope);
                      broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    } finally {
                      resumeWatcher(slug);
                    }
                    break;
                case 'rebase-continue':
                    pauseWatcher(slug);
                    try {
                      const boundary = await runGitBoundary(
                        async () => gitService.rebaseContinue(slug, effectiveUserId, commitIdentity),
                      );
                      result = boundary.applyResult;
                      broadcastFileReverted(slug, [], notifyScope);
                      await invalidateDocsForSlug(slug, null, notifyScope);
                      broadcastFileTreeChanged(slug, notifyScope);
                      broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    } finally {
                      resumeWatcher(slug);
                    }
                    break;
                case 'cherry-pick':
                    {
                      const boundary = await runGitBoundary(
                        async () => gitService.cherryPick(slug, data.hash, effectiveUserId, commitIdentity),
                      );
                      result = boundary.applyResult;
                    }
                    broadcastFileReverted(slug, [], notifyScope);
                    await invalidateDocsForSlug(slug, null, notifyScope);
                    broadcastFileTreeChanged(slug, notifyScope);
                    break;
                case 'tags':
                    result = await gitService.getTags(slug, effectiveUserId);
                    break;
                case 'create-tag':
                    {
                      const boundary = await runGitBoundary(
                        async () => gitService.createTag(
                          slug,
                          data.name,
                          data.ref || 'HEAD',
                          data.message,
                          effectiveUserId,
                          codeSiteGitServiceOptions(codeSiteContext, 'create-tag'),
                        ),
                      );
                      result = boundary.applyResult;
                    }
                    break;
                case 'delete-tag':
                    {
                      const boundary = await runGitBoundary(
                        async () => gitService.deleteTag(
                          slug,
                          data.name,
                          effectiveUserId,
                          codeSiteGitServiceOptions(codeSiteContext, 'delete-tag'),
                        ),
                      );
                      result = boundary.applyResult;
                    }
                    break;
                case 'push-tag':
                    {
                      const boundary = await runGitBoundary(
                        async () => gitService.pushTag(
                          slug,
                          data.name,
                          effectiveUserId,
                          data.token,
                          tokenUserId,
                          tokenFallbackUserIds,
                          codeSiteGitServiceOptions(codeSiteContext, 'push-tag'),
                        ),
                      );
                      result = boundary.applyResult;
                    }
                    break;
                case 'revert':
                    {
                      const boundary = await runGitBoundary(
                        async () => gitService.revertCommit(slug, data.hash, effectiveUserId, commitIdentity),
                      );
                      result = boundary.applyResult;
                    }
                    broadcastFileReverted(slug, [], notifyScope);
                    await invalidateDocsForSlug(slug, null, notifyScope);
                    broadcastFileTreeChanged(slug, notifyScope);
                    break;
                case 'commit-detail':
                    result = await gitService.getCommitDetail(slug, data.hash, effectiveUserId);
                    break;
                case 'sync':
                    // Sync a single file — explicit save action from the client.
                    // Guard: reject stale save requests that were in-flight during
                    // a revert/pull/checkout. The revert cooldown prevents overwriting
                    // freshly reverted disk content with pre-revert editor content.
                    {
                      const cooldownKey = `${slug}:${data.filePath}`;
                      const cooldownTs = revertCooldowns.get(cooldownKey);
                      if (cooldownTs && (Date.now() - cooldownTs) < REVERT_COOLDOWN_MS) {
                        console.log(`[Collab Sync] Rejected stale save for ${data.filePath} — revert cooldown active (${Date.now() - cooldownTs}ms since invalidation)`);
                        result = { success: false, reason: 'revert-cooldown' };
                        break;
                      }
                      // Clean up expired cooldown
                      if (cooldownTs) revertCooldowns.delete(cooldownKey);

                      // Flush CRDT content to disk + GCS in a single pass.  An
                      // earlier version called gitService.syncFile() first,
                      // which wrote the new content to disk before
                      // flushDocToDisk's baseline-snapshot read — that read
                      // then saw the just-written content as the "prior" and
                      // skipped seeding the pre-edit baseline on the first
                      // save.  flushDocToDisk already performs the disk write,
                      // so calling syncFile() here was redundant AND prevented
                      // the very first version from being restorable.
                      const docKey = buildDocName(slug, data.filePath, notifyScope);
                      await flushDocToDisk(docKey, {
                        contentOverride: data.content,
                        physicalContentOverride: prepareFileContentForIdeWrite({
                          path: data.filePath,
                          userContent: data.content,
                          projectionResult: instructionProjection,
                        }),
                        codesiteContext: codeSiteContext,
                        ...codeSiteWriteEvidence(data),
                      });
                    }
                    result = { success: true };
                    break;
                case 'files':
                    result = presentFileTreeForIde(
                      await gitService.listFiles(slug, effectiveUserId),
                      instructionProjection,
                    );
                    break;
                case 'files-meta':
                  // Metadata only (no content)
                  result = {
                    files: presentFileTreeForIde(
                      await gitService.listFilesMeta(slug, effectiveUserId),
                      instructionProjection,
                    ),
                  };
                  // Kick off index build in background (non-blocking)
                  try {
                    fileIndex.ensureIndex(slug, gitService.getEffectiveRepoPath(slug, effectiveUserId)).catch(() => {});
                  } catch (_) {}
                  try {
                    const canAutoPrepare = !sessionId || !userId || sessionManager.checkPermission(sessionId, userId, 'canFileOps');
                    if (canAutoPrepare && !codeSiteContext.active) {
                      workspacePrepManager.ensureWorkspacePrepared(slug, effectiveUserId, {
                        trigger: 'workspace_files_meta',
                        codesiteContext: codeSiteContext,
                      }).catch((error) => {
                        logger.warn('workspace_prep_background_trigger_failed', {
                          slug,
                          userId: effectiveUserId || null,
                          message: error.message,
                        });
                      });
                    }
                  } catch (_) {}
                  break;
                case 'index-ensure':
                  // Non-blocking ensure; returns immediately with current status
                  try {
                    fileIndex.ensureIndex(slug, gitService.getEffectiveRepoPath(slug, effectiveUserId)).catch(() => {});
                  } catch (_) {}
                  result = fileIndex.getStatus(slug);
                  break;
                case 'index-status':
                  result = fileIndex.getStatus(slug);
                  break;
                case 'search':
                  // Index-first search; never reads disk on request
                  result = await withTelemetry.async('fs:search', async () => {
                    // fileIndex.search is still synchronous, but we can offload it to a worker or setImmediate 
                    // to prevent blocking this specific event loop turn for too long if needed.
                    // For now, wrapping in withTelemetry.async to prepare for future worker offloading.
                    return fileIndex.search(slug, data.q || data.query || '');
                  });
                  break;
                case 'open-lookup':
                  result = fileIndex.fileLookup(slug, data.q || data.query || '');
                  break;
                case 'imports':
                  result = fileIndex.getImports(slug, data.filePath || data.path || '');
                  break;
                case 'file':
                    // Normalize path - convert backslashes and strip leading slashes
                    const filePath_file = (data.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
                    const content = await withTelemetry('fs:read', () => gitService.readFile(slug, filePath_file, effectiveUserId, {
                      codesiteContext: codeSiteContext,
                      ...codeSiteEnforcement,
                      operation: 'workspace-action:file',
                      tool: 'file_read',
                      evidenceRefs: ['collab:workspace-action:file'],
                      processAncestry: ['collab-server:workspace-action'],
                    }));
                    result = {
                      content: presentFileContentForIde({
                        path: filePath_file,
                        physicalContent: content,
                        projectionResult: instructionProjection,
                      }),
                    };
                    break;
                case 'file-hash':
                    // Get content hash for a file (for VFS validation)
                    try {
                        const hashFilePath = (data.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
                        const hashContent = await gitService.readFile(slug, hashFilePath, effectiveUserId, {
                          codesiteContext: codeSiteContext,
                          ...codeSiteEnforcement,
                          operation: 'workspace-action:file-hash',
                          tool: 'file_read',
                          evidenceRefs: ['collab:workspace-action:file-hash'],
                          processAncestry: ['collab-server:workspace-action'],
                        });
                        const hashValue = computeHash(hashContent);
                        result = { hash: hashValue, path: data.path };
                    } catch (e) {
                        result = { hash: null, path: data.path, error: e.message };
                    }
                    break;
                case 'write-file':
                  {
                    const physicalContent = prepareFileContentForIdeWrite({
                      path: data.path,
                      userContent: data.content,
                      projectionResult: instructionProjection,
                    });
                    const derivedLineProvenance = await deriveCodeSiteLineProvenance(slug, data.path, data.content, effectiveUserId, {
                      evidenceRefs: data.evidenceRefs || data.evidence_refs,
                      processAncestry: data.processAncestry || data.process_ancestry,
                      promptSummary: 'Direct file write',
                      reasonRef: `write-file:${data.path}`,
                    });
                    await runCodeSiteMutationBoundary(codeSiteContext, {
                      operation: 'write-file',
                      tool: 'file_write',
                      attempts: [{
                        path: data.path,
                        kind: 'write-file',
                        tool: 'file_write',
                        ...codeSiteWriteEvidence(data, derivedLineProvenance),
                      }],
                    }, async () => withTelemetry('fs:write', () => gitService.writeFile(slug, data.path, physicalContent, effectiveUserId)), {
                      ...codeSiteEnforcement,
                      repoRoot: gitService.getEffectiveRepoPath(slug, effectiveUserId),
                    });
	                    result = { success: true };
	                    broadcastFileTreeChanged(slug, notifyScope);
	                  }
	                  break;
                case 'apply-shadow-patch':
                    // Synthi Genome — master plan §8.4.
                    // Apply a verified shadow patch as a CRDT-aware Yjs.Text
                    // edit (longest-common-prefix/suffix hunk) so concurrent
                    // editors merge cleanly. Falls back to direct disk write
                    // if Y-Sweet rejects the op or the doc does not exist.
                    // Payload: { files: [{ path, base, patched }], universeId }
                    result = { applied: [], skipped: [] };
                    for (const f of (data.files || [])) {
                      if (!f?.path || typeof f.patched !== 'string') {
                        result.skipped.push({ path: f?.path, reason: 'invalid file entry' });
                        continue;
                      }
                      try {
                        const previousContent = typeof f.base === 'string'
                          ? f.base
                          : await readWorkspaceFileForLineProvenance(slug, f.path, effectiveUserId);
                        const derivedLineProvenance = deriveLineProvenanceFromContentChange(f.path, previousContent, f.patched, {
                          evidenceRefs: f.evidenceRefs || f.evidence_refs || data.evidenceRefs || data.evidence_refs,
                          processAncestry: f.processAncestry || f.process_ancestry || data.processAncestry || data.process_ancestry,
                          promptSummary: 'Apply verified shadow patch',
                          reasonRef: `apply-shadow-patch:${data.universeId || 'universe'}:${f.path}`,
                        });
                        const boundary = await runCodeSiteMutationBoundary(codeSiteContext, {
                          operation: 'apply-shadow-patch',
                          tool: 'shadow_patch',
                          attempts: [{
                            path: f.path,
                            kind: 'apply-shadow-patch',
                            tool: 'shadow_patch',
                            ...codeSiteWriteEvidence({ ...data, ...f }, derivedLineProvenance),
                          }],
                        }, async () => {
                          const nonRecordingScope = { ...codeSiteNotifyScope, codesiteContext: null };
                          const docName = buildDocName(slug, f.path, notifyScope);
                          const op = await ySweetBridge.applyTextDiffOps(docName, f.patched);
                          if (op?.ok) {
                            // Persist to disk so git sees the same content.
                            await flushYjsDocForFile(slug, f.path, nonRecordingScope);
                            return { strategy: op.strategy };
                          }
                          // CRDT path failed — fall back to direct write.
                          await flushYjsDocForFile(slug, f.path, nonRecordingScope);
                          await withTelemetry('fs:write', () => gitService.writeFile(slug, f.path, f.patched, effectiveUserId));
                          return { strategy: 'direct-fallback' };
                        }, {
                          ...codeSiteEnforcement,
                          repoRoot: gitService.getEffectiveRepoPath(slug, effectiveUserId),
                        });
                        result.applied.push({ path: f.path, strategy: boundary.applyResult.strategy });
                      } catch (e) {
                        result.skipped.push({ path: f.path, reason: e?.message || 'apply failed' });
                      }
                    }
                    broadcastFileTreeChanged(slug, notifyScope);
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'write-files-batch':
                  // Batch write many files (supports base64 for binary).
                  // Payload shape: { files: [{ path, encoding: 'utf8'|'base64', content }] }
                  {
                    const physicalFiles = (data.files || []).map((file) => {
                      if (!file || String(file.encoding || 'utf8').toLowerCase() === 'base64') return file;
                      return {
                        ...file,
                        content: prepareFileContentForIdeWrite({
                          path: file.path,
                          userContent: file.content,
                          projectionResult: instructionProjection,
                        }),
                      };
                    });
                    const attempts = await Promise.all((data.files || []).map(async (file) => {
                      const nextContent = file?.encoding === 'base64'
                        ? null
                        : file?.content;
                      const derivedLineProvenance = await deriveCodeSiteLineProvenance(slug, file?.path, nextContent, effectiveUserId, {
                        evidenceRefs: file?.evidenceRefs || file?.evidence_refs || data.evidenceRefs || data.evidence_refs,
                        processAncestry: file?.processAncestry || file?.process_ancestry || data.processAncestry || data.process_ancestry,
                        promptSummary: 'Batch file write',
                        reasonRef: `write-files-batch:${file?.path}`,
                      });
                      return {
                        path: file?.path,
                        kind: 'write-files-batch',
                        tool: 'file_write',
                        ...codeSiteWriteEvidence({ ...data, ...file }, derivedLineProvenance),
                      };
                    }));
                    const boundary = await runCodeSiteMutationBoundary(codeSiteContext, {
                      operation: 'write-files-batch',
                      tool: 'file_write',
                      attempts,
                    }, async () => gitService.writeFilesBatch(slug, physicalFiles, {
                      syncToGcs: data.syncToGcs !== false,
                      userId: effectiveUserId,
                    }), {
                      ...codeSiteEnforcement,
                      repoRoot: gitService.getEffectiveRepoPath(slug, effectiveUserId),
                    });
                    result = boundary.applyResult;
                  }
                  break;
                case 'create-directory':
                    await runCodeSiteMutationBoundary(codeSiteContext, {
                      operation: 'create-directory',
                      tool: 'file_write',
                      attempts: [{
                        path: data.path,
                        kind: 'create-directory',
                        tool: 'file_write',
                        ...codeSiteWriteEvidence(data),
                      }],
                    }, async () => gitService.createDirectory(slug, data.path, effectiveUserId), {
                      ...codeSiteEnforcement,
                      repoRoot: gitService.getEffectiveRepoPath(slug, effectiveUserId),
                    });
                    result = { success: true };
                    broadcastFileTreeChanged(slug, notifyScope);
                    break;
                case 'delete-item':
	                    // Delete a file or folder from the workspace
	                    console.log('[Collab] delete-item called for:', slug, data.path);
                    {
                      const previousContent = await readWorkspaceFileForLineProvenance(slug, data.path, effectiveUserId);
                      const derivedLineProvenance = deriveLineProvenanceFromContentChange(data.path, previousContent, '', {
                        evidenceRefs: data.evidenceRefs || data.evidence_refs,
                        processAncestry: data.processAncestry || data.process_ancestry,
                        promptSummary: 'Delete workspace item',
                        reasonRef: `delete-item:${data.path}`,
                      });
                      const boundary = await runCodeSiteMutationBoundary(codeSiteContext, {
                        operation: 'delete-item',
                        tool: 'file_delete',
                        attempts: [{
                          path: data.path,
                          kind: 'delete-item',
                          tool: 'file_delete',
                          ...codeSiteWriteEvidence(data, derivedLineProvenance),
                        }],
                      }, async () => gitService.deleteItem(slug, data.path, effectiveUserId), {
                        ...codeSiteEnforcement,
                        repoRoot: gitService.getEffectiveRepoPath(slug, effectiveUserId),
                      });
                      result = boundary.applyResult;
                    }
                    console.log('[Collab] delete-item result:', result);
                    if (data.path) {
                      await invalidateDocsForSlug(slug, [data.path], notifyScope);
                    }
                    broadcastFileTreeChanged(slug, notifyScope);
                    break;
	                case 'rename-item':
	                    // Rename / move a file or directory
                    {
                      const previousContent = await readWorkspaceFileForLineProvenance(slug, data.oldPath, effectiveUserId);
                      const oldPathLineProvenance = deriveLineProvenanceFromContentChange(data.oldPath, previousContent, '', {
                        evidenceRefs: data.evidenceRefs || data.evidence_refs,
                        processAncestry: data.processAncestry || data.process_ancestry,
                        promptSummary: 'Rename source path',
                        reasonRef: `rename-item:old:${data.oldPath}`,
                      });
                      const newPathLineProvenance = deriveLineProvenanceFromContentChange(data.newPath, '', previousContent, {
                        evidenceRefs: data.evidenceRefs || data.evidence_refs,
                        processAncestry: data.processAncestry || data.process_ancestry,
                        promptSummary: 'Rename destination path',
                        reasonRef: `rename-item:new:${data.newPath}`,
                      });
                      const boundary = await runCodeSiteMutationBoundary(codeSiteContext, {
                        operation: 'rename-item',
                        tool: 'file_rename',
                        attempts: [
                          {
                            path: data.oldPath,
                            kind: 'rename-item:old',
                            tool: 'file_rename',
                            ...codeSiteWriteEvidence(data, oldPathLineProvenance),
                          },
                          {
                            path: data.newPath,
                            kind: 'rename-item:new',
                            tool: 'file_rename',
                            ...codeSiteWriteEvidence(data, newPathLineProvenance),
                          },
                        ],
                      }, async () => gitService.renameItem(slug, data.oldPath, data.newPath, effectiveUserId), {
                        ...codeSiteEnforcement,
                        repoRoot: gitService.getEffectiveRepoPath(slug, effectiveUserId),
                      });
                      result = boundary.applyResult;
                    }
                    // Invalidate old path's Yjs doc (the file no longer exists at old path)
                    if (data.oldPath) {
                      await invalidateDocsForSlug(slug, [data.oldPath], notifyScope);
                    }
                    broadcastFileTreeChanged(slug, notifyScope);
                    break;
                case 'clear-collab':
                    // Clear Yjs persistence for specified files (used after merge conflict resolution)
                    const filesToClear = Array.isArray(data.files) ? data.files : (data.path ? [data.path] : []);
                    for (const filePath of filesToClear) {
                      const docName = buildDocName(slug, filePath, notifyScope);
                        await clearDocumentPersistence(docName);
                    }
                    result = { success: true, cleared: filesToClear.length };
                    break;
                case 'github-info': {
                    // Extract owner/repo from the git remote URL for this workspace.
                    // Used by the PR panel to know which GitHub repo to query.
                    try {
                        const git = await gitService.getGit(slug, effectiveUserId);
                        const remotes = await git.getRemotes(true);
                        const origin = remotes.find(r => r.name === 'origin') || remotes[0];
                        if (!origin || !origin.refs?.fetch) {
                            result = { error: 'no_remote', message: 'No remote configured for this workspace.' };
                            break;
                        }
                        const remoteUrl = origin.refs.fetch;

                        // Parse various remote URL formats:
                        //   https://github.com/owner/repo.git
                        //   git@github.com:owner/repo.git
                        //   https://token@github.com/owner/repo.git
                        let owner = null;
                        let repo = null;
                        let provider = 'unknown';
                        let htmlUrl = null;

                        const cleanUrl = remoteUrl.replace(/^https?:\/\/[^@]+@/, 'https://'); // strip embedded credentials

                        const httpsMatch = cleanUrl.match(/https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/)?$/i);
                        const sshMatch = cleanUrl.match(/git@(github\.com|gitlab\.com|bitbucket\.org):([^/]+)\/([^/]+?)(?:\.git)?$/i);

                        if (httpsMatch) {
                            const host = httpsMatch[1].toLowerCase();
                            owner = httpsMatch[2];
                            repo = httpsMatch[3];
                            provider = host === 'github.com' ? 'github' : host === 'gitlab.com' ? 'gitlab' : 'bitbucket';
                            htmlUrl = `https://${host}/${owner}/${repo}`;
                        } else if (sshMatch) {
                            const host = sshMatch[1].toLowerCase();
                            owner = sshMatch[2];
                            repo = sshMatch[3];
                            provider = host === 'github.com' ? 'github' : host === 'gitlab.com' ? 'gitlab' : 'bitbucket';
                            htmlUrl = `https://${host}/${owner}/${repo}`;
                        }

                        result = { owner, repo, provider, remoteUrl: cleanUrl, htmlUrl };
                    } catch (e) {
                        result = { error: 'parse_failed', message: e.message };
                    }
                    break;
                }
                default:
                    res.writeHead(404);
                    res.end('Unknown action');
                    return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            if (isCodeSiteDeniedError(e)) {
                writeCodeSiteDenied(res, e);
                return;
            }
            if (isCodeSiteCommitBlockedError(e)) {
                res.writeHead(e.status || 409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'codesite_commit_blocked',
                    message: e.message,
                    details: e.details || {},
                }));
                return;
            }
            // Handle structured GitError responses
            if (e.code && e.toJSON) {
                const statusCode = e.code === 'REPO_NOT_FOUND' || e.code === 'REPO_NOT_INITIALIZED' ? 404 : 
                                   e.code === 'AUTH_FAILED' || e.code === 'NO_REMOTE' ? 400 :
                                   e.code === 'MERGE_CONFLICT' ? 409 :
                                   e.code === 'UNCOMMITTED_CHANGES' ? 422 : 400;
                console.debug('[Collab] Git error:', e.code, e.message);
                res.writeHead(statusCode, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(e.toJSON()));
                return;
            }
            
            // Legacy error handling for unstructured errors
            const msg = e?.message || '';
            if (['path_required', 'path_null_byte', 'path_escape'].includes(msg)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'invalid_path', message: msg }));
                return;
            }
            if (msg.includes('not initialized') || msg.includes('not found') || msg.includes('no remote configured') || msg.includes('no configured push destination') || msg.includes('authentication failed') || msg.includes('user cancelled') || msg.includes('user cancelled dialog') || msg.includes('repository not found') || msg.includes('remote: repository not found')) {
                console.debug('[Collab] Client error in /git/:', msg);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: msg }));
            } else {
                console.error(e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: msg }));
            }
        }
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Synthi collaboration server is running');
});

// PERF: Enable permessage-deflate compression.  Yjs binary sync messages
// and JSON notification payloads are highly compressible (~30% smaller).
const wsPerMessageDeflate = {
  zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 }, // level 3 = fast
  zlibInflateOptions: { chunkSize: 10 * 1024 },
  clientNoContextTakeover: true,   // don't keep deflate state between messages
  serverNoContextTakeover: true,
  serverMaxWindowBits: 10,
  concurrencyLimit: 10,
  threshold: 128,                  // only compress messages > 128 bytes
};

// ── Yjs document WebSocket relay ─────────────────────────────────────────────
// Minimal Yjs sync protocol handler — Y-Sweet 0.9.x serve doesn't expose
// WebSocket, so we host the document relay here on the collab server.
const yjsWss = new WebSocket.Server({ noServer: true });
const yjsWsServer = require('./yjsWsServer');

// Lightweight notification WebSocket server for non-Yjs broadcasts
// (e.g., file-tree-changed). Clients connect to /notifications?slug=<slug>.
const notifyWss = new WebSocket.Server({ noServer: true, perMessageDeflate: wsPerMessageDeflate });

// Session notification WebSocket server for collaboration events.
// Clients connect to /session-events?sessionId=<id>&userId=<id>.
const sessionWss = new WebSocket.Server({ noServer: true, perMessageDeflate: wsPerMessageDeflate });

// Terminal PTY WebSocket server — spawns shell sessions via node-pty.
// Clients connect to /terminal?sessionId=<id>&workspace=<slug>&cols=N&rows=N.
const agentSessionAttachService = createAgentSessionAttachService();
const runtimeObservationPublisher = createRuntimeObservationPublisher();
const terminalWss = createTerminalWSS({
  enableContainerRuntime: ENABLE_CONTAINER_RUNTIME,
  enableCodeSiteDockerRuntime: ENABLE_CODESITE_DOCKER_RUNTIME,
  workspaceRuntime,
  flushWorkspaceDocsToDisk,
  agentSessionAttachService,
});

// Grace period for guest disconnect → reconnect (prevents phantom kicks)
const GUEST_DISCONNECT_GRACE_MS = 30_000;
/** @type {Map<string, NodeJS.Timeout>} userId → timeout handle */
const guestDisconnectTimers = new Map();

/**
 * Broadcast a session-level event to all participants (host + guests).
 * @param {string} sessionId
 * @param {string} eventType
 * @param {object} payload
 */
function broadcastSessionEvent(sessionId, eventType, payload) {
  const message = JSON.stringify({ type: eventType, sessionId, ...payload });
  sessionWss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN && ws._sessionId === sessionId) {
      try { ws.send(message); } catch (_) {}
    }
  });
}

/**
 * Send a session-level event ONLY to the session host.
 * Used for events that should never reach guests (e.g. knock requests).
 * Falls back to broadcastSessionEvent if host socket cannot be identified.
 *
 * @param {string} sessionId
 * @param {string} eventType
 * @param {object} payload
 */
function sendToSessionHost(sessionId, eventType, payload) {
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    console.warn(`[Session] sendToSessionHost: session ${sessionId} not found`);
    return;
  }
  const hostUserId = session.hostId;
  if (!hostUserId) {
    console.warn(`[Session] sendToSessionHost: no hostId for session ${sessionId}`);
    return;
  }
  const message = JSON.stringify({ type: eventType, sessionId, ...payload });
  let sent = false;
  sessionWss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN && ws._sessionId === sessionId && ws._userId === hostUserId) {
      try { ws.send(message); sent = true; } catch (_) {}
    }
  });
  if (!sent) {
    console.warn(`[Session] sendToSessionHost: host WS not found for session ${sessionId} (host=${hostUserId}). Attempting notification WS fallback.`);
    // Fallback: try the notification WS channel so the host still gets alerted.
    // Preserve the original event type so that permission:requested, knock:cancelled,
    // etc. are delivered with the correct type — not rewritten to session-knock.
    // Only actual knock events use 'session-knock' as their fallback type.
    if (notifyWss) {
      const fallbackType = eventType === 'knock' ? 'session-knock' : eventType;
      const fallbackMsg = JSON.stringify({ type: fallbackType, sessionId, ...payload });
      notifyWss.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN && ws._userId === hostUserId) {
          try { ws.send(fallbackMsg); sent = true; } catch (_) {}
        }
      });
    }
    if (sent) {
      console.log(`[Session] sendToSessionHost: delivered via notification WS fallback`);
    } else {
      console.error(`[Session] sendToSessionHost: FAILED to deliver knock to host ${hostUserId} via any channel`);
    }
  } else {
    console.log(`[Session] sendToSessionHost: delivered '${eventType}' to host ${hostUserId}`);
  }
}

/**
 * Send a session-level event to a SPECIFIC user in the session.
 * Used for targeted events like knock:denied (only the denied guest needs it).
 *
 * @param {string} sessionId
 * @param {string} targetUserId
 * @param {string} eventType
 * @param {object} payload
 */
function sendToSessionUser(sessionId, targetUserId, eventType, payload) {
  const message = JSON.stringify({ type: eventType, sessionId, ...payload });
  sessionWss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN && ws._sessionId === sessionId && ws._userId === targetUserId) {
      try { ws.send(message); } catch (_) {}
    }
  });
}



server.on('upgrade', (request, socket, head) => {
  if (proxyService.isPreviewHostRequest(request)) {
    if (!proxyService.proxyWsUpgrade(request, socket, head)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
    return;
  }

  // Use replace to safely strip the prefix while retaining the public mount
  // prefix for runtime preview WebSocket URL reconstruction.
  const originalUrl = request.url || '/';
  const collabMountMatch = originalUrl.match(/^\/collab(?=\/|$)/);
  request._synthiExternalMountPrefix = collabMountMatch ? '/collab' : '';
  request.url = originalUrl.replace(/^\/collab(?=\/|$)/, '');
  if (!request.url.startsWith('/')) request.url = '/' + request.url;
  if (request.url.startsWith('/port/') || request.url.startsWith('/runtime/')) {
    if (!proxyService.proxyWsUpgrade(request, socket, head)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
    return;
  }
  const pathname = request.url ? request.url.slice(1).split('?')[0] : 'unknown';
  console.log(`[Collab DEBUG] Upgrade request for room: ${pathname}`);

  if (pathname.startsWith('wsport/')) {
    // Container-program port proxy WS upgrade (HMR etc.) → runtime container.
    // request.url is `/wsport/<slug>/<port>/...` at this point.
    if (!containerPortProxy || !containerPortProxy.proxyWsUpgrade(request, socket, head)) {
      socket.destroy();
    }
  } else if (pathname === 'notifications') {
    // Route to lightweight notification WebSocket server
    notifyWss.handleUpgrade(request, socket, head, (ws) => {
      notifyWss.emit('connection', ws, request);
    });
  } else if (pathname === 'session-events') {
    // Route to session event WebSocket server
    sessionWss.handleUpgrade(request, socket, head, (ws) => {
      sessionWss.emit('connection', ws, request);
    });
  } else if (pathname === 'terminal') {
    const terminalUrl = new URL(request.url || '/terminal', `http://${request.headers.host || 'localhost'}`);
    const terminalSlug = terminalUrl.searchParams.get('workspace') || '';
    const auth = authorizeTerminalGatewayRequest({
      req: request,
      slug: terminalSlug,
      config,
      sessionManager,
    });
    if (!auth.ok) {
      const status = auth.status || 401;
      const body = JSON.stringify({ error: auth.error || 'collab_gateway_auth_failed' });
      socket.write(
        `HTTP/1.1 ${status} Unauthorized\r\n` +
        'Content-Type: application/json\r\n' +
        'Connection: close\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
        body
      );
      socket.destroy();
      return;
    }
    if (auth.source === 'gateway') {
      if (auth.workspaceUserId) terminalUrl.searchParams.set('userId', auth.workspaceUserId);
      if (auth.filesystemUserId) terminalUrl.searchParams.set('filesystemUserId', auth.filesystemUserId);
      else if (auth.workspaceUserId) terminalUrl.searchParams.set('filesystemUserId', auth.workspaceUserId);
      if (auth.runtimeScope) terminalUrl.searchParams.set('runtimeScope', auth.runtimeScope);
      if (auth.collabSessionId) terminalUrl.searchParams.set('collabSessionId', auth.collabSessionId);
      terminalUrl.searchParams.delete('codeSiteProjectId');
      terminalUrl.searchParams.delete('agentProvider');
      terminalUrl.searchParams.delete('providerSessionRef');
      terminalUrl.searchParams.delete('token');
      request.url = `${terminalUrl.pathname}${terminalUrl.search}`;
    }
    // Route to terminal PTY WebSocket server
    terminalWss.handleUpgrade(request, socket, head, (ws) => {
      terminalWss.emit('connection', ws, request);
    });
  } else if (pathname.startsWith('yjs/')) {
    // Route to Yjs document sync WebSocket (y-websocket protocol)
    // Room name = everything after 'yjs/'
    yjsWss.handleUpgrade(request, socket, head, async (ws) => {
      const docName = decodeURIComponent(pathname.slice(4));
      let initialContent = null;
      let slug = null, userId = null;

      try {
        // Parse docName: workspace:${slug}:user:${userId}:${path}
        const parts = docName.split(':');
        if (parts.length >= 5 && parts[0] === 'workspace' && parts[2] === 'user') {
           slug = parts[1];
           userId = decodeURIComponent(parts[3]);
           // Path starts at index 4, rejoin rest
           const rawFilePath = parts.slice(4).join(':');

           // Reject traversal / absolute paths / null bytes up-front.
           // validateFilePath throws on anything dangerous.
           const safeRelative = validateFilePath(rawFilePath);

           // Acquire repo to ensure file exists on disk
           const repoPath = await repoCache.acquire(slug, userId);
           try {
             const fullPath = path.join(repoPath, safeRelative);
             // fs.realpath resolves symlinks; we then verify the resolved path
             // is strictly inside the repo root.  Uses realpath on the repo
             // too so that mount-point symlinks are handled consistently.
             let realFull, realRepo;
             try {
               [realFull, realRepo] = await Promise.all([
                 fsPromises.realpath(fullPath),
                 fsPromises.realpath(repoPath),
               ]);
             } catch (_) {
               // File doesn't exist yet — that's fine; nothing to seed.
               realFull = null;
             }
             if (realFull && realRepo) {
               const rel = path.relative(realRepo, realFull);
               const isInside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
               if (isInside) {
                 const stat = await fsPromises.stat(realFull);
                 if (stat.isFile()) {
                   initialContent = await fsPromises.readFile(realFull, 'utf8');
                 }
               } else {
                 console.warn('[Collab] Rejecting Yjs seed: resolved path escapes repo', { slug, userId, rawFilePath });
               }
             }
           } finally {
             repoCache.release(slug, userId);
           }
        }
      } catch (e) {
        console.warn('[Collab] Failed to seed Yjs doc from disk', docName, e.message);
      }

      yjsWsServer.setupConnection(ws, docName, initialContent);
    });
  } else {
    // Unknown upgrade path — Y-Sweet handles CRDT WebSockets directly.
    console.warn(`[Collab] Rejected unknown WS upgrade: /${pathname}`);
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

// ── Presence + offline delivery helpers ─────────────────────────────
// Online = has at least one open notify-WS OR session-WS.  We prefer the
// notify-WS because it's the long-lived channel every user keeps open on
// the workspace page, but we also look at sessionWss so a user inside an
// active collab session is considered online even if their notify-WS
// hasn't reconnected yet.
function isUserOnline(userId) {
  if (!userId) return false;
  const id = String(userId);
  if (notifyWss) {
    for (const ws of notifyWss.clients) {
      if (ws.readyState === WebSocket.OPEN && ws._userId === id) return true;
    }
  }
  if (sessionWss) {
    for (const ws of sessionWss.clients) {
      if (ws.readyState === WebSocket.OPEN && ws._userId === id) return true;
    }
  }
  return false;
}

/**
 * Deliver an event to a user.  If they're online we send immediately via
 * every open notify-WS for that user; otherwise we queue in Redis so their
 * next connect picks it up.  When a slug is supplied only matching
 * notify-WS connections receive the live delivery — the Redis fallback
 * has no slug filter since inbox drains target the userId only.
 *
 * @param {string} userId
 * @param {string} type  event type (e.g. 'collab-invite', 'knock:denied')
 * @param {object} payload
 * @param {{ slug?: string, forceQueue?: boolean }} [opts]
 * @returns {Promise<{ delivered: boolean, queued: boolean }>}
 */
async function deliverToUser(userId, type, payload, opts = {}) {
  if (!userId || !type) return { delivered: false, queued: false };
  const msg = JSON.stringify({ type, ...payload });
  let delivered = false;
  if (!opts.forceQueue && notifyWss) {
    notifyWss.clients.forEach((ws) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws._userId !== userId) return;
      if (opts.slug && ws._slug && ws._slug !== opts.slug) return;
      try { ws.send(msg); delivered = true; } catch (_) {}
    });
  }
  if (delivered) return { delivered: true, queued: false };
  // Not online (or no matching slug connection) — queue for next connect.
  await persistence.enqueueUserEvent(userId, { type, payload });
  return { delivered: false, queued: true };
}

/**
 * On WS connect, drain any events that were queued while the user was
 * offline and send them immediately.  Each event carries `queued: true`
 * and `queuedAt` so the client can render it as a popup "missed while
 * offline" notification.  Safe to call even when persistence is off —
 * drainUserInbox returns [] in that case.
 */
async function flushUserInboxToSocket(ws, userId) {
  if (!userId) return;
  const events = await persistence.drainUserInbox(userId);
  if (!events.length) return;
  for (const e of events) {
    if (ws.readyState !== WebSocket.OPEN) break;
    try {
      ws.send(JSON.stringify({
        type: e.type,
        ...(e.payload || {}),
        queued: true,
        queuedAt: e.queuedAt,
      }));
    } catch (_) { /* socket went away mid-flush */ }
  }
  logger.info('inbox_drained', { userId, count: events.length });
}

// ── Notification WS connection handler ──────────────────────────────
notifyWss.on('connection', (ws, req) => {
  const params = new URLSearchParams((req.url || '').split('?')[1] || '');
  ws._slug = params.get('slug') || null;
  ws._userId = params.get('userId') ? decodeURIComponent(params.get('userId')) : null;
  ws._userEmail = params.get('email') ? decodeURIComponent(params.get('email')).trim().toLowerCase() : null;
  ws._sessionId = params.get('sessionId') || null;
  logger.info('notify_ws_connected', { slug: ws._slug, userId: ws._userId, hasEmail: !!ws._userEmail });
  // Flush any offline events for this user as a burst of queued:true
  // messages so the UI can surface them as popups.
  if (ws._userId) {
    flushUserInboxToSocket(ws, ws._userId).catch((err) =>
      logger.warn('inbox_flush_failed', { userId: ws._userId }, err));
  }
  ws.on('close', () => {
    logger.info('notify_ws_disconnected', { slug: ws._slug, userId: ws._userId });
  });
});

// ── Session-events WS connection handler ────────────────────────────
sessionWss.on('connection', (ws, req) => {
  const params = new URLSearchParams((req.url || '').split('?')[1] || '');
  ws._socketId = `session-ws-${crypto.randomBytes(8).toString('hex')}`;
  ws._sessionId = params.get('sessionId') || null;
  ws._userId = params.get('userId') ? decodeURIComponent(params.get('userId')) : null;
  ws._role = params.get('role') || null;

  function identify(payload = {}) {
    const nextSessionId = payload.sessionId || ws._sessionId;
    const nextUserId = payload.userId || ws._userId;
    const nextRole = payload.role || ws._role;
    if (nextSessionId) ws._sessionId = String(nextSessionId);
    if (nextUserId) ws._userId = String(nextUserId);
    if (nextRole) ws._role = String(nextRole);

    const session = ws._sessionId ? sessionManager.getSession(ws._sessionId) : null;
    if (!session || !ws._userId) return;

    if (session.hostId === ws._userId && (ws._role === 'hosting' || ws._role === 'host')) {
      try { sessionManager.registerHostSocket(ws._sessionId, ws._socketId); } catch (_) {}
      return;
    }

    const isGuestLike = ws._role === 'guest' || ws._role === 'knocking';
    if (isGuestLike) {
      if (guestDisconnectTimers.has(ws._userId)) {
        clearTimeout(guestDisconnectTimers.get(ws._userId));
        guestDisconnectTimers.delete(ws._userId);
      }
      try { sessionManager.updateGuestSocket(ws._sessionId, ws._userId, ws); } catch (_) {}
    }
  }

  identify();

  logger.info('session_ws_connected', { sessionId: ws._sessionId, userId: ws._userId });
  ws.on('message', (raw) => {
    try {
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      const msg = JSON.parse(text);
      if (msg?.type === 'identify') {
        identify(msg);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'identified', sessionId: ws._sessionId, userId: ws._userId, role: ws._role }));
        }
      }
    } catch (_) {
      // Session event WS only accepts JSON control frames from clients.
    }
  });
  ws.on('close', () => {
    if (ws._role === 'hosting' || ws._role === 'host') {
      try { sessionManager.handleDisconnect(ws._socketId); } catch (_) {}
    }
    logger.info('session_ws_disconnected', { sessionId: ws._sessionId, userId: ws._userId });
  });
});

// ── Wire SessionManager events to WebSocket delivery ─────────────────────
// SessionManager is an EventEmitter; these listeners bridge in-process events
// to the connected WebSocket clients (host + guests).

sessionManager.on('session:knock', ({ sessionId, hostId, guestId, displayName, avatarUrl }) => {
  sendToSessionHost(sessionId, 'knock', { guestId, displayName, avatarUrl, hostId });
});

sessionManager.on('session:guestJoined', ({ sessionId, hostId, guest, autoAdmitted }) => {
  const session = sessionManager.getSession(sessionId);
  broadcastSessionEvent(sessionId, 'guest:joined', {
    guest,
    hostId,
    slug: session?.slug,
    autoAdmitted: autoAdmitted || false,
  });
});

sessionManager.on('session:knockDenied', ({ sessionId, guestId }) => {
  sendToSessionUser(sessionId, guestId, 'knock:denied', { guestId });
});

sessionManager.on('session:permissionsUpdated', ({ sessionId, guestId, permissions }) => {
  broadcastSessionEvent(sessionId, 'permissions:updated', { guestId, permissions });
});

sessionManager.on('session:guestRemoved', ({ sessionId, guestId, reason }) => {
  broadcastSessionEvent(sessionId, 'guest:removed', { guestId, reason });
});

sessionManager.on('session:terminated', ({ sessionId }) => {
  broadcastSessionEvent(sessionId, 'session:terminated', {});
});

sessionManager.on('session:knockCancelled', ({ sessionId, guestId }) => {
  sendToSessionHost(sessionId, 'knock:cancelled', { guestId });
});

// ── Persistence bridge ──────────────────────────────────────────────────
// SessionManager emits persist:session / persist:delete for every mutation.
// The bridge forwards to the persistence adapter which is a no-op unless
// REDIS_URL is configured + the redis module is installed.
sessionManager.on('persist:session', (session) => {
  persistence.saveSession(session);
});
sessionManager.on('persist:delete', (sessionId) => {
  persistence.deleteSession(sessionId);
});

// ── Graceful shutdown ───────────────────────────────────────────────────
// Drain WebSockets, stop accepting new connections, flush persistence,
// then let the process exit.  The deadline enforces bounded shutdown time
// so orchestrators don't have to SIGKILL us.
let shuttingDown = false;
const SHUTDOWN_DEADLINE_MS = Number(process.env.COLLAB_SHUTDOWN_DEADLINE_MS) || 15_000;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutdown_started', { signal });

  // Force-exit watchdog in case a socket refuses to close.
  const watchdog = setTimeout(() => {
    logger.error('shutdown_timeout', { deadlineMs: SHUTDOWN_DEADLINE_MS });
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  if (typeof watchdog.unref === 'function') watchdog.unref();

  // 1. Stop accepting new HTTP/WS connections.
  try { server.close(); } catch (err) { logger.warn('server_close_failed', {}, err); }

  // 2. Tell every connected WebSocket to go away cleanly.  1001 "going
  //    away" is the canonical close code for graceful server shutdown.
  const wsServers = [
    { name: 'notify', s: notifyWss },
    { name: 'session', s: sessionWss },
    { name: 'terminal', s: terminalWss },
    { name: 'yjs', s: yjsWss },
  ];
  for (const { name, s } of wsServers) {
    if (!s || !s.clients) continue;
    const count = s.clients.size;
    logger.info('ws_drain', { channel: name, clients: count });
    s.clients.forEach((ws) => {
      try { ws.close(1001, 'server_shutting_down'); } catch (_) {}
    });
  }

  // 3. Give in-flight work a brief moment to finish (Y-Sweet writes,
  //    file I/O, pending persistence calls).
  await new Promise((r) => setTimeout(r, 1500));

  // 4. Close persistence.  Best-effort — if Redis is down we still exit.
  try { await persistence.close(); }
  catch (err) { logger.warn('persistence_close_failed', {}, err); }

  logger.info('shutdown_complete', { signal });
  clearTimeout(watchdog);
  // Small delay to let last log flush.
  setTimeout(() => process.exit(0), 50).unref?.();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Surface (but don't crash on) unhandled rejections — they're easy to
// miss in production logs and usually indicate a .catch() we forgot.
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', { reason: reason?.message || String(reason) },
    reason instanceof Error ? reason : null);
});
process.on('uncaughtException', (err) => {
  logger.error('uncaught_exception', {}, err);
});

// ── Boot sequence ───────────────────────────────────────────────────────
(async () => {
  // Try to attach persistence up-front.  If REDIS_URL isn't set this is
  // a fast no-op and we continue with pure in-memory behaviour.
  try {
    await persistence.connect();
    if (persistence.isAvailable()) {
      const sessions = await persistence.loadSessions();
      const restored = sessionManager.restoreFromSnapshot(sessions);
      logger.info('sessions_restored', { count: restored });

      const blocks = await persistence.loadBlocks();
      let blockCount = 0;
      for (const { userId, blocked } of blocks) {
        if (!blockedBy.has(userId)) blockedBy.set(userId, new Set());
        for (const b of blocked) { blockedBy.get(userId).add(b); blockCount++; }
      }
      logger.info('blocks_restored', { owners: blocks.length, entries: blockCount });
    }
  } catch (err) {
    logger.error('persistence_bootstrap_failed', {}, err);
  }

  server.listen(PORT, '0.0.0.0', () => {
    logger.info('server_listening', {
      port: PORT,
      ySweetUrl: config.YSWEET_URL,
      persistence: persistence.isAvailable() ? 'redis' : 'memory',
    });
    proxyService.startScanner(PORT);

    // Start the idle-workspace culler (only inside K8s).
    if (process.env.KUBERNETES_SERVICE_HOST) {
      spawner.startCuller();
    }

    // Synthi Genome — bridge fs-change events to the ai-engine's
    // continuous-shadow watcher (master plan §14).
    shadowContinuousProducer.start();

    // Slice 3 Phase 3 — live web-port auto-detection. Run the port scanner
    // (excluding our own port) and push detected port-set changes into the
    // managed program sessions so their App/Ports surfaces light up live.
    proxyService.startScanner(PORT);
    if (containerPortMonitor) {
      containerPortMonitor.start();
      logger.info('container_port_monitor_started', {});
    }
    if (runtimePortMonitor) {
      runtimePortMonitor.start();
      logger.info('runtime_port_monitor_started', {});
    }
    proxyService.onPortsChanged((ports) => {
      try {
        managedProgramRuntime.recomputeManagedPorts(ports);
      } catch (err) {
        logger.warn({ err }, 'recomputeManagedPorts failed');
      }
    });
  });
})();
