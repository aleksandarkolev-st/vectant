import { createLiveCommandScenario } from "../lib/live_command_scenario.mjs";

export default createLiveCommandScenario({
  name: "live_browser_session_crash",
  description: "Opt-in live chaos hook for crashing a hosted browser session while verifying the runtime session is revoked safely.",
  commandEnv: "SYNTHI_CHAOS_BROWSER_CRASH_COMMAND_JSON",
});
