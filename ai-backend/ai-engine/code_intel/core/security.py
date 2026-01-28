"""
Security Boundaries for Code Intelligence.

Production requirements:
1. Path jail - never traverse outside workspace
2. Secrets redaction - filter out API keys, passwords, tokens
3. Workspace isolation - each workspace is a separate security context
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple, Pattern

from ..core.types import SemanticChunk


logger = logging.getLogger("code_intel.security")


# =============================================================================
# Secrets Detection Patterns
# =============================================================================

@dataclass
class SecretPattern:
    """A pattern for detecting secrets."""
    name: str
    pattern: Pattern[str]
    severity: str  # "high", "medium", "low"
    redact_full_line: bool = False


# Pre-compiled secret patterns
SECRET_PATTERNS: List[SecretPattern] = [
    # API Keys
    SecretPattern(
        name="generic_api_key",
        pattern=re.compile(
            r'''(?i)(api[_-]?key|apikey)\s*[:=]\s*["']?([a-zA-Z0-9_\-]{20,})["']?''',
            re.MULTILINE
        ),
        severity="high",
    ),
    SecretPattern(
        name="aws_access_key",
        pattern=re.compile(r'AKIA[0-9A-Z]{16}'),
        severity="high",
    ),
    SecretPattern(
        name="github_token",
        pattern=re.compile(r'gh[pous]_[A-Za-z0-9_]{36,}'),
        severity="high",
    ),
    SecretPattern(
        name="jwt_token",
        pattern=re.compile(r'eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*'),
        severity="high",
    ),
    
    # Passwords
    SecretPattern(
        name="password_assignment",
        pattern=re.compile(
            r'''(?i)(password|passwd|pwd)\s*[:=]\s*["']([^"'\s]{8,})["']''',
            re.MULTILINE
        ),
        severity="high",
    ),
    SecretPattern(
        name="secret_assignment",
        pattern=re.compile(
            r'''(?i)(secret|token|auth)\s*[:=]\s*["']([^"'\s]{8,})["']''',
            re.MULTILINE
        ),
        severity="medium",
    ),
    
    # Connection strings
    SecretPattern(
        name="database_url",
        pattern=re.compile(
            r'''(?i)(postgres|mysql|mongodb|redis)://[^\s<>"']+:[^\s<>"']+@[^\s<>"']+''',
            re.MULTILINE
        ),
        severity="high",
        redact_full_line=True,
    ),
    
    # Private keys
    SecretPattern(
        name="private_key",
        pattern=re.compile(r'-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----'),
        severity="high",
        redact_full_line=True,
    ),
    
    # Cloud credentials
    SecretPattern(
        name="azure_key",
        pattern=re.compile(r'[a-zA-Z0-9+/]{86}=='),
        severity="medium",
    ),
]

# Files that should never be indexed
BLOCKED_FILE_PATTERNS: List[Pattern[str]] = [
    re.compile(r'\.env(?:\.local|\.prod|\.dev)?$'),
    re.compile(r'\.pem$'),
    re.compile(r'\.key$'),
    re.compile(r'credentials\.json$'),
    re.compile(r'secrets\.ya?ml$'),
    re.compile(r'\.npmrc$'),
    re.compile(r'\.pypirc$'),
    re.compile(r'id_rsa(?:\.pub)?$'),
    re.compile(r'\.ssh/'),
]


# =============================================================================
# Security Boundary Enforcement
# =============================================================================

@dataclass
class SecurityContext:
    """
    Security context for a workspace.
    
    All operations are restricted to this context.
    """
    workspace_root: Path
    workspace_id: str
    
    # Computed fields
    _canonical_root: Path = field(init=False)
    
    def __post_init__(self):
        """Canonicalize the workspace root."""
        self._canonical_root = self.workspace_root.resolve()
    
    @classmethod
    def create(cls, workspace_path: str, workspace_id: Optional[str] = None) -> "SecurityContext":
        """Create a security context from a path."""
        root = Path(workspace_path).resolve()
        
        if not root.exists():
            raise SecurityViolation(f"Workspace does not exist: {workspace_path}")
        
        if not root.is_dir():
            raise SecurityViolation(f"Workspace is not a directory: {workspace_path}")
        
        # Generate ID from path if not provided
        if workspace_id is None:
            workspace_id = hashlib.sha256(str(root).encode()).hexdigest()[:16]
        
        return cls(workspace_root=root, workspace_id=workspace_id)


class SecurityViolation(Exception):
    """Raised when a security boundary is violated."""
    pass


class SecurityBoundary:
    """
    Enforces security boundaries for code intelligence operations.
    
    Three key guarantees:
    1. Path jail: All file access is within workspace root
    2. Secrets redaction: Sensitive data is masked before returning
    3. Workspace isolation: Each workspace is independent
    """
    
    def __init__(self, context: SecurityContext):
        self.context = context
        self._secret_patterns = SECRET_PATTERNS
        self._blocked_patterns = BLOCKED_FILE_PATTERNS
    
    # =========================================================================
    # Path Jail
    # =========================================================================
    
    def validate_path(self, path: str) -> Path:
        """
        Validate and canonicalize a path, ensuring it's within workspace.
        
        Raises SecurityViolation if path escapes workspace.
        """
        # Handle both absolute and relative paths
        path_obj = Path(path)
        
        if path_obj.is_absolute():
            canonical = path_obj.resolve()
        else:
            canonical = (self.context.workspace_root / path_obj).resolve()
        
        # Check if within workspace (prevent path traversal)
        try:
            canonical.relative_to(self.context._canonical_root)
        except ValueError:
            raise SecurityViolation(
                f"Path escapes workspace: {path} -> {canonical}"
            )
        
        return canonical
    
    def is_valid_path(self, path: str) -> bool:
        """Check if a path is valid without raising."""
        try:
            self.validate_path(path)
            return True
        except SecurityViolation:
            return False
    
    def get_relative_path(self, path: str) -> str:
        """Get workspace-relative path."""
        canonical = self.validate_path(path)
        return str(canonical.relative_to(self.context._canonical_root))
    
    # =========================================================================
    # File Blocking
    # =========================================================================
    
    def should_block_file(self, path: str) -> Tuple[bool, Optional[str]]:
        """
        Check if a file should be blocked from indexing.
        
        Returns: (should_block, reason)
        """
        path_str = str(path).replace("\\", "/")
        
        for pattern in self._blocked_patterns:
            if pattern.search(path_str):
                return True, f"Matches blocked pattern: {pattern.pattern}"
        
        return False, None
    
    def filter_paths(self, paths: List[str]) -> List[str]:
        """Filter out blocked paths."""
        result = []
        for path in paths:
            blocked, reason = self.should_block_file(path)
            if blocked:
                logger.info(f"Blocking file: {path} ({reason})")
            else:
                result.append(path)
        return result
    
    # =========================================================================
    # Secrets Redaction
    # =========================================================================
    
    def redact_secrets(self, content: str) -> Tuple[str, List[str]]:
        """
        Redact secrets from content.
        
        Returns: (redacted_content, list_of_redacted_types)
        """
        redacted_types: List[str] = []
        redacted = content
        
        for pattern in self._secret_patterns:
            matches = list(pattern.pattern.finditer(redacted))
            
            if not matches:
                continue
            
            redacted_types.append(pattern.name)
            
            if pattern.redact_full_line:
                # Redact entire lines containing matches
                lines = redacted.split("\n")
                new_lines = []
                for line in lines:
                    if pattern.pattern.search(line):
                        new_lines.append(f"[REDACTED: {pattern.name}]")
                    else:
                        new_lines.append(line)
                redacted = "\n".join(new_lines)
            else:
                # Just redact the matched value
                redacted = pattern.pattern.sub(
                    lambda m: self._redact_match(m, pattern.name),
                    redacted
                )
        
        return redacted, redacted_types
    
    def _redact_match(self, match: re.Match, pattern_name: str) -> str:
        """Replace match with redaction marker."""
        groups = match.groups()
        if len(groups) >= 2:
            # Keep the key name, redact the value
            return f'{groups[0]}=[REDACTED:{pattern_name}]'
        else:
            return f'[REDACTED:{pattern_name}]'
    
    def redact_chunk(self, chunk: SemanticChunk) -> SemanticChunk:
        """Redact secrets from a chunk."""
        code, code_types = self.redact_secrets(chunk.code_body) if chunk.code_body else ("", [])
        doc, doc_types = self.redact_secrets(chunk.docstring) if chunk.docstring else ("", [])
        
        if code_types or doc_types:
            logger.info(
                f"Redacted secrets in {chunk.file_path}: "
                f"{code_types + doc_types}"
            )
        
        # Return new chunk with redacted content
        return SemanticChunk(
            id=chunk.id,
            file_path=chunk.file_path,
            symbol_name=chunk.symbol_name,
            symbol_type=chunk.symbol_type,
            docstring=doc if doc else chunk.docstring,
            code_body=code if code else chunk.code_body,
            embedding=chunk.embedding,
            metadata=chunk.metadata,
        )
    
    def redact_chunks(self, chunks: List[SemanticChunk]) -> List[SemanticChunk]:
        """Redact secrets from multiple chunks."""
        return [self.redact_chunk(c) for c in chunks]
    
    # =========================================================================
    # Workspace Isolation
    # =========================================================================
    
    def get_storage_path(self, name: str) -> Path:
        """
        Get isolated storage path for workspace data.
        
        All persistent data goes here.
        """
        storage_root = self.context.workspace_root / ".synthi" / "code_intel"
        storage_root.mkdir(parents=True, exist_ok=True)
        return storage_root / name
    
    def validate_workspace_id(self, provided_id: str) -> bool:
        """Verify a workspace ID matches this context."""
        return provided_id == self.context.workspace_id


def create_security_boundary(workspace_path: str) -> SecurityBoundary:
    """Create a security boundary for a workspace."""
    context = SecurityContext.create(workspace_path)
    return SecurityBoundary(context)
