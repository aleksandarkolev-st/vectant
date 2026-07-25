import { asArray, compact, uniqueValues } from "./format";

export function hasEntries(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length,
  );
}

export function quarantinePath(change = {}) {
  return compact(change.path || change.quarantineEvidence?.path, "");
}

export function quarantineDigest(change = {}, key) {
  const evidence = change.quarantineEvidence || {};
  return compact(
    change[key] ||
      evidence[key] ||
      evidence[key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)],
    "",
  );
}

export function quarantineEvidenceRef(change = {}) {
  const evidence = change.quarantineEvidence || {};
  return compact(
    change.evidenceRef ||
      evidence.evidenceRef ||
      asArray(change.evidenceRefs || evidence.evidenceRefs)[0],
    "",
  );
}

export function selectedPathKey(paths) {
  return asArray(paths).map(String).sort().join("\n");
}

export function quarantineAppliedPaths(record = {}, reviewState = {}) {
  return uniqueValues([
    ...asArray(record.appliedPaths),
    ...asArray(record.applied).map((item) => item.path),
    ...asArray(reviewState.apply?.applied).map((item) => item.path),
  ]);
}

export function quarantineRemainingPaths(record = {}, reviewState = {}) {
  const paths = uniqueValues([
    ...asArray(record.paths),
    ...asArray(record.changes).map(quarantinePath),
  ]);
  const applied = new Set(quarantineAppliedPaths(record, reviewState));
  return paths.filter((item) => !applied.has(item));
}

export function quarantineDisplayStatus(record = {}, reviewState = {}) {
  const appliedPaths = quarantineAppliedPaths(record, reviewState);
  if (appliedPaths.length > 0) {
    return quarantineRemainingPaths(record, reviewState).length > 0
      ? "partially_applied"
      : "applied";
  }
  if (reviewState.replay?.ok === true) return "replayed";
  return record.status || "reviewable";
}

export function quarantineEventId(event = {}) {
  const details = event.details || {};
  const codesiteFsEvent =
    details.codesiteFsEvent || details.codesite_fs_event || {};
  const fsDetails = codesiteFsEvent.details || {};
  const evidence =
    details.quarantineEvidence ||
    details.quarantine_evidence ||
    fsDetails.quarantineEvidence ||
    fsDetails.quarantine_evidence ||
    {};
  return String(
    details.quarantineId ||
      details.quarantine_id ||
      fsDetails.quarantineId ||
      fsDetails.quarantine_id ||
      evidence.quarantineId ||
      evidence.quarantine_id ||
      event.actorId ||
      evidence.evidenceRef ||
      event.id ||
      "unknown-quarantine",
  );
}

