"""
Secret & PII Redaction Engine.

Scans code and context before any LLM call to strip:
- API keys, tokens, passwords
- AWS/GCP/Azure credentials  
- Private keys (RSA, SSH, PGP)
- JWTs and session tokens
- Email addresses, IP addresses (configurable)
- Environment variable values matching sensitive patterns
- Custom deny-list paths/files
- Database connection strings

This is a HARD BLOCKER — no code goes to an LLM without passing
through this filter first.

Design:
- All patterns run on-device
- Redacted values are replaced with placeholders: <REDACTED:type>
- A redaction report is generated for audit
- Configurable: can add custom patterns and deny paths
"""

from __future__ import annotations

import hashlib
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

logger = logging.getLogger("healing.redaction")


# ── Redaction patterns ────────────────────────────────────────────────

@dataclass
class RedactionPattern:
    """A single redaction pattern."""
    name: str
    pattern: re.Pattern
    placeholder: str
    description: str = ""
    severity: str = "high"  # "critical", "high", "medium", "low"


# Pre-compiled patterns for performance
_PATTERNS: List[RedactionPattern] = [
    # ── API Keys & Tokens ───────────────────────────────────────
    RedactionPattern(
        name="generic_api_key",
        pattern=re.compile(
            r"""(?:api[_-]?key|apikey|api[_-]?secret|api[_-]?token)"""
            r"""[\s]*[=:]\s*['"]([a-zA-Z0-9_\-]{20,})['"]""",
            re.IGNORECASE,
        ),
        placeholder="<REDACTED:API_KEY>",
        description="Generic API key assignment",
    ),
    RedactionPattern(
        name="bearer_token",
        pattern=re.compile(
            r"""Bearer\s+[a-zA-Z0-9_\-\.]{20,}""",
            re.IGNORECASE,
        ),
        placeholder="<REDACTED:BEARER_TOKEN>",
        description="Bearer authentication token",
    ),
    RedactionPattern(
        name="basic_auth",
        pattern=re.compile(
            r"""Basic\s+[a-zA-Z0-9+/=]{20,}""",
            re.IGNORECASE,
        ),
        placeholder="<REDACTED:BASIC_AUTH>",
        description="Basic authentication header",
    ),

    # ── AWS ─────────────────────────────────────────────────────
    RedactionPattern(
        name="aws_access_key",
        pattern=re.compile(r"""(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}"""),
        placeholder="<REDACTED:AWS_ACCESS_KEY>",
        description="AWS Access Key ID",
        severity="critical",
    ),
    RedactionPattern(
        name="aws_secret_key",
        pattern=re.compile(
            r"""(?:aws[_-]?secret[_-]?(?:access[_-]?)?key)[\s]*[=:]\s*['"]([a-zA-Z0-9/+=]{40})['"]""",
            re.IGNORECASE,
        ),
        placeholder="<REDACTED:AWS_SECRET_KEY>",
        description="AWS Secret Access Key",
        severity="critical",
    ),

    # ── GCP ─────────────────────────────────────────────────────
    RedactionPattern(
        name="gcp_service_account",
        pattern=re.compile(
            r""""private_key":\s*"-----BEGIN (?:RSA )?PRIVATE KEY-----[^"]+-----END (?:RSA )?PRIVATE KEY-----""",
        ),
        placeholder="<REDACTED:GCP_PRIVATE_KEY>",
        description="GCP service account private key",
        severity="critical",
    ),
    RedactionPattern(
        name="gcp_api_key",
        pattern=re.compile(r"""AIza[a-zA-Z0-9_\-]{35}"""),
        placeholder="<REDACTED:GCP_API_KEY>",
        description="Google Cloud API Key",
    ),

    # ── Azure ───────────────────────────────────────────────────
    RedactionPattern(
        name="azure_storage_key",
        pattern=re.compile(
            r"""(?:AccountKey|SharedAccessSignature)=[a-zA-Z0-9+/=]{44,}""",
            re.IGNORECASE,
        ),
        placeholder="<REDACTED:AZURE_KEY>",
        description="Azure storage key or SAS token",
        severity="critical",
    ),

    # ── Private keys ────────────────────────────────────────────
    RedactionPattern(
        name="private_key_pem",
        pattern=re.compile(
            r"""-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----""",
        ),
        placeholder="<REDACTED:PRIVATE_KEY>",
        description="PEM-encoded private key",
        severity="critical",
    ),
    RedactionPattern(
        name="pgp_private_key",
        pattern=re.compile(
            r"""-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?-----END PGP PRIVATE KEY BLOCK-----""",
        ),
        placeholder="<REDACTED:PGP_PRIVATE_KEY>",
        description="PGP private key block",
        severity="critical",
    ),

    # ── JWTs ────────────────────────────────────────────────────
    RedactionPattern(
        name="jwt_token",
        pattern=re.compile(
            r"""eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}""",
        ),
        placeholder="<REDACTED:JWT>",
        description="JSON Web Token",
    ),

    # ── Database connection strings ─────────────────────────────
    RedactionPattern(
        name="db_connection_string",
        pattern=re.compile(
            r"""(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp)://[^\s'"]{10,}""",
            re.IGNORECASE,
        ),
        placeholder="<REDACTED:DB_CONNECTION_STRING>",
        description="Database connection URI with credentials",
    ),

    # ── Passwords in assignments ────────────────────────────────
    RedactionPattern(
        name="password_assignment",
        pattern=re.compile(
            r"""(?:password|passwd|pwd|secret|token|auth_token|access_token|refresh_token)"""
            r"""[\s]*[=:]\s*['"]([^'"]{8,})['"]""",
            re.IGNORECASE,
        ),
        placeholder="<REDACTED:PASSWORD>",
        description="Password/secret in assignment",
    ),

    # ── GitHub tokens ───────────────────────────────────────────
    RedactionPattern(
        name="github_token",
        pattern=re.compile(r"""gh[pousr]_[a-zA-Z0-9]{36,}"""),
        placeholder="<REDACTED:GITHUB_TOKEN>",
        description="GitHub personal/OAuth/app token",
    ),

    # ── Slack tokens ────────────────────────────────────────────
    RedactionPattern(
        name="slack_token",
        pattern=re.compile(r"""xox[bpoas]-[a-zA-Z0-9\-]{10,}"""),
        placeholder="<REDACTED:SLACK_TOKEN>",
        description="Slack API token",
    ),

    # ── Stripe keys ─────────────────────────────────────────────
    RedactionPattern(
        name="stripe_key",
        pattern=re.compile(r"""(?:sk|pk)_(?:test|live)_[a-zA-Z0-9]{20,}"""),
        placeholder="<REDACTED:STRIPE_KEY>",
        description="Stripe API key",
    ),

    # ── SSH keys (public is fine, catch private patterns) ───────
    RedactionPattern(
        name="ssh_private_key",
        pattern=re.compile(
            r"""-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----""",
        ),
        placeholder="<REDACTED:SSH_PRIVATE_KEY>",
        description="OpenSSH private key",
        severity="critical",
    ),

    # ── Generic high-entropy strings in env-like assignments ────
    RedactionPattern(
        name="env_secret",
        pattern=re.compile(
            r"""(?:^|\n)\s*(?:export\s+)?([A-Z][A-Z0-9_]*(?:SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*)"""
            r"""[\s]*=\s*['"]?([^\s'"]{12,})['"]?""",
            re.MULTILINE,
        ),
        placeholder="<REDACTED:ENV_SECRET>",
        description="Environment variable with secret-like name",
    ),
]


