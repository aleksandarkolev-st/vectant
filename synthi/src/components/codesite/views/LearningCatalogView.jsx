"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Check, RefreshCw, Share2 } from "lucide-react";
import {
  adoptCodeSiteLearningCatalogEntry,
  fetchCodeSiteLearningCatalog,
  updateCodeSiteProjectControlPlan,
} from "../codesiteClient";
import { EmptyLine, IconButton, OperatorPane, Pill, Section, TagList } from "../ui";
import { CodeSiteIcons } from "../icons";

function scopeLabel(scope) {
  return scope === "learning_network" ? "multi-workspace" : "this workspace";
}

function scopeTone(scope) {
  return scope === "learning_network" ? "pending" : "active";
}

function commandSummary(commands) {
  const values = Array.isArray(commands) ? commands.filter(Boolean) : [];
  if (values.length === 0) return "No command is required.";
  return values.join(" · ");
}

export default function LearningCatalogView({ workspaceSlug, project, acting = false }) {
  const projectId = project?.id || null;
  const [learning, setLearning] = useState([]);
  const [networkEnabled, setNetworkEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!workspaceSlug || !projectId) {
      setLearning([]);
      setNetworkEnabled(false);
      return;
    }
    setLoading(true);
    try {
      const catalog = await fetchCodeSiteLearningCatalog(workspaceSlug, projectId);
      setLearning(catalog.learning);
      setNetworkEnabled(catalog.networkEnabled);
      setError(null);
    } catch (nextError) {
      setError(nextError.message || "learning_catalog_fetch_failed");
    } finally {
      setLoading(false);
    }
  }, [projectId, workspaceSlug]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const runAction = useCallback(async (key, work) => {
    if (busyKey || acting) return;
    setBusyKey(key);
    try {
      await work();
      await refresh();
      setError(null);
    } catch (nextError) {
      setError(nextError.message || "learning_catalog_action_failed");
    } finally {
      setBusyKey(null);
    }
  }, [acting, busyKey, refresh]);

  const toggleNetwork = useCallback(() => {
    const nextNetworkEnabled = !networkEnabled;
    const currentLearning = project?.controlPlan?.learningNetwork || project?.controlPlan?.learning || {};
    void runAction("network-preference", () => updateCodeSiteProjectControlPlan(workspaceSlug, projectId, {
      learningNetwork: {
        workspace: currentLearning.workspace !== false,
        network: nextNetworkEnabled,
      },
    }));
  }, [networkEnabled, project?.controlPlan?.learning, project?.controlPlan?.learningNetwork, projectId, runAction, workspaceSlug]);

  const adopt = useCallback((entry) => {
    void runAction(`adopt:${entry.id}`, () => adoptCodeSiteLearningCatalogEntry(
      workspaceSlug,
      projectId,
      entry.id,
    ));
  }, [projectId, runAction, workspaceSlug]);

  if (!projectId) return null;

  return (
    <div className="grid content-start gap-3 p-3 @min-[28rem]/panel:p-4" data-testid="codesite-learning-catalog-view">
      <OperatorPane
        title="Learning catalogue"
        icon={Share2}
        testId="codesite-learning-catalog-board"
        right={<Pill tone={networkEnabled ? "active" : "idle"}>{networkEnabled ? "network on" : "local only"}</Pill>}
      >
        <div className="grid gap-3">
          <p className="max-w-[68ch] text-xs leading-5" style={{ color: "var(--text-secondary)" }}>
            Agents receive verified, read-only guidance during orientation. Source projects, file paths, evidence references, and environment data are removed before anything is shown here.
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] leading-5" style={{ color: "var(--text-muted)" }}>
              Workspace lessons are available automatically. Multi-workspace intake is an explicit project choice.
            </span>
            <div className="flex flex-wrap gap-1.5">
              <IconButton
                title="Refresh learning catalogue"
                onClick={() => void refresh()}
                disabled={loading || acting || Boolean(busyKey)}
                testId="codesite-learning-refresh"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh
              </IconButton>
              <IconButton
                title={networkEnabled ? "Disable multi-workspace learning" : "Enable multi-workspace learning"}
                variant={networkEnabled ? "neutral" : "primary"}
                onClick={toggleNetwork}
                disabled={acting || Boolean(busyKey)}
                testId="codesite-learning-network-toggle"
              >
                <Share2 className="h-3.5 w-3.5" />
                {networkEnabled ? "Network on" : "Enable network"}
              </IconButton>
            </div>
          </div>
          {error ? <Pill tone="blocked">{String(error)}</Pill> : null}
        </div>
      </OperatorPane>

      <Section
        title="Available guidance"
        icon={CodeSiteIcons.learning}
        right={<Pill tone={learning.length ? "active" : "idle"}>{learning.length}</Pill>}
      >
        {loading && learning.length === 0 ? (
          <EmptyLine>Loading verified learning guidance.</EmptyLine>
        ) : learning.length === 0 ? (
          <EmptyLine>
            No portable lessons are available yet. Publish a verified, read-only shared skill from a source project to make guidance available here.
          </EmptyLine>
        ) : (
          <div className="divide-y rounded-md border" style={{ borderColor: "var(--border-subtle)" }} data-testid="codesite-learning-catalog-list">
            {learning.map((entry) => {
              const busy = busyKey === `adopt:${entry.id}`;
              return (
                <article key={entry.id} className="grid gap-3 px-3 py-3 text-xs" data-testid="codesite-learning-catalog-row">
                  <div className="grid gap-2 @min-[34rem]/panel:grid-cols-[minmax(0,1fr)_auto] @min-[34rem]/panel:items-start">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="break-words font-semibold">{entry.title || "Untitled guidance"}</span>
                        <Pill tone={scopeTone(entry.scope)}>{scopeLabel(entry.scope)}</Pill>
                        <Pill tone="active">read-only</Pill>
                      </div>
                      {entry.summary ? <p className="mt-1 leading-5" style={{ color: "var(--text-secondary)" }}>{entry.summary}</p> : null}
                    </div>
                    <div className="font-mono text-[10px] @min-[34rem]/panel:text-right" style={{ color: "var(--text-muted)" }}>
                      confidence {Math.round(Number(entry.confidence || 0) * 100)}%
                    </div>
                  </div>

                  <div className="grid gap-2 @min-[38rem]/panel:grid-cols-2" style={{ color: "var(--text-secondary)" }}>
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--text-muted)" }}>Safe recipe</div>
                      <p className="mt-1 break-words font-mono text-[11px] leading-5">{commandSummary(entry.recipe?.commands)}</p>
                    </div>
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--text-muted)" }}>Required tools</div>
                      <TagList items={entry.recipe?.requiredTools} empty="No extra tool declared" maxVisible={4} />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3" style={{ borderColor: "var(--border-subtle)" }}>
                    <span className="text-[11px] leading-5" style={{ color: "var(--text-muted)" }}>
                      Adopting records an audit event. It does not grant mutation permission.
                    </span>
                    <IconButton
                      title="Record learning guidance adoption"
                      variant="primary"
                      onClick={() => adopt(entry)}
                      disabled={acting || busy}
                      testId="codesite-learning-adopt"
                    >
                      <Check className="h-3.5 w-3.5" />
                      Adopt
                    </IconButton>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}
