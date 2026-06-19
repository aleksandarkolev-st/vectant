import { createLiveCommandScenario } from "../lib/live_command_scenario.mjs";

export default createLiveCommandScenario({
  name: "live_evidence_store_unavailable",
  description: "Opt-in live chaos hook for making the evidence store unavailable while verifying evidence writes fail closed.",
  commandEnv: "SYNTHI_CHAOS_EVIDENCE_STORE_UNAVAILABLE_COMMAND_JSON",
});