# ── Configuration ─────────────────────────────────────────────────────

@dataclass
class RedactionConfig:
    """Configuration for the redaction engine."""
    enabled: bool = True

    # Which pattern severities to enforce
    enforce_severities: Set[str] = field(
        default_factory=lambda: {"critical", "high", "medium"}
    )

    # Additional custom patterns
    custom_patterns: List[RedactionPattern] = field(default_factory=list)

    # File paths that should NEVER be sent to LLM
    deny_paths: Set[str] = field(default_factory=lambda: {
        ".env", ".env.local", ".env.production", ".env.staging",
        ".env.development", ".env.test",
        "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
        ".pem", ".key", ".p12", ".pfx",
        "credentials.json", "service-account.json",
        "secrets.yaml", "secrets.yml", "secrets.json",
        ".npmrc", ".pypirc", ".docker/config.json",
    })

    # Deny file patterns (glob-like)
    deny_patterns: List[str] = field(default_factory=lambda: [
        r".*\.env(?:\.\w+)?$",
        r".*[/\\]\.ssh[/\\].*",
        r".*[/\\]\.gnupg[/\\].*",
        r".*\.pem$",
        r".*\.key$",
    ])

    # Redact PII (emails, IPs, phone numbers)
    redact_pii: bool = False  # Off by default — can cause false positives in code

    # PII patterns (only active if redact_pii=True)
    pii_patterns: List[RedactionPattern] = field(default_factory=list)

    def __post_init__(self):
        if self.redact_pii and not self.pii_patterns:
            self.pii_patterns = [
                RedactionPattern(
                    name="email_address",
                    pattern=re.compile(
                        r"""[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"""
                    ),
                    placeholder="<REDACTED:EMAIL>",
                    description="Email address",
                    severity="medium",
                ),
                RedactionPattern(
                    name="ipv4_address",
                    pattern=re.compile(
                        r"""\b(?:\d{1,3}\.){3}\d{1,3}\b"""
                    ),
                    placeholder="<REDACTED:IP>",
                    description="IPv4 address",
                    severity="low",
                ),
            ]


