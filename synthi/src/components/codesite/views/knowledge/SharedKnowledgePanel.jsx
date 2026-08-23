import { useId, useMemo, useRef, useState } from "react";
import { CodeSiteIcons } from "../../icons";
import { Pill } from "../../ui";

const TABS = Object.freeze([
  {
    kind: "discovery",
    label: "Discoveries",
    singular: "discovery",
    empty: "No discoveries have been shared with this project yet.",
  },
  {
    kind: "lead",
    label: "Leads",
    singular: "lead",
    empty: "No open leads have been shared with this project yet.",
  },
  {
    kind: "shared_skill",
    label: "Skills",
    singular: "skill",
    empty: "No reviewed skills have been shared with this project yet.",
  },
  {
    kind: "handoff",
    label: "Handoffs",
    singular: "handoff",
    empty: "No handoffs have been shared with this project yet.",
  },
]);

const TAB_KINDS = new Set(TABS.map((tab) => tab.kind));
const REFERENCE_GROUPS = Object.freeze([
  ["paths", "Path"],
  ["symbols", "Symbol"],
  ["contracts", "Contract"],
  ["runtimeSessionIds", "Runtime"],
  ["agentSessionIds", "Agent"],
  ["workstreamIds", "Workstream"],
  ["transactionIds", "Transaction"],
]);

function validKind(value, fallback = "discovery") {
  return TAB_KINDS.has(value) ? value : fallback;
}

function visibleProjectItem(item) {
  if (!item || typeof item !== "object" || !TAB_KINDS.has(item.kind))
    return false;
  const visibility = String(item.visibility || "project").toLowerCase();
  const redactionClass = String(item.redactionClass || "").toLowerCase();
  return (
    visibility === "project" &&
    (!redactionClass || redactionClass === "project_fact")
  );
}

function displayLabel(value, fallback) {
  const normalized = String(value || fallback || "")
    .trim()
    .replaceAll("_", " ");
  return normalized
    ? normalized.replace(/^./, (character) => character.toUpperCase())
    : "Unknown";
}

