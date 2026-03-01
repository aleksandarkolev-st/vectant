"""
Verification Pipeline.

Post-fix verification stages that prove a fix actually works:
1. Syntax check (AST parse for supported languages)
2. Compile/build success check
3. Lint pass
4. Typecheck pass  
5. Targeted test execution (impacted tests first)
6. Behavioral smoke checks

A fix is only "healed" if verification passes.
Otherwise: auto-rollback and try next plan.

This is the line between "fix suggester" and "self-healing".
"""

from __future__ import annotations

import re
import asyncio
import hashlib
import logging
import subprocess
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger("healing.verification")


# ── Verification types ────────────────────────────────────────────────

class VerificationStage(str, Enum):
    """Stages of the verification pipeline."""
    SYNTAX = "syntax"
    COMPILE = "compile"
    LINT = "lint"
    TYPECHECK = "typecheck"
    TEST = "test"
    SMOKE = "smoke"


class VerificationStatus(str, Enum):
    """Status of a verification check."""
    PASSED = "passed"
    FAILED = "failed"
    SKIPPED = "skipped"
    TIMEOUT = "timeout"
    ERROR = "error"


@dataclass
class VerificationCheck:
    """Result of a single verification check."""
    stage: VerificationStage
    status: VerificationStatus
    message: str = ""
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    duration_ms: float = 0.0
    timestamp: float = field(default_factory=time.time)
    details: Dict[str, Any] = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return self.status == VerificationStatus.PASSED

    def to_dict(self) -> Dict[str, Any]:
        return {
            "stage": self.stage.value,
            "status": self.status.value,
            "message": self.message,
            "errors": self.errors,
            "warnings": self.warnings,
            "durationMs": round(self.duration_ms, 1),
            "timestamp": self.timestamp,
            "details": self.details,
        }


@dataclass
class VerificationPipelineResult:
    """Result of running the full verification pipeline."""
    checks: List[VerificationCheck] = field(default_factory=list)
    overall_passed: bool = False
    total_duration_ms: float = 0.0
    stages_run: int = 0
    stages_passed: int = 0
    stages_failed: int = 0
    stop_reason: str = ""  # Why the pipeline stopped (if early)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "checks": [c.to_dict() for c in self.checks],
            "overallPassed": self.overall_passed,
            "totalDurationMs": round(self.total_duration_ms, 1),
            "stagesRun": self.stages_run,
            "stagesPassed": self.stages_passed,
            "stagesFailed": self.stages_failed,
            "stopReason": self.stop_reason,
        }


# ── Verification configuration ───────────────────────────────────────

@dataclass
class VerificationConfig:
    """Configuration for the verification pipeline."""
    # Which stages to run and in what order
    stages: List[VerificationStage] = field(default_factory=lambda: [
        VerificationStage.SYNTAX,
        VerificationStage.COMPILE,
        VerificationStage.LINT,
        VerificationStage.TYPECHECK,
        VerificationStage.TEST,
    ])

    # Stop pipeline on first failure?
    fail_fast: bool = True

    # Per-stage timeouts (seconds)
    stage_timeouts: Dict[str, float] = field(default_factory=lambda: {
        "syntax": 5.0,
        "compile": 30.0,
        "lint": 15.0,
        "typecheck": 30.0,
        "test": 60.0,
        "smoke": 30.0,
    })

    # Total pipeline timeout (seconds)
    total_timeout: float = 120.0

    # Working directory for commands
    working_directory: Optional[str] = None

    # Custom commands per language per stage
    # Format: { "python": { "compile": "python -m py_compile {file}", ... } }
    custom_commands: Dict[str, Dict[str, str]] = field(default_factory=dict)

    # Environment variables for subprocess
    env_vars: Dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "stages": [s.value for s in self.stages],
            "failFast": self.fail_fast,
            "stageTimeouts": self.stage_timeouts,
            "totalTimeout": self.total_timeout,
            "workingDirectory": self.working_directory,
        }


# ── Language-specific verification commands ───────────────────────────

