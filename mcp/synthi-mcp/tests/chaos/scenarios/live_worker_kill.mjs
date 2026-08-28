import { createLiveCommandScenario } from "../lib/live_command_scenario.mjs";

export default createLiveCommandScenario({
  name: "live_worker_kill",
  description: "Opt-in live chaos hook for killing or restarting the worker while verifying unsafe actions fail closed.",
  commandEnv: "SYNTHI_CHAOS_WORKER_KILL_COMMAND_JSON",
});
