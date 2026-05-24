from fastapi import FastAPI

from gpu_hmr.api import router
from gpu_hmr.broker import get_gpu_hmr_broker, reset_gpu_hmr_broker_for_tests
from gpu_hmr.contracts import CandidateSpecManifest, VerifierReport


def _client():
    try:
        from fastapi.testclient import TestClient
    except RuntimeError as exc:
        import pytest

        pytest.skip(str(exc))

    reset_gpu_hmr_broker_for_tests()
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _create_projection(client):
    response = client.post(
        "/gpu-hmr/projections",
        json={
            "sourceSplitIdentityHash": "source-split-1",
            "selectedTargetIdentityHash": "target-1",
            "codeIntelGeneration": "ci-42",
            "buildMetadataHash": "build-meta-1",
            "idempotencyKey": "ws:projection:1",
            "sourceSets": {"targetInputs": ["src/main.cpp", "src/kernel.hip"]},
            "retrievalEvidenceRefs": [{"kind": "codeintel_generation", "hash": "ci-42"}],
            "buildToolchainEvidenceRefs": [{"kind": "compile_commands", "hash": "cc-1"}],
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["projectionHash"]


def _candidate_id_for_manifest(projection_hash):
    spec = CandidateSpecManifest(
        sourceSplitIdentityHash="source-split-1",
        selectedTargetIdentityHash="target-1",
        projectionHash=projection_hash,
        roleGenerationPackageHashes=["role-shared", "role-device"],
        generatedArtifactHash="artifact-1",
        generatedRoles={
            "device": {
                "role": "device",
                "path": ".synthi/gpu_hmr/candidates/placeholder/device.hip",
                "contentHash": "device-content",
                "internal": True,
            }
        },
        sourceToGeneratedMappingHash="mapping-1",
    )
    return spec.candidate_id()


def _prepare_generated_candidate(client, projection_hash):
    preview = client.post(
        "/gpu-hmr/prepare-candidate",
        json={
            "projectionHash": projection_hash,
            "sourceSplitIdentityHash": "source-split-1",
            "requestedRoles": ["shared", "device"],
            "roleGenerationPackageHashes": ["role-shared", "role-device"],
            "generatedArtifactHash": "artifact-1",
            "generatedRoles": {
                "device": {
                    "role": "device",
                    "path": ".synthi/gpu_hmr/candidates/placeholder/device.hip",
                    "contentHash": "device-content",
                    "internal": True,
                }
            },
            "sourceToGeneratedMappingHash": "mapping-1",
            "idempotencyKey": "ws:prepare:bad-path",
        },
    )
    assert preview.status_code == 422, preview.text
    assert preview.json()["error"]["code"] == "generated.path_traversal_rejected"

    candidate_id = _candidate_id_for_manifest(projection_hash)
    response = client.post(
        "/gpu-hmr/prepare-candidate",
        json={
            "projectionHash": projection_hash,
            "sourceSplitIdentityHash": "source-split-1",
            "requestedRoles": ["shared", "device"],
            "roleGenerationPackageHashes": ["role-shared", "role-device"],
            "generatedArtifactHash": "artifact-1",
            "generatedRoles": {
                "device": {
                    "role": "device",
                    "path": f".synthi/gpu_hmr/candidates/{candidate_id}/device.hip",
                    "contentHash": "device-content",
                    "internal": True,
                }
            },
            "sourceToGeneratedMappingHash": "mapping-1",
            "idempotencyKey": "ws:prepare:generated",
        },
    )
    assert response.status_code == 202, response.text
    return response.json()


def test_readiness_and_projection_routes_are_identity_scoped():
    client = _client()

    blocked = client.post("/gpu-hmr/readiness", json={"entryFile": "src/main.cpp"})
    assert blocked.status_code == 200, blocked.text
    blocked_body = blocked.json()
    assert blocked_body["readiness"]["preflight"] == "blocked"
    assert "target_resolution_unmatched" in blocked_body["blockingReasonCodes"]

    projection_hash = _create_projection(client)

    ready = client.post(
        "/gpu-hmr/readiness",
        json={
            "selectedTargetIdentityHash": "target-1",
            "sourceSplitIdentityHash": "source-split-1",
            "projectionHash": projection_hash,
            "codeIntelGeneration": "ci-42",
            "buildMetadataHash": "build-meta-1",
        },
    )
    assert ready.status_code == 200, ready.text
    assert ready.json()["readiness"]["scope"] == "pass"

    fetched = client.get(f"/gpu-hmr/projections/{projection_hash}")
    assert fetched.status_code == 200, fetched.text
    assert fetched.json()["projectionHash"] == projection_hash


def test_projection_idempotency_conflict_is_rejected():
    client = _client()
    _create_projection(client)

    conflict = client.post(
        "/gpu-hmr/projections",
        json={
            "sourceSplitIdentityHash": "different-source",
            "selectedTargetIdentityHash": "target-1",
            "codeIntelGeneration": "ci-42",
            "buildMetadataHash": "build-meta-1",
            "idempotencyKey": "ws:projection:1",
        },
    )
    assert conflict.status_code == 409, conflict.text
    assert conflict.json()["error"]["code"] == "gpu_hmr.idempotency_key_conflict"


def test_prepare_candidate_requires_fresh_projection_identity():
    client = _client()
    projection_hash = _create_projection(client)

    stale = client.post(
        "/gpu-hmr/prepare-candidate",
        json={
            "projectionHash": projection_hash,
            "sourceSplitIdentityHash": "stale-source",
            "requestedRoles": ["device"],
            "operationMode": "normal",
            "idempotencyKey": "ws:prepare:stale",
        },
    )
    assert stale.status_code == 409, stale.text
    assert stale.json()["error"]["code"] == "candidate.stale_source_generation"


def test_candidate_lifecycle_routes_fail_closed_until_deterministic_proof_exists():
    client = _client()
    projection_hash = _create_projection(client)

    prepared = client.post(
        "/gpu-hmr/prepare-candidate",
        json={
            "projectionHash": projection_hash,
            "sourceSplitIdentityHash": "source-split-1",
            "requestedRoles": ["device"],
            "operationMode": "normal",
            "idempotencyKey": "ws:prepare:plain",
        },
    )
    assert prepared.status_code == 202, prepared.text
    plain_candidate_id = prepared.json()["candidateId"]

    missing_spec = client.post(
        f"/gpu-hmr/candidates/{plain_candidate_id}/verify",
        json={
            "candidateSpecManifestHash": "missing",
            "verificationKinds": ["schema"],
            "idempotencyKey": "ws:verify:missing",
        },
    )
    assert missing_spec.status_code == 422, missing_spec.text
    assert missing_spec.json()["error"]["code"] == "candidate.spec_manifest_missing"

    generated = _prepare_generated_candidate(client, projection_hash)
    candidate_id = generated["candidateId"]
    spec_hash = generated["candidateSpecManifestHash"]

    listed = client.get("/gpu-hmr/candidates", params={"selectedTargetIdentityHash": "target-1"})
    assert listed.status_code == 200, listed.text
    assert any(item["candidateId"] == candidate_id for item in listed.json()["candidates"])

    verify = client.post(
        f"/gpu-hmr/candidates/{candidate_id}/verify",
        json={
            "candidateSpecManifestHash": spec_hash,
            "verificationKinds": ["schema", "scope", "mapping"],
            "idempotencyKey": "ws:verify:schema",
        },
    )
    assert verify.status_code == 200, verify.text
    verify_body = verify.json()
    assert verify_body["state"] == "schema_verified_candidate"
    assert verify_body["blockingReasonCodes"] == []

    compile_verify = client.post(
        f"/gpu-hmr/candidates/{candidate_id}/verify",
        json={
            "candidateSpecManifestHash": spec_hash,
            "verificationKinds": ["compile"],
            "idempotencyKey": "ws:verify:compile",
        },
    )
    assert compile_verify.status_code == 200, compile_verify.text
    assert compile_verify.json()["state"] == "rejected_candidate"
    assert compile_verify.json()["blockingReasonCodes"] == ["verifier.proof_unavailable"]

    promote = client.post(
        f"/gpu-hmr/candidates/{candidate_id}/promote",
        json={
            "candidateSpecManifestHash": spec_hash,
            "candidateVerificationRecordHash": compile_verify.json()["candidateVerificationRecordHash"],
            "promotionIdentityHash": "promotion-1",
            "idempotencyKey": "ws:promote:blocked",
        },
    )
    assert promote.status_code == 422, promote.text
    assert promote.json()["error"]["code"] == "candidate.verification_failed_closed"

    candidate = client.get(f"/gpu-hmr/candidates/{candidate_id}")
    assert candidate.status_code == 200, candidate.text
    assert candidate.json()["state"] == "rejected_candidate"

    trace = client.get(f"/gpu-hmr/candidates/{candidate_id}/trace")
    assert trace.status_code == 200, trace.text
    assert trace.json()["events"]

    diagnostics = client.post(
        f"/gpu-hmr/candidates/{candidate_id}/diagnose",
        json={"idempotencyKey": "ws:diagnose:1"},
    )
    assert diagnostics.status_code == 202, diagnostics.text
    job_id = diagnostics.json()["jobId"]

    job = client.get(f"/gpu-hmr/jobs/{job_id}")
    assert job.status_code == 200, job.text
    assert job.json()["status"] == "succeeded"

    job_trace = client.get(f"/gpu-hmr/jobs/{job_id}/trace")
    assert job_trace.status_code == 200, job_trace.text
    assert job_trace.json()["events"]

    job_cancel = client.post(f"/gpu-hmr/jobs/{job_id}/cancel", json={"idempotencyKey": "ws:job-cancel:1"})
    assert job_cancel.status_code == 409, job_cancel.text
    assert job_cancel.json()["error"]["code"] == "job_not_cancellable"

    accepted = client.get("/gpu-hmr/accepted/current")
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["acceptedPointer"] is None


def test_candidate_reverify_preserves_highest_verified_state(monkeypatch):
    client = _client()
    projection_hash = _create_projection(client)
    generated = _prepare_generated_candidate(client, projection_hash)
    candidate_id = generated["candidateId"]
    spec_hash = generated["candidateSpecManifestHash"]
    broker = get_gpu_hmr_broker()

    def pass_verifier(candidate, kind, runtime_verification_identity_hash):
        return VerifierReport(
            verifierName=kind,
            candidateId=candidate.candidateId,
            candidateSpecManifestHash=str(candidate.candidateSpecManifestHash),
            inputIdentitySnapshot={
                "sourceSplitIdentityHash": candidate.sourceSplitIdentityHash,
                "compileCandidateIdentityHash": None,
                "runtimeVerificationIdentityHash": runtime_verification_identity_hash,
                "codeIntelGeneration": "ci-42",
                "retrievalTraceHashes": [],
            },
            status="pass",
            blocking=True,
            reasonCodes=[],
            proofRefs=[{"kind": f"{kind}_proof", "hash": f"{kind}-hash"}],
            toolVersion="test",
        )

    monkeypatch.setattr(broker, "_run_verifier", pass_verifier)

    runtime_verify = client.post(
        f"/gpu-hmr/candidates/{candidate_id}/verify",
        json={
            "candidateSpecManifestHash": spec_hash,
            "verificationKinds": ["schema", "compile", "runtime"],
            "runtimeVerificationIdentityHash": "runtime-1",
            "idempotencyKey": "ws:verify:runtime-pass",
        },
    )
    assert runtime_verify.status_code == 200, runtime_verify.text
    assert runtime_verify.json()["state"] == "runtime_verified_candidate"
    runtime_report_hashes = set(runtime_verify.json()["verifierReportHashes"])
    assert len(runtime_report_hashes) == 3

    schema_verify = client.post(
        f"/gpu-hmr/candidates/{candidate_id}/verify",
        json={
            "candidateSpecManifestHash": spec_hash,
            "verificationKinds": ["schema"],
            "idempotencyKey": "ws:verify:schema-after-runtime",
        },
    )
    assert schema_verify.status_code == 200, schema_verify.text
    assert schema_verify.json()["state"] == "runtime_verified_candidate"
    assert runtime_report_hashes.issubset(set(schema_verify.json()["verifierReportHashes"]))

    promote = client.post(
        f"/gpu-hmr/candidates/{candidate_id}/promote",
        json={
            "candidateSpecManifestHash": spec_hash,
            "candidateVerificationRecordHash": schema_verify.json()["candidateVerificationRecordHash"],
            "promotionIdentityHash": "promotion-1",
            "idempotencyKey": "ws:promote:after-narrow-reverify",
        },
    )
    assert promote.status_code == 200, promote.text


def test_candidate_cancel_route_is_idempotent():
    client = _client()
    projection_hash = _create_projection(client)
    prepared = client.post(
        "/gpu-hmr/prepare-candidate",
        json={
            "projectionHash": projection_hash,
            "sourceSplitIdentityHash": "source-split-1",
            "requestedRoles": ["device"],
            "idempotencyKey": "ws:prepare:cancel",
        },
    )
    candidate_id = prepared.json()["candidateId"]

    cancel = client.post(f"/gpu-hmr/candidates/{candidate_id}/cancel", json={"idempotencyKey": "ws:cancel:1"})
    assert cancel.status_code == 200, cancel.text
    assert cancel.json()["state"] == "cancelled_candidate"

    repeated = client.post(f"/gpu-hmr/candidates/{candidate_id}/cancel", json={"idempotencyKey": "ws:cancel:1"})
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["state"] == "cancelled_candidate"