# Default commands per language per stage
_DEFAULT_COMMANDS: Dict[str, Dict[str, List[str]]] = {
    "python": {
        "compile": ["python", "-m", "py_compile", "{file}"],
        "lint": ["python", "-m", "flake8", "--max-line-length", "120", "{file}"],
        "typecheck": ["python", "-m", "mypy", "--ignore-missing-imports", "{file}"],
        "test": ["python", "-m", "pytest", "--tb=short", "-q", "{file}"],
    },
    "javascript": {
        "compile": ["node", "--check", "{file}"],
        "lint": ["npx", "eslint", "--no-eslintrc", "--rule", "{}", "{file}"],
        "typecheck": [],  # JS has no built-in typecheck
        "test": ["npx", "jest", "--bail", "--findRelatedTests", "{file}"],
    },
    "typescript": {
        "compile": ["npx", "tsc", "--noEmit", "--pretty", "{file}"],
        "lint": ["npx", "eslint", "{file}"],
        "typecheck": ["npx", "tsc", "--noEmit", "--pretty", "{file}"],
        "test": ["npx", "jest", "--bail", "--findRelatedTests", "{file}"],
    },
    "go": {
        "compile": ["go", "build", "./{dir}"],
        "lint": ["golangci-lint", "run", "{file}"],
        "typecheck": ["go", "vet", "./{dir}"],
        "test": ["go", "test", "-run", ".*", "./{dir}"],
    },
    "rust": {
        "compile": ["cargo", "check"],
        "lint": ["cargo", "clippy", "--", "-D", "warnings"],
        "typecheck": ["cargo", "check"],
        "test": ["cargo", "test"],
    },
    "java": {
        "compile": ["javac", "{file}"],
        "lint": [],
        "typecheck": ["javac", "{file}"],
        "test": [],
    },
}

# Language aliases
_LANG_ALIASES: Dict[str, str] = {
    "py": "python",
    "js": "javascript",
    "jsx": "javascript",
    "ts": "typescript",
    "tsx": "typescript",
    "rs": "rust",
}


# ── Syntax checker (in-process, no subprocess) ───────────────────────

class SyntaxChecker:
    """
    Fast in-process syntax check using language-native parsing.

    For Python: uses ast.parse()
    For JS/TS: basic bracket/paren/brace matching
    For others: falls back to compile command
    """

    def check(
        self,
        code: str,
        language: str,
        file_path: str = "",
    ) -> VerificationCheck:
        """Run syntax check on code content."""
        start = time.perf_counter()
        lang = _LANG_ALIASES.get(language.lower(), language.lower())

        try:
            if lang == "python":
                return self._check_python(code, file_path, start)
            elif lang in ("javascript", "typescript"):
                return self._check_js_ts(code, file_path, start)
            else:
                return VerificationCheck(
                    stage=VerificationStage.SYNTAX,
                    status=VerificationStatus.SKIPPED,
                    message=f"No in-process syntax checker for {language}",
                    duration_ms=(time.perf_counter() - start) * 1000,
                )
        except Exception as e:
            return VerificationCheck(
                stage=VerificationStage.SYNTAX,
                status=VerificationStatus.ERROR,
                message=f"Syntax check error: {e}",
                errors=[str(e)],
                duration_ms=(time.perf_counter() - start) * 1000,
            )

    def _check_python(
        self, code: str, file_path: str, start: float
    ) -> VerificationCheck:
        """Python syntax check via ast.parse()."""
        import ast
        try:
            ast.parse(code, filename=file_path or "<string>")
            return VerificationCheck(
                stage=VerificationStage.SYNTAX,
                status=VerificationStatus.PASSED,
                message="Python syntax valid",
                duration_ms=(time.perf_counter() - start) * 1000,
            )
        except SyntaxError as e:
            return VerificationCheck(
                stage=VerificationStage.SYNTAX,
                status=VerificationStatus.FAILED,
                message=f"SyntaxError at line {e.lineno}: {e.msg}",
                errors=[f"Line {e.lineno}, col {e.offset}: {e.msg}"],
                duration_ms=(time.perf_counter() - start) * 1000,
                details={"line": e.lineno, "column": e.offset},
            )

    def _check_js_ts(
        self, code: str, file_path: str, start: float
    ) -> VerificationCheck:
        """Basic JS/TS syntax check via bracket/paren/brace matching."""
        errors = []
        stack: List[Tuple[str, int, int]] = []
        openers = {"(": ")", "[": "]", "{": "}"}
        closers = {")", "]", "}"}
        in_string = False
        string_char = ""
        in_comment = False
        in_block_comment = False
        in_template = False
        prev_char = ""

        lines = code.split("\n")
        for line_num, line in enumerate(lines):
            col = 0
            while col < len(line):
                ch = line[col]

                # Handle block comments
                if in_block_comment:
                    if ch == "*" and col + 1 < len(line) and line[col + 1] == "/":
                        in_block_comment = False
                        col += 2
                        continue
                    col += 1
                    continue

                # Handle line comments
                if in_comment:
                    break  # rest of line is comment

                # Handle strings
                if in_string:
                    if ch == "\\" and col + 1 < len(line):
                        col += 2  # skip escape
                        continue
                    if ch == string_char:
                        in_string = False
                    col += 1
                    continue

                # Handle template literals
                if in_template:
                    if ch == "\\" and col + 1 < len(line):
                        col += 2
                        continue
                    if ch == "`":
                        in_template = False
                    col += 1
                    continue

                # Start of comment?
                if ch == "/" and col + 1 < len(line):
                    next_ch = line[col + 1]
                    if next_ch == "/":
                        in_comment = True
                        col += 2
                        continue
                    if next_ch == "*":
                        in_block_comment = True
                        col += 2
                        continue

                # Start of string?
                if ch in ('"', "'"):
                    in_string = True
                    string_char = ch
                    col += 1
                    continue
                if ch == "`":
                    in_template = True
                    col += 1
                    continue

                # Bracket matching
                if ch in openers:
                    stack.append((ch, line_num, col))
                elif ch in closers:
                    if not stack:
                        errors.append(
                            f"Line {line_num + 1}, col {col + 1}: "
                            f"unexpected '{ch}'"
                        )
                    else:
                        opener, open_line, open_col = stack.pop()
                        if openers[opener] != ch:
                            errors.append(
                                f"Line {line_num + 1}, col {col + 1}: "
                                f"expected '{openers[opener]}' but found '{ch}' "
                                f"(opened at line {open_line + 1})"
                            )

                prev_char = ch
                col += 1

            in_comment = False  # reset line comment for next line

        # Check for unclosed brackets
        for opener, open_line, open_col in stack:
            errors.append(
                f"Line {open_line + 1}, col {open_col + 1}: "
                f"unclosed '{opener}'"
            )

        elapsed = (time.perf_counter() - start) * 1000
        if errors:
            return VerificationCheck(
                stage=VerificationStage.SYNTAX,
                status=VerificationStatus.FAILED,
                message=f"{len(errors)} syntax error(s) found",
                errors=errors,
                duration_ms=elapsed,
            )
        return VerificationCheck(
            stage=VerificationStage.SYNTAX,
            status=VerificationStatus.PASSED,
            message="Syntax check passed",
            duration_ms=elapsed,
        )


