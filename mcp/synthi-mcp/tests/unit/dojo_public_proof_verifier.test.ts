import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildDojoSkill,
  issueDojoProofCapsule,
} from "../../src/browser/dojo.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import { DOJO_DEFAULT_LOCAL_PROOF_SIGNING_KEY } from "../../src/dojo/config/enforcement.js";
import {
  canonicalDojoProofPayload,
  createEd25519DojoProofSigner,
  createEd25519DojoProofVerifier,
  createLocalHmacDojoProofSigner,
  encodeDojoProofSignatureEnvelope,
  generateEd25519DojoProofKeyPair,
} from "../../src/dojo/proof/signing.js";
import {
  verifyDojoProofCapsulePublic,
  type DojoPublicProofCapsule,
} from "../../src/dojo/proof/public_verifier.js";
import { dojoEvidenceRecordForProof } from "./dojo_test_fixtures.js";

describe("Dojo public proof capsule verifier", () => {
  it("verifies a real issued evidence-backed capsule with an external verifier", () => {
    const skill = skillFixture();
    const evidenceRecord = dojoEvidenceRecordForProof(skill, { record_id: "evidence-public-proof-a" });
    const capsule = issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: { workspace_verified: true },
      evidence_ledger_records: [evidenceRecord],
      require_verified_evidence: true,
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    const verifier = createLocalHmacDojoProofSigner({
      key: DOJO_DEFAULT_LOCAL_PROOF_SIGNING_KEY,
      key_id: capsule.key_id,
    });

    expect(verifyDojoProofCapsulePublic({
      capsule,
      verifier,
      expected: {
        issuer: capsule.issuer,
        key_id: capsule.key_id,
        skill_id: skill.skill_id,
        skill_version: skill.skill_version,
        license_version: skill.permission_license.license_version,
        requested_action: "run_workflow",
        ledger_checkpoint_hash: evidenceRecord.ledger_head_hash,
        required_evidence_claims: skill.permission_license.proof_requirements.required_evidence_claims,
      },
      require_ledger_checkpoint: true,
      now: "2026-06-11T00:01:00.000Z",
    })).toEqual(expect.objectContaining({
      ok: true,
      status: "verified",
      signature_verified: true,
      blocked_by: [],
    }));
  });

  it("blocks tampered or context-mismatched capsules with explicit reasons", () => {
    const skill = skillFixture();
    const capsule = issueDojoProofCapsule(skill, "run_workflow", {
      context_claims: { workspace_verified: true },
      now: "2026-06-11T00:00:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    });
    const verifier = createLocalHmacDojoProofSigner({
      key: DOJO_DEFAULT_LOCAL_PROOF_SIGNING_KEY,
      key_id: capsule.key_id,
    });
    const tampered = {
      ...capsule,
      context_claims: { workspace_verified: false },
    };

    expect(verifyDojoProofCapsulePublic({
      capsule: tampered,
      verifier,
      expected: {
        requested_action: "delete_everything",
        ledger_checkpoint_hash: "b".repeat(64),
      },
      require_ledger_checkpoint: true,
      now: "2026-06-11T00:01:00.000Z",
    })).toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      signature_verified: false,
      blocked_by: expect.arrayContaining([
        "proof_capsule_action_mismatch",
        "proof_capsule_ledger_checkpoint_mismatch",
        "proof_capsule_ledger_checkpoint_missing",
        "proof_capsule_signature_invalid",
      ]),
    }));
  });

  it("verifies an Ed25519 capsule from public key material", () => {
    const keyPair = generateEd25519DojoProofKeyPair("ed-key-a");
    const signer = createEd25519DojoProofSigner({
      key_id: keyPair.key_id,
      private_key_pem: keyPair.private_key_pem,
    });
    const verifier = createEd25519DojoProofVerifier({
      key_id: keyPair.key_id,
      public_key_pem: keyPair.public_key_pem,
    });
    const unsigned = ed25519CapsuleWithoutSignature(keyPair.key_id);
    const capsule: DojoPublicProofCapsule = {
      ...unsigned,
      signature: encodeDojoProofSignatureEnvelope(signer.sign(canonicalDojoProofPayload(unsigned))),
    };

    expect(verifyDojoProofCapsulePublic({
      capsule,
      verifier,
      expected: {
        issuer: "unit-test-issuer",
        key_id: keyPair.key_id,
        skill_id: "skill-a",
        skill_version: "1.0.0",
        license_version: "license-v1",
        requested_action: "run_workflow",
        ledger_checkpoint_hash: "c".repeat(64),
      },
      require_ledger_checkpoint: true,
      now: "2026-06-11T00:01:00.000Z",
    })).toEqual(expect.objectContaining({
      ok: true,
      status: "verified",
      signature_verified: true,
      blocked_by: [],
    }));
  });

  it("blocks signed capsules whose required evidence claims have no evidence refs", () => {
    const keyPair = generateEd25519DojoProofKeyPair("ed-key-missing-evidence-refs");
    const signer = createEd25519DojoProofSigner({
      key_id: keyPair.key_id,
      private_key_pem: keyPair.private_key_pem,
    });
    const verifier = createEd25519DojoProofVerifier({
      key_id: keyPair.key_id,
      public_key_pem: keyPair.public_key_pem,
    });
    const unsigned = {
      ...ed25519CapsuleWithoutSignature(keyPair.key_id),
      evidence_claims: [{ claim: "checkride_passed", satisfied: true, evidence_refs: [] }],
    };
    const capsule = signPublicCapsule(unsigned, signer);

    expect(verifyDojoProofCapsulePublic({
      capsule,
      verifier,
      expected: {
        issuer: "unit-test-issuer",
        key_id: keyPair.key_id,
        skill_id: "skill-a",
        skill_version: "1.0.0",
        license_version: "license-v1",
        requested_action: "run_workflow",
        ledger_checkpoint_hash: "c".repeat(64),
        required_evidence_claims: ["checkride_passed"],
      },
      require_ledger_checkpoint: true,
      now: "2026-06-11T00:01:00.000Z",
    })).toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      signature_verified: true,
      blocked_by: ["proof_capsule_evidence_claim_refs_missing:checkride_passed"],
    }));
  });

  it("blocks signed capsules with malformed ledger checkpoint hashes", () => {
    const keyPair = generateEd25519DojoProofKeyPair("ed-key-malformed-checkpoint");
    const signer = createEd25519DojoProofSigner({
      key_id: keyPair.key_id,
      private_key_pem: keyPair.private_key_pem,
    });
    const verifier = createEd25519DojoProofVerifier({
      key_id: keyPair.key_id,
      public_key_pem: keyPair.public_key_pem,
    });
    const unsigned = {
      ...ed25519CapsuleWithoutSignature(keyPair.key_id),
      ledger_checkpoint_hash: "not-a-sha256-ledger-head",
    };
    const capsule: DojoPublicProofCapsule = {
      ...unsigned,
      signature: encodeDojoProofSignatureEnvelope(signer.sign(canonicalDojoProofPayload(unsigned))),
    };

    expect(verifyDojoProofCapsulePublic({
      capsule,
      verifier,
      require_ledger_checkpoint: true,
      now: "2026-06-11T00:01:00.000Z",
    })).toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      signature_verified: true,
      blocked_by: ["proof_capsule_ledger_checkpoint_invalid"],
    }));
  });

  it("blocks signed capsules with non-forward proof timestamp windows", () => {
    const keyPair = generateEd25519DojoProofKeyPair("ed-key-invalid-window");
    const signer = createEd25519DojoProofSigner({
      key_id: keyPair.key_id,
      private_key_pem: keyPair.private_key_pem,
    });
    const verifier = createEd25519DojoProofVerifier({
      key_id: keyPair.key_id,
      public_key_pem: keyPair.public_key_pem,
    });
    const unsigned = {
      ...ed25519CapsuleWithoutSignature(keyPair.key_id),
      issued_at: "2026-06-11T00:15:00.000Z",
      expires_at: "2026-06-11T00:15:00.000Z",
    };
    const capsule = signPublicCapsule(unsigned, signer);

    expect(verifyDojoProofCapsulePublic({
      capsule,
      verifier,
      now: "2026-06-11T00:01:00.000Z",
    })).toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      signature_verified: true,
      blocked_by: ["proof_capsule_expires_at_not_after_issued_at"],
    }));
  });

  it("blocks public verification when the verifier timestamp is malformed", () => {
    const keyPair = generateEd25519DojoProofKeyPair("ed-key-invalid-checked-at");
    const signer = createEd25519DojoProofSigner({
      key_id: keyPair.key_id,
      private_key_pem: keyPair.private_key_pem,
    });
    const verifier = createEd25519DojoProofVerifier({
      key_id: keyPair.key_id,
      public_key_pem: keyPair.public_key_pem,
    });
    const unsigned = ed25519CapsuleWithoutSignature(keyPair.key_id);
    const capsule = signPublicCapsule(unsigned, signer);

    expect(verifyDojoProofCapsulePublic({
      capsule,
      verifier,
      now: "not-a-date",
    })).toEqual(expect.objectContaining({
      ok: false,
      status: "blocked",
      signature_verified: true,
      blocked_by: ["proof_validation_time_invalid"],
    }));
  });
});

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

