'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  buildEvent,
  buildQuarantineChangeEvidence,
  diffSnapshots,
  normalizeRepoRelativePath,
  recordCodeSiteWriteAttempt,
  snapshotTree,
} = require('./codesiteFs');

const DEFAULT_SENTINEL_BASE_DIR = path.join(os.tmpdir(), 'synthi-codesite-host-sentinel');
const DEFAULT_SCAN_INTERVAL_MS = 1_000;

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
  }

  async start(options = {}) {
    await this.refreshBaseline({ reason: options.reason || 'sentinel_start' });
    this.started = true;
    if (options.watch !== false) {
      this.interval = setInterval(() => {
        this.scanNow({ reason: 'interval' }).catch(() => {});
      }, this.scanIntervalMs);
      if (typeof this.interval.unref === 'function') this.interval.unref();
    }
    return this.status();
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.started = false;
    return this.status();
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
      for (const change of changes) {
        const record = await this.quarantineChange(change, current, options);
        quarantined.push(record);
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
    event.details = {
      ...event.details,
      host_sentinel_id: this.sentinelId,
      operation: 'host_direct_write',
      quarantine_evidence: evidence,
      restore_action: restore.action,
      restored: restore.restored,
      detection_reason: options.reason || 'host_direct_write_detected',
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
    const record = {
      schemaVersion: 1,
      kind: 'codesite_host_write_sentinel',
      sentinelId: this.sentinelId,
      workspaceSlug: this.workspaceSlug,
      transactionId: this.context.transactionId || null,
      mutationLeaseId: this.context.mutationLeaseId || null,
      agentSessionId: this.context.agentSessionId || null,
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
        controlPlaneError: recordItem.controlPlaneError || null,
      })),
    };
    await writeManifest(this.manifestPath, record);
    return record;
  }

  status() {
    return {
      started: this.started,
      sentinelId: this.sentinelId,
      workspaceSlug: this.workspaceSlug,
      transactionId: this.context.transactionId || null,
      repoRoot: this.repoRoot,
      manifestPath: this.manifestPath,
      baselineDir: this.baselineDir,
      quarantinedCount: this.records.length,
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
