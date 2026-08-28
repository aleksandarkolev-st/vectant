"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Check, EyeOff, Megaphone, RefreshCw, RotateCcw, Send, X } from "lucide-react";
import {
  decideCodeSiteFleetNotam,
  fetchCodeSiteFleetNotams,
  publishCodeSiteFleetNotam,
  supersedeCodeSiteFleetNotam,
  withdrawCodeSiteFleetNotam,
} from "../codesiteClient";
import { asArray, compact, formatPercent } from "../lib/format";
import { EmptyLine, IconButton, OperatorPane, Pill, Section, TagList } from "../ui";
import { CodeSiteIcons } from "../icons";

const PROMOTED_STATES = new Set(["promoted", "accepted", "active", "validated"]);

function notamTone(notam = {}) {
  if (notam.status === "active" && notam.effect === "adopted") return "active";
  if (notam.status === "active") return "pending";
  if (notam.status === "withdrawn") return "idle";
  if (notam.status === "superseded") return "holding";
  return "idle";
}

function notamTime(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "not recorded";
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function digestLabel(value) {
  const digest = String(value || "");
  return digest.length > 22 ? `${digest.slice(0, 12)}…${digest.slice(-8)}` : compact(digest, "missing");
}

function isActivePublication(notam = {}) {
  return notam.status === "active";
}

export default function FleetNotamsView({ workspaceSlug, project, acting = false }) {
  const projectId = project?.id || null;
  const [advisories, setAdvisories] = useState([]);
  const [suppressed, setSuppressed] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [publishDeltaId, setPublishDeltaId] = useState("");
  const [replacementByNotamId, setReplacementByNotamId] = useState({});
  const [reasonByNotamId, setReasonByNotamId] = useState({});

  const refresh = useCallback(async () => {
    if (!workspaceSlug || !projectId) {
      setAdvisories([]);
      setSuppressed(0);
      return;
    }
    setLoading(true);
    try {
      const board = await fetchCodeSiteFleetNotams(workspaceSlug, projectId, {
        includeOwn: true,
        includeMuted: true,
        includeInactive: true,
      });
      setAdvisories(board.advisories);
      setSuppressed(board.suppressed);
      setError(null);
    } catch (nextError) {
      setError(nextError.message || "fleet_notams_fetch_failed");
    } finally {
      setLoading(false);
    }
  }, [projectId, workspaceSlug]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const promotedDeltas = useMemo(
    () => asArray(project?.policyDeltas)
      .filter((delta) => PROMOTED_STATES.has(String(delta?.promotionState || "").toLowerCase()))
      .sort((left, right) => String(right?.updatedAt || "").localeCompare(String(left?.updatedAt || ""))),
    [project?.policyDeltas],
  );
  const ownActive = useMemo(
    () => advisories.filter((notam) => notam.originProjectId === projectId && isActivePublication(notam)),
    [advisories, projectId],
  );
  const visibleCount = advisories.filter((notam) => isActivePublication(notam)).length;

  const runAction = useCallback(async (key, work) => {
    if (busyKey || acting) return;
    setBusyKey(key);
    try {
      await work();
      await refresh();
      setError(null);
    } catch (nextError) {
      setError(nextError.message || "fleet_notam_action_failed");
    } finally {
      setBusyKey(null);
    }
  }, [acting, busyKey, refresh]);

  const publish = useCallback(() => {
    if (!publishDeltaId) return;
    void runAction(`publish:${publishDeltaId}`, async () => {
      await publishCodeSiteFleetNotam(workspaceSlug, projectId, { policyDeltaId: publishDeltaId });
      setPublishDeltaId("");
    });
  }, [projectId, publishDeltaId, runAction, workspaceSlug]);

  const decide = useCallback((notam, state) => {
    void runAction(`${notam.notamId}:${state}`, () => decideCodeSiteFleetNotam(
      workspaceSlug,
      projectId,
      notam.notamId,
      { state, reason: reasonByNotamId[notam.notamId] || undefined },
    ));
  }, [projectId, reasonByNotamId, runAction, workspaceSlug]);

  const withdraw = useCallback((notam) => {
    void runAction(`${notam.notamId}:withdraw`, () => withdrawCodeSiteFleetNotam(
      workspaceSlug,
      projectId,
      notam.notamId,
      { reason: reasonByNotamId[notam.notamId] || undefined },
    ));
  }, [projectId, reasonByNotamId, runAction, workspaceSlug]);

  const supersede = useCallback((notam) => {
    const policyDeltaId = replacementByNotamId[notam.notamId];
    if (!policyDeltaId) return;
    void runAction(`${notam.notamId}:supersede`, async () => {
      await supersedeCodeSiteFleetNotam(workspaceSlug, projectId, notam.notamId, {
        policyDeltaId,
        reason: reasonByNotamId[notam.notamId] || undefined,
      });
      setReplacementByNotamId((current) => ({ ...current, [notam.notamId]: "" }));
    });
  }, [projectId, reasonByNotamId, replacementByNotamId, runAction, workspaceSlug]);

  if (!projectId) return null;

  return (
    <div className="grid content-start gap-3 p-3 @min-[28rem]/panel:p-4" data-testid="codesite-fleet-notams-view">
      <OperatorPane
        title="Fleet advisory board"
        icon={Megaphone}
        testId="codesite-fleet-notams-board"
        right={<Pill tone={visibleCount ? "pending" : "active"}>{visibleCount} active</Pill>}
      >
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <p className="max-w-[68ch] leading-5" style={{ color: "var(--text-secondary)" }}>
              Fleet advisories are visible across projects. They change local clearance only after this project explicitly adopts them.
            </p>
            <IconButton
              title="Refresh fleet advisories"
              onClick={() => void refresh()}
              disabled={loading || acting || Boolean(busyKey)}
              testId="codesite-fleet-notams-refresh"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </IconButton>
          </div>
          {suppressed ? (
            <div className="rounded border px-3 py-2 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
              {suppressed} advisory {suppressed === 1 ? "was" : "were"} withheld because its integrity digest did not match its stored payload.
            </div>
          ) : null}
          {error ? <Pill tone="blocked">{String(error)}</Pill> : null}
        </div>
      </OperatorPane>

      <Section
        title="Publish an evidence-backed advisory"
        icon={CodeSiteIcons.evidence}
        right={<Pill tone={promotedDeltas.length ? "active" : "idle"}>{promotedDeltas.length} eligible</Pill>}
      >
        {promotedDeltas.length === 0 ? (
          <EmptyLine>Promote a policy delta with replay evidence before publishing it to the fleet.</EmptyLine>
        ) : (
          <div className="grid gap-2 @min-[36rem]/panel:grid-cols-[minmax(0,1fr)_auto] @min-[36rem]/panel:items-end">
            <label className="grid gap-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
              Promoted policy delta
              <select
                value={publishDeltaId}
                onChange={(event) => setPublishDeltaId(event.target.value)}
                className="h-11 min-w-0 rounded-md border px-2 text-xs outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--attention-purple)]"
                style={{ borderColor: "var(--border-subtle)", background: "var(--bg-editor)", color: "var(--text-primary)" }}
                data-testid="codesite-fleet-notam-publish-select"
              >
                <option value="">Select an evidence-backed delta</option>
                {promotedDeltas.map((delta) => (
                  <option key={delta.id} value={delta.id}>
                    {compact(delta.ruleCandidate?.title || delta.ruleCandidate?.rule || delta.id, delta.id)}
                  </option>
                ))}
              </select>
            </label>
            <IconButton
              title="Publish fleet advisory"
              variant="primary"
              onClick={publish}
              disabled={!publishDeltaId || acting || Boolean(busyKey)}
              testId="codesite-fleet-notam-publish"
            >
              <Send className="h-3.5 w-3.5" />
              Publish
            </IconButton>
          </div>
        )}
      </Section>

      <Section
        title="Advisories"
        icon={CodeSiteIcons.signals}
        right={<Pill tone={advisories.length ? "pending" : "idle"}>{advisories.length}</Pill>}
      >
        {loading && advisories.length === 0 ? (
          <EmptyLine>Loading fleet advisory evidence</EmptyLine>
        ) : advisories.length === 0 ? (
          <EmptyLine>No fleet advisories are visible to this project.</EmptyLine>
        ) : (
          <div className="divide-y rounded-md border" style={{ borderColor: "var(--border-subtle)" }} data-testid="codesite-fleet-notam-list">
            {advisories.map((notam) => {
              const origin = notam.originProjectId === projectId;
              const active = isActivePublication(notam);
              const busy = Boolean(busyKey && busyKey.startsWith(`${notam.notamId}:`));
              const selectedReplacement = replacementByNotamId[notam.notamId] || "";
              return (
                <article key={notam.notamId} className="grid gap-3 px-3 py-3 text-xs" data-testid="codesite-fleet-notam-row">
                  <div className="grid gap-2 @min-[34rem]/panel:grid-cols-[minmax(0,1fr)_auto] @min-[34rem]/panel:items-start">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="break-words font-semibold">{compact(notam.title, "Untitled advisory")}</span>
                        <Pill tone={notamTone(notam)}>{notam.status || "unknown"}</Pill>
                        <Pill tone={notam.effect === "adopted" ? "active" : "idle"}>
                          {notam.effect === "adopted" ? "locally enforced" : "visible only"}
                        </Pill>
                        {origin ? <Pill tone="idle">published here</Pill> : null}
                      </div>
                      {notam.summary ? <p className="mt-1 leading-5" style={{ color: "var(--text-secondary)" }}>{notam.summary}</p> : null}
                    </div>
                    <div className="font-mono text-[10px] @min-[34rem]/panel:text-right" style={{ color: "var(--text-muted)" }}>
                      <div>published {notamTime(notam.publishedAt)}</div>
                      <div title={notam.digestSha256}>digest {digestLabel(notam.digestSha256)}</div>
                    </div>
                  </div>

                  <div className="grid gap-2 @min-[38rem]/panel:grid-cols-2" style={{ color: "var(--text-secondary)" }}>
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--text-muted)" }}>Scope</div>
                      <TagList items={asArray(notam.affectedRoutes)} empty="No route restriction recorded" maxVisible={3} />
                    </div>
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--text-muted)" }}>Required checks</div>
                      <TagList items={asArray(notam.ruleCandidate?.requiredRadar)} empty="No added checks" maxVisible={3} />
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px]" style={{ color: "var(--text-muted)" }}>
                    <span>confidence {formatPercent(notam.confidence)}</span>
                    {notam.affectedZoneKey ? <span>zone {notam.affectedZoneKey}</span> : null}
                    {notam.expiresAt ? <span>expires {notamTime(notam.expiresAt)}</span> : <span>no expiry</span>}
                    <span>local state {notam.ingestState || "unreviewed"}</span>
                  </div>

                  {notam.status !== "active" ? (
                    <div className="text-[11px] leading-5" style={{ color: "var(--text-secondary)" }}>
                      {notam.status === "superseded" && notam.supersededByNotamId
                        ? `Superseded by ${notam.supersededByNotamId}.`
                        : "Withdrawn publications remain here as lifecycle evidence and do not affect clearance."}
                      {notam.lifecycleReason ? ` Reason: ${notam.lifecycleReason}` : ""}
                    </div>
                  ) : null}

                  {active ? (
                    <div className="grid gap-2 border-t pt-3 @min-[42rem]/panel:grid-cols-[minmax(0,1fr)_auto] @min-[42rem]/panel:items-end" style={{ borderColor: "var(--border-subtle)" }}>
                      <label className="grid gap-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
                        Decision or lifecycle reason, optional
                        <input
                          value={reasonByNotamId[notam.notamId] || ""}
                          onChange={(event) => setReasonByNotamId((current) => ({ ...current, [notam.notamId]: event.target.value }))}
                          maxLength={2000}
                          className="h-9 min-w-0 rounded-md border px-2 text-xs outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--attention-purple)]"
                          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-editor)", color: "var(--text-primary)" }}
                          data-testid="codesite-fleet-notam-reason"
                        />
                      </label>
                      {origin ? (
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <IconButton
                            title="Withdraw fleet advisory"
                            onClick={() => withdraw(notam)}
                            disabled={acting || busy}
                            testId="codesite-fleet-notam-withdraw"
                          >
                            <X className="h-3.5 w-3.5" />
                            Withdraw
                          </IconButton>
                        </div>
                      ) : (
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {notam.ingestState === "adopted" ? (
                            <IconButton title="Remove local adoption" onClick={() => decide(notam, "reactivate")} disabled={acting || busy} testId="codesite-fleet-notam-reactivate">
                              <RotateCcw className="h-3.5 w-3.5" />
                              Stop enforcing
                            </IconButton>
                          ) : (
                            <IconButton title="Adopt fleet advisory locally" variant="primary" onClick={() => decide(notam, "adopt")} disabled={acting || busy} testId="codesite-fleet-notam-adopt">
                              <Check className="h-3.5 w-3.5" />
                              Adopt
                            </IconButton>
                          )}
                          {notam.ingestState === "muted" || notam.ingestState === "dismissed" ? (
                            <IconButton title="Restore advisory visibility" onClick={() => decide(notam, "reactivate")} disabled={acting || busy}>
                              <RotateCcw className="h-3.5 w-3.5" />
                              Restore
                            </IconButton>
                          ) : (
                            <>
                              <IconButton title="Mute fleet advisory" onClick={() => decide(notam, "mute")} disabled={acting || busy} testId="codesite-fleet-notam-mute">
                                <EyeOff className="h-3.5 w-3.5" />
                                Mute
                              </IconButton>
                              <IconButton title="Dismiss fleet advisory" onClick={() => decide(notam, "dismiss")} disabled={acting || busy}>
                                Dismiss
                              </IconButton>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  ) : null}

                  {origin && active ? (
                    <div className="grid gap-2 @min-[42rem]/panel:grid-cols-[minmax(0,1fr)_auto] @min-[42rem]/panel:items-end">
                      <label className="grid gap-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
                        Replace with a different promoted policy delta
                        <select
                          value={selectedReplacement}
                          onChange={(event) => setReplacementByNotamId((current) => ({ ...current, [notam.notamId]: event.target.value }))}
                          className="h-9 min-w-0 rounded-md border px-2 text-xs outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--attention-purple)]"
                          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-editor)", color: "var(--text-primary)" }}
                          data-testid="codesite-fleet-notam-supersede-select"
                        >
                          <option value="">Choose a replacement</option>
                          {promotedDeltas.filter((delta) => delta.id !== notam.sourcePolicyDeltaId).map((delta) => (
                            <option key={delta.id} value={delta.id}>
                              {compact(delta.ruleCandidate?.title || delta.ruleCandidate?.rule || delta.id, delta.id)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <IconButton
                        title="Supersede fleet advisory"
                        onClick={() => supersede(notam)}
                        disabled={!selectedReplacement || acting || busy}
                        testId="codesite-fleet-notam-supersede"
                      >
                        <Megaphone className="h-3.5 w-3.5" />
                        Supersede
                      </IconButton>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </Section>

      {ownActive.length ? null : (
        <div className="px-3 pb-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
          This project has no active fleet publication.
        </div>
      )}
    </div>
  );
}
