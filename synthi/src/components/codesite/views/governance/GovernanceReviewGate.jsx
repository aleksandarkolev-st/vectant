import { IconButton, PathList, Pill } from "../../ui";
import { motion } from "framer-motion";
import { compact } from "../../lib/format";
import { actionLabel, actionReviewSummary } from "../../lib/governance";
import { CodeSiteIcons } from "../../icons";

export default function GovernanceReviewGate({ action, rationale, onRationale, onCancel, onConfirm, disabled }) {
  if (!action) return null;
  const summary = actionReviewSummary(action);
  const canConfirm = String(rationale || "").trim().length >= 12;
  return (
    <motion.div
      layout
      data-testid="codesite-governance-review-gate"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      className="rounded-lg border p-3"
      style={{
        borderColor:
          summary.severity === "critical"
            ? "color-mix(in srgb, var(--accent-danger) 50%, var(--border-subtle))"
            : "color-mix(in srgb, var(--accent-primary) 38%, var(--border-subtle))",
        background:
          "linear-gradient(180deg, color-mix(in srgb, var(--bg-surface) 88%, var(--accent-primary) 6%), var(--bg-surface))",
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold">Review before governed action</div>
          <div
            className="mt-1 break-words text-[11px]"
            style={{ color: "var(--text-muted)" }}
          >
            {compact(action.title || action.label, actionLabel(action))}
          </div>
        </div>
        <Pill tone={summary.severity}>{summary.severity}</Pill>
      </div>
      <div className="mt-3 grid gap-2 text-[11px] sm:grid-cols-3">
        <div>
          <div style={{ color: "var(--text-muted)" }}>Owner</div>
          <div className="mt-1 break-all font-mono">{summary.owner}</div>
        </div>
        <div>
          <div style={{ color: "var(--text-muted)" }}>Target</div>
          <div className="mt-1 break-all font-mono">{summary.entity}</div>
        </div>
        <div>
          <div style={{ color: "var(--text-muted)" }}>Evidence</div>
          <div className="mt-1 break-all font-mono">
            {summary.evidenceRefs[0] || action.evidenceRefs?.[0] || "required"}
          </div>
        </div>
      </div>
      {summary.scope.length ? (
        <div className="mt-2">
          <div className="mb-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
            Scope
          </div>
          <PathList paths={summary.scope} maxVisible={6} />
        </div>
      ) : null}
      <label
        className="mt-3 grid gap-1 text-[11px]"
        style={{ color: "var(--text-muted)" }}
      >
        Operator rationale
        <textarea
          data-testid="codesite-governance-review-rationale"
          value={rationale}
          onChange={(event) => onRationale(event.target.value)}
          rows={3}
          className="min-h-24 rounded border px-2 py-2 text-xs outline-none"
          placeholder="Confirm replay, evidence, and impact before issuing this action."
          style={{
            borderColor: canConfirm
              ? "color-mix(in srgb, var(--accent-primary) 38%, var(--border-subtle))"
              : "var(--border-subtle)",
            background: "var(--bg-editor)",
            color: "var(--text-primary)",
          }}
        />
      </label>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <IconButton
          title="Cancel governed action"
          disabled={disabled}
          onClick={onCancel}
          testId="codesite-governance-review-cancel"
        >
          Cancel
        </IconButton>
        <IconButton
          title="Confirm governed action"
          variant="primary"
          disabled={disabled || !canConfirm}
          onClick={() => onConfirm(rationale)}
          testId="codesite-governance-review-confirm"
        >
          <CodeSiteIcons.approvals className="h-3.5 w-3.5" />
          Confirm
        </IconButton>
      </div>
    </motion.div>
  );
}
