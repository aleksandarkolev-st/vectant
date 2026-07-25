import { EmptyLine, IconButton, Metric, PathList, Pill, SignalBar } from "../../ui";
import { motion, useReducedMotion } from "framer-motion";
import { MOTION_EASE } from "../../lib/motion";
import { asArray, compact, formatPercent, uniqueValues, universeHealthScore } from "../../lib/format";
import { CodeSiteIcons } from "../../icons";
import AssumptionInvalidatorPanel from "./AssumptionInvalidatorPanel";

export default function TowerSimulatorDeck({
  towerSimulation,
  latestSimulation,
  towerUniverses,
  selectedUniverse,
  assumptions,
  activeFlights,
  activeLeases,
  events,
  simulationRun,
  onRun,
  disabled,
}) {
  const reduceMotion = useReducedMotion();
  const selectedSignals = Object.entries(selectedUniverse?.sourceSignals || {})
    .map(([key, value]) => `${key}:${value}`)
    .filter((item) => !item.endsWith(":0"));
  const evidenceRefs = uniqueValues([
    ...asArray(towerSimulation?.evidenceRefs),
    ...asArray(latestSimulation?.run?.evidenceRefs),
    towerSimulation?.shadowJobRef,
    latestSimulation?.run?.shadowJobRef,
  ]);
  const selectedHealth = universeHealthScore(selectedUniverse);

  return (
    <div data-testid="codesite-tower-simulator" className="grid min-w-0 gap-3">
      <div
        className="grid gap-3 rounded-lg border p-3 lg:grid-cols-[minmax(0,0.9fr)_auto]"
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 70%, var(--accent-primary) 30%)",
          background:
            "linear-gradient(135deg, color-mix(in srgb, var(--bg-surface) 92%, var(--accent-primary) 8%), var(--bg-editor))",
        }}
      >
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Pill tone={selectedUniverse?.result || simulationRun.status}>
              {compact(
                towerSimulation?.selected,
                simulationRun.status === "running" ? "running" : "not run",
              )}
            </Pill>
            <Pill tone={selectedHealth >= 0.65 ? "active" : "holding"}>
              health {formatPercent(selectedHealth)}
            </Pill>
            {towerUniverses.length ? (
              <Pill>{towerUniverses.length} options</Pill>
            ) : null}
          </div>
          <div className="mt-2 text-sm font-semibold">
            Counterfactual route board
          </div>
          <div
            className="mt-1 max-w-[70ch] text-xs leading-5"
            style={{ color: "var(--text-muted)" }}
          >
            Compares policy-safe routes before commit, using stale
            assumptions, inspection cost, unresolved risks, and proof refs.
          </div>
        </div>
        <IconButton
          title="Run coordination simulation"
          onClick={onRun}
          disabled={disabled}
          testId="codesite-run-tower-simulator"
        >
          <CodeSiteIcons.simulator className="h-3.5 w-3.5" />
          Simulate
        </IconButton>
      </div>
      {simulationRun.error ? (
        <div
          className="rounded border px-2 py-1 text-[11px]"
          style={{
            borderColor:
              "color-mix(in srgb, var(--accent-danger) 40%, var(--border-subtle))",
            color: "var(--text-primary)",
          }}
        >
          {simulationRun.error}
        </div>
      ) : null}
      {towerUniverses.length === 0 ? (
        <EmptyLine>No simulator run recorded</EmptyLine>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(132px,1fr))] gap-2">
            <Metric
              label="Selected"
              value={compact(towerSimulation?.selected, "none")}
              tone={selectedUniverse?.result || "idle"}
              testId="codesite-tower-selected"
            />
            <Metric
              label="Collision"
              value={formatPercent(selectedUniverse?.predictedCollisionRisk)}
              tone={selectedUniverse?.result || "idle"}
            />
            <Metric
              label="Inspect"
              value={selectedUniverse?.inspectionCost ?? 0}
            />
            <Metric
              label="Confidence"
              value={formatPercent(selectedUniverse?.confidence)}
            />
          </div>
          <AssumptionInvalidatorPanel
            assumptions={assumptions}
            towerUniverses={towerUniverses}
            activeFlights={activeFlights}
            activeLeases={activeLeases}
            events={events}
          />
          <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(260px,0.85fr)]">
            <div className="grid min-w-0 gap-2">
              {towerUniverses.map((universe, index) => {
                const selected =
                  universe.strategy === towerSimulation?.selected;
                const health = universeHealthScore(universe);
                return (
                  <motion.div
                    key={
                      universe.strategy ||
                      universe.id ||
                      `tower-universe-${index}`
                    }
                    data-testid="codesite-tower-universe"
                    className="rounded-lg border px-3 py-2 text-xs"
                    initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: reduceMotion ? 0 : 0.2,
                      delay: reduceMotion ? 0 : index * 0.03,
                      ease: MOTION_EASE,
                    }}
                    style={{
                      borderColor: selected
                        ? "color-mix(in srgb, var(--accent-primary) 52%, var(--border-subtle))"
                        : "var(--border-subtle)",
                      background: selected
                        ? "color-mix(in srgb, var(--accent-primary) 12%, var(--bg-surface))"
                        : "var(--bg-surface)",
                    }}
                  >
                    <div className="grid gap-3 sm:grid-cols-[minmax(128px,1fr)_minmax(0,1.4fr)_minmax(118px,0.65fr)] sm:items-center">
                      <div className="min-w-0">
                        <div className="break-words font-medium leading-tight">
                          {compact(universe.strategy, "strategy")}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          <Pill tone={universe.result}>
                            {compact(universe.result, "review")}
                          </Pill>
                          {selected ? <Pill tone="active">selected</Pill> : null}
                        </div>
                      </div>
                      <div className="grid min-w-0 gap-1">
                        <SignalBar
                          value={health}
                          tone={health >= 0.65 ? "active" : "holding"}
                          label={`${compact(universe.strategy, "strategy")} health`}
                        />
                        <div
                          className="grid gap-1 text-[11px] sm:grid-cols-3"
                          style={{ color: "var(--text-secondary)" }}
                        >
                          <span>
                            Risk{" "}
                            <strong className="font-mono tabular-nums">
                              {formatPercent(universe.predictedCollisionRisk)}
                            </strong>
                          </span>
                          <span>
                            Stale{" "}
                            <strong className="font-mono tabular-nums">
                              {universe.staleAssumptions ?? 0}
                            </strong>
                          </span>
                          <span>
                            Cost{" "}
                            <strong className="font-mono tabular-nums">
                              {universe.inspectionCost ?? 0}
                            </strong>
                          </span>
                        </div>
                      </div>
                      <div className="justify-self-start sm:justify-self-end">
                        <Pill
                          tone={
                            universe.unresolvedRisks?.length
                              ? "holding"
                              : "active"
                          }
                        >
                          {asArray(universe.unresolvedRisks).length} unresolved
                        </Pill>
                      </div>
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <div>
                        <div
                          className="text-[11px]"
                          style={{ color: "var(--text-muted)" }}
                        >
                          Coordinator actions
                        </div>
                        <PathList
                          paths={universe.requiredTowerActions || []}
                          empty="none"
                          maxVisible={6}
                        />
                      </div>
                      <div>
                        <div
                          className="text-[11px]"
                          style={{ color: "var(--text-muted)" }}
                        >
                          Reason codes
                        </div>
                        <PathList
                          paths={universe.reasonCodes || []}
                          empty="none"
                          maxVisible={6}
                        />
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
            <div className="grid min-w-0 content-start gap-2">
              <div
                className="rounded-lg border px-3 py-2 text-xs"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-surface)",
                }}
              >
                <div
                  className="mb-1 text-[11px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  Signals used
                </div>
                <PathList
                  paths={selectedSignals}
                  empty="no source signals"
                  maxVisible={10}
                />
              </div>
              <div
                className="rounded-lg border px-3 py-2 text-xs"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-surface)",
                }}
              >
                <div
                  className="mb-1 text-[11px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  Evidence
                </div>
                <PathList paths={evidenceRefs} empty="none" maxVisible={10} />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