function ed25519CapsuleWithoutSignature(keyId: string): Omit<DojoPublicProofCapsule, "signature"> {
  return {
    schema_version: "synthi.dojo.proofCapsule.v1",
    capsule_id: `capsule_${hash(keyId)}`,
    skill_id: "skill-a",
    skill_version: "1.0.0",
    requested_action: "run_workflow",
    license_version: "license-v1",
    entrustment_level: "E3",
    issuer: "unit-test-issuer",
    key_id: keyId,
    nonce: "nonce-a",
    context_claims: { workspace_verified: true },
    evidence_claims: [{ claim: "checkride_passed", satisfied: true, evidence_refs: ["evidence:evidence-a"] }],
    evidence_record_ids: ["evidence-a"],
    ledger_checkpoint_hash: "c".repeat(64),
    guardrails_active: ["guardrail-a"],
    substrate_claim: "mcp",
    assurance_case_ref: "assurance-a",
    issued_at: "2026-06-11T00:00:00.000Z",
    expires_at: "2026-06-11T00:15:00.000Z",
    signature_algorithm: "ed25519",
  };
}

function signPublicCapsule(
  unsigned: Omit<DojoPublicProofCapsule, "signature">,
  signer: ReturnType<typeof createEd25519DojoProofSigner>
): DojoPublicProofCapsule {
  return {
    ...unsigned,
    signature: encodeDojoProofSignatureEnvelope(signer.sign(canonicalDojoProofPayload(unsigned))),
  };
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

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
