import { describe, expect, it } from "vitest";
import {
  projectPublicWorkerDiagnostic,
  publicWorkerReference,
} from "../../src/events/public_worker_diagnostic.js";

describe("public worker event diagnostics", () => {
  it.each([
    "security",
    "human_action",
    "input_ack",
    "input_lease_result",
    "input_rejected",
  ] as const)("projects %s through the same closed schema", (eventClass) => {
    const canaries = {
      reason: "https://user:password@provider.invalid/resource?signature=secret",
      dispatch: "dispatch-sensitive-123",
      lease: "lease-sensitive-456",
      owner: "owner@example.invalid",
      peer: "peer-sensitive-789",
      token: "Bearer synthetic.secret.value",
    };
    const projected = projectPublicWorkerDiagnostic(eventClass, {
      reason: canaries.reason,
      dispatch_id: canaries.dispatch,
      lease_id: canaries.lease,
      owner: canaries.owner,
      peer_id: canaries.peer,
      accepted: false,
      queue_position: 3,
      detail: { authorization: canaries.token },
      arbitrary: { cookie: canaries.token },
    });

    expect(projected).toMatchObject({
      schemaVersion: "synthi.worker.public_event_diagnostic.v1",
      proofAuthority: "worker_event_diagnostic_only_not_gpu_hmr_acceptance",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      eventClass,
      reasonPresent: true,
      detailPresent: true,
      accepted: false,
      queuePosition: 3,
    });
    expect(projected.reasonRef).toMatch(/^worker-reason-ref:sha256:[a-f0-9]{64}$/);
    expect(projected.dispatchRef).toMatch(/^worker-dispatch-ref:sha256:[a-f0-9]{64}$/);
    expect(projected.leaseRef).toMatch(/^worker-lease-ref:sha256:[a-f0-9]{64}$/);
    expect(projected.ownerRef).toMatch(/^worker-owner-ref:sha256:[a-f0-9]{64}$/);
    expect(projected.peerRef).toMatch(/^worker-peer-ref:sha256:[a-f0-9]{64}$/);
    const serialized = JSON.stringify(projected);
    for (const canary of Object.values(canaries)) expect(serialized).not.toContain(canary);
    expect(projected).not.toHaveProperty("detail");
    expect(projected).not.toHaveProperty("arbitrary");
  });

  it("uses stable process-local references without cross-role collisions", () => {
    const value = "same-sensitive-identifier";
    expect(publicWorkerReference("lease", value)).toBe(publicWorkerReference("lease", value));
    expect(publicWorkerReference("lease", value)).not.toBe(publicWorkerReference("owner", value));
    expect(publicWorkerReference("stage", value)).toMatch(/^worker-stage-ref:sha256:[a-f0-9]{64}$/);
  });
});
