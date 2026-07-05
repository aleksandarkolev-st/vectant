'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  buildEvent,
  buildQuarantineChangeEvidence,
  collectCodeSiteProcessAncestry,
  diffSnapshots,
  normalizeRepoRelativePath,
  recordCodeSiteWriteAttempt,
  snapshotTree,
} = require('./codesiteFs');

const DEFAULT_SENTINEL_BASE_DIR = path.join(os.tmpdir(), 'synthi-codesite-host-sentinel');
const DEFAULT_SCAN_INTERVAL_MS = 1_000;
const DEFAULT_PREWRITE_GUARD_IGNORE_NAMES = new Set(['.git']);

function safeSegment(value) {
  return String(value || 'unknown')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'unknown';
}

function digestText(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function cloneSnapshotEntry(entry = {}) {
  return {
    ...entry,
    baselinePath: entry.baselinePath || null,
  };
}

function cloneSnapshot(snapshot) {
  return new Map([...snapshot.entries()].map(([relPath, entry]) => [relPath, cloneSnapshotEntry(entry)]));
}

async function copyFileIfExists(source, target) {
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(source, target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function captureRestorableBaseline(repoRoot, snapshot, baselineDir) {
  const next = new Map();
  await fsp.mkdir(baselineDir, { recursive: true });
  for (const [relPath, entry] of snapshot.entries()) {
    const normalized = normalizeRepoRelativePath(relPath);
    const sourcePath = path.join(repoRoot, normalized);
    const baselineName = `${digestText(normalized)}-${safeSegment(path.basename(normalized))}`;
    const baselinePath = path.join(baselineDir, baselineName);
    const copied = await copyFileIfExists(sourcePath, baselinePath);
    next.set(normalized, {
      ...entry,
      baselinePath: copied ? baselinePath : null,
    });
  }
  return next;
}

function booleanEnv(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'required'].includes(text);
}

function permissionEntrySortAscending(left, right) {
  return left.path.length - right.path.length || left.path.localeCompare(right.path);
}

function permissionEntrySortDescending(left, right) {
  return right.path.length - left.path.length || left.path.localeCompare(right.path);
}

async function collectPermissionEntries(root, options = {}) {
  const ignoreNames = new Set([
    ...DEFAULT_PREWRITE_GUARD_IGNORE_NAMES,
    ...asArray(options.ignoreNames).map(String),
  ]);
  const entries = [];

  async function walk(current) {
    const stat = await fsp.lstat(current);
    entries.push({
      path: current,
      mode: stat.mode,
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink(),
    });
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const children = await fsp.readdir(current, { withFileTypes: true });
    for (const child of children) {
      if (ignoreNames.has(child.name)) continue;
      await walk(path.join(current, child.name));
    }
  }

  await walk(root);
  return entries;
}

async function applyReadOnlyPrewriteGuard(root, options = {}) {
  const entries = await collectPermissionEntries(root, options);
  const changed = [];
  const errors = [];
  for (const entry of entries.sort(permissionEntrySortDescending)) {
    if (entry.isSymbolicLink) continue;
    const guardedMode = entry.mode & ~0o222;
    if (guardedMode === entry.mode) continue;
    try {
      await fsp.chmod(entry.path, guardedMode);
      changed.push(entry);
    } catch (error) {
      errors.push({
        path: entry.path,
        code: error?.code || null,
        message: error?.message || String(error),
      });
    }
  }
  if (errors.length) {
    for (const entry of changed.sort(permissionEntrySortAscending)) {
      try {
        await fsp.chmod(entry.path, entry.mode);
      } catch (_) {}
    }
    const error = new Error('codesite_host_prewrite_guard_failed');
    error.code = 'CODESITE_HOST_PREWRITE_GUARD_FAILED';
    error.errors = errors;
    throw error;
  }
  const verification = await verifyReadOnlyPrewriteGuard(root);
  if (!verification.createDenied) {
    for (const entry of changed.sort(permissionEntrySortAscending)) {
      try {
        await fsp.chmod(entry.path, entry.mode);
      } catch (_) {}
    }
    const error = new Error('codesite_host_prewrite_guard_unsupported');
    error.code = 'CODESITE_HOST_PREWRITE_GUARD_UNSUPPORTED';
    error.verification = verification;
    throw error;
  }
  return {
    schemaVersion: 'synthi.codesite.hostPrewriteBoundary.v1',
    mode: 'posix_readonly_tree',
    active: true,
    enforcedBeforeMutation: true,
    verification,
    guardedPathCount: changed.length,
    guardedPathsSample: changed
      .map((entry) => path.relative(root, entry.path) || '.')
      .slice(0, 20),
    armedAt: new Date().toISOString(),
    entries: changed,
  };
}

async function verifyReadOnlyPrewriteGuard(root) {
  const probePath = path.join(root, `.codesite-prewrite-create-probe-${crypto.randomBytes(4).toString('hex')}`);
  try {
    await fsp.writeFile(probePath, 'prewrite guard probe\n', { flag: 'wx' });
    await fsp.rm(probePath, { force: true });
    return {
      createDenied: false,
      code: null,
      message: 'create probe unexpectedly succeeded',
    };
  } catch (error) {
    return {
      createDenied: ['EACCES', 'EPERM', 'EROFS'].includes(error?.code),
      code: error?.code || null,
      message: error?.message || String(error),
    };
  }
}

async function restoreReadOnlyPrewriteGuard(boundary = {}) {
  const entries = asArray(boundary.entries);
  const errors = [];
  for (const entry of entries.sort(permissionEntrySortAscending)) {
    if (!entry?.path || entry.isSymbolicLink) continue;
    try {
      await fsp.chmod(entry.path, entry.mode);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      errors.push({
        path: entry.path,
        code: error?.code || null,
        message: error?.message || String(error),
      });
    }
  }
  return {
    ...boundary,
    active: false,
    restoredAt: new Date().toISOString(),
    restoreErrors: errors,
  };
}

async function restoreBaselineEntry(repoRoot, relPath, beforeEntry) {
  const targetPath = path.join(repoRoot, normalizeRepoRelativePath(relPath));
  if (!beforeEntry) {
    await fsp.rm(targetPath, { recursive: true, force: true });
    return { restored: true, action: 'removed_untracked_file' };
  }
  if (beforeEntry.baselinePath) {
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.copyFile(beforeEntry.baselinePath, targetPath);
    return { restored: true, action: 'restored_from_baseline_copy' };
  }
  if (typeof beforeEntry.text === 'string') {
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, beforeEntry.text, 'utf8');
    return { restored: true, action: 'restored_from_inline_text' };
  }
  if (typeof beforeEntry.base64 === 'string') {
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, Buffer.from(beforeEntry.base64, 'base64'));
    return { restored: true, action: 'restored_from_inline_base64' };
  }
  return { restored: false, action: 'baseline_content_unavailable' };
}