# ── Redaction report ──────────────────────────────────────────────────

@dataclass
class RedactionMatch:
    """A single redaction match."""
    pattern_name: str
    severity: str
    line: int
    column: int
    length: int
    placeholder: str
    original_hash: str  # SHA-256 of redacted content (for audit, not reversal)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "patternName": self.pattern_name,
            "severity": self.severity,
            "line": self.line,
            "column": self.column,
            "length": self.length,
            "placeholder": self.placeholder,
            "originalHash": self.original_hash,
        }


@dataclass
class RedactionReport:
    """Report of all redactions applied to a text."""
    total_redactions: int = 0
    redactions: List[RedactionMatch] = field(default_factory=list)
    blocked_file: bool = False
    blocked_reason: str = ""
    elapsed_ms: float = 0.0

    @property
    def has_redactions(self) -> bool:
        return self.total_redactions > 0 or self.blocked_file

    @property
    def critical_count(self) -> int:
        return sum(1 for r in self.redactions if r.severity == "critical")

    def to_dict(self) -> Dict[str, Any]:
        return {
            "totalRedactions": self.total_redactions,
            "redactions": [r.to_dict() for r in self.redactions],
            "blockedFile": self.blocked_file,
            "blockedReason": self.blocked_reason,
            "elapsedMs": round(self.elapsed_ms, 2),
            "criticalCount": self.critical_count,
        }


# ── Redaction Engine ──────────────────────────────────────────────────

