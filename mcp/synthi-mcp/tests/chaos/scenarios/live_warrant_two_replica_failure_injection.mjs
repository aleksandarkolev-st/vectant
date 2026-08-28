import { createLiveCommandScenario } from "../lib/live_command_scenario.mjs";
import { validateWarrantTwoReplicaEvidenceFromStdout } from "../lib/warrant_two_replica_evidence.mjs";

export default createLiveCommandScenario({
  name: "live_warrant_two_replica_failure_injection",
  description: "Opt-in deployment acceptance for shared warrant authority, lifecycle denial, managed signing, and failure-injection behavior across exactly two replicas.",
  commandEnv: "SYNTHI_CHAOS_WARRANT_TWO_REPLICA_COMMAND_JSON",
  validateEvidence: ({ stdout }) => validateWarrantTwoReplicaEvidenceFromStdout(stdout),
});
