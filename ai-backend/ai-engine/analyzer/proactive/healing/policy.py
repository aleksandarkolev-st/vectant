"""
Policy Engine.

Defines organizational constraints and risk tiers that govern
the self-healing system's behavior.

A policy specifies:
  Goal = what the system is trying to achieve
  Constraints = hard limits on what it can do
  Risk tiers = file/path categories with different autonomy levels

Risk tier examples:
  Tier 0 (test/docs) → auto-fix, no approval needed
  Tier 1 (app code)  → auto-fix with verification, can rollback
  Tier 2 (config)    → require explicit user approval
  Tier 3 (infra)     → block, always escalate

The policy engine is queried before every repair action.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from enum import Enum
from fnmatch import fnmatch
from typing import Any, Callable, Dict, List, Optional, Set

logger = logging.getLogger("healing.policy")


# ── Types ─────────────────────────────────────────────────────────────

class RiskTier(int, Enum):
    """Risk tiers from lowest to highest."""
    TIER_0 = 0   # Test/docs: auto-fix freely
    TIER_1 = 1   # App code: auto-fix with verification
    TIER_2 = 2   # Config: require user approval
    TIER_3 = 3   # Infrastructure: always block/escalate


class ApprovalMode(str, Enum):
    """How the system obtains approval for fixes."""
    AUTO = "auto"              # No approval needed
    NOTIFY = "notify"          # Apply and notify user
    CONFIRM = "confirm"        # Ask user before applying
    BLOCK = "block"            # Never auto-apply


class PolicyDecision(str, Enum):
    """Decision from policy evaluation."""
    ALLOW = "allow"
    ALLOW_WITH_VERIFICATION = "allow_with_verification"
    REQUIRE_APPROVAL = "require_approval"
    BLOCK = "block"


@dataclass
class PolicyViolation:
    """A specific policy rule that was triggered."""
    rule_name: str
    description: str
    severity: str = "warning"  # "warning", "error", "block"
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ruleName": self.rule_name,
            "description": self.description,
            "severity": self.severity,
            "metadata": self.metadata,
        }


@dataclass
class PolicyEvaluation:
    """Result of evaluating a repair action against policy."""
    decision: PolicyDecision
    risk_tier: RiskTier
    approval_mode: ApprovalMode
    violations: List[PolicyViolation] = field(default_factory=list)
    reason: str = ""
    max_allowed_changes: int = 0
    requires_sandbox: bool = False
    requires_verification: bool = True
    allowed_step_types: List[str] = field(default_factory=list)

    @property
    def is_allowed(self) -> bool:
        return self.decision in (
            PolicyDecision.ALLOW,
            PolicyDecision.ALLOW_WITH_VERIFICATION,
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "decision": self.decision.value,
            "riskTier": self.risk_tier.value,
            "approvalMode": self.approval_mode.value,
            "violations": [v.to_dict() for v in self.violations],
            "reason": self.reason,
            "maxAllowedChanges": self.max_allowed_changes,
            "requiresSandbox": self.requires_sandbox,
            "requiresVerification": self.requires_verification,
            "isAllowed": self.is_allowed,
        }


# ── Risk Classification ──────────────────────────────────────────────

@dataclass
class RiskRule:
    """Maps file patterns to risk tiers."""
    name: str
    patterns: List[str]         # Glob patterns
    tier: RiskTier
    approval: ApprovalMode
    reason: str = ""

    def matches(self, file_path: str) -> bool:
        return any(fnmatch(file_path, p) for p in self.patterns)


# Default risk classification rules
DEFAULT_RISK_RULES: List[RiskRule] = [
    # Tier 0: Tests and docs — auto-fix freely
    RiskRule(
        name="test_files",
        patterns=[
            "*/test/*", "*/tests/*", "*/__tests__/*",
            "*.test.*", "*.spec.*", "*_test.*",
            "test_*", "spec_*",
        ],
        tier=RiskTier.TIER_0,
        approval=ApprovalMode.AUTO,
        reason="Test files are safe to auto-fix",
    ),
    RiskRule(
        name="documentation",
        patterns=[
            "*.md", "*.txt", "*.rst",
            "docs/*", "README*", "CHANGELOG*",
        ],
        tier=RiskTier.TIER_0,
        approval=ApprovalMode.AUTO,
        reason="Documentation is safe to auto-fix",
    ),
    RiskRule(
        name="stylesheets",
        patterns=["*.css", "*.scss", "*.less", "*.sass"],
        tier=RiskTier.TIER_0,
        approval=ApprovalMode.AUTO,
        reason="Style files are safe to auto-fix",
    ),

    # Tier 2: Configuration files — require approval
    RiskRule(
        name="package_config",
        patterns=[
            "package.json", "package-lock.json",
            "yarn.lock", "pnpm-lock.yaml",
        ],
        tier=RiskTier.TIER_2,
        approval=ApprovalMode.CONFIRM,
        reason="Package config changes can break dependencies",
    ),
    RiskRule(
        name="build_config",
        patterns=[
            "webpack.config.*", "vite.config.*",
            "tsconfig.json", "tsconfig.*.json",
            "babel.config.*", ".babelrc*",
            "next.config.*", "nuxt.config.*",
            "rollup.config.*", "esbuild.*",
            "Makefile", "CMakeLists.txt",
            "Cargo.toml", "go.mod", "go.sum",
        ],
        tier=RiskTier.TIER_2,
        approval=ApprovalMode.CONFIRM,
        reason="Build config changes can break the build pipeline",
    ),
    RiskRule(
        name="ci_config",
        patterns=[
            ".github/*", ".gitlab-ci.yml",
            "Jenkinsfile", ".circleci/*",
            ".travis.yml", "azure-pipelines.yml",
        ],
        tier=RiskTier.TIER_2,
        approval=ApprovalMode.CONFIRM,
        reason="CI config changes can break the pipeline",
    ),

    # Tier 3: Infrastructure/secrets — always block
    RiskRule(
        name="env_files",
        patterns=[".env", ".env.*", "*.env"],
        tier=RiskTier.TIER_3,
        approval=ApprovalMode.BLOCK,
        reason="Environment files may contain secrets",
    ),
    RiskRule(
        name="crypto_keys",
        patterns=[
            "*.pem", "*.key", "*.p12", "*.pfx",
            "*.cer", "*.crt",
        ],
        tier=RiskTier.TIER_3,
        approval=ApprovalMode.BLOCK,
        reason="Cryptographic files must never be modified",
    ),
    RiskRule(
        name="docker_infra",
        patterns=[
            "Dockerfile*", "docker-compose*",
            "*.dockerfile",
        ],
        tier=RiskTier.TIER_3,
        approval=ApprovalMode.BLOCK,
        reason="Infrastructure files require human review",
    ),
    RiskRule(
        name="database",
        patterns=[
            "*/migrations/*", "*.sql",
            "schema.prisma", "*/prisma/schema*",
        ],
        tier=RiskTier.TIER_3,
        approval=ApprovalMode.BLOCK,
        reason="Database schema changes require human review",
    ),
]


class RiskClassifier:
    """Classifies files into risk tiers."""

    def __init__(
        self,
        rules: Optional[List[RiskRule]] = None,
        default_tier: RiskTier = RiskTier.TIER_1,
        default_approval: ApprovalMode = ApprovalMode.NOTIFY,
    ):
        self._rules = rules or list(DEFAULT_RISK_RULES)
        self._default_tier = default_tier
        self._default_approval = default_approval

    def classify(self, file_path: str) -> tuple[RiskTier, ApprovalMode, str]:
        """
        Classify a file into a risk tier.

        Returns:
            (tier, approval_mode, reason)
        """
        # Normalize path separators
        normalized = file_path.replace("\\", "/")

        for rule in self._rules:
            if rule.matches(normalized):
                return rule.tier, rule.approval, rule.reason

        return self._default_tier, self._default_approval, "Default app code tier"

    def add_rule(self, rule: RiskRule) -> None:
        """Add a custom risk rule (checked before defaults)."""
        self._rules.insert(0, rule)

    def remove_rule(self, name: str) -> bool:
        before = len(self._rules)
        self._rules = [r for r in self._rules if r.name != name]
        return len(self._rules) < before


# ── Policy Constraints ────────────────────────────────────────────────

@dataclass
class PolicyConstraints:
    """Hard limits on what the healing system can do."""
    # File limits
    max_files_per_repair: int = 5
    max_lines_changed_per_file: int = 50
    max_total_lines_changed: int = 150

    # Execution limits
    max_repairs_per_hour: int = 20
    max_concurrent_repairs: int = 3
    max_llm_calls_per_repair: int = 10

    # Safety
    require_verification: bool = True
    require_sandbox_for_multi_file: bool = True
    block_on_failing_tests: bool = True

    # Scope
    allowed_languages: List[str] = field(default_factory=lambda: [
        "python", "javascript", "typescript", "jsx", "tsx",
        "go", "rust", "java", "kotlin", "css", "html",
    ])
    blocked_paths: List[str] = field(default_factory=lambda: [
        "node_modules/**", ".git/**", "dist/**", "build/**",
    ])

    # Feature flags
    allow_dependency_install: bool = False
    allow_service_restart: bool = False
    allow_cache_clear: bool = True
    allow_runtime_healing: bool = True

    def to_dict(self) -> Dict[str, Any]:
        return {
            "maxFilesPerRepair": self.max_files_per_repair,
            "maxLinesChangedPerFile": self.max_lines_changed_per_file,
            "maxTotalLinesChanged": self.max_total_lines_changed,
            "maxRepairsPerHour": self.max_repairs_per_hour,
            "maxConcurrentRepairs": self.max_concurrent_repairs,
            "requireVerification": self.require_verification,
            "requireSandboxForMultiFile": self.require_sandbox_for_multi_file,
            "blockOnFailingTests": self.block_on_failing_tests,
            "allowDependencyInstall": self.allow_dependency_install,
            "allowServiceRestart": self.allow_service_restart,
            "allowRuntimeHealing": self.allow_runtime_healing,
        }


# ── Policy Engine ─────────────────────────────────────────────────────

class PolicyEngine:
    """
    Evaluates repair actions against organizational policy.

    Queried before every repair to determine:
    - Is this action allowed?
    - What risk tier is the target file?
    - Does it require user approval?
    - What verification is required?
    - What limits apply?
    """

    def __init__(
        self,
        constraints: Optional[PolicyConstraints] = None,
        classifier: Optional[RiskClassifier] = None,
    ):
        self._constraints = constraints or PolicyConstraints()
        self._classifier = classifier or RiskClassifier()

        # Rate tracking
        self._repair_timestamps: List[float] = []
        self._active_repairs: int = 0

    @property
    def constraints(self) -> PolicyConstraints:
        return self._constraints

    @constraints.setter
    def constraints(self, value: PolicyConstraints) -> None:
        self._constraints = value

    def evaluate(
        self,
        file_path: str,
        language: str = "",
        num_files: int = 1,
        estimated_lines_changed: int = 0,
        step_types: Optional[List[str]] = None,
    ) -> PolicyEvaluation:
        """
        Evaluate whether a repair action is allowed by policy.

        Args:
            file_path: Primary file being repaired.
            language: Programming language.
            num_files: Number of files in the repair.
            estimated_lines_changed: Estimated lines changed.
            step_types: Planned step types (from planner).

        Returns:
            PolicyEvaluation with decision and constraints.
        """
        violations = []

        # 1. Classify risk tier
        tier, approval, reason = self._classifier.classify(file_path)

        # 2. Check blocked paths
        for pattern in self._constraints.blocked_paths:
            if fnmatch(file_path.replace("\\", "/"), pattern):
                return PolicyEvaluation(
                    decision=PolicyDecision.BLOCK,
                    risk_tier=tier,
                    approval_mode=ApprovalMode.BLOCK,
                    reason=f"Path matches blocked pattern: {pattern}",
                    violations=[PolicyViolation(
                        rule_name="blocked_path",
                        description=f"File matches blocked path: {pattern}",
                        severity="block",
                    )],
                )

        # 3. Check language
        if language and language.lower() not in self._constraints.allowed_languages:
            violations.append(PolicyViolation(
                rule_name="unsupported_language",
                description=f"Language '{language}' not in allowed list",
                severity="warning",
            ))

        # 4. Check file count
        if num_files > self._constraints.max_files_per_repair:
            violations.append(PolicyViolation(
                rule_name="too_many_files",
                description=f"Repair spans {num_files} files (max: {self._constraints.max_files_per_repair})",
                severity="error",
            ))

        # 5. Check lines changed
        if estimated_lines_changed > self._constraints.max_total_lines_changed:
            violations.append(PolicyViolation(
                rule_name="too_many_lines",
                description=f"Estimated {estimated_lines_changed} lines changed (max: {self._constraints.max_total_lines_changed})",
                severity="error",
            ))

        # 6. Check rate limit
        if self._is_rate_limited():
            violations.append(PolicyViolation(
                rule_name="rate_limited",
                description=f"Repair rate limit exceeded ({self._constraints.max_repairs_per_hour}/hr)",
                severity="error",
            ))

        # 7. Check concurrency
        if self._active_repairs >= self._constraints.max_concurrent_repairs:
            violations.append(PolicyViolation(
                rule_name="max_concurrent",
                description=f"Max concurrent repairs reached ({self._constraints.max_concurrent_repairs})",
                severity="error",
            ))

        # 8. Check step types for blocked actions
        if step_types:
            blocked_steps = self._check_blocked_steps(step_types)
            for bs in blocked_steps:
                violations.append(bs)

        # Determine decision
        has_blocking = any(v.severity == "block" for v in violations)
        has_error = any(v.severity == "error" for v in violations)

        if has_blocking or tier == RiskTier.TIER_3:
            decision = PolicyDecision.BLOCK
        elif has_error:
            decision = PolicyDecision.REQUIRE_APPROVAL
        elif tier == RiskTier.TIER_2:
            decision = PolicyDecision.REQUIRE_APPROVAL
        elif tier == RiskTier.TIER_1:
            decision = PolicyDecision.ALLOW_WITH_VERIFICATION
        else:
            decision = PolicyDecision.ALLOW

        # Determine requirements
        requires_sandbox = (
            num_files > 1 and self._constraints.require_sandbox_for_multi_file
        )

        return PolicyEvaluation(
            decision=decision,
            risk_tier=tier,
            approval_mode=approval,
            violations=violations,
            reason=reason,
            max_allowed_changes=self._constraints.max_lines_changed_per_file,
            requires_sandbox=requires_sandbox,
            requires_verification=self._constraints.require_verification,
        )

    def begin_repair(self) -> None:
        """Track a new active repair."""
        self._active_repairs += 1
        self._repair_timestamps.append(time.time())

    def end_repair(self) -> None:
        """Track repair completion."""
        self._active_repairs = max(0, self._active_repairs - 1)

    def _is_rate_limited(self) -> bool:
        now = time.time()
        cutoff = now - 3600
        self._repair_timestamps = [
            t for t in self._repair_timestamps if t > cutoff
        ]
        return len(self._repair_timestamps) >= self._constraints.max_repairs_per_hour

    def _check_blocked_steps(self, step_types: List[str]) -> List[PolicyViolation]:
        violations = []

        if "install_dependency" in step_types and not self._constraints.allow_dependency_install:
            violations.append(PolicyViolation(
                rule_name="blocked_dep_install",
                description="Dependency installation is disabled by policy",
                severity="block",
            ))

        if "restart_service" in step_types and not self._constraints.allow_service_restart:
            violations.append(PolicyViolation(
                rule_name="blocked_restart",
                description="Service restart is disabled by policy",
                severity="block",
            ))

        return violations

    def status(self) -> Dict[str, Any]:
        now = time.time()
        return {
            "activeRepairs": self._active_repairs,
            "repairsThisHour": len([
                t for t in self._repair_timestamps if t > now - 3600
            ]),
            "constraints": self._constraints.to_dict(),
        }


# ── Module-level singleton ────────────────────────────────────────────

_policy_engine: Optional[PolicyEngine] = None


def get_policy_engine(**kwargs) -> PolicyEngine:
    global _policy_engine
    if _policy_engine is None:
        _policy_engine = PolicyEngine(**kwargs)
    return _policy_engine


def reset_policy_engine() -> None:
    global _policy_engine
    _policy_engine = None
