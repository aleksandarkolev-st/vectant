import { EmptyLine, PathList, Pill } from "../../ui";
import { CheckCircle2 } from "lucide-react";
import { asArray, compact, formatTime, mergeTransactionSources, transactionDigestLabel, transactionEvents, transactionProofBundle, transactionReason, transactionTowerAction, uniqueValues } from "../../lib/format";

export default function SerializableIsolationDeck({
  activeTransactions,
  mutationTransactions,
  proofBundles,
  events,
}) {
  const transactions = mergeTransactionSources(
    activeTransactions,
    mutationTransactions,
  );
  const visibleTransactions = transactions.slice(0, 8);
  const hiddenTransactions = transactions.length - visibleTransactions.length;
  const recentBundles = asArray(proofBundles).slice(-3).reverse();

  if (!transactions.length && !recentBundles.length) {
    return <EmptyLine>No serializable transactions recorded</EmptyLine>;
  }

  return (
    <div data-testid="codesite-serializable-isolation" className="grid gap-3">
      <div
        className="grid gap-2 rounded-lg border px-3 py-2 text-xs @min-[28rem]/panel:grid-cols-[minmax(0,1fr)_auto]"
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 74%, var(--accent-primary) 26%)",
          background:
            "linear-gradient(180deg, var(--bg-surface), color-mix(in srgb, var(--bg-surface) 86%, var(--bg-editor) 14%))",
        }}
      >
        <div className="min-w-0">
          <div className="font-semibold">Serializable isolation report</div>
          <div
            className="mt-1 max-w-[76ch] leading-5"
            style={{ color: "var(--text-muted)" }}
          >
            Database-style mutation validation with base snapshot, declared
            reads, observed reads, writes, result, reason, and coordinator action.
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1 @min-[28rem]/panel:justify-end">
          <Pill>{transactions.length} txns</Pill>
          {hiddenTransactions > 0 ? (
            <Pill tone="holding">+{hiddenTransactions} archived</Pill>
          ) : null}
        </div>
      </div>
      {visibleTransactions.map((transaction, index) => {
        const rowEvents = transactionEvents(transaction, events);
        const proofBundle = transactionProofBundle(transaction, proofBundles);
        const declaredReads = asArray(transaction.readSet);
        const observedReads = asArray(transaction.observedReadSet);
        const writes = asArray(
          transaction.writeSet?.length
            ? transaction.writeSet
            : transaction.observedWriteSet,
        );
        const result = compact(transaction.status, "pending");
        const reason = transactionReason(transaction, rowEvents);
        const towerAction = transactionTowerAction(transaction, rowEvents);
        return (
          <div
            key={transaction.id || `transaction-${index}`}
            className="rounded-lg border p-3 text-xs"
            style={{
              borderColor:
                result === "aborted"
                  ? "color-mix(in srgb, var(--accent-danger) 42%, var(--border-subtle))"
                  : "var(--border-subtle)",
              background: "var(--bg-surface)",
            }}
          >
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate font-mono text-[11px]">
                  {compact(transaction.id, "transaction")}
                </div>
                <div
                  className="mt-0.5 text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {transaction.live ? "live" : "recorded"} / opened{" "}
                  {formatTime(transaction.openedAt) || "pending"}
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-1">
                <Pill tone={transaction.isolation || "pending"}>
                  {compact(transaction.isolation, "isolation")}
                </Pill>
                <Pill tone={transaction.status}>{result}</Pill>
              </div>
            </div>
            <div className="mt-3 grid gap-2 @min-[34rem]/panel:grid-cols-4">
              <div className="min-w-0 rounded-md border px-2 py-1.5" style={{
                borderColor: "var(--border-subtle)",
                background: "var(--bg-editor)",
              }}>
                <div
                  className="text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  Base snapshot
                </div>
                <div
                  className="truncate font-mono text-[10px]"
                  title={transaction.baseSnapshot || ""}
                >
                  {transactionDigestLabel(transaction.baseSnapshot)}
                </div>
              </div>
              <div className="rounded-md border px-2 py-1.5" style={{
                borderColor: "var(--border-subtle)",
                background: "var(--bg-editor)",
              }}>
                <div
                  className="text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  Declared read set
                </div>
                <div className="font-mono text-lg font-semibold leading-none">
                  {declaredReads.length}
                </div>
              </div>
              <div className="rounded-md border px-2 py-1.5" style={{
                borderColor: "var(--border-subtle)",
                background: "var(--bg-editor)",
              }}>
                <div
                  className="text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  Observed read set
                </div>
                <div className="font-mono text-lg font-semibold leading-none">
                  {observedReads.length}
                </div>
              </div>
              <div className="rounded-md border px-2 py-1.5" style={{
                borderColor: "var(--border-subtle)",
                background: "var(--bg-editor)",
              }}>
                <div
                  className="text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  Write set
                </div>
                <div className="font-mono text-lg font-semibold leading-none">
                  {writes.length}
                </div>
              </div>
            </div>
            <div className="mt-3 grid min-w-0 gap-3 @min-[44rem]/panel:grid-cols-[minmax(0,1fr)_minmax(220px,0.45fr)]">
              <div className="grid min-w-0 gap-2 @min-[28rem]/panel:grid-cols-2">
                <div className="min-w-0">
                  <div
                    className="text-[10px] font-semibold uppercase tracking-normal"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Reads
                  </div>
                  <PathList
                    paths={uniqueValues([...declaredReads, ...observedReads])}
                    empty="read set pending"
                    maxVisible={4}
                  />
                </div>
                <div className="min-w-0">
                  <div
                    className="text-[10px] font-semibold uppercase tracking-normal"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Writes
                  </div>
                  <PathList
                    paths={writes}
                    empty="write set pending"
                    maxVisible={4}
                  />
                </div>
              </div>
              <div
                className="min-w-0 rounded-md border px-2 py-2"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-editor)",
                }}
              >
                <div
                  className="text-[10px] font-semibold uppercase tracking-normal"
                  style={{ color: "var(--text-muted)" }}
                >
                  Result
                </div>
                <div className="mt-1 break-words">
                  Reason:{" "}
                  <span className="font-mono text-[10px]">{reason}</span>
                </div>
                <div className="mt-1 break-words">
                  Coordinator action:{" "}
                  <span className="font-mono text-[10px]">{towerAction}</span>
                </div>
                <div className="mt-2">
                  <PathList
                    paths={uniqueValues([
                      transaction.proofBundleDigest,
                      proofBundle?.id,
                      proofBundle?.bundleDigest,
                      ...asArray(proofBundle?.evidenceRefs),
                    ])}
                    empty="evidence pending"
                    maxVisible={4}
                  />
                </div>
              </div>
            </div>
          </div>
        );
      })}
      {recentBundles.length ? (
        <div className="grid gap-2">
          {recentBundles.map((bundle, index) => (
            <div
              key={bundle.id || `proof-bundle-${index}`}
              className="rounded-md border px-3 py-2 text-xs"
              style={{
                borderColor: "var(--border-subtle)",
                background: "var(--bg-surface)",
              }}
            >
              {/* Same track as the shared Row primitive, gated the same way. */}
              <div className="grid min-h-10 grid-cols-1 items-start gap-1 @min-[26rem]/panel:grid-cols-[minmax(76px,0.9fr)_minmax(0,1.5fr)_minmax(72px,0.8fr)] @min-[26rem]/panel:items-center @min-[26rem]/panel:gap-2">
                <div className="min-w-0">
                  <div className="truncate font-mono text-[11px]">
                    {bundle.id}
                  </div>
                  <div
                    className="text-[10px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    evidence bundle
                  </div>
                </div>
                <div
                  className="min-w-0 truncate font-mono text-[11px]"
                  title={bundle.bundleDigest || bundle.readSetDigest}
                >
                  {bundle.bundleDigest || bundle.readSetDigest}
                </div>
                <div className="justify-self-end">
                  <CheckCircle2
                    className="h-4 w-4"
                    style={{
                      color:
                        "color-mix(in srgb, var(--accent-success) 70%, var(--text-primary))",
                    }}
                  />
                </div>
              </div>
              <div className="mt-1 grid gap-1 @min-[28rem]/panel:grid-cols-2">
                <PathList
                  paths={bundle.evidenceRefs || []}
                  empty="no evidence refs"
                />
                <PathList
                  paths={Object.entries(bundle.trailers || {}).map(
                    ([key, value]) => `${key}: ${value}`,
                  )}
                  empty="no trailers"
                  maxVisible={10}
                />
              </div>
              {bundle.repoState ? (
                <div className="mt-1">
                  <PathList
                    paths={[
                      bundle.repoState.evidenceDigest &&
                        `repo-state:${bundle.repoState.evidenceDigest}`,
                      bundle.repoState.gitHead &&
                        `git-head:${bundle.repoState.gitHead}`,
                      bundle.repoState.worktreeDiffDigest &&
                        `worktree-diff:${bundle.repoState.worktreeDiffDigest}`,
                      ...asArray(bundle.repoState.writeFileDigests).map(
                        (file) => `${file.path}:${file.digest || "missing"}`,
                      ),
                    ].filter(Boolean)}
                    empty="no repo-state evidence"
                    maxVisible={6}
                  />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