export function quarantineRecordsFromEvents(events) {
  const records = new globalThis.Map();
  for (const event of asArray(events)) {
    if (
      ![
        "write_quarantined",
        "quarantine_reviewed",
        "quarantine_replayed",
        "quarantine_applied",
      ].includes(event?.eventType)
    )
      continue;
    const details = event.details || {};
    const codesiteFsEvent =
      details.codesiteFsEvent || details.codesite_fs_event || {};
    const fsDetails = codesiteFsEvent.details || {};
    const evidence =
      details.quarantineEvidence ||
      details.quarantine_evidence ||
      fsDetails.quarantineEvidence ||
      fsDetails.quarantine_evidence ||
      {};
    const id = quarantineEventId(event);
    const record = records.get(id) || {
      quarantineId: id,
      status: "reviewable",
      transactionId:
        details.transactionId ||
        details.transaction_id ||
        codesiteFsEvent.transaction_id ||
        null,
      mutationLeaseId:
        event.mutationLeaseId ||
        details.mutationLeaseId ||
        details.mutation_lease_id ||
        null,
      displayCallsign: event.displayCallsign || null,
      paths: [],
      changes: [],
      rejected: [],
      latestReplayAttempt: null,
      replayAttempts: [],
      successfulReplay: null,
      evidenceRefs: [],
      eventRefs: [],
      lifecycle: {
        capturedAt: null,
        reviewedAt: null,
        replayedAt: null,
        appliedAt: null,
      },
      symlinkSanitization:
        fsDetails.symlinkSanitization ||
        fsDetails.symlink_sanitization ||
        details.symlinkSanitization ||
        details.symlink_sanitization ||
        null,
      updatedAt: event.createdAt || null,
    };
    record.eventRefs = uniqueValues([...record.eventRefs, event.id]);
    record.evidenceRefs = uniqueValues([
      ...record.evidenceRefs,
      ...asArray(event.evidenceRefs),
      ...asArray(details.evidenceRefs || details.evidence_refs),
      evidence.evidenceRef,
      ...asArray(evidence.evidenceRefs || evidence.evidence_refs),
    ]);
    record.paths = uniqueValues([
      ...record.paths,
      details.path,
      codesiteFsEvent.path,
      evidence.path,
      ...asArray(
        details.paths || details.changedPaths || details.changed_paths,
      ),
    ]);
    if (event.eventType === "write_quarantined") {
      record.lifecycle.capturedAt =
        record.lifecycle.capturedAt || event.createdAt || null;
      const change = {
        path: evidence.path || details.path || codesiteFsEvent.path,
        kind:
          evidence.kind ||
          details.changeKind ||
          details.change_kind ||
          "modified",
        beforeDigest: evidence.beforeDigest || evidence.before_digest,
        afterDigest: evidence.afterDigest || evidence.after_digest,
        evidenceRef: evidence.evidenceRef,
        quarantineEvidence: evidence,
      };
      if (
        change.path &&
        !record.changes.some(
          (item) =>
            quarantinePath(item) === change.path &&
            quarantineEvidenceRef(item) === quarantineEvidenceRef(change),
        )
      ) {
        record.changes.push(change);
      }
    }
    if (event.eventType === "quarantine_reviewed") {
      record.status = record.status === "applied" ? record.status : "reviewed";
      record.lifecycle.reviewedAt =
        record.lifecycle.reviewedAt || event.createdAt || null;
    }
    if (event.eventType === "quarantine_replayed") {
      const attempt = quarantineReplayAttemptFromEvent(event, details);
      record.latestReplayAttempt = attempt;
      record.replayAttempts = appendUniqueObjects(record.replayAttempts, [
        attempt,
      ]);
      record.rejected = [...record.rejected, ...asArray(details.rejected)];
      if (isSuccessfulQuarantineReplay(attempt)) {
        record.status =
          record.status === "applied" ? record.status : "replayed";
        if (isReplayAttemptBeforeApply(attempt, record.lifecycle)) {
          record.lifecycle.replayedAt =
            attempt.attemptedAt || record.lifecycle.replayedAt || null;
          record.successfulReplay = attempt;
        } else if (!record.successfulReplay) {
          record.successfulReplay = attempt;
        }
      } else if (record.status !== "applied" && record.status !== "replayed") {
        record.status = "blocked";
      }
    }
    if (event.eventType === "quarantine_applied") {
      record.status = "applied";
      record.lifecycle.appliedAt =
        event.createdAt || record.lifecycle.appliedAt;
      record.applied = asArray(details.applied);
    }
    records.set(id, record);
  }
  return [...records.values()];
}

export function normalizeQuarantineRecord(record = {}) {
  const changes = asArray(record.changes);
  const paths = uniqueValues([
    ...asArray(record.paths),
    ...changes.map(quarantinePath),
  ]);
  return {
    ...record,
    quarantineId: compact(
      record.quarantineId || record.id,
      "unknown-quarantine",
    ),
    status: compact(record.status, changes.length ? "reviewable" : "pending"),
    paths,
    changes,
    rejected: asArray(record.rejected),
    applied: asArray(record.applied),
    latestReplayAttempt: record.latestReplayAttempt || null,
    replayAttempts: asArray(record.replayAttempts),
    successfulReplay: record.successfulReplay || record.replay || null,
    appliedPaths: uniqueValues([
      ...asArray(record.appliedPaths),
      ...asArray(record.applied).map((item) => item.path),
    ]),
    remainingPaths: asArray(record.remainingPaths),
    evidenceRefs: uniqueValues(record.evidenceRefs),
    eventRefs: uniqueValues(record.eventRefs),
    lifecycle: record.lifecycle || {
      capturedAt: record.createdAt || null,
      reviewedAt: null,
      replayedAt: null,
      appliedAt: null,
    },
    symlinkSanitization:
      record.symlinkSanitization || record.symlink_sanitization || null,
  };
}

