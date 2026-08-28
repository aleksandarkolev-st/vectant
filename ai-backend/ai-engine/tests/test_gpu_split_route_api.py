import asyncio
import hashlib
import json

import main


def _canonical_sha256(value):
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _classify(payload):
    request = main.AnalyzeRequest(**payload)
    return asyncio.run(main.classify_refactor_split_route(request))


def test_route_classifier_endpoint_is_registered():
    registered_paths = {
        route.path for route in main.app.routes if "POST" in getattr(route, "methods", set())
    }
    assert "/refactor/split/route" in registered_paths


def test_route_classifier_selects_gpu_from_build_evidence_without_provider(monkeypatch):
    def provider_must_not_be_selected(*_args, **_kwargs):
        raise AssertionError("route classification must not select an AI provider")

    monkeypatch.setattr(main, "get_provider", provider_must_not_be_selected)
    body = _classify(
        {
            "code": "int main() { return 0; }",
            "lang": "cpp",
            "focus": "src/main.cpp",
            "files": [
                {
                    "path": "CMakeLists.txt",
                    "content": "project(app LANGUAGES CXX)\nenable_language(HIP)\n",
                },
                {
                    "path": "src/main.cpp",
                    "content": "int main() { return 0; }",
                },
            ],
        }
    )

    assert body["selectedRoute"] == "gpu_split"
    assert body["detection"]["is_gpu"] is True
    assert body["detection"]["vendor_hint"] == "rocm"
    assert body["acceptedForGpuHmr"] is False
    assert body["gpuHmrSuccess"] is False
    assert body["canSatisfyRuntimeProof"] is False
    assert body["canSatisfyDispatchProof"] is False
    assert body["sourceManifestHash"] == _canonical_sha256(body["sourceManifest"])
    receipt_payload = {
        "schema_version": body["schemaVersion"],
        "proof_authority": body["proofAuthority"],
        "selected_route": body["selectedRoute"],
        "reason_code": body["reasonCode"],
        "source_manifest_hash": body["sourceManifestHash"],
        "detection": body["detection"],
    }
    assert body["classificationId"] == (
        "gpu-split-route-classification:" + _canonical_sha256(receipt_payload)
    )


def test_route_classifier_keeps_host_source_on_host_route(monkeypatch):
    def provider_must_not_be_selected(*_args, **_kwargs):
        raise AssertionError("route classification must not select an AI provider")

    monkeypatch.setattr(main, "get_provider", provider_must_not_be_selected)
    body = _classify(
        {
            "code": "int add(int a, int b) { return a + b; }",
            "lang": "cpp",
            "focus": "src/add.cpp",
            "files": [
                {
                    "path": "CMakeLists.txt",
                    "content": "# enable_language(HIP)\nproject(app LANGUAGES CXX)\n",
                },
                {
                    "path": "src/add.cpp",
                    "content": "int add(int a, int b) { return a + b; }",
                },
            ],
        }
    )

    assert body["selectedRoute"] == "host_split"
    assert body["detection"]["is_gpu"] is False
    assert body["reasonCode"] == "static_gpu_evidence_not_detected"
    assert body["sourceFileCount"] == 2
    assert body["sourceManifestHash"] == _canonical_sha256(body["sourceManifest"])


def test_route_receipt_changes_when_source_bytes_change():
    request = {
        "code": "__kernel void step(__global float* out) { out[0] = 1.0f; }",
        "lang": "opencl",
        "focus": "src/kernel.cl",
    }
    before = _classify(request)
    request["code"] = "__kernel void step(__global float* out) { out[0] = 2.0f; }"
    after = _classify(request)

    assert before["selectedRoute"] == "gpu_split"
    assert after["selectedRoute"] == "gpu_split"
    assert before["sourceManifestHash"] != after["sourceManifestHash"]
    assert before["classificationId"] != after["classificationId"]
