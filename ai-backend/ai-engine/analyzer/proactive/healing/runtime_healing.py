"""
Runtime Exception Healing.

Catches and heals runtime errors (not just compile-time), including:
- Unhandled exceptions from dev server / HMR
- Console errors from browser runtime
- Node.js process crashes
- Test runner failures
- Stack trace analysis for runtime bugs

This module:
1. Ingests runtime error events (from terminal, browser, HMR)
2. Deduplicates repeated errors
3. Correlates to source files via stack traces
4. Triggers the healing pipeline if the error is actionable
5. Tracks which runtime errors were auto-healed
"""

from __future__ import annotations

import hashlib
import logging
import re
import time
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

logger = logging.getLogger("healing.runtime")


# ── Types ─────────────────────────────────────────────────────────────

class RuntimeErrorSource(str, Enum):
    """Where the runtime error originated."""
    DEV_SERVER = "dev_server"
    HMR = "hmr"
    BROWSER_CONSOLE = "browser_console"
    NODE_PROCESS = "node_process"
    TERMINAL = "terminal"
    TEST_RUNNER = "test_runner"
    BUILD_WATCH = "build_watch"
    CUSTOM = "custom"


class RuntimeErrorSeverity(str, Enum):
    FATAL = "fatal"        # Process crash
    ERROR = "error"        # Unhandled exception
    WARNING = "warning"    # Caught but concerning
    INFO = "info"          # Informational (e.g., deprecation)


class HealingDecision(str, Enum):
    HEAL = "heal"
    SUPPRESS = "suppress"    # Known benign, ignore
    ESCALATE = "escalate"    # Too risky for auto-fix
    DEFER = "defer"          # Rate limited, try later
    DUPLICATE = "duplicate"  # Already being healed


@dataclass
class StackFrame:
    """Parsed stack frame."""
    file_path: str
    line: int
    column: int = 0
    function_name: str = ""
    is_internal: bool = False   # Node/browser internal frame
    is_node_module: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "filePath": self.file_path,
            "line": self.line,
            "column": self.column,
            "functionName": self.function_name,
            "isInternal": self.is_internal,
            "isNodeModule": self.is_node_module,
        }


@dataclass
class RuntimeError_:
    """A structured runtime error event."""
    id: str
    message: str
    source: RuntimeErrorSource
    severity: RuntimeErrorSeverity = RuntimeErrorSeverity.ERROR
    error_type: str = ""          # e.g., "TypeError", "ReferenceError"
    raw_output: str = ""
    stack_frames: List[StackFrame] = field(default_factory=list)
    file_path: str = ""           # Primary file (from top user frame)
    line: int = 0
    timestamp: float = field(default_factory=time.time)
    workspace_id: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)

    @property
    def fingerprint(self) -> str:
        """Unique signature for deduplication."""
        key = f"{self.error_type}:{self.message}:{self.file_path}:{self.line}"
        return hashlib.sha256(key.encode()).hexdigest()[:16]

    @property
    def top_user_frame(self) -> Optional[StackFrame]:
        """First stack frame that is in user code (not internal/node_module)."""
        for frame in self.stack_frames:
            if not frame.is_internal and not frame.is_node_module:
                return frame
        return None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "message": self.message[:500],
            "source": self.source.value,
            "severity": self.severity.value,
            "errorType": self.error_type,
            "stackFrames": [f.to_dict() for f in self.stack_frames[:10]],
            "filePath": self.file_path,
            "line": self.line,
            "fingerprint": self.fingerprint,
            "timestamp": self.timestamp,
        }


@dataclass
class RuntimeHealingResult:
    """Result of processing a runtime error."""
    error_id: str
    decision: HealingDecision
    reason: str = ""
    episode_id: str = ""   # If healing was triggered, the repair episode ID
    suppression_rule: str = ""
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "errorId": self.error_id,
            "decision": self.decision.value,
            "reason": self.reason,
            "episodeId": self.episode_id,
            "suppressionRule": self.suppression_rule,
        }


# ── Stack Trace Parser ────────────────────────────────────────────────

