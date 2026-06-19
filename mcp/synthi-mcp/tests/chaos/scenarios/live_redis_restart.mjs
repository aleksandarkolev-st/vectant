import { createLiveCommandScenario } from "../lib/live_command_scenario.mjs";

export default createLiveCommandScenario({
  name: "live_redis_restart",
  description: "Opt-in live chaos hook for restarting Redis while verifying revocation, replay, and queue behavior fail closed.",
  commandEnv: "SYNTHI_CHAOS_REDIS_RESTART_COMMAND_JSON",
});