class RedactionEngine:
    """
    Scans text and replaces secrets/PII with safe placeholders.

    Usage:
        engine = RedactionEngine()
        safe_text, report = engine.redact(code, file_path="src/config.py")

        if report.blocked_file:
            # File is on the deny list — do NOT send to LLM
            ...

        if report.has_redactions:
            logger.info(f"Redacted {report.total_redactions} secrets")

        # safe_text is now safe to send to LLM
        llm_response = await llm.call(safe_text)
    """

    def __init__(self, config: Optional[RedactionConfig] = None):
        self._config = config or RedactionConfig()
        self._all_patterns = self._build_pattern_list()
        self._deny_path_compiled = [
            re.compile(p) for p in self._config.deny_patterns
        ]

    def _build_pattern_list(self) -> List[RedactionPattern]:
        """Combine built-in and custom patterns."""
        patterns = list(_PATTERNS)
        patterns.extend(self._config.custom_patterns)
        if self._config.redact_pii:
            patterns.extend(self._config.pii_patterns)
        # Filter by severity
        return [
            p for p in patterns
            if p.severity in self._config.enforce_severities
        ]

    def is_blocked_path(self, file_path: str) -> Tuple[bool, str]:
        """
        Check if a file path is on the deny list.

        Returns (blocked, reason).
        """
        if not file_path:
            return False, ""

        # Normalize path
        normalized = file_path.replace("\\", "/").lower()
        basename = normalized.split("/")[-1] if "/" in normalized else normalized

        # Check exact deny paths
        for deny in self._config.deny_paths:
            deny_lower = deny.lower()
            if basename == deny_lower or normalized.endswith(deny_lower):
                return True, f"File matches deny path: {deny}"

        # Check deny patterns
        for pattern in self._deny_path_compiled:
            if pattern.search(normalized):
                return True, f"File matches deny pattern: {pattern.pattern}"

        return False, ""

    def redact(
        self,
        text: str,
        file_path: str = "",
    ) -> Tuple[str, RedactionReport]:
        """
        Redact secrets and sensitive data from text.

        Returns (redacted_text, report).
        If file is blocked, returns ("", report) with report.blocked_file=True.
        """
        if not self._config.enabled:
            return text, RedactionReport()

        start = time.perf_counter()

        # Check file path deny list
        blocked, reason = self.is_blocked_path(file_path)
        if blocked:
            elapsed = (time.perf_counter() - start) * 1000
            logger.warning(f"Blocked file from LLM: {file_path} ({reason})")
            return "", RedactionReport(
                blocked_file=True,
                blocked_reason=reason,
                elapsed_ms=elapsed,
            )

        report = RedactionReport()
        redacted = text

        # Track offset shifts from replacements
        # We process patterns sequentially, each replacement may shift offsets
        for pattern_def in self._all_patterns:
            matches = list(pattern_def.pattern.finditer(redacted))
            if not matches:
                continue

            # Apply replacements in reverse order to preserve offsets
            for match in reversed(matches):
                matched_text = match.group(0)

                # Compute line/column for the match
                line_num = redacted[:match.start()].count("\n")
                line_start = redacted.rfind("\n", 0, match.start()) + 1
                col = match.start() - line_start

                # Hash the original for audit (NOT for reversal)
                original_hash = hashlib.sha256(
                    matched_text.encode()
                ).hexdigest()[:16]

                report.redactions.append(RedactionMatch(
                    pattern_name=pattern_def.name,
                    severity=pattern_def.severity,
                    line=line_num,
                    column=col,
                    length=len(matched_text),
                    placeholder=pattern_def.placeholder,
                    original_hash=original_hash,
                ))

                # Replace
                redacted = (
                    redacted[:match.start()]
                    + pattern_def.placeholder
                    + redacted[match.end():]
                )

        report.total_redactions = len(report.redactions)
        report.elapsed_ms = (time.perf_counter() - start) * 1000

        if report.has_redactions:
            logger.info(
                f"Redacted {report.total_redactions} secrets "
                f"({report.critical_count} critical) "
                f"in {report.elapsed_ms:.1f}ms"
                f"{f' from {file_path}' if file_path else ''}"
            )

        return redacted, report

    def redact_dict(
        self,
        data: Dict[str, Any],
        file_path: str = "",
    ) -> Tuple[Dict[str, Any], RedactionReport]:
        """
        Redact secrets from all string values in a dict (shallow).

        Useful for redacting request bodies before logging.
        """
        if not self._config.enabled:
            return data, RedactionReport()

        combined_report = RedactionReport()
        redacted_data = {}

        for key, value in data.items():
            if isinstance(value, str):
                redacted_val, report = self.redact(value, file_path)
                redacted_data[key] = redacted_val
                combined_report.redactions.extend(report.redactions)
            elif isinstance(value, list):
                redacted_list = []
                for item in value:
                    if isinstance(item, str):
                        redacted_val, report = self.redact(item, file_path)
                        redacted_list.append(redacted_val)
                        combined_report.redactions.extend(report.redactions)
                    else:
                        redacted_list.append(item)
                redacted_data[key] = redacted_list
            else:
                redacted_data[key] = value

        combined_report.total_redactions = len(combined_report.redactions)
        return redacted_data, combined_report

    def scan_only(
        self,
        text: str,
        file_path: str = "",
    ) -> RedactionReport:
        """
        Scan for secrets without actually redacting.

        Useful for pre-flight checks and warnings.
        """
        _, report = self.redact(text, file_path)
        return report


# ── Module-level singleton ────────────────────────────────────────────

_redaction_engine: Optional[RedactionEngine] = None


def get_redaction_engine(
    config: Optional[RedactionConfig] = None,
) -> RedactionEngine:
    """Get or create the global redaction engine."""
    global _redaction_engine
    if _redaction_engine is None:
        _redaction_engine = RedactionEngine(config)
    return _redaction_engine


def reset_redaction_engine() -> None:
    """Reset (for testing)."""
    global _redaction_engine
    _redaction_engine = None


def redact_before_llm(
    text: str,
    file_path: str = "",
) -> Tuple[str, RedactionReport]:
    """
    Convenience function: redact text before sending to LLM.

    Usage:
        safe_code, report = redact_before_llm(source_code, "config.py")
        if report.blocked_file:
            raise ValueError("Cannot send this file to LLM")
        response = await llm.call(safe_code)
    """
    engine = get_redaction_engine()
    return engine.redact(text, file_path)
