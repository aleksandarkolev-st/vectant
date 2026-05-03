"""
Gitignore guard — ensures AI-generated index directories are excluded
from version control in user workspaces.

When the code-intel engine or RAG pipeline creates `.code_intel/` or
`.synthi/` inside a workspace, this module appends the necessary entries
to the workspace's `.gitignore` (creating it if absent).   This prevents
AI index artefacts from flooding the user's source-control panel.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Sequence

logger = logging.getLogger("code_intel.gitignore_guard")

# Directories that must never be tracked by git
AI_IGNORE_ENTRIES: list[str] = [
    ".code_intel/",
    ".code_intel_backups/",
    ".synthi/",
]

_HEADER = "# Synthi AI – auto-generated index data (do not track)"


def ensure_gitignore(workspace_root: str | Path, extra: Sequence[str] = ()) -> bool:
    """
    Make sure *workspace_root*/.gitignore contains entries for every
    AI-generated directory.

    Parameters
    ----------
    workspace_root : str | Path
        Absolute path to the workspace root.
    extra : Sequence[str]
        Additional patterns to ensure (optional).

    Returns
    -------
    bool
        ``True`` if the file was modified/created, ``False`` if it
        already contained all required entries.
    """
    root = Path(workspace_root)
    # Workspace directory may not exist on disk — common for synthetic test
    # slugs (e.g. nep-livetest-*) that exercise endpoint shape without
    # materialising a repo. Without this guard the `.open("a")` below raises
    # FileNotFoundError and floods logs with tracebacks.
    if not root.is_dir():
        logger.debug("Skipping gitignore update: %s is not a directory", root)
        return False
    gitignore = root / ".gitignore"

    required = set(AI_IGNORE_ENTRIES)
    if extra:
        required.update(extra)

    # Read existing content (if any)
    existing_lines: list[str] = []
    if gitignore.exists():
        try:
            existing_lines = gitignore.read_text(encoding="utf-8").splitlines()
        except Exception:
            logger.warning("Could not read %s, will attempt to append", gitignore)

    # Determine which entries are already present
    normalised_existing = {line.strip() for line in existing_lines}
    missing = sorted(entry for entry in required if entry not in normalised_existing)

    if not missing:
        return False  # nothing to do

    # Build the block to append
    block_lines: list[str] = []
    if _HEADER not in normalised_existing:
        # Add a blank separator if the file already has content
        if existing_lines and existing_lines[-1].strip():
            block_lines.append("")
        block_lines.append(_HEADER)

    block_lines.extend(missing)
    block_lines.append("")  # trailing newline

    try:
        with gitignore.open("a", encoding="utf-8") as fh:
            fh.write("\n".join(block_lines))
        logger.info("Updated %s with AI index entries: %s", gitignore, missing)
        return True
    except Exception:
        logger.warning("Failed to update %s — AI index files may appear in SCM", gitignore, exc_info=True)
        return False
