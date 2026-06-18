import { createLiveCommandScenario } from "../lib/live_command_scenario.mjs";

export default createLiveCommandScenario({
  name: "live_postgres_restart_during_proof_validation",
  description: "Opt-in live chaos hook for restarting Postgres during proof validation while verifying proof use remains atomic.",
  commandEnv: "SYNTHI_CHAOS_POSTGRES_RESTART_PROOF_COMMAND_JSON",
});
