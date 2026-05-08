"""
Workspace Analyzer - Multi-File Analysis Coordinator

This module provides workspace-level code analysis that:
1. Analyzes multiple files efficiently with incremental updates
2. Tracks dependencies between files
3. Detects cross-file issues
4. Generates multi-file suggestions
5. Optimizes AI calls to avoid sending all files constantly

Key optimization strategies:
- Content hashing for change detection
- Dependency-aware incremental analysis
- Batched AI analysis with context windowing
- Priority queue for analysis (focus file first)
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from .cache import AnalysisCache
from .dependency_tracker import DependencyTracker, get_dependency_tracker
from .hunk_applier import (
    Hunk as ApplierHunk,
    HunkApplicationError,
    apply_hunks,
    content_hash as compute_content_hash,
)
from .orchestrator import ProactiveAnalyzer
from .types import (
    AnalysisTier,
    CodeFix,
    CrossFileReference,
    Diagnostic,
    DiagnosticCategory,
    DiagnosticLocation,
    FileAnalysisResult,
    FileChange,
    FileContext,
    FileDependency,
    FileEdit,
    MultiFileDiagnostic,
    MultiFileFix,
    Severity,
    TierResult,
    WorkspaceAnalysisRequest,
    WorkspaceAnalysisResult,
    WorkspaceSuggestion,
)


class HunkResolutionError(Exception):
    """Raised when a FileChange carrying hunks cannot be resolved to content.

    The HTTP layer should map this to 409 with a machine-readable code so
    the frontend can drop its baseline and resend full content.
    """

    def __init__(self, code: str, message: str, path: str):
        super().__init__(message)
        self.code = code
        self.path = path


@dataclass
class FileAnalysisState:
    """Tracks analysis state for a single file."""
    path: str
    content_hash: str
    language: str
    last_analyzed: float = 0.0
    diagnostics: List[MultiFileDiagnostic] = field(default_factory=list)
    from_cache: bool = False


class WorkspaceAnalyzer:
    """
    Main coordinator for workspace-level analysis.
    
    Provides:
    - Incremental multi-file analysis
    - Cross-file issue detection
    - Smart AI analysis batching
    - Suggestion generation
    """
    
    def __init__(
        self,
        cache: Optional[AnalysisCache] = None,
        llm_provider=None,
        enable_ai: bool = True,
        ai_min_confidence: float = 0.6,
        max_ai_files: int = 5,  # Max files to send to AI at once
        max_ai_context_chars: int = 50000,  # Max chars for AI context
    ):
        self._cache = cache or AnalysisCache()
        self._single_file_analyzer = ProactiveAnalyzer(
            cache=self._cache,
            llm_provider=llm_provider,
            enable_ai=enable_ai,
            ai_min_confidence=ai_min_confidence,
        )
        self._dependency_tracker = get_dependency_tracker()
        self._llm_provider = llm_provider
        self._enable_ai = enable_ai
        self._ai_min_confidence = ai_min_confidence
        self._max_ai_files = max_ai_files
        self._max_ai_context_chars = max_ai_context_chars
        
        # Workspace state
        # workspace_id -> {path -> FileAnalysisState}
        self._workspace_states: Dict[str, Dict[str, FileAnalysisState]] = defaultdict(dict)
        # Last-known full content per file, indexed by workspace.
        # Hunk-only requests apply against this; full-content requests refresh it.
        # workspace_id -> {path -> content}
        self._workspace_base_content: Dict[str, Dict[str, str]] = defaultdict(dict)

    def _store_base_content(self, workspace_id: str, path: str, content: str) -> None:
        self._workspace_base_content[workspace_id][path] = content

    def _get_base_content(self, workspace_id: str, path: str) -> Optional[str]:
        return self._workspace_base_content.get(workspace_id, {}).get(path)

    def _drop_base_content(self, workspace_id: str, path: str) -> None:
        bucket = self._workspace_base_content.get(workspace_id)
        if bucket is not None:
            bucket.pop(path, None)

    def _materialize_changes(
        self,
        workspace_id: str,
        changes: List[FileChange],
    ) -> None:
        """Resolve hunk-only FileChanges to full content in-place.

        For each change:
          - If full content is provided, refresh the stored baseline.
          - If only hunks are provided, look up the baseline (verifying
            base_hash if given), apply hunks, verify the resulting hash,
            and write the reconstructed content back to change.content
            so the rest of the pipeline sees a normal full-content change.
          - If hunks are present but no usable baseline exists, raise
            HunkResolutionError so the client can fall back to full content.

        Deletions are passed through unchanged and the baseline is dropped.
        """
        if not changes:
            return

        for change in changes:
            if change.change_type == "deleted":
                self._drop_base_content(workspace_id, change.path)
                continue

            if change.content is not None:
                # Full content is authoritative. Refresh baseline.
                self._store_base_content(workspace_id, change.path, change.content)
                continue

            if not change.hunks:
                # Neither content nor hunks — nothing to materialize. Earlier
                # code paths handle this (skipped from analysis) so leave as-is.
                continue

            base = self._get_base_content(workspace_id, change.path)
            if base is None:
                raise HunkResolutionError(
                    code="BASELINE_MISSING",
                    message=(
                        f"No stored baseline for {change.path} in workspace "
                        f"{workspace_id}; client must resend full content."
                    ),
                    path=change.path,
                )

            if change.base_hash is not None:
                actual_base_hash = compute_content_hash(base)
                if actual_base_hash != change.base_hash:
                    # Drop the diverged baseline so a future full-content
                    # request can establish a clean baseline again.
                    self._drop_base_content(workspace_id, change.path)
                    raise HunkResolutionError(
                        code="BASELINE_MISMATCH",
                        message=(
                            f"Stored baseline for {change.path} hashes to "
                            f"{actual_base_hash} but client expected "
                            f"{change.base_hash}; client must resend full content."
                        ),
                        path=change.path,
                    )

            try:
                applier_hunks = [
                    ApplierHunk(
                        start_line=h.start_line,
                        end_line=h.end_line,
                        new_lines=h.new_lines,
                    )
                    for h in change.hunks
                ]
                new_content = apply_hunks(base, applier_hunks)
            except HunkApplicationError as e:
                self._drop_base_content(workspace_id, change.path)
                raise HunkResolutionError(
                    code="HUNK_APPLY_FAILED",
                    message=f"Cannot apply hunks to {change.path}: {e}",
                    path=change.path,
                )

            actual_new_hash = compute_content_hash(new_content)
            if change.content_hash and actual_new_hash != change.content_hash:
                # The applied result does not match what the client claimed.
                # Drop baseline and signal so the client resends full content.
                self._drop_base_content(workspace_id, change.path)
                raise HunkResolutionError(
                    code="POST_APPLY_HASH_MISMATCH",
                    message=(
                        f"Applied hunks for {change.path} produced hash "
                        f"{actual_new_hash} but client claimed {change.content_hash}."
                    ),
                    path=change.path,
                )

            change.content = new_content
            self._store_base_content(workspace_id, change.path, new_content)

    async def analyze(
        self,
        request: WorkspaceAnalysisRequest,
    ) -> WorkspaceAnalysisResult:
        """
        Perform workspace-level analysis.

        This is the main entry point for multi-file analysis.
        """
        start_time = time.perf_counter()

        # Resolve any hunk-only changes to full content. Also refreshes the
        # baseline store from full-content payloads so subsequent hunk-only
        # requests have something to apply against. Raises HunkResolutionError
        # on irrecoverable mismatch — the API layer maps this to 409.
        self._materialize_changes(request.workspace_id, request.changed_files or [])

        # Refresh baselines from any full-content all_files payloads too, so
        # the very first incremental request after a full analyze can use hunks.
        for f in request.all_files or []:
            self._store_base_content(request.workspace_id, f.path, f.content)

        result = WorkspaceAnalysisResult(
            workspace_id=request.workspace_id,
        )

        # Step 1: Update dependency graph and determine what needs analysis
        files_to_analyze = await self._determine_analysis_scope(request)
        
        # Step 2: Run static + semantic analysis on each file
        static_semantic_results = await self._run_static_semantic_analysis(
            files_to_analyze,
            request,
        )
        
        # Step 3: If AI is enabled, run batched AI analysis
        if request.include_ai and self._enable_ai:
            ai_results = await self._run_ai_analysis(
                files_to_analyze,
                static_semantic_results,
                request,
            )
            # Merge AI results
            for path, diags in ai_results.items():
                if path in static_semantic_results:
                    static_semantic_results[path].diagnostics.extend(diags)
        
        # Step 4: Detect cross-file issues
        cross_file_diags = self._detect_cross_file_issues(
            static_semantic_results,
            request.all_files,
        )
        
        # Step 5: Generate suggestions
        suggestions = self._generate_suggestions(
            static_semantic_results,
            cross_file_diags,
            request.all_files,
        )
        
        # Step 6: Build result
        result.files = {
            path: FileAnalysisResult(
                file_path=path,
                content_hash=state.content_hash,
                language=state.language,
                diagnostics=state.diagnostics[:request.max_diagnostics_per_file],
                from_cache=state.from_cache,
                elapsed_ms=0.0,
            )
            for path, state in static_semantic_results.items()
        }
        result.cross_file_diagnostics = cross_file_diags
        result.suggestions = suggestions
        result.dependencies = self._dependency_tracker.get_all_dependencies()
        result.total_elapsed_ms = (time.perf_counter() - start_time) * 1000
        result.files_analyzed = len(files_to_analyze)
        result.files_from_cache = sum(1 for s in static_semantic_results.values() if s.from_cache)
        
        # Update workspace state
        self._workspace_states[request.workspace_id] = static_semantic_results
        
        return result
    
    async def analyze_incremental(
        self,
        request: WorkspaceAnalysisRequest,
    ) -> WorkspaceAnalysisResult:
        """
        Perform incremental workspace analysis.

        Only analyzes files that changed and their dependents.
        Much faster than full analysis for typical edit scenarios.
        """
        start_time = time.perf_counter()

        # Resolve hunk-only changes into full content first. After this
        # returns, every change in request.changed_files either has
        # change.content set (added/modified) or is a deletion.
        self._materialize_changes(request.workspace_id, request.changed_files or [])

        # Refresh baselines from any full-content all_files payloads.
        for f in request.all_files or []:
            self._store_base_content(request.workspace_id, f.path, f.content)

        # Get previous state
        prev_state = self._workspace_states.get(request.workspace_id, {})
        
        result = WorkspaceAnalysisResult(
            workspace_id=request.workspace_id,
        )
        
        # Determine which files actually changed
        changed_paths = set()
        for change in request.changed_files:
            if change.change_type == "deleted":
                self._dependency_tracker.remove_file(change.path)
                prev_state.pop(change.path, None)
            else:
                old_state = prev_state.get(change.path)
                # CRITICAL: Always re-analyze if content_hash differs OR if we have new content
                # This ensures we analyze the latest content even if hashing differs
                if not old_state or old_state.content_hash != change.content_hash:
                    changed_paths.add(change.path)
                    print(f"[WorkspaceAnalyzer] File changed: {change.path}")
                    print(f"  Old hash: {old_state.content_hash if old_state else 'N/A'}")
                    print(f"  New hash: {change.content_hash}")
                    if change.content:
                        print(f"  Content preview: {change.content[:100]}...")
        
        if not changed_paths:
            # No changes - return cached results
            result.files = {
                path: FileAnalysisResult(
                    file_path=path,
                    content_hash=state.content_hash,
                    language=state.language,
                    diagnostics=state.diagnostics,
                    from_cache=True,
                    elapsed_ms=0.0,
                )
                for path, state in prev_state.items()
            }
            result.total_elapsed_ms = (time.perf_counter() - start_time) * 1000
            return result
        
        # Find all files that need re-analysis (changed + dependents)
        files_to_analyze: Set[str] = set()
        
        for path in changed_paths:
            files_to_analyze.add(path)
            if request.analyze_dependents:
                # Get files that import the changed file
                dependents = self._dependency_tracker.get_dependents(path)
                files_to_analyze.update(dependents)
        
        # Filter to only files we have content for. Changed files count as
        # having content because materialize_changes already resolved any
        # hunk-only payloads into change.content.
        files_with_content = {f.path for f in request.all_files}
        for change in request.changed_files:
            if change.change_type != "deleted" and change.content is not None:
                files_with_content.add(change.path)
        files_to_analyze &= files_with_content
        
        # Get optimal analysis order
        analysis_order = self._dependency_tracker.get_analysis_order(files_to_analyze)
        
        # Build file contexts for analysis
        file_map = {f.path: f for f in request.all_files}
        
        # Ensure changed files are in the map (using content from change)
        # This is critical because request.all_files might be truncated/sliced
        for change in request.changed_files:
            if change.change_type != "deleted" and change.content is not None:
                file_map[change.path] = FileContext(
                    path=change.path,
                    content=change.content,
                    language=change.language or "plaintext",
                )
        
        files_to_process = [file_map[p] for p in analysis_order if p in file_map]
        
        # Run analysis on changed files
        print(f"[WorkspaceAnalyzer] Analyzing {len(files_to_process)} changed files")
        for f in files_to_process:
            print(f"  - {f.path} ({len(f.content)} chars) Hash: {hashlib.md5(f.content.encode()).hexdigest()[:8]}")
            
        new_results = await self._run_static_semantic_analysis(
            files_to_process,
            request,
        )
        
        # Run AI analysis if enabled (only on focus file + related)
        if request.include_ai and self._enable_ai and request.focus_file:
            print(f"[WorkspaceAnalyzer] Running AI analysis for focus file: {request.focus_file}")
            ai_results = await self._run_ai_analysis(
                files_to_process,
                new_results,
                request,
            )
            for path, diags in ai_results.items():
                if path in new_results:
                    new_results[path].diagnostics.extend(diags)
        
        # Merge with unchanged files
        merged_state = dict(prev_state)
        merged_state.update(new_results)
        
        # Ensure we have a complete list of files for cross-file analysis
        # Start with request.all_files
        cross_analysis_files = list(request.all_files)
        files_in_list = {f.path for f in cross_analysis_files}
        
        # Add changed files if not present
        for change in request.changed_files:
            if change.change_type != "deleted" and change.content is not None and change.path not in files_in_list:
                cross_analysis_files.append(FileContext(
                    path=change.path,
                    content=change.content,
                    language=change.language or "plaintext",
                ))
        
        # Detect cross-file issues
        cross_file_diags = self._detect_cross_file_issues(
            merged_state,
            cross_analysis_files,
        )
        
        # Generate suggestions
        suggestions = self._generate_suggestions(
            merged_state,
            cross_file_diags,
            cross_analysis_files,
        )
        
        # Build result
        result.files = {
            path: FileAnalysisResult(
                file_path=path,
                content_hash=state.content_hash,
                language=state.language,
                diagnostics=state.diagnostics[:request.max_diagnostics_per_file],
                from_cache=state.from_cache,
                elapsed_ms=0.0,
            )
            for path, state in merged_state.items()
        }
        result.cross_file_diagnostics = cross_file_diags
        result.suggestions = suggestions
        result.dependencies = self._dependency_tracker.get_all_dependencies()
        result.total_elapsed_ms = (time.perf_counter() - start_time) * 1000
        result.files_analyzed = len(files_to_analyze)
        result.files_from_cache = len(merged_state) - len(files_to_analyze)
        
        # Update workspace state
        self._workspace_states[request.workspace_id] = merged_state
        
        return result
    
    async def _determine_analysis_scope(
        self,
        request: WorkspaceAnalysisRequest,
    ) -> List[FileContext]:
        """Determine which files need to be analyzed."""
        if request.incremental and request.changed_files:
            # Incremental: analyze changed files + dependents
            changed_paths = {c.path for c in request.changed_files if c.change_type != "deleted"}
            
            files_to_analyze = set(changed_paths)
            
            if request.analyze_dependents:
                for path in changed_paths:
                    dependents = self._dependency_tracker.get_dependents(path)
                    files_to_analyze.update(dependents)
            
            # Filter to files we have content for
            file_map = {f.path: f for f in request.all_files}
            return [file_map[p] for p in files_to_analyze if p in file_map]
        else:
            # Full analysis
            return request.all_files
    
    async def _run_static_semantic_analysis(
        self,
        files: List[FileContext],
        request: WorkspaceAnalysisRequest,
    ) -> Dict[str, FileAnalysisState]:
        """
        Run static and semantic analysis on files.
        
        Runs in parallel for efficiency.
        """
        results: Dict[str, FileAnalysisState] = {}
        
        # Update dependency tracker
        for file in files:
            self._dependency_tracker.update_file(file)
        
        # Create analysis tasks
        tasks = []
        for file in files:
            task = self._analyze_single_file(file, request)
            tasks.append((file.path, task))
        
        # Run in parallel
        for path, task in tasks:
            try:
                state = await task
                results[path] = state
            except Exception as e:
                # Don't fail entire analysis for one file error
                results[path] = FileAnalysisState(
                    path=path,
                    content_hash="error",
                    language="unknown",
                    diagnostics=[
                        MultiFileDiagnostic(
                            primary_file=path,
                            message=f"Analysis error: {str(e)}",
                            severity=Severity.ERROR,
                            tier=AnalysisTier.STATIC,
                            location=DiagnosticLocation(0, 0, 0, 0),
                            code="ANALYSIS_ERROR",
                            category=DiagnosticCategory.SYNTAX,
                        )
                    ],
                )
        
        return results
    
    async def _analyze_single_file(
        self,
        file: FileContext,
        request: WorkspaceAnalysisRequest,
    ) -> FileAnalysisState:
        """Analyze a single file with static + semantic tiers."""
        # Use the single-file analyzer
        tier_result = await self._single_file_analyzer.analyze_quick(file)
        
        # Convert to multi-file diagnostics
        multi_diags = [
            MultiFileDiagnostic(
                primary_file=file.path,
                message=d.message,
                severity=d.severity,
                tier=d.tier,
                location=d.location,
                code=d.code,
                category=d.category,
                source=d.source,
                fixes=[
                    MultiFileFix(
                        description=f.description,
                        edits=[FileEdit(
                            file_path=file.path,
                            location=f.location,
                            new_text=f.replacement_text,
                        )],
                        is_preferred=f.is_preferred,
                    )
                    for f in d.fixes
                ],
                explanation=d.explanation,
                confidence=d.confidence,
                originalText=d.originalText,
            )
            for d in tier_result.diagnostics
        ]
        
        return FileAnalysisState(
            path=file.path,
            content_hash=file.content_hash,
            language=file.language,
            last_analyzed=time.time(),
            diagnostics=multi_diags,
            from_cache=tier_result.from_cache,
        )
    
    async def _run_ai_analysis(
        self,
        files: List[FileContext],
        static_results: Dict[str, FileAnalysisState],
        request: WorkspaceAnalysisRequest,
    ) -> Dict[str, List[MultiFileDiagnostic]]:
        """
        Run AI analysis on files with smart batching.
        
        Optimizations:
        - Prioritize focus file
        - Limit context size
        - Include only relevant related files
        - Skip files with no static issues (lower priority)
        """
        if not self._llm_provider:
            return {}
        
        results: Dict[str, List[MultiFileDiagnostic]] = {}
        
        # Prioritize files for AI analysis
        priority_files = self._prioritize_for_ai(files, static_results, request)
        
        if not priority_files:
            return {}
        
        # Build context for AI
        ai_context = self._build_ai_context(priority_files, files)
        
        # Run AI analysis
        try:
            ai_diags = await self._run_multi_file_ai(ai_context, request)
            
            # Group results by file
            for diag in ai_diags:
                if diag.primary_file not in results:
                    results[diag.primary_file] = []
                results[diag.primary_file].append(diag)
                
        except Exception as e:
            # print(f"[WorkspaceAnalyzer] AI analysis failed: {e}")
            pass
        
        return results
    
    def _prioritize_for_ai(
        self,
        files: List[FileContext],
        static_results: Dict[str, FileAnalysisState],
        request: WorkspaceAnalysisRequest,
    ) -> List[FileContext]:
        """
        Prioritize which files should be sent to AI.
        
        Priority factors:
        1. Focus file (currently being edited)
        2. Files with existing issues
        3. Files related to focus file
        """
        priority = []
        file_map = {f.path: f for f in files}
        
        # 1. Focus file first
        if request.focus_file and request.focus_file in file_map:
            priority.append(file_map[request.focus_file])
        
        # 2. Files with errors/warnings
        files_with_issues = [
            file_map[path]
            for path, state in static_results.items()
            if path in file_map and any(
                d.severity in (Severity.ERROR, Severity.WARNING)
                for d in state.diagnostics
            )
        ]
        for f in files_with_issues:
            if f not in priority:
                priority.append(f)
        
        # 3. Related files (imports/dependents of focus file)
        if request.focus_file:
            related = self._dependency_tracker.get_related_files(request.focus_file)
            for path in related:
                if path in file_map and file_map[path] not in priority:
                    priority.append(file_map[path])
        
        # Limit to max files
        return priority[:self._max_ai_files]
    
    def _build_ai_context(
        self,
        priority_files: List[FileContext],
        all_files: List[FileContext],
    ) -> List[FileContext]:
        """
        Build the context to send to AI.
        
        Ensures we stay within token limits while providing useful context.
        """
        context = []
        total_chars = 0
        
        # Add priority files first
        for file in priority_files:
            file_chars = len(file.content)
            if total_chars + file_chars <= self._max_ai_context_chars:
                context.append(file)
                total_chars += file_chars
            else:
                # Trim large files
                remaining = self._max_ai_context_chars - total_chars
                if remaining > 1000:  # Worth including partial
                    trimmed = FileContext(
                        path=file.path,
                        content=file.content[:remaining] + "\n// ... (truncated)",
                        language=file.language,
                    )
                    context.append(trimmed)
                break
        
        return context
    
    async def _run_multi_file_ai(
        self,
        files: List[FileContext],
        request: WorkspaceAnalysisRequest,
    ) -> List[MultiFileDiagnostic]:
        """
        Run AI analysis on multiple files.
        
        Uses a specialized prompt for multi-file analysis.
        """
        from .ai_predictor import AIErrorPredictor
        
        if not files:
            return []
        
        # Focus on the first file (highest priority)
        focus_file = files[0]
        related_files = files[1:]
        
        # Create AI predictor with provider
        predictor = AIErrorPredictor(
            provider=self._llm_provider,
            min_confidence=self._ai_min_confidence,
        )
        
        # Get existing diagnostics to avoid duplicates
        existing_diags: List[Diagnostic] = []
        
        # Run analysis
        print(f"[AI Predictor] Analyzing {focus_file.path} with {len(related_files)} related files")
        print(f"[AI Predictor] Focus file content preview: {focus_file.content[:100]}...")
        
        result = await predictor.analyze(
            focus_file,
            related_files,
            existing_diags,
        )
        
        # Convert to multi-file diagnostics
        multi_diags = []
        for d in result.diagnostics:
            multi_diag = MultiFileDiagnostic(
                primary_file=focus_file.path,
                message=d.message,
                severity=d.severity,
                tier=d.tier,
                location=d.location,
                code=d.code,
                category=d.category,
                source=d.source,
                fixes=[
                    MultiFileFix(
                        description=f.description,
                        edits=[FileEdit(
                            file_path=focus_file.path,
                            location=f.location,
                            new_text=f.replacement_text,
                        )],
                        is_preferred=f.is_preferred,
                    )
                    for f in d.fixes
                ],
                explanation=d.explanation,
                confidence=d.confidence,
                originalText=d.originalText,
            )
            multi_diags.append(multi_diag)
        
        return multi_diags
    
    def _detect_cross_file_issues(
        self,
        file_results: Dict[str, FileAnalysisState],
        all_files: List[FileContext],
    ) -> List[MultiFileDiagnostic]:
        """
        Detect issues that span multiple files.
        
        Examples:
        - Missing imports
        - Circular dependencies
        - Unused exports
        - Type mismatches across files
        """
        cross_file_diags: List[MultiFileDiagnostic] = []
        
        # Check for circular dependencies
        circular = self._detect_circular_dependencies()
        cross_file_diags.extend(circular)
        
        # Check for broken imports
        broken_imports = self._detect_broken_imports(all_files)
        cross_file_diags.extend(broken_imports)
        
        return cross_file_diags
    
    def _detect_circular_dependencies(self) -> List[MultiFileDiagnostic]:
        """Detect circular import dependencies."""
        diags = []
        visited = set()
        
        for path in self._dependency_tracker._nodes:
            cycle = self._find_cycle(path, [], visited)
            if cycle:
                diags.append(MultiFileDiagnostic(
                    primary_file=cycle[0],
                    message=f"Circular dependency detected: {' → '.join(cycle)}",
                    severity=Severity.WARNING,
                    tier=AnalysisTier.SEMANTIC,
                    location=DiagnosticLocation(0, 0, 0, 0),
                    code="CIRCULAR_DEP",
                    category=DiagnosticCategory.BEST_PRACTICE,
                    cross_file_refs=[
                        CrossFileReference(
                            file_path=p,
                            location=DiagnosticLocation(0, 0, 0, 0),
                            message=f"Part of cycle at position {i+1}",
                        )
                        for i, p in enumerate(cycle[1:])
                    ],
                ))
        
        return diags
    
    def _find_cycle(
        self,
        start: str,
        path: List[str],
        visited: Set[str],
    ) -> Optional[List[str]]:
        """Find a cycle starting from a node using DFS."""
        if start in visited:
            return None
        
        if start in path:
            cycle_start = path.index(start)
            return path[cycle_start:] + [start]
        
        node = self._dependency_tracker._nodes.get(start)
        if not node:
            return None
        
        path = path + [start]
        
        for imported in node.imports:
            cycle = self._find_cycle(imported, path, visited)
            if cycle:
                return cycle
        
        visited.add(start)
        return None
    
    def _detect_broken_imports(
        self,
        all_files: List[FileContext],
    ) -> List[MultiFileDiagnostic]:
        """Detect imports that don't resolve to any file."""
        diags = []
        known_paths = {f.path for f in all_files}
        
        for path, node in self._dependency_tracker._nodes.items():
            for i, imported in enumerate(node.imports):
                # Check if import resolves to a known file
                if imported not in known_paths and not imported.startswith("node_modules"):
                    raw_import = node.raw_imports[i] if i < len(node.raw_imports) else imported
                    diags.append(MultiFileDiagnostic(
                        primary_file=path,
                        message=f"Cannot resolve import '{raw_import}'",
                        severity=Severity.ERROR,
                        tier=AnalysisTier.SEMANTIC,
                        location=DiagnosticLocation(0, 0, 0, 0),  # Would need to find actual line
                        code="UNRESOLVED_IMPORT",
                        category=DiagnosticCategory.UNDEFINED_VARIABLE,
                    ))
        
        return diags
    
    def _generate_suggestions(
        self,
        file_results: Dict[str, FileAnalysisState],
        cross_file_diags: List[MultiFileDiagnostic],
        all_files: List[FileContext],
    ) -> List[WorkspaceSuggestion]:
        """
        Generate workspace-level suggestions.
        
        Looks for patterns that could be improved across multiple files.
        """
        suggestions: List[WorkspaceSuggestion] = []
        
        # Group similar issues across files
        issue_groups = self._group_similar_issues(file_results)
        
        for issue_type, files_with_issue in issue_groups.items():
            if len(files_with_issue) >= 2:
                # Suggest batch fix for repeated issues
                suggestions.append(WorkspaceSuggestion(
                    id=f"batch-fix-{issue_type}",
                    title=f"Fix {issue_type} in {len(files_with_issue)} files",
                    description=f"The same issue '{issue_type}' appears in multiple files. Apply a batch fix to resolve them all.",
                    category="fix",
                    severity=Severity.INFO,
                    affected_files=files_with_issue,
                    related_diagnostic_codes=[issue_type],
                ))
        
        # Suggest refactoring for circular dependencies
        if any(d.code == "CIRCULAR_DEP" for d in cross_file_diags):
            affected = set()
            for d in cross_file_diags:
                if d.code == "CIRCULAR_DEP":
                    affected.add(d.primary_file)
                    for ref in d.cross_file_refs:
                        affected.add(ref.file_path)
            
            suggestions.append(WorkspaceSuggestion(
                id="refactor-circular-deps",
                title="Refactor circular dependencies",
                description="Circular dependencies can cause issues with module loading and make the codebase harder to understand. Consider extracting shared code into a separate module.",
                category="refactor",
                severity=Severity.WARNING,
                affected_files=list(affected),
                related_diagnostic_codes=["CIRCULAR_DEP"],
            ))
        
        return suggestions
    
    def _group_similar_issues(
        self,
        file_results: Dict[str, FileAnalysisState],
    ) -> Dict[str, List[str]]:
        """Group similar issues across files."""
        groups: Dict[str, List[str]] = defaultdict(list)
        
        for path, state in file_results.items():
            for diag in state.diagnostics:
                groups[diag.code].append(path)
        
        return groups
    
    def clear_workspace(self, workspace_id: str):
        """Clear all cached state for a workspace."""
        self._workspace_states.pop(workspace_id, None)
        self._workspace_base_content.pop(workspace_id, None)
    
    def get_workspace_stats(self, workspace_id: str) -> Dict[str, Any]:
        """Get statistics for a workspace."""
        state = self._workspace_states.get(workspace_id, {})
        return {
            "files": len(state),
            "total_diagnostics": sum(len(s.diagnostics) for s in state.values()),
            "dependency_stats": self._dependency_tracker.stats(),
        }


# Singleton instance
_workspace_analyzer: Optional[WorkspaceAnalyzer] = None


def get_workspace_analyzer(
    llm_provider=None,
    enable_ai: bool = True,
) -> WorkspaceAnalyzer:
    """Get or create the workspace analyzer singleton."""
    global _workspace_analyzer
    
    if _workspace_analyzer is None or (llm_provider is not None):
        _workspace_analyzer = WorkspaceAnalyzer(
            llm_provider=llm_provider,
            enable_ai=enable_ai,
        )
    
    return _workspace_analyzer