class StackTraceParser:
    """
    Parses stack traces from various runtimes into structured frames.

    Supports:
    - Node.js / V8 stack traces
    - Browser (Chrome, Firefox, Safari)
    - Python tracebacks
    - Go panic traces
    """

    # V8 / Node.js: "    at functionName (file:line:col)"
    _V8_FRAME = re.compile(
        r'^\s+at\s+(?:(.+?)\s+\()?([^():]+):(\d+):(\d+)\)?$',
        re.MULTILINE,
    )

    # V8 anonymous: "    at file:line:col"
    _V8_ANON = re.compile(
        r'^\s+at\s+([^():]+):(\d+):(\d+)$',
        re.MULTILINE,
    )

    # Python: '  File "path", line N, in func'
    _PYTHON_FRAME = re.compile(
        r'^\s*File "([^"]+)", line (\d+)(?:, in (\w+))?',
        re.MULTILINE,
    )

    # Firefox: "functionName@file:line:col"
    _FIREFOX_FRAME = re.compile(
        r'^(.+?)@([^@:]+):(\d+):(\d+)$',
        re.MULTILINE,
    )

    # Go: "goroutine N [...] file.go:line"
    _GO_FRAME = re.compile(
        r'^\s*(.+\.go):(\d+)',
        re.MULTILINE,
    )

    # Error type extractor
    _ERROR_TYPE = re.compile(
        r'^((?:Uncaught\s+)?(?:\w+Error|\w+Exception|TypeError|ReferenceError|SyntaxError|RangeError))',
        re.MULTILINE,
    )

    def parse(self, stack_text: str) -> Tuple[str, List[StackFrame]]:
        """
        Parse a stack trace string.

        Returns:
            (error_type, list of StackFrame)
        """
        frames: List[StackFrame] = []

        # Extract error type
        error_type = ""
        type_match = self._ERROR_TYPE.search(stack_text)
        if type_match:
            error_type = type_match.group(1)

        # Try V8 format first (most common)
        for match in self._V8_FRAME.finditer(stack_text):
            func_name = match.group(1) or "<anonymous>"
            file_path = match.group(2)
            line = int(match.group(3))
            col = int(match.group(4))

            frames.append(StackFrame(
                file_path=file_path,
                line=line,
                column=col,
                function_name=func_name,
                is_internal=self._is_internal_frame(file_path),
                is_node_module="node_modules" in file_path,
            ))

        # Try Python format
        if not frames:
            for match in self._PYTHON_FRAME.finditer(stack_text):
                frames.append(StackFrame(
                    file_path=match.group(1),
                    line=int(match.group(2)),
                    function_name=match.group(3) or "",
                    is_internal=self._is_internal_frame(match.group(1)),
                ))

        # Try Firefox format
        if not frames:
            for match in self._FIREFOX_FRAME.finditer(stack_text):
                frames.append(StackFrame(
                    file_path=match.group(2),
                    line=int(match.group(3)),
                    column=int(match.group(4)),
                    function_name=match.group(1),
                    is_internal=self._is_internal_frame(match.group(2)),
                ))

        # Try Go format
        if not frames:
            for match in self._GO_FRAME.finditer(stack_text):
                frames.append(StackFrame(
                    file_path=match.group(1),
                    line=int(match.group(2)),
                ))

        return error_type, frames

    @staticmethod
    def _is_internal_frame(path: str) -> bool:
        """Is this an internal runtime frame?"""
        internals = [
            "internal/", "node:", "<anonymous>",
            "native ", "bootstrap_node",
            "timers.js", "events.js",
            "next/dist/", "webpack/",
        ]
        path_lower = path.lower()
        return any(i in path_lower for i in internals)


# ── Error Deduplicator ────────────────────────────────────────────────

class ErrorDeduplicator:
    """
    Deduplicates runtime errors to avoid healing the same issue repeatedly.

    Uses fingerprinting (error type + message + file + line) and tracks
    occurrence counts. Only triggers healing on the first occurrence
    within a cooldown window.
    """

    def __init__(
        self,
        cooldown_sec: float = 30.0,
        max_occurrences: int = 5,
    ):
        self._cooldown = cooldown_sec
        self._max_occ = max_occurrences
        # fingerprint -> (last_seen, count, first_error_id)
        self._seen: Dict[str, Tuple[float, int, str]] = {}

    def check(self, error: RuntimeError_) -> Tuple[bool, str]:
        """
        Check if this error is a duplicate.

        Returns:
            (is_new, reason)
            is_new=True means this should be processed.
        """
        fp = error.fingerprint
        now = time.time()

        if fp in self._seen:
            last_seen, count, first_id = self._seen[fp]

            if now - last_seen < self._cooldown:
                self._seen[fp] = (now, count + 1, first_id)
                return False, f"Duplicate within cooldown (seen {count + 1}x)"

            if count >= self._max_occ:
                self._seen[fp] = (now, count + 1, first_id)
                return False, f"Exceeded max occurrences ({count + 1})"

            # Cooldown expired, treat as new wave
            self._seen[fp] = (now, 1, error.id)
            return True, "New wave after cooldown"

        self._seen[fp] = (now, 1, error.id)
        return True, "First occurrence"

    def reset(self) -> None:
        self._seen.clear()

    def cleanup_stale(self, max_age_sec: float = 300.0) -> int:
        now = time.time()
        stale = [
            fp for fp, (ts, _, _) in self._seen.items()
            if now - ts > max_age_sec
        ]
        for fp in stale:
            del self._seen[fp]
        return len(stale)


