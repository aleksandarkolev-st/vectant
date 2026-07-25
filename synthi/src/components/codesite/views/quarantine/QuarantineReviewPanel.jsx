import { EmptyLine, IconButton, PathList, Pill } from "../../ui";
import { CheckCircle2 } from "lucide-react";
import { asArray, compact, countBy, formatTime, uniqueValues } from "../../lib/format";
import { quarantineDigest, quarantineDisplayStatus, quarantineEvidenceRef, quarantinePath, quarantineRemainingPaths, quarantineReviewMessage, selectedPathKey } from "../../lib/quarantine";
import { CodeSiteIcons } from "../../icons";

export default function QuarantineReviewPanel({
  records,
  fetchError,
  selectedId,
  selectedPaths,
  reviewState,
  onSelect,
  onTogglePath,
  onReplay,
  onApply,
  disabled,
}) {
  const rows = asArray(records);
  const selected =
    rows.find((record) => record.quarantineId === selectedId) ||
    rows[0] ||
    null;
  const changes = asArray(selected?.changes);
  const replayOk =
    reviewState.replay?.ok === true &&
    reviewState.replayPathKey === selectedPathKey(selectedPaths);
  const selectedSet = new Set(selectedPaths);
  const reviewMessage = quarantineReviewMessage(reviewState);
  const selectedStatus = selected
    ? quarantineDisplayStatus(selected, reviewState)
    : "reviewable";
  const selectedRemainingPaths = selected
    ? quarantineRemainingPaths(selected, reviewState)
    : [];
  const selectedLifecycle = selected
    ? {
        ...(selected.lifecycle || {}),
        reviewedAt:
          reviewState.replay?.timelineEvents?.reviewed?.createdAt ||
          selected.lifecycle?.reviewedAt,
        replayedAt:
          reviewState.replay?.ok === true
            ? reviewState.replay?.timelineEvents?.replayed?.createdAt ||
              selected.lifecycle?.replayedAt
            : selected.lifecycle?.replayedAt,
        appliedAt:
          reviewState.apply?.timelineEvent?.createdAt ||
          reviewState.apply?.timelineEvents?.applied?.createdAt ||
          selected.lifecycle?.appliedAt,
      }
    : {};
  const totalQueuedPaths = rows.reduce(
    (total, record) =>
      total +
      Math.max(asArray(record.changes).length, asArray(record.paths).length),
    0,
  );
  const queueStatusCounts = Object.entries(
    countBy(
      rows.map((record) =>
        quarantineDisplayStatus(
          record,
          record.quarantineId === selected?.quarantineId
            ? reviewState
            : undefined,
        ),
      ),
    ),
  );
  const queueCallsigns = uniqueValues(
    rows.map((record) => compact(record.displayCallsign, "codesitefs")),
  );
  const quarantineRailStats = [
    ["Manifests", rows.length],
    ["Paths", totalQueuedPaths],
    ["Selected", selectedPaths.length],
    ["Remaining", selectedRemainingPaths.length],
  ];
  const selectedChangeKinds = Object.entries(
    countBy(
      (changes.length
        ? changes
        : asArray(selected?.paths).map((path) => ({ path }))
      ).map((change) => compact(change.kind || change.change_kind, "modified")),
    ),
  );
  const selectedTraceSteps = [
    ["Captured", selectedLifecycle.capturedAt],
    ["Reviewed", selectedLifecycle.reviewedAt],
    ["Replayed", selectedLifecycle.replayedAt],
    ["Applied", selectedLifecycle.appliedAt],
  ];
  const selectedTracePaths = selectedRemainingPaths.length
    ? selectedRemainingPaths
    : selectedPaths;

  if (!rows.length) {
    return fetchError ? (
      <div
        data-testid="codesite-quarantine-fetch-error"
        className="rounded border px-3 py-2 text-xs"
        style={{
          borderColor: "color-mix(in srgb, var(--accent-danger) 40%, var(--border-subtle))",
          background: "var(--bg-surface)",
        }}
      >
        Quarantine manifests unavailable:{" "}
        {compact(fetchError.message, "fetch failed")}
      </div>
    ) : (
      <EmptyLine>No CodeSiteFS quarantines waiting for review</EmptyLine>
    );
  }

  return (
    <div
      data-testid="codesite-quarantine-review"
      className="grid min-w-0 gap-3 xl:grid-cols-[minmax(220px,0.78fr)_minmax(0,1.22fr)]"
    >
      <div className="grid min-w-0 gap-2 xl:min-h-full xl:grid-rows-[auto_auto_auto_minmax(180px,1fr)]">
        <div
          className="min-w-0 overflow-hidden rounded border"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          {rows.map((record) => {
            const active = selected?.quarantineId === record.quarantineId;
            const displayStatus = active
              ? quarantineDisplayStatus(record, reviewState)
              : quarantineDisplayStatus(record);
            return (
              <button
                key={record.quarantineId}
                type="button"
                data-testid="codesite-quarantine-row"
                aria-pressed={active}
                onClick={() => onSelect(record)}
                className="block w-full border-t px-3 py-2 text-left text-xs first:border-t-0"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: active
                    ? "color-mix(in srgb, var(--accent-primary) 12%, var(--bg-surface))"
                    : "var(--bg-surface)",
                  color: "var(--text-primary)",
                }}
              >
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <code
                    className="min-w-0 truncate text-[10px]"
                    title={record.quarantineId}
                  >
                    {record.quarantineId}
                  </code>
                  <Pill tone={displayStatus}>{displayStatus}</Pill>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Pill>{compact(record.displayCallsign, "codesitefs")}</Pill>
                  <Pill>
                    {asArray(record.changes).length ||
                      asArray(record.paths).length}{" "}
                    paths
                  </Pill>
                </div>
                <div className="mt-1">
                  <PathList
                    paths={record.paths}
                    empty="no paths"
                    maxVisible={2}
                  />
                </div>
              </button>
            );
          })}
        </div>

        <div
          className="rounded border px-3 py-2 text-xs"
          style={{
            borderColor:
              "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
            background:
              "linear-gradient(180deg, var(--bg-surface), color-mix(in srgb, var(--bg-surface) 86%, var(--bg-editor) 14%))",
          }}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="font-semibold">Review queue</span>
            <Pill tone={selectedRemainingPaths.length ? "holding" : "active"}>
              {selectedRemainingPaths.length ? "actionable" : "clear"}
            </Pill>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {quarantineRailStats.map(([label, value]) => (
              <div
                key={label}
                className="rounded-md border px-2 py-1"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-editor)",
                }}
              >
                <div
                  className="text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {label}
                </div>
                <div className="font-mono text-sm font-semibold">{value}</div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {queueStatusCounts.map(([status, count]) => (
              <Pill key={status} tone={status}>
                {status} {count}
              </Pill>
            ))}
          </div>
        </div>

        <div
          className="rounded border px-3 py-2 text-xs"
          style={{
            borderColor: "var(--border-subtle)",
            background: "var(--bg-surface)",
          }}
        >
          <div className="font-semibold">Runtime boundary</div>
          <div
            className="mt-1 leading-5"
            style={{ color: "var(--text-muted)" }}
          >
            Raw writes stay outside the source tree until replay validates the
            selected manifest paths.
          </div>
          <div className="mt-2">
            <PathList
              paths={queueCallsigns}
              empty="no active filesystem actors"
              maxVisible={4}
            />
          </div>
        </div>

        <div
          data-testid="codesite-quarantine-rail-trace"
          className="flex min-h-44 flex-col rounded border px-3 py-2 text-xs"
          style={{
            borderColor:
              "color-mix(in srgb, var(--border-subtle) 78%, var(--accent-primary) 22%)",
            background:
              "radial-gradient(circle at 20% 0%, color-mix(in srgb, var(--accent-primary) 12%, transparent), transparent 44%), var(--bg-surface)",
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold">Containment trace</span>
            <Pill tone={selectedStatus}>{selectedStatus}</Pill>
          </div>
          <div className="mt-2 grid gap-1.5">
            {selectedTraceSteps.map(([label, value], index) => (
              <div
                key={label}
                className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2"
              >
                <span
                  className="h-2.5 w-2.5 rounded-full border"
                  style={{
                    borderColor: value
                      ? "color-mix(in srgb, var(--accent-success) 72%, var(--border-subtle))"
                      : "var(--border-subtle)",
                    background: value
                      ? "color-mix(in srgb, var(--accent-success) 34%, transparent)"
                      : "var(--bg-editor)",
                    boxShadow:
                      value && index === selectedTraceSteps.length - 1
                        ? "0 0 0 4px color-mix(in srgb, var(--accent-success) 12%, transparent)"
                        : "none",
                  }}
                />
                <div className="min-w-0">
                  <div style={{ color: "var(--text-muted)" }}>{label}</div>
                  <div
                    className="truncate font-mono text-[10px]"
                    title={value || ""}
                  >
                    {formatTime(value) || "pending"}
                  </div>
                </div>
                <Pill tone={value ? "active" : "holding"}>
                  {value ? "logged" : "wait"}
                </Pill>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-1">
            {selectedChangeKinds.map(([kind, count]) => (
              <Pill key={kind}>
                {kind} {count}
              </Pill>
            ))}
          </div>
          <div className="mt-auto pt-3">
            <div
              className="mb-1 text-[10px] uppercase tracking-[0.14em]"
              style={{ color: "var(--text-muted)" }}
            >
              Review path scope
            </div>
            <PathList
              paths={selectedTracePaths}
              empty="no selected paths"
              maxVisible={3}
            />
          </div>
        </div>
      </div>

      <div
        data-testid="codesite-quarantine-detail"
        className="min-w-0 overflow-hidden rounded border p-3 text-xs"
        style={{
          borderColor: "var(--border-subtle)",
          background: "var(--bg-surface)",
        }}
      >
        {!selected ? (
          <EmptyLine>Select a quarantine</EmptyLine>
        ) : (
          <div className="space-y-3">
            <div
              data-testid="codesite-quarantine-summary"
              className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <code
                    className="min-w-0 truncate text-[11px]"
                    title={selected.quarantineId}
                  >
                    {selected.quarantineId}
                  </code>
                  <Pill tone={selectedStatus}>{selectedStatus}</Pill>
                  <Pill>{selectedPaths.length} selected</Pill>
                  {selectedRemainingPaths.length ? (
                    <Pill tone="holding">
                      {selectedRemainingPaths.length} pending
                    </Pill>
                  ) : null}
                </div>
                <div className="mt-1 grid gap-1 text-[11px] sm:grid-cols-2">
                  <div className="min-w-0">
                    <span style={{ color: "var(--text-muted)" }}>
                      Transaction{" "}
                    </span>
                    <code className="truncate" title={selected.transactionId}>
                      {compact(selected.transactionId, "none")}
                    </code>
                  </div>
                  <div className="min-w-0">
                    <span style={{ color: "var(--text-muted)" }}>
                      Approval{" "}
                    </span>
                    <code className="truncate" title={selected.mutationLeaseId}>
                      {compact(selected.mutationLeaseId, "none")}
                    </code>
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-1 sm:justify-end">
                <IconButton
                  title="Replay selected quarantine paths"
                  onClick={() => onReplay(selected)}
                  disabled={
                    disabled ||
                    !selected.transactionId ||
                    selectedPaths.length === 0
                  }
                  testId="codesite-quarantine-replay-button"
                >
                  <CodeSiteIcons.replay className="h-3.5 w-3.5" />
                  Replay
                </IconButton>
                <IconButton
                  title="Apply replayed quarantine paths"
                  onClick={() => onApply(selected)}
                  disabled={disabled || !replayOk || selectedPaths.length === 0}
                  variant={replayOk ? "primary" : "neutral"}
                  testId="codesite-quarantine-apply-button"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Apply
                </IconButton>
              </div>
            </div>

            {reviewMessage ? (
              <div
                role="alert"
                aria-live="polite"
                className="rounded border px-2 py-1 text-[11px]"
                style={{
                  borderColor:
                    "color-mix(in srgb, var(--accent-danger) 40%, var(--border-subtle))",
                }}
              >
                {reviewMessage}
              </div>
            ) : null}

            <div className="space-y-1">
              {(changes.length
                ? changes
                : selected.paths.map((path) => ({ path }))
              ).map((change) => {
                const path = quarantinePath(change);
                const checked = selectedSet.has(path);
                return (
                  <button
                    key={`${selected.quarantineId}-${path}-${quarantineEvidenceRef(change)}`}
                    data-testid="codesite-quarantine-change-row"
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() => onTogglePath(path)}
                    className="grid min-h-12 cursor-pointer grid-cols-[22px_minmax(0,1fr)] gap-2 rounded-[var(--radius-control)] border px-2 py-1.5 text-left outline-none transition-[background,border-color] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--attention-purple)]"
                    style={{
                      borderColor: checked
                        ? "color-mix(in srgb, var(--accent-primary) 44%, var(--border-subtle))"
                        : "var(--border-subtle)",
                      background: checked
                        ? "color-mix(in srgb, var(--accent-primary) 10%, var(--bg-editor))"
                        : "var(--bg-editor)",
                    }}
                  >
                    <span
                      data-testid="codesite-quarantine-path-toggle"
                      className="mt-1 grid h-4 w-4 place-items-center rounded border"
                      style={{
                        borderColor: checked
                          ? "color-mix(in srgb, var(--accent-primary) 66%, var(--border-subtle))"
                          : "var(--border-medium)",
                        background: checked
                          ? "color-mix(in srgb, var(--accent-primary) 18%, var(--bg-elevated))"
                          : "color-mix(in srgb, var(--bg-panel) 70%, transparent)",
                      }}
                    >
                      {checked ? (
                        <CheckCircle2
                          aria-hidden="true"
                          className="h-3 w-3"
                          style={{ color: "var(--accent-primary)" }}
                        />
                      ) : null}
                    </span>
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-1">
                        <code
                          className="min-w-0 truncate text-[10px]"
                          title={path}
                        >
                          {path}
                        </code>
                        <Pill>
                          {compact(
                            change.kind || change.change_kind,
                            "modified",
                          )}
                        </Pill>
                      </div>
                      <div className="mt-1 grid gap-1 sm:grid-cols-2">
                        <PathList
                          paths={[
                            quarantineDigest(change, "beforeDigest"),
                            quarantineDigest(change, "expectedDigest"),
                          ].filter(Boolean)}
                          empty="no base digest"
                          maxVisible={2}
                        />
                        <PathList
                          paths={[
                            quarantineDigest(change, "afterDigest"),
                            quarantineEvidenceRef(change),
                          ].filter(Boolean)}
                          empty="no after digest"
                          maxVisible={2}
                        />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {asArray(selected.symlinkSanitization?.sanitized).length ? (
              <div
                data-testid="codesite-quarantine-symlink-guard"
                className="rounded border px-3 py-2"
                style={{
                  borderColor:
                    "color-mix(in srgb, var(--accent-warning) 36%, var(--border-subtle))",
                  background: "var(--bg-editor)",
                }}
              >
                <div className="mb-1 text-[11px] font-medium">
                  Symlink Escape Guard
                </div>
                {selected.symlinkSanitization.sanitized.map((item) => (
                  <div
                    key={`${item.path}-${item.resolvedTarget}`}
                    className="grid gap-1 border-t py-1 first:border-t-0 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto]"
                    style={{ borderColor: "var(--border-subtle)" }}
                  >
                    <code className="truncate text-[10px]" title={item.path}>
                      {item.path}
                    </code>
                    <code
                      className="truncate text-[10px]"
                      title={item.resolvedTarget || item.target}
                    >
                      {item.resolvedTarget || item.target}
                    </code>
                    <Pill tone="holding">
                      {compact(item.reason, "replaced")}
                    </Pill>
                  </div>
                ))}
              </div>
            ) : null}

            {reviewState.replay ? (
              <div
                data-testid="codesite-quarantine-replay-result"
                className="rounded border px-3 py-2"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-editor)",
                }}
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="font-medium">Replay result</span>
                  <Pill tone={reviewState.replay.ok ? "active" : "failed"}>
                    {reviewState.replay.ok ? "replayable" : "blocked"}
                  </Pill>
                </div>
                <PathList
                  paths={asArray(reviewState.replay.replay).map(
                    (item) => item.path,
                  )}
                  empty="no replayed paths"
                  maxVisible={8}
                />
                {asArray(reviewState.replay.rejected).length ? (
                  <div className="mt-2 space-y-1">
                    {reviewState.replay.rejected.map((item, index) => (
                      <div
                        key={`${item.path || "reject"}-${index}`}
                        data-testid="codesite-quarantine-rejected-row"
                        className="grid gap-2 rounded border px-2 py-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
                        style={{
                          borderColor:
                            "color-mix(in srgb, var(--accent-danger) 36%, var(--border-subtle))",
                        }}
                      >
                        <code
                          className="truncate text-[10px]"
                          title={item.path}
                        >
                          {compact(item.path, "path")}
                        </code>
                        <PathList
                          paths={
                            item.reasonCodes ||
                            item.reason_codes ||
                            [item.error].filter(Boolean)
                          }
                          empty="rejected"
                          maxVisible={4}
                        />
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {reviewState.apply ? (
              <div
                data-testid="codesite-quarantine-apply-result"
                className="rounded border px-3 py-2"
                style={{
                  borderColor:
                    "color-mix(in srgb, var(--accent-success) 36%, var(--border-subtle))",
                  background: "var(--bg-editor)",
                }}
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="font-medium">Apply result</span>
                  <Pill tone={reviewState.apply.ok ? "active" : "failed"}>
                    {reviewState.apply.ok ? "applied" : "blocked"}
                  </Pill>
                </div>
                <PathList
                  paths={asArray(reviewState.apply.applied).map(
                    (item) => item.path,
                  )}
                  empty="no applied paths"
                  maxVisible={8}
                />
              </div>
            ) : null}

            <div
              data-testid="codesite-quarantine-timeline"
              className="grid gap-1 text-[11px] sm:grid-cols-4"
            >
              {[
                ["Captured", selectedLifecycle.capturedAt],
                ["Reviewed", selectedLifecycle.reviewedAt],
                ["Replayed", selectedLifecycle.replayedAt],
                ["Applied", selectedLifecycle.appliedAt],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="rounded border px-2 py-1"
                  style={{
                    borderColor: "var(--border-subtle)",
                    background: "var(--bg-editor)",
                  }}
                >
                  <div style={{ color: "var(--text-muted)" }}>{label}</div>
                  <div
                    className="truncate font-mono text-[10px]"
                    title={value || ""}
                  >
                    {formatTime(value) || "pending"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
