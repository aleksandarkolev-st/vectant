import { createLiveCommandScenario } from "../lib/live_command_scenario.mjs";

export default createLiveCommandScenario({
  name: "live_proof_signing_outage",
  description: "Opt-in live chaos hook for proof signing service outage while verifying production proof issuance fails closed.",
  commandEnv: "SYNTHI_CHAOS_PROOF_SIGNING_OUTAGE_COMMAND_JSON",
});