# ── Suppression Rules ─────────────────────────────────────────────────

@dataclass
class SuppressionRule:
    """A rule for suppressing known-benign runtime errors."""
    name: str
    pattern: re.Pattern
    source: Optional[RuntimeErrorSource] = None
    reason: str = ""
    expires_at: float = 0.0  # 0 = never expires

    def matches(self, error: RuntimeError_) -> bool:
        if self.source and error.source != self.source:
            return False
        if self.expires_at and time.time() > self.expires_at:
            return False
        return bool(self.pattern.search(error.message) or
                     self.pattern.search(error.raw_output))


# Default suppression rules for common benign errors
DEFAULT_SUPPRESSIONS: List[SuppressionRule] = [
    SuppressionRule(
        name="hmr_update",
        pattern=re.compile(r"HMR.*update|hot.*reload.*applied", re.I),
        reason="HMR update is normal operation",
    ),
    SuppressionRule(
        name="react_dev_warning",
        pattern=re.compile(r"Warning:.*ReactDOM|findDOMNode is deprecated", re.I),
        source=RuntimeErrorSource.BROWSER_CONSOLE,
        reason="React dev mode warning, not an error",
    ),
    SuppressionRule(
        name="source_map_warning",
        pattern=re.compile(r"source map|sourceMappingURL", re.I),
        reason="Source map warnings are benign",
    ),
    SuppressionRule(
        name="favicon_404",
        pattern=re.compile(r"favicon\.ico.*404|GET.*favicon.*not found", re.I),
        reason="Missing favicon is cosmetic",
    ),
    SuppressionRule(
        name="websocket_disconnect",
        pattern=re.compile(r"WebSocket.*closed|connection.*reset", re.I),
        reason="WebSocket disconnect during dev is transient",
    ),
    SuppressionRule(
        name="experimental_warning",
        pattern=re.compile(r"ExperimentalWarning|--experimental", re.I),
        source=RuntimeErrorSource.NODE_PROCESS,
        reason="Node.js experimental feature warning",
    ),
]


# ── Runtime Healing Engine ────────────────────────────────────────────