# ── Subprocess runner ─────────────────────────────────────────────────

class SubprocessRunner:
    """Run verification commands as subprocesses with timeout."""

    async def run(
        self,
        cmd: List[str],
        timeout: float,
        cwd: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
    ) -> Tuple[int, str, str]:
        """
        Run a command, return (exit_code, stdout, stderr).
        """
        import os
        full_env = dict(os.environ)
        if env:
            full_env.update(env)

        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=full_env,
            )
            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=timeout,
            )
            return (
                process.returncode or 0,
                stdout.decode("utf-8", errors="replace"),
                stderr.decode("utf-8", errors="replace"),
            )
        except asyncio.TimeoutError:
            try:
                process.kill()
            except Exception:
                pass
            return -1, "", "Command timed out"
        except FileNotFoundError:
            return -2, "", f"Command not found: {cmd[0]}"
        except Exception as e:
            return -3, "", str(e)


# ── Verification Pipeline ────────────────────────────────────────────

class VerificationPipeline:
    """
    Runs staged verification checks on code after a fix is applied.

    Pipeline stages (configurable):
    1. Syntax check (in-process, fast)
    2. Compile/build (subprocess)
    3. Lint (subprocess)
    4. Typecheck (subprocess)
    5. Test (subprocess)
    6. Smoke check (custom function)

    Fail-fast by default: stops on first failure.
    """

    def __init__(self, config: Optional[VerificationConfig] = None):
        self._config = config or VerificationConfig()
        self._syntax_checker = SyntaxChecker()
        self._subprocess_runner = SubprocessRunner()
        self._smoke_checks: List[Callable] = []

    def register_smoke_check(
        self,
        check_fn: Callable[[str, str, str], VerificationCheck],
    ) -> None:
        """Register a custom smoke check function.

        check_fn(code, language, file_path) -> VerificationCheck
        """
        self._smoke_checks.append(check_fn)

    async def run_pipeline(
        self,
        code: str,
        language: str,
        file_path: str,
        stages: Optional[List[VerificationStage]] = None,
    ) -> VerificationPipelineResult:
        """
        Run the full verification pipeline.

        Returns VerificationPipelineResult with all check results.
        """
        pipeline_start = time.perf_counter()
        stages_to_run = stages or self._config.stages
        result = VerificationPipelineResult()

        for stage in stages_to_run:
            # Check total timeout
            elapsed = (time.perf_counter() - pipeline_start)
            if elapsed >= self._config.total_timeout:
                result.stop_reason = "total_timeout"
                break

            stage_timeout = self._config.stage_timeouts.get(
                stage.value, 30.0
            )

            try:
                check = await self._run_stage(
                    stage, code, language, file_path, stage_timeout
                )
            except Exception as e:
                check = VerificationCheck(
                    stage=stage,
                    status=VerificationStatus.ERROR,
                    message=str(e),
                    errors=[str(e)],
                )

            result.checks.append(check)
            result.stages_run += 1

            if check.passed:
                result.stages_passed += 1
            elif check.status != VerificationStatus.SKIPPED:
                result.stages_failed += 1
                if self._config.fail_fast:
                    result.stop_reason = f"fail_fast_at_{stage.value}"
                    break

        result.total_duration_ms = (time.perf_counter() - pipeline_start) * 1000
        result.overall_passed = (
            result.stages_failed == 0 and result.stages_run > 0
        )

        logger.info(
            f"Verification pipeline: {result.stages_passed}/{result.stages_run} passed "
            f"({'PASS' if result.overall_passed else 'FAIL'}) "
            f"in {result.total_duration_ms:.0f}ms for {file_path}"
        )

        return result

    async def run_single_stage(
        self,
        stage: VerificationStage,
        code: str,
        language: str,
        file_path: str,
    ) -> VerificationCheck:
        """Run a single verification stage."""
        timeout = self._config.stage_timeouts.get(stage.value, 30.0)
        return await self._run_stage(stage, code, language, file_path, timeout)

    async def _run_stage(
        self,
        stage: VerificationStage,
        code: str,
        language: str,
        file_path: str,
        timeout: float,
    ) -> VerificationCheck:
        """Dispatch to the appropriate stage handler."""
        if stage == VerificationStage.SYNTAX:
            return self._syntax_checker.check(code, language, file_path)

        elif stage == VerificationStage.COMPILE:
            return await self._run_command_stage(
                stage, language, file_path, timeout
            )

        elif stage == VerificationStage.LINT:
            return await self._run_command_stage(
                stage, language, file_path, timeout
            )

        elif stage == VerificationStage.TYPECHECK:
            return await self._run_command_stage(
                stage, language, file_path, timeout
            )

        elif stage == VerificationStage.TEST:
            return await self._run_command_stage(
                stage, language, file_path, timeout
            )

        elif stage == VerificationStage.SMOKE:
            return await self._run_smoke_checks(code, language, file_path)

        return VerificationCheck(
            stage=stage,
            status=VerificationStatus.SKIPPED,
            message=f"Unknown stage: {stage.value}",
        )

    async def _run_command_stage(
        self,
        stage: VerificationStage,
        language: str,
        file_path: str,
        timeout: float,
    ) -> VerificationCheck:
        """Run a command-based verification stage."""
        start = time.perf_counter()
        lang = _LANG_ALIASES.get(language.lower(), language.lower())
        stage_name = stage.value

        # Check for custom command first
        custom = self._config.custom_commands.get(lang, {}).get(stage_name)
        if custom:
            cmd = custom.replace("{file}", file_path)
            cmd_list = cmd.split()
        else:
            # Use default commands
            lang_commands = _DEFAULT_COMMANDS.get(lang, {})
            cmd_template = lang_commands.get(stage_name, [])
            if not cmd_template:
                return VerificationCheck(
                    stage=stage,
                    status=VerificationStatus.SKIPPED,
                    message=f"No {stage_name} command for {language}",
                    duration_ms=(time.perf_counter() - start) * 1000,
                )

            # Substitute file path
            cmd_list = []
            for part in cmd_template:
                part = part.replace("{file}", file_path)
                if "{dir}" in part:
                    dir_path = str(Path(file_path).parent)
                    part = part.replace("{dir}", dir_path)
                cmd_list.append(part)

        exit_code, stdout, stderr = await self._subprocess_runner.run(
            cmd_list,
            timeout=timeout,
            cwd=self._config.working_directory,
            env=self._config.env_vars,
        )

        elapsed = (time.perf_counter() - start) * 1000

        if exit_code == -1:
            return VerificationCheck(
                stage=stage,
                status=VerificationStatus.TIMEOUT,
                message=f"{stage_name} timed out after {timeout}s",
                duration_ms=elapsed,
            )
        elif exit_code == -2:
            return VerificationCheck(
                stage=stage,
                status=VerificationStatus.SKIPPED,
                message=f"Tool not available: {cmd_list[0]}",
                duration_ms=elapsed,
            )
        elif exit_code == 0:
            return VerificationCheck(
                stage=stage,
                status=VerificationStatus.PASSED,
                message=f"{stage_name} passed",
                duration_ms=elapsed,
                details={"stdout": stdout[:500], "stderr": stderr[:500]},
            )
        else:
            # Parse errors from output
            output = (stderr or stdout).strip()
            error_lines = [
                line for line in output.split("\n")
                if line.strip() and ("error" in line.lower() or "Error" in line)
            ][:10]  # Limit to 10 error lines

            return VerificationCheck(
                stage=stage,
                status=VerificationStatus.FAILED,
                message=f"{stage_name} failed (exit code {exit_code})",
                errors=error_lines if error_lines else [output[:500]],
                duration_ms=elapsed,
                details={
                    "exitCode": exit_code,
                    "stdout": stdout[:500],
                    "stderr": stderr[:500],
                },
            )

    async def _run_smoke_checks(
        self,
        code: str,
        language: str,
        file_path: str,
    ) -> VerificationCheck:
        """Run registered smoke checks."""
        start = time.perf_counter()
        if not self._smoke_checks:
            return VerificationCheck(
                stage=VerificationStage.SMOKE,
                status=VerificationStatus.SKIPPED,
                message="No smoke checks registered",
                duration_ms=(time.perf_counter() - start) * 1000,
            )

        errors = []
        for check_fn in self._smoke_checks:
            try:
                check = check_fn(code, language, file_path)
                if not check.passed:
                    errors.extend(check.errors)
            except Exception as e:
                errors.append(f"Smoke check error: {e}")

        elapsed = (time.perf_counter() - start) * 1000
        if errors:
            return VerificationCheck(
                stage=VerificationStage.SMOKE,
                status=VerificationStatus.FAILED,
                message=f"{len(errors)} smoke check(s) failed",
                errors=errors,
                duration_ms=elapsed,
            )
        return VerificationCheck(
            stage=VerificationStage.SMOKE,
            status=VerificationStatus.PASSED,
            message="All smoke checks passed",
            duration_ms=elapsed,
        )

    async def verify_fix(
        self,
        original_code: str,
        fixed_code: str,
        language: str,
        file_path: str,
    ) -> VerificationPipelineResult:
        """
        Convenience method: verify that a fix doesn't break things.

        Runs the pipeline on the fixed code. If the original code
        also fails syntax, we only check that the fix doesn't make
        things worse.
        """
        # Check if original code passes syntax
        original_syntax = self._syntax_checker.check(
            original_code, language, file_path
        )

        # Run pipeline on fixed code
        result = await self.run_pipeline(fixed_code, language, file_path)

        # If original had syntax errors, adjust: fix is OK if it
        # reduces errors or at least doesn't add new ones
        if not original_syntax.passed and result.checks:
            syntax_check = result.checks[0]
            if syntax_check.stage == VerificationStage.SYNTAX:
                orig_errors = len(original_syntax.errors)
                fixed_errors = len(syntax_check.errors)
                if fixed_errors < orig_errors:
                    syntax_check.details["note"] = (
                        f"Improved: {orig_errors} → {fixed_errors} errors"
                    )

        return result


