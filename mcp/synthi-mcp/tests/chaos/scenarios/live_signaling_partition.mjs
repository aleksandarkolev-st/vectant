import { createLiveCommandScenario } from "../lib/live_command_scenario.mjs";

export default createLiveCommandScenario({
  name: "live_signaling_partition",
  description: "Opt-in live chaos hook for partitioning signaling while verifying runtime recovery and fail-closed behavior.",
  commandEnv: "SYNTHI_CHAOS_SIGNALING_PARTITION_COMMAND_JSON",
});
