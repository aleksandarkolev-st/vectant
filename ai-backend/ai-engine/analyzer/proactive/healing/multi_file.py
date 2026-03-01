"""
Multi-File Repair Coordinator.

Orchestrates repairs that span multiple files — the hard problem
that single-file fixers can't solve.

Architecture:
1. Takes a CauseGraph with multiple affected files
2. Builds a dependency-aware repair order
3. Plans patches for each file
4. Applies patches in topological order
5. Runs cross-file verification
6. Rolls back all-or-nothing on failure

Key insight: files must be patched in dependency order so that
downstream files see the updated API of upstream files.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

logger = logging.getLogger("healing.multi_file")


# ── Types ─────────────────────────────────────────────────────────────

class FileRepairStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    PATCHED = "patched"
    VERIFIED = "verified"
    FAILED = "failed"
    ROLLED_BACK = "rolled_back"


class CoordinationStrategy(str, Enum):
    """How to coordinate multi-file repairs."""
    SEQUENTIAL = "sequential"      # One file at a time, verify each
    BATCH = "batch"                # Apply all, verify once
    TOPOLOGICAL = "topological"    # Follow dependency graph order
    INDEPENDENT = "independent"    # Files are unrelated, parallel OK


@dataclass
class FilePatch:
    """A patch for a single file in a multi-file repair."""
    file_path: str
    original_content: str = ""
    patched_content: str = ""
    description: str = ""
    status: FileRepairStatus = FileRepairStatus.PENDING
    error: str = ""
    depends_on: List[str] = field(default_factory=list)  # file paths
    priority: int = 0  # lower = applied first

    def to_dict(self) -> Dict[str, Any]:
        return {
            "filePath": self.file_path,
            "description": self.description,
            "status": self.status.value,
            "error": self.error,
            "dependsOn": self.depends_on,
            "priority": self.priority,
            "hasOriginal": bool(self.original_content),
            "hasPatched": bool(self.patched_content),
        }


@dataclass
class MultiFileRepairPlan:
    """A coordinated plan for repairing multiple files."""
    plan_id: str
    files: Dict[str, FilePatch] = field(default_factory=dict)
    strategy: CoordinationStrategy = CoordinationStrategy.TOPOLOGICAL
    dependency_order: List[str] = field(default_factory=list)
    status: str = "created"  # created, executing, succeeded, failed, rolled_back
    started_at: float = 0.0
    finished_at: float = 0.0
    error: str = ""

    @property
    def file_count(self) -> int:
        return len(self.files)

    @property
    def duration_sec(self) -> float:
        if self.started_at:
            end = self.finished_at or time.time()
            return end - self.started_at
        return 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "planId": self.plan_id,
            "files": {k: v.to_dict() for k, v in self.files.items()},
            "strategy": self.strategy.value,
            "dependencyOrder": self.dependency_order,
            "status": self.status,
            "fileCount": self.file_count,
            "durationSec": round(self.duration_sec, 2),
            "error": self.error,
        }


# ── Dependency graph utilities ────────────────────────────────────────

class DependencyResolver:
    """
    Resolves file dependencies for repair ordering.

    Uses an external dependency graph function to determine
    which files depend on which, then computes topological order.
    """

    def __init__(
        self,
        dep_graph_fn: Optional[Callable] = None,
    ):
        # (file_path) -> list of files this file imports/depends on
        self._dep_graph_fn = dep_graph_fn

    def get_dependencies(self, file_path: str) -> List[str]:
        """Get files that file_path depends on."""
        if not self._dep_graph_fn:
            return []
        try:
            return self._dep_graph_fn(file_path)
        except Exception as e:
            logger.debug(f"Failed to get deps for {file_path}: {e}")
            return []

    def topological_sort(self, files: List[str]) -> List[str]:
        """
        Topological sort of files based on dependency relationships.

        Files that are depended upon come first (upstream → downstream).
        Falls back to original order on cycles.
        """
        file_set = set(files)

        # Build adjacency: file → set of files it depends on (that are in our set)
        deps: Dict[str, Set[str]] = {}
        for f in files:
            file_deps = set(self.get_dependencies(f)) & file_set
            deps[f] = file_deps

        # Kahn's algorithm
        in_degree: Dict[str, int] = {f: 0 for f in files}
        for f, d in deps.items():
            for dep in d:
                if dep in in_degree:
                    in_degree[f] += 1

        # But we want *depended-upon* files first.
        # Reverse: in_degree counts how many deps each file has.
        # Those with 0 deps go first.
        queue = [f for f in files if in_degree[f] == 0]
        result = []

        while queue:
            # Pick the one with lowest in-degree (most upstream)
            node = queue.pop(0)
            result.append(node)

            # "Remove" node → decrease in-degree for nodes that depend on it
            for f in files:
                if node in deps.get(f, set()):
                    in_degree[f] -= 1
                    if in_degree[f] == 0:
                        queue.append(f)

        # If cycle, add remaining in original order
        remaining = [f for f in files if f not in result]
        if remaining:
            logger.warning(f"Dependency cycle detected among: {remaining}")
            result.extend(remaining)

        return result

    def determine_strategy(
        self,
        files: List[str],
    ) -> CoordinationStrategy:
        """Determine the best coordination strategy for a file set."""
        if len(files) <= 1:
            return CoordinationStrategy.SEQUENTIAL

        # Check for dependencies between files
        file_set = set(files)
        has_deps = False

        for f in files:
            deps = set(self.get_dependencies(f)) & file_set
            if deps:
                has_deps = True
                break

        if has_deps:
            return CoordinationStrategy.TOPOLOGICAL
        else:
            return CoordinationStrategy.INDEPENDENT


# ── Multi-File Repair Coordinator ─────────────────────────────────────

class MultiFileCoordinator:
    """
    Coordinates multi-file repair operations.

    Process:
    1. Receive patches for multiple files
    2. Resolve dependency order
    3. Snapshot all files (for rollback)
    4. Apply patches in order
    5. Run cross-file verification
    6. Commit or rollback all
    """

    def __init__(
        self,
        dep_resolver: Optional[DependencyResolver] = None,
        read_file_fn: Optional[Callable] = None,
        write_file_fn: Optional[Callable] = None,
        verify_fn: Optional[Callable] = None,
        max_files: int = 10,
    ):
        self._resolver = dep_resolver or DependencyResolver()
        self._read_file = read_file_fn
        self._write_file = write_file_fn
        self._verify_fn = verify_fn
        self._max_files = max_files
        self._active_plans: Dict[str, MultiFileRepairPlan] = {}

    def create_plan(
        self,
        patches: List[FilePatch],
        strategy: Optional[CoordinationStrategy] = None,
    ) -> MultiFileRepairPlan:
        """
        Create a multi-file repair plan.

        Args:
            patches: Patches for each affected file.
            strategy: Override coordination strategy.

        Returns:
            A MultiFileRepairPlan ready for execution.
        """
        if len(patches) > self._max_files:
            raise ValueError(
                f"Too many files ({len(patches)}) exceeds limit ({self._max_files})"
            )

        plan_id = f"mfr_{int(time.time() * 1000)}"
        file_paths = [p.file_path for p in patches]

        # Determine strategy
        if strategy is None:
            strategy = self._resolver.determine_strategy(file_paths)

        # Compute dependency order
        if strategy == CoordinationStrategy.TOPOLOGICAL:
            dep_order = self._resolver.topological_sort(file_paths)
        else:
            dep_order = file_paths

        # Build file patches dict
        file_patches = {}
        for patch in patches:
            file_patches[patch.file_path] = patch

        # Set dependency info on patches
        for fp in dep_order:
            if fp in file_patches:
                deps = set(self._resolver.get_dependencies(fp)) & set(file_paths)
                file_patches[fp].depends_on = list(deps)

        plan = MultiFileRepairPlan(
            plan_id=plan_id,
            files=file_patches,
            strategy=strategy,
            dependency_order=dep_order,
        )

        self._active_plans[plan_id] = plan
        logger.info(
            f"Created multi-file plan {plan_id}: "
            f"{len(patches)} files, strategy={strategy.value}"
        )
        return plan

    async def execute(self, plan: MultiFileRepairPlan) -> MultiFileRepairPlan:
        """
        Execute a multi-file repair plan.

        Applies patches in dependency order, verifies, and rolls back on failure.
        """
        plan.started_at = time.time()
        plan.status = "executing"

        # Snapshot originals
        await self._snapshot_originals(plan)

        # Apply patches in order
        applied_files = []
        try:
            for file_path in plan.dependency_order:
                patch = plan.files.get(file_path)
                if not patch or not patch.patched_content:
                    continue

                patch.status = FileRepairStatus.IN_PROGRESS
                success = await self._apply_single_patch(patch)

                if success:
                    patch.status = FileRepairStatus.PATCHED
                    applied_files.append(file_path)
                else:
                    patch.status = FileRepairStatus.FAILED
                    if plan.strategy != CoordinationStrategy.INDEPENDENT:
                        # Roll back all on dependency-aware strategies
                        await self._rollback_all(plan, applied_files)
                        plan.status = "failed"
                        plan.error = f"Patch failed for {file_path}: {patch.error}"
                        plan.finished_at = time.time()
                        return plan

            # Verify all patches together
            if self._verify_fn and applied_files:
                verify_ok = await self._verify_all(plan, applied_files)
                if not verify_ok:
                    await self._rollback_all(plan, applied_files)
                    plan.status = "failed"
                    plan.error = "Cross-file verification failed"
                    plan.finished_at = time.time()
                    return plan

            # Mark verified
            for fp in applied_files:
                if fp in plan.files:
                    plan.files[fp].status = FileRepairStatus.VERIFIED

            plan.status = "succeeded"

        except Exception as e:
            logger.error(f"Multi-file repair failed: {e}")
            await self._rollback_all(plan, applied_files)
            plan.status = "failed"
            plan.error = str(e)[:500]

        plan.finished_at = time.time()
        return plan

    async def _snapshot_originals(self, plan: MultiFileRepairPlan) -> None:
        """Read original content for all files (for rollback)."""
        if not self._read_file:
            return

        for file_path, patch in plan.files.items():
            if not patch.original_content:
                try:
                    content = await self._read_file(file_path)
                    if isinstance(content, str):
                        patch.original_content = content
                except Exception as e:
                    logger.debug(f"Cannot read {file_path}: {e}")

    async def _apply_single_patch(self, patch: FilePatch) -> bool:
        """Apply a single file patch."""
        if not self._write_file:
            patch.error = "No write_file function configured"
            return False

        try:
            await self._write_file(patch.file_path, patch.patched_content)
            return True
        except Exception as e:
            patch.error = str(e)[:200]
            return False

    async def _verify_all(
        self,
        plan: MultiFileRepairPlan,
        applied_files: List[str],
    ) -> bool:
        """Run cross-file verification."""
        if not self._verify_fn:
            return True

        try:
            result = await self._verify_fn(applied_files)
            if isinstance(result, bool):
                return result
            if isinstance(result, dict):
                return result.get("passed", False)
            return True
        except Exception as e:
            logger.warning(f"Verification error: {e}")
            plan.error = f"Verification error: {e}"
            return False

    async def _rollback_all(
        self,
        plan: MultiFileRepairPlan,
        applied_files: List[str],
    ) -> None:
        """Rollback all applied patches."""
        if not self._write_file:
            return

        # Rollback in reverse order
        for file_path in reversed(applied_files):
            patch = plan.files.get(file_path)
            if not patch or not patch.original_content:
                continue

            try:
                await self._write_file(file_path, patch.original_content)
                patch.status = FileRepairStatus.ROLLED_BACK
            except Exception as e:
                logger.error(f"Rollback failed for {file_path}: {e}")
                patch.status = FileRepairStatus.FAILED
                patch.error = f"Rollback failed: {e}"

    def get_plan(self, plan_id: str) -> Optional[MultiFileRepairPlan]:
        return self._active_plans.get(plan_id)

    def list_plans(self) -> List[Dict[str, Any]]:
        return [
            {
                "planId": p.plan_id,
                "status": p.status,
                "fileCount": p.file_count,
                "strategy": p.strategy.value,
            }
            for p in self._active_plans.values()
        ]

    def cleanup(self, plan_id: str) -> None:
        self._active_plans.pop(plan_id, None)


# ── Change Impact Analyzer ────────────────────────────────────────────

class ChangeImpactAnalyzer:
    """
    Analyzes the impact of a code change across the project.

    Given a file change, determines:
    - Which other files import/use symbols from the changed file
    - Whether the change breaks the API contract
    - Which files need to be updated
    """

    def __init__(
        self,
        dep_graph_fn: Optional[Callable] = None,
        reverse_dep_fn: Optional[Callable] = None,
    ):
        # (file) -> files it depends on
        self._dep_graph_fn = dep_graph_fn
        # (file) -> files that depend on it
        self._reverse_dep_fn = reverse_dep_fn

    def analyze_impact(
        self,
        changed_file: str,
        change_description: str = "",
    ) -> Dict[str, Any]:
        """
        Analyze impact of a change to a file.

        Returns:
            Dict with impacted files and risk assessment.
        """
        direct_dependents = self._get_dependents(changed_file)
        transitive = self._get_transitive_dependents(changed_file, depth=3)

        return {
            "changedFile": changed_file,
            "directDependents": direct_dependents,
            "transitiveDependents": list(transitive - set(direct_dependents)),
            "totalImpactedFiles": len(transitive),
            "riskLevel": self._assess_risk(len(transitive)),
        }

    def _get_dependents(self, file_path: str) -> List[str]:
        """Get files that directly depend on file_path."""
        if not self._reverse_dep_fn:
            return []
        try:
            return self._reverse_dep_fn(file_path)
        except Exception:
            return []

    def _get_transitive_dependents(
        self,
        file_path: str,
        depth: int = 3,
    ) -> Set[str]:
        """Get all files that transitively depend on file_path."""
        visited = set()
        queue = [file_path]
        current_depth = 0

        while queue and current_depth < depth:
            next_queue = []
            for f in queue:
                if f in visited:
                    continue
                visited.add(f)
                dependents = self._get_dependents(f)
                next_queue.extend(
                    d for d in dependents if d not in visited
                )
            queue = next_queue
            current_depth += 1

        visited.discard(file_path)
        return visited

    def _assess_risk(self, impacted_count: int) -> str:
        if impacted_count == 0:
            return "none"
        elif impacted_count <= 3:
            return "low"
        elif impacted_count <= 10:
            return "medium"
        else:
            return "high"


# ── Module-level singletons ──────────────────────────────────────────

_coordinator: Optional[MultiFileCoordinator] = None
_impact_analyzer: Optional[ChangeImpactAnalyzer] = None


def get_multi_file_coordinator(**kwargs) -> MultiFileCoordinator:
    global _coordinator
    if _coordinator is None:
        _coordinator = MultiFileCoordinator(**kwargs)
    return _coordinator


def get_impact_analyzer(**kwargs) -> ChangeImpactAnalyzer:
    global _impact_analyzer
    if _impact_analyzer is None:
        _impact_analyzer = ChangeImpactAnalyzer(**kwargs)
    return _impact_analyzer


def reset_multi_file() -> None:
    global _coordinator, _impact_analyzer
    _coordinator = None
    _impact_analyzer = None
