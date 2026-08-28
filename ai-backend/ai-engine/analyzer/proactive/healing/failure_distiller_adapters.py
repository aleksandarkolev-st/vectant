"""Typed failure-adapter contracts for Failure Distiller.

The reducer deliberately does not guess how a browser trace, compiler
diagnostic, HMR stream, or GPU frame relates to a failure.  Each adapter
normalises only evidence it can validate and returns an explicit boundary
state for incomplete recordings.  This keeps adapter-specific signatures out
of the generic command reducer while giving callers one uniform envelope.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List


class AdapterContractError(ValueError):
    """The observation cannot safely be reduced by its declared adapter."""


@dataclass(frozen=True)
class AdapterEnvelope:
    kind: str
    recording: Dict[str, Any]
    candidate_groups: Dict[str, List[str]]


def _strings(value: Any, field: str, *, allow_empty: bool = False) -> List[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
        raise AdapterContractError(f"{field} must be a list of non-empty strings")
    result = [item.strip() for item in value]
    if not result and not allow_empty:
        raise AdapterContractError(f"{field} is required")
    return result


def _object(value: Any, field: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise AdapterContractError(f"{field} must be an object")
    return value


class FailureAdapter:
    kind = "command"

    def normalize(self, observation: Dict[str, Any]) -> AdapterEnvelope:
        return AdapterEnvelope(self.kind, {}, {})


class TestAdapter(FailureAdapter):
    kind = "test"

    def normalize(self, observation: Dict[str, Any]) -> AdapterEnvelope:
        target = observation.get("test_target", observation.get("testTarget"))
        if target is not None and (not isinstance(target, str) or not target.strip()):
            raise AdapterContractError("test_target must be a non-empty string")
        return AdapterEnvelope(self.kind, {"test_target": target.strip() if isinstance(target, str) else None}, {})


class BrowserAdapter(FailureAdapter):
    kind = "browser"

    def normalize(self, observation: Dict[str, Any]) -> AdapterEnvelope:
        contract = observation.get("workflow_contract", observation.get("workflowContract"))
        if contract is not None:
            return self._normalize_taught_contract(_object(contract, "browser workflow_contract"), observation)
        workflow = _object(observation.get("workflow"), "browser workflow")
        steps = _strings(workflow.get("steps"), "browser workflow.steps")
        network = _strings(workflow.get("network_sequence"), "browser workflow.network_sequence", allow_empty=True)
        transitions = _strings(workflow.get("dom_transitions"), "browser workflow.dom_transitions")
        source_events = _strings(workflow.get("source_events"), "browser workflow.source_events")
        viewport = _object(workflow.get("viewport"), "browser workflow.viewport")
        if not isinstance(viewport.get("width"), int) or not isinstance(viewport.get("height"), int):
            raise AdapterContractError("browser workflow.viewport requires integer width and height")
        route = workflow.get("route")
        if not isinstance(route, str) or not route.startswith("/"):
            raise AdapterContractError("browser workflow.route must be an absolute application route")
        return AdapterEnvelope(self.kind, {
            "route": route, "state_fixture": workflow.get("state_fixture", workflow.get("stateFixture", {})),
            "device": str(workflow.get("device", "desktop")), "viewport": {"width": viewport["width"], "height": viewport["height"]},
            "steps": steps, "network_sequence": network, "dom_transitions": transitions,
            "source_events": source_events, "console": _strings(workflow.get("console", []), "browser workflow.console", allow_empty=True),
        }, {"steps": steps, "network": network})

    def _normalize_taught_contract(self, contract: Dict[str, Any], observation: Dict[str, Any]) -> AdapterEnvelope:
        """Adapt Synthi Browser WorkflowContractV7 without loosening its gates."""
        workflow_id = contract.get("workflowId")
        origin = contract.get("appOrigin")
        route = contract.get("routePattern", "/")
        coverage = _object(contract.get("sourceIdentityCoverage"), "workflow_contract.sourceIdentityCoverage")
        replay_modes = _strings(contract.get("replayModes"), "workflow_contract.replayModes")
        steps_raw = contract.get("steps")
        if not isinstance(workflow_id, str) or not workflow_id or not isinstance(origin, str) or not origin:
            raise AdapterContractError("workflow_contract requires workflowId and appOrigin")
        if not isinstance(route, str) or not route.startswith("/"):
            raise AdapterContractError("workflow_contract.routePattern must be an absolute route")
        if coverage.get("status") == "missing" or not isinstance(coverage.get("linkedSteps"), int) or coverage["linkedSteps"] < 1:
            raise AdapterContractError("workflow_contract lacks source identity attribution")
        if "ciIsolated" not in replay_modes:
            raise AdapterContractError("workflow_contract is not eligible for isolated replay")
        if not isinstance(steps_raw, list) or not steps_raw:
            raise AdapterContractError("workflow_contract.steps is required")
        steps, source_events, network, transitions = [], [], [], []
        for step in steps_raw:
            item = _object(step, "workflow_contract step")
            step_id, label = item.get("stepId"), item.get("label")
            if not isinstance(step_id, str) or not step_id or not isinstance(label, str) or not label:
                raise AdapterContractError("workflow_contract steps require stepId and label")
            steps.append(step_id)
            source = _object(item.get("sourcePlan"), "workflow_contract step.sourcePlan")
            if source.get("status") == "linked":
                path = source.get("filePath")
                if not isinstance(path, str) or not path:
                    raise AdapterContractError("linked workflow sourcePlan requires filePath")
                source_events.append(f"{path}:{source.get('line', 0)}")
            api = item.get("apiPlan")
            if isinstance(api, dict) and api.get("status") == "observed" and isinstance(api.get("method"), str) and isinstance(api.get("url"), str):
                network.append(f"{api['method']} {api['url']}")
            transitions.extend(str(effect) for effect in item.get("expectedEffects", []) if isinstance(effect, str) and effect)
        if not source_events:
            raise AdapterContractError("workflow_contract has no linked source events")
        return AdapterEnvelope(self.kind, {
            "workflow_contract_version": "synthi.browser.workflow.v7", "workflow_id": workflow_id, "origin": origin, "route": route,
            "state_fixture": observation.get("state_fixture", observation.get("stateFixture", {})), "device": str(observation.get("device", "desktop")),
            "viewport": _object(observation.get("viewport", {"width": 1280, "height": 720}), "browser viewport"),
            "steps": steps, "network_sequence": network, "dom_transitions": transitions or ["workflow effect recorded"],
            "source_events": source_events, "console": _strings(observation.get("console", []), "browser console", allow_empty=True),
            "replay_mode": "ciIsolated",
        }, {"steps": steps, "network": network})


class NativeAdapter(FailureAdapter):
    kind = "native"

    def normalize(self, observation: Dict[str, Any]) -> AdapterEnvelope:
        diagnostic = _object(observation.get("diagnostic"), "native diagnostic")
        for key in ("code", "source_span"):
            if not isinstance(diagnostic.get(key), str) or not diagnostic[key].strip():
                raise AdapterContractError(f"native diagnostic.{key} is required")
        return AdapterEnvelope(self.kind, {"diagnostic": {"code": diagnostic["code"].strip(), "source_span": diagnostic["source_span"].strip()}, "compiler_flags": _strings(observation.get("compiler_flags", observation.get("compilerFlags", [])), "compiler_flags", allow_empty=True)}, {})


class HmrAdapter(FailureAdapter):
    kind = "hmr"

    def normalize(self, observation: Dict[str, Any]) -> AdapterEnvelope:
        events = _strings(observation.get("hmr_events", observation.get("hmrEvents")), "hmr_events")
        terminal = events[-1].lower()
        if terminal not in {"applied", "compile-error", "full-reload-required", "rejected", "discarded"}:
            raise AdapterContractError("hmr_events must end in a terminal HMR state")
        return AdapterEnvelope(self.kind, {"hmr_events": events, "terminal": terminal}, {"events": events})


class GpuAdapter(FailureAdapter):
    kind = "gpu"

    def normalize(self, observation: Dict[str, Any]) -> AdapterEnvelope:
        marker = observation.get("device_marker", observation.get("deviceMarker"))
        fingerprint = observation.get("error_fingerprint", observation.get("errorFingerprint"))
        frames = _strings(observation.get("frame_states", observation.get("frameStates")), "frame_states")
        if not isinstance(marker, str) or not marker.strip() or not isinstance(fingerprint, str) or not fingerprint.strip():
            raise AdapterContractError("GPU observation requires device_marker and error_fingerprint")
        return AdapterEnvelope(self.kind, {"device_marker": marker.strip(), "error_fingerprint": fingerprint.strip(), "frame_states": frames, "launch_parameters": _object(observation.get("launch_parameters", observation.get("launchParameters", {})), "launch_parameters")}, {"frames": frames})


ADAPTERS = {adapter.kind: adapter for adapter in (FailureAdapter(), TestAdapter(), BrowserAdapter(), NativeAdapter(), HmrAdapter(), GpuAdapter())}


def normalize_adapter_observation(observation: Dict[str, Any]) -> AdapterEnvelope:
    kind = str(observation.get("kind", observation.get("type", "command"))).strip().lower()
    adapter = ADAPTERS.get(kind)
    if adapter is None:
        raise AdapterContractError(f"unsupported failure adapter: {kind}")
    return adapter.normalize(observation)
