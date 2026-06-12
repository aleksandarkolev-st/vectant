import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildDojoSkill,
  issueDojoProofCapsule,
  validateDojoProofCapsule,
} from "../../src/browser/dojo.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import {
  DOJO_PROOF_SIGNING_KEY_ID_ENV,
  DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM_ENV,
  DOJO_PROOF_SIGNING_PROVIDER_ENV,
  DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM_ENV,
} from "../../src/dojo/config/enforcement.js";
import { generateEd25519DojoProofKeyPair } from "../../src/dojo/proof/signing.js";

const ENV_KEYS = [
  DOJO_PROOF_SIGNING_PROVIDER_ENV,
  DOJO_PROOF_SIGNING_KEY_ID_ENV,
  DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM_ENV,
  DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM_ENV,
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  savedEnv.clear();
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Dojo Ed25519 proof capsules", () => {
  it("keeps default HMAC proof issuance compatible", () => {
    const skill = skillFixture();

    const capsule = issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: { workspace_verified: true },
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });

    expect(capsule.signature_algorithm).toBe("hmac-sha256");
    expect(capsule.signature).toMatch(/^hmac-sha256:/);
    expect(validateDojoProofCapsule(skill, capsule, "run_workflow", "2026-06-11T00:01:00.000Z")).toEqual(
      expect.objectContaining({ ok: true, status: "allowed" })
    );
  });

  it("issues and validates Ed25519 proof capsules when explicitly configured", () => {
    const keyPair = configureEd25519ProofSigning();
    const skill = skillFixture();

    const capsule = issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: { workspace_verified: true },
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });

    expect(capsule.key_id).toBe(keyPair.key_id);
    expect(capsule.signature_algorithm).toBe("ed25519");
    expect(capsule.signature).toMatch(/^ed25519:ed-key-a:/);
    expect(validateDojoProofCapsule(skill, capsule, "run_workflow", "2026-06-11T00:01:00.000Z")).toEqual(
      expect.objectContaining({ ok: true, status: "allowed" })
    );

    const tampered = { ...capsule, context_claims: { workspace_verified: false } };
    expect(validateDojoProofCapsule(skill, tampered, "run_workflow", "2026-06-11T00:01:00.000Z")).toEqual(
      expect.objectContaining({
        ok: false,
        blocked_by: expect.arrayContaining(["proof_capsule_signature_invalid"]),
      })
    );
  });

  it("fails closed when an Ed25519 verifier is not configured", () => {
    configureEd25519ProofSigning();
    const skill = skillFixture();
    const capsule = issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: { workspace_verified: true },
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    delete process.env[DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM_ENV];

    expect(validateDojoProofCapsule(skill, capsule, "run_workflow", "2026-06-11T00:01:00.000Z")).toEqual(
      expect.objectContaining({
        ok: false,
        blocked_by: expect.arrayContaining(["proof_capsule_signature_invalid"]),
      })
    );
  });
});

function configureEd25519ProofSigning() {
  const keyPair = generateEd25519DojoProofKeyPair("ed-key-a");
  process.env[DOJO_PROOF_SIGNING_PROVIDER_ENV] = "ed25519-local";
  process.env[DOJO_PROOF_SIGNING_KEY_ID_ENV] = keyPair.key_id;
  process.env[DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM_ENV] = keyPair.private_key_pem;
  process.env[DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM_ENV] = keyPair.public_key_pem;
  return keyPair;
}

function skillFixture() {
  return buildDojoSkill(compileWorkflowContract([
    event({
      event_id: "open",
      action: "click",
      detail: { element: { role: "button", name: "Open details", source_id: "details.open" } },
      locator_candidates: [
        { kind: "role", locator: "page.getByRole(\"button\", { name: \"Open details\" })", confidence: 0.98, reason: "role" },
      ],
    }),
  ]).contract, {
    workspace_id: "workspace-a",
    now: "2026-06-11T00:00:00.000Z",
  });
}

function event(overrides: Partial<BrowserTraceEvent>): BrowserTraceEvent {
  return {
    event_id: "evt",
    trace_id: "trace",
    trace_version: 1,
    event_seq: 1,
    ts: 1,
    tab_id: "tab",
    origin: "https://app.example.test",
    url: "https://app.example.test/settings",
    kind: "human_action",
    action: "click",
    target: "button",
    selectors: [],
    locator_candidates: [],
    confidence: 0.99,
    ...overrides,
  };
}