export function mergeQuarantineRecords(...groups) {
  const merged = new globalThis.Map();
  for (const raw of groups.flatMap((group) => asArray(group))) {
    const record = normalizeQuarantineRecord(raw);
    const previous = merged.get(record.quarantineId);
    if (!previous) {
      merged.set(record.quarantineId, record);
      continue;
    }
    merged.set(record.quarantineId, {
      ...previous,
      ...record,
      changes: [...previous.changes, ...record.changes].filter(
        (change, index, allChanges) => {
          const key = `${quarantinePath(change)}:${quarantineEvidenceRef(change)}`;
          return (
            index ===
            allChanges.findIndex(
              (candidate) =>
                `${quarantinePath(candidate)}:${quarantineEvidenceRef(candidate)}` ===
                key,
            )
          );
        },
      ),
      paths: uniqueValues([...previous.paths, ...record.paths]),
      rejected: [...asArray(previous.rejected), ...asArray(record.rejected)],
      applied: [
        ...asArray(previous.applied),
        ...asArray(record.applied),
      ].filter((item, index, allItems) => {
        const key = `${item?.path || ""}:${item?.evidenceRef || ""}`;
        return (
          index ===
          allItems.findIndex(
            (candidate) =>
              `${candidate?.path || ""}:${candidate?.evidenceRef || ""}` ===
              key,
          )
        );
      }),
      appliedPaths: uniqueValues([
        ...asArray(previous.appliedPaths),
        ...asArray(record.appliedPaths),
      ]),
      remainingPaths: record.remainingPaths?.length
        ? record.remainingPaths
        : previous.remainingPaths,
      latestReplayAttempt:
        record.latestReplayAttempt || previous.latestReplayAttempt || null,
      replayAttempts: appendUniqueObjects(
        previous.replayAttempts,
        record.replayAttempts,
      ),
      successfulReplay:
        previous.successfulReplay || record.successfulReplay || null,
      evidenceRefs: uniqueValues([
        ...previous.evidenceRefs,
        ...record.evidenceRefs,
      ]),
      eventRefs: uniqueValues([...previous.eventRefs, ...record.eventRefs]),
      lifecycle: mergeLifecycle(previous.lifecycle, record.lifecycle),
      symlinkSanitization:
        record.symlinkSanitization || previous.symlinkSanitization,
    });
  }
  return [...merged.values()].sort((left, right) =>
    String(
      right.updatedAt || right.finalizedAt || right.createdAt || "",
    ).localeCompare(
      String(left.updatedAt || left.finalizedAt || left.createdAt || ""),
    ),
  );
}

export function quarantineReplayAttemptFromEvent(event, details = {}) {
  return {
    attemptedAt: event.createdAt || null,
    selectedChangeCount: details.selectedChangeCount ?? null,
    replayableChangeCount: details.replayableChangeCount ?? null,
    rejectedChangeCount: details.rejectedChangeCount ?? null,
    paths: asArray(
      details.paths || details.selectedPaths || details.selected_paths,
    ),
    replayablePaths: asArray(
      details.replay || details.replayable || details.prepared,
    )
      .map((item) => item.path)
      .filter(Boolean),
    rejectedPaths: asArray(details.rejected)
      .map((item) => item.path)
      .filter(Boolean),
  };
}

export function isSuccessfulQuarantineReplay(attempt = {}) {
  return (
    Number(attempt.replayableChangeCount || 0) > 0 &&
    Number(attempt.rejectedChangeCount || 0) === 0
  );
}

export function isReplayAttemptBeforeApply(attempt = {}, lifecycle = {}) {
  if (!lifecycle.appliedAt) return true;
  const attemptedAt = Date.parse(attempt.attemptedAt || "");
  const appliedAt = Date.parse(lifecycle.appliedAt);
  if (Number.isNaN(attemptedAt) || Number.isNaN(appliedAt)) return false;
  return attemptedAt <= appliedAt;
}

export function appendUniqueObjects(current, values) {
  const next = [...asArray(current)];
  const seen = new Set(next.map((item) => JSON.stringify(item)));
  for (const value of asArray(values)) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(value);
  }
  return next;
}

export function mergeLifecycle(previous = {}, next = {}) {
  return {
    capturedAt: previous.capturedAt || next.capturedAt || null,
    reviewedAt: previous.reviewedAt || next.reviewedAt || null,
    replayedAt: previous.replayedAt || next.replayedAt || null,
    appliedAt: previous.appliedAt || next.appliedAt || null,
  };
}

export function quarantineReviewMessage(reviewState = {}) {
  if (reviewState.status === "replaying")
    return "Replaying selected paths against the current workspace.";
  if (reviewState.status === "applying")
    return "Applying replayed paths through the active transaction.";
  const rejected = asArray(
    reviewState.replay?.rejected || reviewState.apply?.rejected,
  );
  if (rejected.length) {
    const paths =
      uniqueValues(rejected.map((item) => item.path)).join(", ") ||
      "selected paths";
    const reasons =
      uniqueValues(
        rejected.flatMap(
          (item) => item.reasonCodes || item.reason_codes || item.error,
        ),
      ).join(", ") || "replay rejected";
    return `Replay blocked for ${paths}: ${reasons}. Refresh the workspace, inspect the changed base, then replay again before applying.`;
  }
  return reviewState.error || "";
}