class RuntimeHealingEngine:
    """
    Main engine for runtime error healing.

    Flow:
    1. Ingest error event (from terminal, browser, HMR)
    2. Parse stack trace
    3. Check suppression rules
    4. Deduplicate
    5. Decide: heal / suppress / escalate / defer
    6. If heal → trigger diagnosis + repair pipeline
    """

    def __init__(
        self,
        stack_parser: Optional[StackTraceParser] = None,
        deduplicator: Optional[ErrorDeduplicator] = None,
        suppressions: Optional[List[SuppressionRule]] = None,
        heal_callback: Optional[Callable] = None,
        max_concurrent_heals: int = 3,
        rate_limit_per_min: int = 10,
    ):
        self._parser = stack_parser or StackTraceParser()
        self._dedup = deduplicator or ErrorDeduplicator()
        self._suppressions = suppressions or list(DEFAULT_SUPPRESSIONS)
        self._heal_callback = heal_callback
        self._max_concurrent = max_concurrent_heals
        self._rate_limit = rate_limit_per_min

        # Tracking
        self._active_heals: Set[str] = set()   # fingerprints being healed
        self._recent_heals: List[float] = []    # timestamps for rate limiting
        self._stats = {
            "total_ingested": 0,
            "healed": 0,
            "suppressed": 0,
            "deduplicated": 0,
            "escalated": 0,
            "deferred": 0,
        }

    def ingest(
        self,
        message: str,
        source: RuntimeErrorSource,
        raw_output: str = "",
        severity: RuntimeErrorSeverity = RuntimeErrorSeverity.ERROR,
        workspace_id: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> RuntimeHealingResult:
        """
        Ingest a runtime error and decide what to do.

        Returns a RuntimeHealingResult with the decision.
        """
        self._stats["total_ingested"] += 1

        # Parse stack trace
        full_text = raw_output or message
        error_type, frames = self._parser.parse(full_text)

        # Build structured error
        error_id = f"rte_{int(time.time() * 1000)}_{self._stats['total_ingested']}"
        error = RuntimeError_(
            id=error_id,
            message=message[:1000],
            source=source,
            severity=severity,
            error_type=error_type,
            raw_output=raw_output[:5000],
            stack_frames=frames,
            workspace_id=workspace_id,
            metadata=metadata or {},
        )

        # Set primary file/line from top user frame
        top = error.top_user_frame
        if top:
            error.file_path = top.file_path
            error.line = top.line

        # Step 1: Check suppression rules
        for rule in self._suppressions:
            if rule.matches(error):
                self._stats["suppressed"] += 1
                return RuntimeHealingResult(
                    error_id=error_id,
                    decision=HealingDecision.SUPPRESS,
                    reason=rule.reason,
                    suppression_rule=rule.name,
                )

        # Step 2: Deduplicate
        is_new, dedup_reason = self._dedup.check(error)
        if not is_new:
            self._stats["deduplicated"] += 1
            return RuntimeHealingResult(
                error_id=error_id,
                decision=HealingDecision.DUPLICATE,
                reason=dedup_reason,
            )

        # Step 3: Rate limit check
        if self._is_rate_limited():
            self._stats["deferred"] += 1
            return RuntimeHealingResult(
                error_id=error_id,
                decision=HealingDecision.DEFER,
                reason=f"Rate limited ({self._rate_limit}/min)",
            )

        # Step 4: Concurrency check
        if len(self._active_heals) >= self._max_concurrent:
            self._stats["deferred"] += 1
            return RuntimeHealingResult(
                error_id=error_id,
                decision=HealingDecision.DEFER,
                reason=f"Max concurrent heals ({self._max_concurrent})",
            )

        # Step 5: Check if error is actionable
        if not error.file_path:
            self._stats["escalated"] += 1
            return RuntimeHealingResult(
                error_id=error_id,
                decision=HealingDecision.ESCALATE,
                reason="No user code found in stack trace",
            )

        # Step 6: Trigger healing
        self._active_heals.add(error.fingerprint)
        self._recent_heals.append(time.time())
        self._stats["healed"] += 1

        episode_id = ""
        if self._heal_callback:
            try:
                result = self._heal_callback(error)
                if isinstance(result, str):
                    episode_id = result
                elif isinstance(result, dict):
                    episode_id = result.get("episodeId", "")
            except Exception as e:
                logger.error(f"Heal callback failed: {e}")
                self._active_heals.discard(error.fingerprint)

        return RuntimeHealingResult(
            error_id=error_id,
            decision=HealingDecision.HEAL,
            reason=f"Runtime {error_type or 'error'} in {error.file_path}:{error.line}",
            episode_id=episode_id,
        )

    def mark_heal_complete(self, fingerprint: str) -> None:
        """Mark a healing attempt as complete."""
        self._active_heals.discard(fingerprint)

    def add_suppression(self, rule: SuppressionRule) -> None:
        """Add a suppression rule."""
        self._suppressions.append(rule)

    def remove_suppression(self, name: str) -> bool:
        """Remove a suppression rule by name."""
        before = len(self._suppressions)
        self._suppressions = [r for r in self._suppressions if r.name != name]
        return len(self._suppressions) < before

    def _is_rate_limited(self) -> bool:
        """Check if we've exceeded the rate limit."""
        now = time.time()
        cutoff = now - 60
        self._recent_heals = [t for t in self._recent_heals if t > cutoff]
        return len(self._recent_heals) >= self._rate_limit

    @property
    def stats(self) -> Dict[str, Any]:
        return {
            **self._stats,
            "activeHeals": len(self._active_heals),
            "suppressionRules": len(self._suppressions),
        }

    def reset_stats(self) -> None:
        for key in self._stats:
            self._stats[key] = 0


# ── Module-level singleton ────────────────────────────────────────────

_runtime_engine: Optional[RuntimeHealingEngine] = None


def get_runtime_healing_engine(**kwargs) -> RuntimeHealingEngine:
    global _runtime_engine
    if _runtime_engine is None:
        _runtime_engine = RuntimeHealingEngine(**kwargs)
    return _runtime_engine


def reset_runtime_healing() -> None:
    global _runtime_engine
    _runtime_engine = None
