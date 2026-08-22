"""Live-workspace mutation policy and evidence capture."""

from __future__ import annotations

import hashlib
import os
import stat
from pathlib import Path
from typing import Dict


PROTECTED_ROOTS = frozenset({".git", ".vectant", ".synthi", ".claude", ".codex", ".agents"})
PROTECTED_NAMES = frozenset({".env", ".env.local", ".env.production", ".envrc"})


def protected_snapshot(workspace: Path) -> Dict[str, str]:
    """Hash protected files without retaining their contents in telemetry."""
    root = Path(workspace).resolve()
    result: Dict[str, str] = {}
    for path in root.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        relative = path.relative_to(root)
        if relative.parts[0] in PROTECTED_ROOTS or path.name in PROTECTED_NAMES or path.suffix.lower() in {".pem", ".key", ".p12", ".pfx"}:
            result[relative.as_posix()] = _digest(path)
    return result


def assert_protected_unchanged(before: Dict[str, str], workspace: Path) -> None:
    after = protected_snapshot(workspace)
    if before != after:
        changed = sorted(set(before).symmetric_difference(after) | {key for key in before.keys() & after.keys() if before[key] != after[key]})
        raise PermissionError("agent modified protected workspace paths: " + ", ".join(changed[:10]))


def provision_agent_write_access(workspace: Path, shared_gid: int = 1000) -> None:
    """Grant the harness group write access only to non-protected entries.

    This is intentionally a targeted chmod/chgrp operation: secrets and
    control-plane paths retain their existing owner-only permissions.
    """
    if not hasattr(os, "chown"):
        raise RuntimeError("live agent permission provisioning requires a POSIX runtime")
    root = Path(workspace).resolve()
    for path in [root, *root.rglob("*")]:
        if path.is_symlink() or _is_protected(root, path):
            continue
        try:
            current = path.stat().st_mode
            os.chown(path, -1, shared_gid)
            if path.is_dir():
                os.chmod(path, current | stat.S_IRWXG | stat.S_ISGID)
            elif path.is_file():
                os.chmod(path, current | stat.S_IRGRP | stat.S_IWGRP)
        except OSError as error:
            raise PermissionError(f"unable to provision agent write access for {path.relative_to(root)}") from error


def protected_paths(workspace: Path) -> list[Path]:
    root = Path(workspace).resolve()
    paths: list[Path] = []
    for item in root.iterdir():
        if item.is_symlink():
            continue
        if item.name in PROTECTED_ROOTS or item.name in PROTECTED_NAMES or item.suffix.lower() in {".pem", ".key", ".p12", ".pfx"}:
            paths.append(item)
    return paths


def _is_protected(root: Path, path: Path) -> bool:
    relative = path.relative_to(root)
    return bool(relative.parts) and (relative.parts[0] in PROTECTED_ROOTS or path.name in PROTECTED_NAMES or path.suffix.lower() in {".pem", ".key", ".p12", ".pfx"})


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