function safeStrings(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((entry) => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function confidenceValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 1
    ? numeric
    : null;
}

function impactCount(item) {
  const candidates = [
    item?.impactCount,
    item?.pendingImpactCount,
    item?.affectedWorkstreamCount,
  ];
  const explicit = candidates.find(
    (value) => Number.isInteger(Number(value)) && Number(value) >= 0,
  );
  if (explicit != null) return Number(explicit);
  if (Array.isArray(item?.impacts)) return item.impacts.length;
  if (Array.isArray(item?.impactNotices)) return item.impactNotices.length;
  return 0;
}

function sourceDescription(source) {
  if (!source || typeof source !== "object") return null;
  const actorType =
    typeof source.actorType === "string" ? source.actorType.trim() : "";
  const actorId =
    typeof source.actorId === "string" ? source.actorId.trim() : "";
  if (!actorType && !actorId) return null;
  return `${displayLabel(actorType, "source")}${actorId ? ` · ${actorId}` : ""}`;
}

function Source({ source }) {
  const description = sourceDescription(source);
  if (!description) return null;
  const sessionRefs = [
    typeof source.agentSessionId === "string" && source.agentSessionId.trim()
      ? `agent ${source.agentSessionId.trim()}`
      : null,
    typeof source.terminalSessionId === "string" &&
    source.terminalSessionId.trim()
      ? `terminal ${source.terminalSessionId.trim()}`
      : null,
  ].filter(Boolean);

  return (
    <div className="min-w-0 text-[11px]" data-testid="shared-knowledge-source">
      <span style={{ color: "var(--text-muted)" }}>Source </span>
      <span
        className="break-words font-medium"
        style={{ color: "var(--text-secondary)" }}
      >
        {description}
      </span>
      {sessionRefs.length ? (
        <span
          className="mt-0.5 block break-all font-mono text-[10px]"
          style={{ color: "var(--text-muted)" }}
        >
          {sessionRefs.join(" · ")}
        </span>
      ) : null}
    </div>
  );
}

function References({ references }) {
  if (
    !references ||
    typeof references !== "object" ||
    Array.isArray(references)
  )
    return null;
  const groups = REFERENCE_GROUPS.map(([key, label]) => ({
    key,
    label,
    values: safeStrings(references[key]),
  })).filter((group) => group.values.length);
  if (!groups.length) return null;

  return (
    <dl
      className="grid min-w-0 gap-1.5 @min-[34rem]/panel:grid-cols-2"
      aria-label="Knowledge references"
    >
      {groups.map((group) => {
        const visible = group.values.slice(0, 3);
        return (
          <div
            key={group.key}
            className="grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-2 text-[10px]"
          >
            <dt
              className="pt-0.5 font-semibold uppercase tracking-[0.06em]"
              style={{ color: "var(--text-muted)" }}
            >
              {group.label}
            </dt>
            <dd className="flex min-w-0 flex-wrap gap-1">
              {visible.map((reference) => (
                <code
                  key={reference}
                  className="max-w-full break-all rounded border px-1.5 py-0.5 leading-4"
                  style={{
                    borderColor: "var(--border-subtle)",
                    background: "var(--bg-editor)",
                    color: "var(--text-secondary)",
                  }}
                  title={reference}
                >
                  {reference}
                </code>
              ))}
              {group.values.length > visible.length ? (
                <span
                  className="self-center"
                  style={{ color: "var(--text-muted)" }}
                >
                  +{group.values.length - visible.length} more
                </span>
              ) : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function Confidence({ value }) {
  const confidence = confidenceValue(value);
  if (confidence == null) return null;
  const percent = Math.round(confidence * 100);
  return (
    <div
      className="flex min-w-[8.5rem] items-center gap-2 text-[10px]"
      data-testid="shared-knowledge-confidence"
    >
      <meter
        aria-label={`Confidence: ${percent} percent`}
        className="h-1.5 min-w-0 flex-1 accent-[var(--primary)]"
        min="0"
        max="1"
        value={confidence}
      />
      <span
        className="shrink-0 font-mono tabular-nums"
        style={{ color: "var(--text-muted)" }}
      >
        {percent}% confidence
      </span>
    </div>
  );
}

function ImpactVisibility({ item }) {
  const count = impactCount(item);
  const needsResponse =
    item?.requiresResponse === true || item?.impactRequiresResponse === true;
  if (!count && !needsResponse) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-1 text-[10px]"
      data-testid="shared-knowledge-impact"
      aria-label="Impact visibility"
    >
      {count ? <Pill tone="review">{count} affected</Pill> : null}
      {needsResponse ? <Pill tone="holding">Response needed</Pill> : null}
    </div>
  );
}

function KnowledgeItem({ item, singular }) {
  const status = displayLabel(item.status, "unknown");
  const title =
    typeof item.title === "string" && item.title.trim()
      ? item.title.trim()
      : `Untitled ${singular}`;
  const summary = typeof item.summary === "string" ? item.summary.trim() : "";
  const priority =
    item.kind === "lead" && typeof item.priority === "string"
      ? item.priority
      : null;
  const verification =
    item.kind === "discovery" && typeof item.verification === "string"
      ? item.verification
      : null;
  const skillKey =
    item.kind === "shared_skill" && typeof item.skillKey === "string"
      ? item.skillKey
      : null;

  return (
    <li
      className="grid min-w-0 gap-3 border-t px-3 py-3 first:border-t-0 @min-[44rem]/panel:grid-cols-[minmax(0,1fr)_minmax(13rem,0.38fr)]"
      style={{
        borderColor:
          "color-mix(in srgb, var(--border-subtle) 78%, transparent)",
      }}
      data-testid={`shared-knowledge-item-${item.id || item.kind}`}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <h3 className="min-w-0 break-words text-xs font-semibold leading-5">
            {title}
          </h3>
          <Pill tone={item.status || "idle"}>{status}</Pill>
          {priority ? (
            <Pill tone={priority}>{displayLabel(priority)}</Pill>
          ) : null}
          {verification && verification !== item.status ? (
            <Pill tone={verification}>{displayLabel(verification)}</Pill>
          ) : null}
        </div>
        {skillKey ? (
          <code
            className="mt-1 block break-all text-[10px]"
            style={{ color: "var(--text-muted)" }}
          >
            {skillKey}
          </code>
        ) : null}
        <p
          className="mt-1.5 max-w-[76ch] whitespace-pre-wrap break-words text-[11px] leading-4"
          style={{ color: "var(--text-secondary)" }}
        >
          {summary || "No project-safe summary was provided."}
        </p>
        <div className="mt-2">
          <References references={item.references} />
        </div>
      </div>
      <div
        className="flex min-w-0 flex-col gap-2 border-t pt-2 @min-[44rem]/panel:border-l @min-[44rem]/panel:border-t-0 @min-[44rem]/panel:pl-3 @min-[44rem]/panel:pt-0"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <Confidence value={item.confidence} />
        <Source source={item.source} />
        <ImpactVisibility item={item} />
      </div>
    </li>
  );
}

function LoadingState() {
  return (
    <div
      className="space-y-2 px-3 py-3"
      role="status"
      aria-live="polite"
      data-testid="shared-knowledge-loading"
    >
      <span className="sr-only">Loading shared knowledge</span>
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          aria-hidden="true"
          className="h-20 rounded border"
          style={{
            borderColor: "var(--border-subtle)",
            background:
              "color-mix(in srgb, var(--bg-surface) 88%, var(--bg-editor))",
            opacity: 0.72,
          }}
        />
      ))}
    </div>
  );
}

function ErrorState({ error, onRetry }) {
  const message = typeof error === "string" ? error : error?.message;
  return (
    <div
      className="grid gap-3 px-3 py-6 text-xs @min-[28rem]/panel:grid-cols-[minmax(0,1fr)_auto] @min-[28rem]/panel:items-center"
      role="alert"
    >
      <div>
        <div className="font-semibold">Shared knowledge is unavailable</div>
        <p className="mt-1" style={{ color: "var(--text-muted)" }}>
          {message ||
            "The project knowledge view could not be loaded. Try again when the connection is available."}
        </p>
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-9 justify-self-start rounded-md border px-3 text-[11px] font-semibold outline-none hover:bg-[color-mix(in_srgb,var(--text-primary)_5%,transparent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]"
          style={{
            borderColor: "var(--border-subtle)",
            color: "var(--text-primary)",
          }}
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

export default function SharedKnowledgePanel({
  items = [],
  loading = false,
  error = null,
  activeKind,
  defaultKind = "discovery",
  onActiveKindChange,
  onRetry,
  title = "Shared knowledge",
  description = "Project-safe findings, leads, reusable skills, and agent handoffs.",
  className = "",
}) {
  const instanceId = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const initialKind = validKind(defaultKind);
  const [internalKind, setInternalKind] = useState(initialKind);
  const selectedKind =
    activeKind == null ? internalKind : validKind(activeKind, initialKind);
  const tabRefs = useRef({});
  const safeItems = useMemo(
    () => (Array.isArray(items) ? items.filter(visibleProjectItem) : []),
    [items],
  );
  const counts = useMemo(
    () =>
      Object.fromEntries(
        TABS.map((tab) => [
          tab.kind,
          safeItems.filter((item) => item.kind === tab.kind).length,
        ]),
      ),
    [safeItems],
  );
  const selectedTab = TABS.find((tab) => tab.kind === selectedKind) || TABS[0];
  const visibleItems = safeItems.filter((item) => item.kind === selectedKind);

  function selectTab(kind, { focus = false } = {}) {
    if (activeKind == null) setInternalKind(kind);
    onActiveKindChange?.(kind);
    if (focus) tabRefs.current[kind]?.focus();
  }

  function handleTabKeyDown(event, index) {
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft")
      nextIndex = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = TABS.length - 1;
    else return;
    event.preventDefault();
    selectTab(TABS[nextIndex].kind, { focus: true });
  }

  const panelId = `${instanceId}-knowledge-panel`;

  return (
    <section
      className={`min-w-0 overflow-hidden rounded-lg border ${className}`}
      style={{
        borderColor:
          "color-mix(in srgb, var(--border-subtle) 84%, transparent)",
        background: "color-mix(in srgb, var(--bg-surface) 94%, transparent)",
      }}
      aria-labelledby={`${instanceId}-knowledge-title`}
      aria-busy={loading ? "true" : "false"}
      data-testid="shared-knowledge-panel"
    >
      <div
        className="grid gap-3 border-b px-3 py-3 @min-[34rem]/panel:grid-cols-[minmax(0,1fr)_auto] @min-[34rem]/panel:items-end"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <CodeSiteIcons.signals
              className="h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
              style={{ color: "var(--primary)" }}
            />
            <h2
              id={`${instanceId}-knowledge-title`}
              className="text-xs font-semibold"
            >
              {title}
            </h2>
          </div>
          <p
            className="mt-1 max-w-[68ch] text-[11px] leading-4"
            style={{ color: "var(--text-muted)" }}
          >
            {description}
          </p>
        </div>
        <div
          className="flex min-w-0 gap-1 overflow-x-auto pb-0.5"
          role="tablist"
          aria-label={`${title} categories`}
          aria-orientation="horizontal"
        >
          {TABS.map((tab, index) => {
            const selected = tab.kind === selectedKind;
            const tabId = `${instanceId}-knowledge-tab-${tab.kind}`;
            return (
              <button
                key={tab.kind}
                ref={(node) => {
                  tabRefs.current[tab.kind] = node;
                }}
                id={tabId}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                onClick={() => selectTab(tab.kind)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold outline-none transition-[background,border-color,color] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]"
                style={{
                  borderColor: selected
                    ? "color-mix(in srgb, var(--primary) 46%, var(--border-subtle))"
                    : "var(--border-subtle)",
                  background: selected
                    ? "color-mix(in srgb, var(--primary) 9%, transparent)"
                    : "transparent",
                  color: selected ? "var(--text-primary)" : "var(--text-muted)",
                }}
                data-testid={`shared-knowledge-tab-${tab.kind}`}
              >
                <span>{tab.label}</span>
                <span
                  className="min-w-4 rounded px-1 font-mono text-[9px] tabular-nums"
                  style={{
                    background: "var(--bg-editor)",
                    color: "var(--text-muted)",
                  }}
                  aria-label={`${counts[tab.kind]} ${tab.label.toLowerCase()}`}
                >
                  {counts[tab.kind]}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={`${instanceId}-knowledge-tab-${selectedKind}`}
        tabIndex="0"
        className="min-w-0 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--primary)]"
        data-testid={`shared-knowledge-tabpanel-${selectedKind}`}
      >
        {loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState error={error} onRetry={onRetry} />
        ) : visibleItems.length ? (
          <ul
            className="min-w-0"
            aria-label={`${selectedTab.label} shared with this project`}
          >
            {visibleItems.map((item, index) => (
              <KnowledgeItem
                key={item.id || `${item.kind}-${index}`}
                item={item}
                singular={selectedTab.singular}
              />
            ))}
          </ul>
        ) : (
          <div
            className="px-3 py-8 text-center"
            data-testid="shared-knowledge-empty"
          >
            <div className="text-xs font-semibold">Nothing shared here</div>
            <p
              className="mx-auto mt-1 max-w-[52ch] text-[11px] leading-4"
              style={{ color: "var(--text-muted)" }}
            >
              {selectedTab.empty} Project-visible records will appear here after
              they pass knowledge policy.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