function manifestPathFor(baseDir, workspaceSlug, sentinelId) {
  return path.join(baseDir, safeSegment(workspaceSlug), '_records', `${safeSegment(sentinelId)}.json`);
}

async function writeManifest(manifestPath, record) {
  await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
  await fsp.writeFile(manifestPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

function sentinelContext(options = {}) {
  const context = options.codeSiteContext || options.codesiteContext || {};
  return {
    ...context,
    active: Boolean(context.active ?? options.active ?? context.transactionId),
    workspaceSlug: context.workspaceSlug || options.workspaceSlug || options.workspace_slug || null,
    transactionId: context.transactionId || context.transaction_id || options.transactionId || options.transaction_id || null,
    mutationLeaseId: context.mutationLeaseId || context.mutation_lease_id || options.mutationLeaseId || options.mutation_lease_id || null,
    agentSessionId: context.agentSessionId || context.agent_session_id || options.agentSessionId || options.agent_session_id || null,
    actorUserId: context.actorUserId || context.actor_user_id || options.actorUserId || options.actor_user_id || null,
    effectiveUserId: context.effectiveUserId || context.effective_user_id || options.effectiveUserId || options.effective_user_id || null,
    displayCallsign: context.displayCallsign || context.display_callsign || options.displayCallsign || options.display_callsign || null,
    controlPlaneUrl: context.controlPlaneUrl || context.control_plane_url || options.controlPlaneUrl || options.control_plane_url || null,
    controlPlaneTrusted: Boolean(context.controlPlaneTrusted || context.control_plane_trusted || options.controlPlaneTrusted),
    authToken: context.authToken || context.auth_token || options.authToken || options.auth_token || null,
    cookie: context.cookie || options.cookie || null,
    processAncestry: [
      ...new Set([
        ...asArray(context.processAncestry || context.process_ancestry),
        'host-filesystem',
        'codesite-host-write-sentinel',
      ]),
    ],
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

class CodeSiteHostWriteSentinel {
  constructor(options = {}) {
    if (!options.repoRoot) {
      throw new Error('codesite_host_sentinel_repo_root_required');
    }
    this.repoRoot = path.resolve(options.repoRoot);
    this.context = sentinelContext(options);
    this.workspaceSlug = this.context.workspaceSlug || options.workspaceSlug || 'workspace';
    this.baseDir = path.resolve(options.baseDir || process.env.SYNTHI_CODESITE_HOST_SENTINEL_DIR || DEFAULT_SENTINEL_BASE_DIR);
    this.sentinelId = options.sentinelId || [
      'host-sentinel',
      safeSegment(this.workspaceSlug),
      safeSegment(this.context.transactionId || 'no-transaction'),
      Date.now().toString(36),
      crypto.randomBytes(4).toString('hex'),
    ].join('-');
    this.baselineDir = path.join(this.baseDir, safeSegment(this.workspaceSlug), '_baselines', safeSegment(this.sentinelId));
    this.manifestPath = options.manifestPath || manifestPathFor(this.baseDir, this.workspaceSlug, this.sentinelId);
    this.fetch = options.fetch || global.fetch;
    this.scanIntervalMs = Math.max(100, Number(options.scanIntervalMs || DEFAULT_SCAN_INTERVAL_MS));
    this.interval = null;
    this.started = false;
    this.scanning = false;
    this.baseline = null;
    this.records = [];
    this.prewriteGuardRequested = Boolean(
      options.prewriteGuard ||
      options.enablePrewriteGuard ||
      options.enforcePrewriteBoundary ||
      booleanEnv(process.env.SYNTHI_CODESITE_HOST_PREWRITE_GUARD),
    );
    this.prewriteGuardIgnoreNames = asArray(options.prewriteGuardIgnoreNames);
    this.prewriteBoundary = null;
  }

  async start(options = {}) {
    await this.refreshBaseline({ reason: options.reason || 'sentinel_start' });
    if (this.prewriteGuardRequested || options.prewriteGuard) {
      await this.armPrewriteGuard({ reason: options.reason || 'sentinel_start' });
    }
    this.started = true;
    if (options.watch !== false) {
      this.interval = setInterval(() => {
        this.scanNow({ reason: 'interval' }).catch(() => {});
      }, this.scanIntervalMs);
      if (typeof this.interval.unref === 'function') this.interval.unref();
    }
    return this.status();
  }

  async stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.started = false;
    if (this.prewriteBoundary?.active) {
      this.prewriteBoundary = await restoreReadOnlyPrewriteGuard(this.prewriteBoundary);
      await this.persistManifest({
        status: this.records.length ? 'quarantined' : 'stopped',
        reason: 'sentinel_stop',
      });
    }
    return this.status();
  }

  async armPrewriteGuard(options = {}) {
    if (this.prewriteBoundary?.active) return this.prewriteBoundary;
    this.prewriteBoundary = await applyReadOnlyPrewriteGuard(this.repoRoot, {
      ignoreNames: this.prewriteGuardIgnoreNames,
    });
    this.prewriteBoundary.reason = options.reason || 'prewrite_guard_armed';
    await this.persistManifest({
      status: this.started ? 'active' : 'prewrite_guard_armed',
      reason: this.prewriteBoundary.reason,
    });
    return this.prewriteBoundary;
  }

  async disarmPrewriteGuard(options = {}) {
    if (!this.prewriteBoundary?.active) return this.prewriteBoundary;
    this.prewriteBoundary = {
      ...(await restoreReadOnlyPrewriteGuard(this.prewriteBoundary)),
      reason: options.reason || 'prewrite_guard_disarmed',
    };
    await this.persistManifest({
      status: this.records.length ? 'quarantined' : 'active',
      reason: this.prewriteBoundary.reason,
    });
    return this.prewriteBoundary;
  }

  async refreshBaseline(options = {}) {
    const snapshot = await snapshotTree(this.repoRoot);
    this.baseline = await captureRestorableBaseline(this.repoRoot, snapshot, this.baselineDir);
    await this.persistManifest({
      status: this.started ? 'active' : 'baseline_captured',
      reason: options.reason || 'baseline_refresh',
    });
    return cloneSnapshot(this.baseline);
  }

  async scanNow(options = {}) {
    if (!this.baseline) {
      await this.refreshBaseline({ reason: 'scan_without_baseline' });
      return { ok: true, quarantined: [], manifestPath: this.manifestPath };
    }
    if (this.scanning) {
      return { ok: true, skipped: true, reason: 'scan_already_running', manifestPath: this.manifestPath };
    }
    this.scanning = true;
    try {
      const current = await snapshotTree(this.repoRoot);
      const changes = diffSnapshots(this.baseline, current);
      const quarantined = [];
      const shouldRearm = changes.length > 0 && this.prewriteBoundary?.active;
      if (shouldRearm) {
        await this.disarmPrewriteGuard({ reason: 'restore_detected_host_mutation' });
      }
      try {
        for (const change of changes) {
          const record = await this.quarantineChange(change, current, options);
          quarantined.push(record);
        }
      } finally {
        if (shouldRearm) {
          await this.armPrewriteGuard({ reason: 'post_restore_prewrite_guard_rearmed' });
        }
      }
      if (quarantined.length) {
        await this.persistManifest({ status: 'quarantined', reason: options.reason || 'host_direct_write_detected' });
      }
      return {
        ok: quarantined.every((record) => record.restored),
        quarantined,
        manifestPath: this.manifestPath,
      };
    } finally {
      this.scanning = false;
    }
  }

  async quarantineChange(change, currentSnapshot, options = {}) {
    const beforeEntry = this.baseline.get(change.path);
    const afterEntry = currentSnapshot.get(change.path);
    const evidence = buildQuarantineChangeEvidence(change, beforeEntry, afterEntry);
    const restore = await restoreBaselineEntry(this.repoRoot, change.path, beforeEntry || null);
    const event = buildEvent(
      this.context,
      {
        kind: 'host_direct_write',
        tool: 'host_fs_sentinel',
        evidenceRefs: [evidence.evidenceRef],
        processAncestry: this.context.processAncestry,
      },
      change.path,
      'write_quarantined',
      [
        'host_direct_write_quarantined',
        restore.restored ? 'real_repo_restored' : 'real_repo_restore_incomplete',
      ],
      restore.restored
        ? 'Direct host filesystem mutation quarantined and the real repo was restored to the transaction baseline.'
        : 'Direct host filesystem mutation quarantined, but baseline content was unavailable for full restoration.',
    );
    const detectorProcessAncestry = event.details?.os_process_ancestry || collectCodeSiteProcessAncestry();
    event.details = {
      ...event.details,
      host_sentinel_id: this.sentinelId,
      operation: 'host_direct_write',
      quarantine_evidence: evidence,
      restore_action: restore.action,
      restored: restore.restored,
      detection_reason: options.reason || 'host_direct_write_detected',
      host_mutation_provenance: {
        detection_mode: this.prewriteBoundary
          ? 'prewrite_posix_readonly_guard_with_snapshot_audit'
          : 'post_write_polling_snapshot',
        detector: 'codesite-host-write-sentinel',
        detector_process_ancestry: detectorProcessAncestry,
        prewrite_boundary: this.prewriteBoundary
          ? {
            schemaVersion: this.prewriteBoundary.schemaVersion,
            mode: this.prewriteBoundary.mode,
            active: Boolean(this.prewriteBoundary.active),
            enforcedBeforeMutation: Boolean(this.prewriteBoundary.enforcedBeforeMutation),
            verification: this.prewriteBoundary.verification || null,
            guardedPathCount: this.prewriteBoundary.guardedPathCount || 0,
          }
          : null,
        writer_process_attribution: {
          available: false,
          reason: this.prewriteBoundary
            ? 'prewrite_guard_denies_real_tree_mutation_before_snapshot_audit; writer_identity_requires_kernel_actor_binding'
            : 'completed_host_write_has_no_procfs_actor_binding_without_kernel_write_hook',
          required_boundary: this.prewriteBoundary
            ? 'satisfied_by_posix_readonly_tree_or_docker_overlay_runtime_for_managed_agents'
            : 'fanotify_ebpf_fuse_overlay_or_equivalent_prewrite_gate',
        },
        before_stat: evidence.beforeStat || null,
        after_stat: evidence.afterStat || null,
      },
    };
    const result = {
      path: change.path,
      tool: 'host_fs_sentinel',
      restored: restore.restored,
      restoreAction: restore.action,
      change,
      quarantineEvidence: evidence,
      event,
    };
    try {
      result.controlPlane = await recordCodeSiteWriteAttempt(this.context, result, {
        fetch: this.fetch,
        acceptDenied: true,
      });
    } catch (error) {
      result.controlPlaneError = error?.message || 'codesite_control_plane_record_failed';
    }
    this.records.push(result);
    return result;
  }

  async persistManifest(extra = {}) {
    const osProcessAncestry = collectCodeSiteProcessAncestry();
    const record = {
      schemaVersion: 1,
      kind: 'codesite_host_write_sentinel',
      sentinelId: this.sentinelId,
      workspaceSlug: this.workspaceSlug,
      transactionId: this.context.transactionId || null,
      mutationLeaseId: this.context.mutationLeaseId || null,
      agentSessionId: this.context.agentSessionId || null,
      processAncestry: unique([
        ...asArray(this.context.processAncestry),
        ...asArray(osProcessAncestry.labels),
      ]),
      osProcessAncestry,
      prewriteBoundary: this.prewriteBoundary
        ? {
          schemaVersion: this.prewriteBoundary.schemaVersion,
          mode: this.prewriteBoundary.mode,
          active: Boolean(this.prewriteBoundary.active),
          enforcedBeforeMutation: Boolean(this.prewriteBoundary.enforcedBeforeMutation),
          verification: this.prewriteBoundary.verification || null,
          guardedPathCount: this.prewriteBoundary.guardedPathCount || 0,
          guardedPathsSample: this.prewriteBoundary.guardedPathsSample || [],
          armedAt: this.prewriteBoundary.armedAt || null,
          restoredAt: this.prewriteBoundary.restoredAt || null,
          restoreErrors: this.prewriteBoundary.restoreErrors || [],
          reason: this.prewriteBoundary.reason || null,
        }
        : null,
      repoRoot: this.repoRoot,
      baselineDir: this.baselineDir,
      manifestPath: this.manifestPath,
      status: extra.status || 'active',
      reason: extra.reason || null,
      started: this.started,
      updatedAt: new Date().toISOString(),
      quarantined: this.records.map((recordItem) => ({
        path: recordItem.path,
        restored: recordItem.restored,
        restoreAction: recordItem.restoreAction,
        change: recordItem.change,
        evidenceRef: recordItem.quarantineEvidence?.evidenceRef || null,
        osProcessAncestry: recordItem.event?.details?.os_process_ancestry || null,
        hostMutationProvenance: recordItem.event?.details?.host_mutation_provenance || null,
        controlPlaneError: recordItem.controlPlaneError || null,
      })),
    };
    await writeManifest(this.manifestPath, record);
    return record;
  }

  status() {
    const osProcessAncestry = collectCodeSiteProcessAncestry();
    return {
      started: this.started,
      sentinelId: this.sentinelId,
      workspaceSlug: this.workspaceSlug,
      transactionId: this.context.transactionId || null,
      repoRoot: this.repoRoot,
      manifestPath: this.manifestPath,
      baselineDir: this.baselineDir,
      quarantinedCount: this.records.length,
      prewriteBoundary: this.prewriteBoundary
        ? {
          schemaVersion: this.prewriteBoundary.schemaVersion,
          mode: this.prewriteBoundary.mode,
          active: Boolean(this.prewriteBoundary.active),
          enforcedBeforeMutation: Boolean(this.prewriteBoundary.enforcedBeforeMutation),
          verification: this.prewriteBoundary.verification || null,
          guardedPathCount: this.prewriteBoundary.guardedPathCount || 0,
        }
        : null,
      processAncestry: unique([
        ...asArray(this.context.processAncestry),
        ...asArray(osProcessAncestry.labels),
      ]),
      osProcessAncestry,
    };
  }
}

function createCodeSiteHostWriteSentinel(options = {}) {
  return new CodeSiteHostWriteSentinel(options);
}

module.exports = {
  CodeSiteHostWriteSentinel,
  createCodeSiteHostWriteSentinel,
};
