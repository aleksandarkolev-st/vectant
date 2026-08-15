import pytest

from analyzer.proactive.healing.failure_distiller_adapters import AdapterContractError, normalize_adapter_observation


def test_browser_adapter_requires_replayable_trace_contract():
    with pytest.raises(AdapterContractError, match="browser workflow"):
        normalize_adapter_observation({"kind": "browser"})
    envelope = normalize_adapter_observation({
        "kind": "browser",
        "workflow": {
            "route": "/invite", "state_fixture": {"sso": True}, "device": "desktop",
            "viewport": {"width": 1280, "height": 720}, "steps": ["fill email", "submit"],
            "network_sequence": ["POST /invites missing"], "dom_transitions": ["modal:open", "modal:closed"],
            "source_events": ["InviteModal.onSubmit"], "console": ["invite dispatch omitted"],
        },
    })
    assert envelope.recording["route"] == "/invite"
    assert envelope.candidate_groups["steps"] == ["fill email", "submit"]


@pytest.mark.parametrize("observation", [
    {"kind": "native", "diagnostic": {"code": "E0425", "source_span": "main.rs:4:2"}},
    {"kind": "hmr", "hmr_events": ["check", "compile-error"]},
    {"kind": "gpu", "device_marker": "vulkan:0", "error_fingerprint": "VK_ERROR_DEVICE_LOST", "frame_states": ["0", "1:error"], "launch_parameters": {"samples": 4}},
])
def test_specialized_adapters_preserve_attested_signature_contracts(observation):
    envelope = normalize_adapter_observation(observation)
    assert envelope.kind == observation["kind"]


def test_hmr_adapter_rejects_nonterminal_recording():
    with pytest.raises(AdapterContractError, match="terminal"):
        normalize_adapter_observation({"kind": "hmr", "hmr_events": ["check", "building"]})


def test_browser_adapter_consumes_taught_workflow_contract_v7():
    envelope = normalize_adapter_observation({
        "kind": "browser", "viewport": {"width": 1280, "height": 720},
        "workflowContract": {
            "workflowId": "invite-flow", "appOrigin": "http://app.local", "routePattern": "/invite",
            "sourceIdentityCoverage": {"status": "complete", "linkedSteps": 1, "totalSteps": 1},
            "replayModes": ["ciIsolated"],
            "steps": [{"stepId": "submit", "label": "Submit invite", "sourcePlan": {"status": "linked", "filePath": "src/Invite.tsx", "line": 22}, "apiPlan": {"status": "observed", "method": "POST", "url": "/invites"}, "expectedEffects": ["modal closes"]}],
        },
    })
    assert envelope.recording["workflow_id"] == "invite-flow"
    assert envelope.recording["network_sequence"] == ["POST /invites"]
    assert envelope.recording["source_events"] == ["src/Invite.tsx:22"]


def test_browser_adapter_rejects_taught_contract_without_isolated_replay_or_source_identity():
    with pytest.raises(AdapterContractError, match="source identity"):
        normalize_adapter_observation({"kind": "browser", "workflowContract": {"workflowId": "bad", "appOrigin": "http://app", "sourceIdentityCoverage": {"status": "missing", "linkedSteps": 0}, "replayModes": ["ciIsolated"], "steps": []}})
