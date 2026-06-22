"""In-memory store for counterfactual telemetry v1.

The store keeps normalized telemetry objects and compact references. It is
deliberately not a source archive; full runner logs and large artifacts should
live behind raw artifact refs on BranchTrace or DetectorResult.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional

from .counterfactual_types import (
    BranchTrace,
    ChoiceScene,
    CounterfactualRun,
    DetectorResult,
    PolicyDelta,
)


@dataclass
class CounterfactualStore:
    runs: Dict[str, CounterfactualRun] = field(default_factory=dict)
    traces_by_run: Dict[str, List[BranchTrace]] = field(default_factory=dict)
    detectors_by_trace: Dict[str, List[DetectorResult]] = field(default_factory=dict)
    choice_scenes_by_run: Dict[str, List[ChoiceScene]] = field(default_factory=dict)
    policy_deltas_by_run: Dict[str, List[PolicyDelta]] = field(default_factory=dict)

    def put_run(self, run: CounterfactualRun) -> None:
        self.runs[run.run_id] = run

    def get_run(self, run_id: str) -> Optional[CounterfactualRun]:
        return self.runs.get(run_id)

    def add_branch_traces(self, run_id: str, traces: Iterable[BranchTrace]) -> None:
        known = self.traces_by_run.setdefault(run_id, [])
        by_id = {trace.id: idx for idx, trace in enumerate(known)}
        for trace in traces:
            if trace.id in by_id:
                known[by_id[trace.id]] = trace
            else:
                known.append(trace)

    def list_branch_traces(self, run_id: str) -> List[BranchTrace]:
        return list(self.traces_by_run.get(run_id, []))

    def add_detector_results(self, results: Iterable[DetectorResult]) -> None:
        for result in results:
            known = self.detectors_by_trace.setdefault(result.branch_trace_id, [])
            by_id = {detector.id: idx for idx, detector in enumerate(known)}
            if result.id in by_id:
                known[by_id[result.id]] = result
            else:
                known.append(result)

    def list_detector_results(self, branch_trace_id: str) -> List[DetectorResult]:
        return list(self.detectors_by_trace.get(branch_trace_id, []))

    def add_choice_scene(self, scene: ChoiceScene) -> None:
        self.choice_scenes_by_run.setdefault(scene.counterfactual_run_id, []).append(scene)

    def list_choice_scenes(self, run_id: str) -> List[ChoiceScene]:
        return list(self.choice_scenes_by_run.get(run_id, []))

    def add_policy_deltas(self, deltas: Iterable[PolicyDelta]) -> None:
        for delta in deltas:
            self.policy_deltas_by_run.setdefault(delta.source_counterfactual_run_id, []).append(delta)

    def list_policy_deltas(self, run_id: str) -> List[PolicyDelta]:
        return list(self.policy_deltas_by_run.get(run_id, []))

    def clear(self) -> None:
        self.runs.clear()
        self.traces_by_run.clear()
        self.detectors_by_trace.clear()
        self.choice_scenes_by_run.clear()
        self.policy_deltas_by_run.clear()


STORE = CounterfactualStore()
