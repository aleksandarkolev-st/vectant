import { CodeSiteIcons } from "../icons";
import { compact } from "../lib/format";
import { Pill, Section } from "../ui";
import TowerSimulatorDeck from "./simulator/TowerSimulatorDeck";

export default function SimulatorView({
  towerSimulation,
  latestSimulation,
  towerUniverses,
  selectedUniverse,
  assumptions,
  activeFlights,
  activeLeases,
  allEvents,
  simulationRun,
  onRunSimulation,
  simulationDisabled,
}) {
  return (
    <Section
      title="Coordination Simulator"
      icon={CodeSiteIcons.simulator}
      right={
        <Pill tone={selectedUniverse?.result || simulationRun.status}>
          {compact(
            towerSimulation?.selected,
            simulationRun.status === "running"
              ? "running"
              : "not run",
          )}
        </Pill>
      }
    >
      <TowerSimulatorDeck
        towerSimulation={towerSimulation}
        latestSimulation={latestSimulation}
        towerUniverses={towerUniverses}
        selectedUniverse={selectedUniverse}
        assumptions={assumptions}
        activeFlights={activeFlights}
        activeLeases={activeLeases}
        events={allEvents}
        simulationRun={simulationRun}
        onRun={onRunSimulation}
        disabled={simulationDisabled}
      />
    </Section>
  );
}