# ── Semantic guardrails ───────────────────────────────────────────────

class SemanticGuardrails:
    """
    Pre-apply safety checks beyond simple syntax.

    Checks that the patch is:
    1. Minimal (doesn't change too much)
    2. Doesn't touch forbidden files
    3. Doesn't introduce dangerous APIs
    4. Doesn't modify dependencies unless allowed
    """

    # Dangerous API patterns by language
    _DANGEROUS_APIS: Dict[str, List[re.Pattern]] = {
        "python": [
            re.compile(r"""\beval\s*\("""),
            re.compile(r"""\bexec\s*\("""),
            re.compile(r"""\b__import__\s*\("""),
            re.compile(r"""\bos\.system\s*\("""),
            re.compile(r"""\bsubprocess\.(?:call|run|Popen)\s*\(.*shell\s*=\s*True"""),
            re.compile(r"""\bpickle\.(?:load|loads)\s*\("""),
        ],
        "javascript": [
            re.compile(r"""\beval\s*\("""),
            re.compile(r"""\bFunction\s*\("""),
            re.compile(r"""\bchild_process"""),
            re.compile(r"""\bexecSync\s*\("""),
            re.compile(r"""\bexec\s*\("""),
            re.compile(r"""innerHTML\s*="""),
            re.compile(r"""\bdocument\.write\s*\("""),
        ],
        "typescript": [],  # Same as JS, populated at init
    }

    # Forbidden file patterns
    _FORBIDDEN_FILES: List[re.Pattern] = [
        re.compile(r"""package\.json$"""),
        re.compile(r"""package-lock\.json$"""),
        re.compile(r"""yarn\.lock$"""),
        re.compile(r"""Cargo\.toml$"""),
        re.compile(r"""Cargo\.lock$"""),
        re.compile(r"""go\.mod$"""),
        re.compile(r"""go\.sum$"""),
        re.compile(r"""requirements\.txt$"""),
        re.compile(r"""Pipfile\.lock$"""),
        re.compile(r"""poetry\.lock$"""),
        re.compile(r"""\.github[/\\]"""),
        re.compile(r"""\.gitlab-ci\.yml$"""),
        re.compile(r"""Dockerfile$"""),
        re.compile(r"""docker-compose\.ya?ml$"""),
    ]

    def __init__(self):
        # Copy JS patterns to TS
        if not self._DANGEROUS_APIS.get("typescript"):
            self._DANGEROUS_APIS["typescript"] = list(
                self._DANGEROUS_APIS.get("javascript", [])
            )

    def check_patch_safety(
        self,
        original_code: str,
        patched_code: str,
        language: str,
        file_path: str,
        allow_dependency_changes: bool = False,
    ) -> Tuple[bool, List[str]]:
        """
        Check if a patch is safe to apply.

        Returns (is_safe, list_of_violations).
        """
        violations = []
        lang = _LANG_ALIASES.get(language.lower(), language.lower())

        # 1. Check forbidden files
        if not allow_dependency_changes:
            for pattern in self._FORBIDDEN_FILES:
                if pattern.search(file_path):
                    violations.append(
                        f"Forbidden file: {file_path} (dependency/config file)"
                    )

        # 2. Check for new dangerous APIs
        dangerous = self._DANGEROUS_APIS.get(lang, [])
        for api_pattern in dangerous:
            orig_matches = len(api_pattern.findall(original_code))
            patch_matches = len(api_pattern.findall(patched_code))
            if patch_matches > orig_matches:
                violations.append(
                    f"New dangerous API introduced: {api_pattern.pattern}"
                )

        # 3. Check patch minimality
        orig_lines = original_code.split("\n")
        patch_lines = patched_code.split("\n")
        changed_lines = sum(
            1 for a, b in zip(orig_lines, patch_lines) if a != b
        )
        changed_lines += abs(len(orig_lines) - len(patch_lines))

        if changed_lines > 50:
            violations.append(
                f"Patch too large: {changed_lines} lines changed (max 50)"
            )

        is_safe = len(violations) == 0
        return is_safe, violations


# ── Module-level singletons ──────────────────────────────────────────

_verification_pipeline: Optional[VerificationPipeline] = None
_semantic_guardrails: Optional[SemanticGuardrails] = None


def get_verification_pipeline(
    config: Optional[VerificationConfig] = None,
) -> VerificationPipeline:
    """Get or create global verification pipeline."""
    global _verification_pipeline
    if _verification_pipeline is None:
        _verification_pipeline = VerificationPipeline(config)
    return _verification_pipeline


def get_semantic_guardrails() -> SemanticGuardrails:
    """Get or create global semantic guardrails."""
    global _semantic_guardrails
    if _semantic_guardrails is None:
        _semantic_guardrails = SemanticGuardrails()
    return _semantic_guardrails


def reset_verification_pipeline() -> None:
    """Reset (for testing)."""
    global _verification_pipeline, _semantic_guardrails
    _verification_pipeline = None
    _semantic_guardrails = None
