"""Snapshot + 3-way merge + AI-rebase fallback (master plan §8).

A snapshot captures the source-repo state at job start: per-file SHA-256
hashes for every file in the patch set. At apply time we hash-compare to
choose between direct apply, `git merge-file` 3-way, or AI-rebase.

Wave 1 ships a minimum-viable AI-rebase that calls the existing Gemini
provider with a conflict-resolution prompt. The result is run through a
quick syntax-only sanity check before being accepted.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("shadow.snapshot")


@dataclass
class FileSnapshot:
    path: str
    sha256: str
    content: str  # base text used for 3-way merge


@dataclass
class Snapshot:
    files: Dict[str, FileSnapshot]
    yjs_clock: Optional[Dict[str, Any]] = None  # filled when collab-server wired

    def hashes(self) -> Dict[str, str]:
        return {p: f.sha256 for p, f in self.files.items()}


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def create(repo: Path, paths: List[str]) -> Snapshot:
    files: Dict[str, FileSnapshot] = {}
    for rel in paths:
        full = repo / rel
        try:
            content = full.read_text(encoding="utf-8")
        except FileNotFoundError:
            content = ""
        except UnicodeDecodeError:
            # Binary or unknown encoding — skip text snapshot, but record a hash
            # of the raw bytes so we still detect "unchanged" cases.
            data = full.read_bytes()
            files[rel] = FileSnapshot(path=rel, sha256=hashlib.sha256(data).hexdigest(), content="")
            continue
        files[rel] = FileSnapshot(path=rel, sha256=sha256_text(content), content=content)
    return Snapshot(files=files)


# ---------------------------------------------------------------------------
# Apply ladder
# ---------------------------------------------------------------------------

@dataclass
class ApplyResult:
    path: str
    strategy: str  # "direct" | "3way" | "ai-rebase" | "conflict"
    new_content: Optional[str]
    note: Optional[str] = None


async def apply_one(
    repo: Path,
    snap: Snapshot,
    rel: str,
    patched_content: str,
    *,
    ai_rebase: Optional["AiRebaseFn"] = None,
) -> ApplyResult:
    base = snap.files.get(rel)
    full = repo / rel
    current_content: str
    try:
        current_content = full.read_text(encoding="utf-8")
    except FileNotFoundError:
        current_content = ""

    current_hash = sha256_text(current_content)
    base_hash = base.sha256 if base else sha256_text("")

    # Case 1: file unchanged since snapshot
    if current_hash == base_hash:
        return ApplyResult(rel, "direct", patched_content)

    # Case 2: try 3-way merge via `git merge-file`
    merged = await _git_merge_file(
        base=(base.content if base else ""),
        ours=current_content,
        theirs=patched_content,
    )
    if merged is not None:
        return ApplyResult(rel, "3way", merged)

    # Case 3: AI-rebase fallback
    if ai_rebase is not None:
        try:
            ai_text = await ai_rebase(
                base=(base.content if base else ""),
                ours=current_content,
                theirs=patched_content,
                path=rel,
            )
            if ai_text and await _quick_validate(rel, ai_text):
                return ApplyResult(rel, "ai-rebase", ai_text)
            if ai_text:
                return ApplyResult(rel, "conflict", None,
                                   note="AI-rebase produced output but quick-validate rejected it")
        except Exception as e:
            logger.warning("ai-rebase failed for %s: %s", rel, e)

    return ApplyResult(rel, "conflict", None, note="3-way + AI-rebase exhausted")


# ---------------------------------------------------------------------------
# AI-rebase quick-validate (master plan §8.3)
# ---------------------------------------------------------------------------
#
# After AI-rebase produces a merged file, we run a syntax-only check before
# accepting the result. Pass → apply. Fail → surface as a conflict so the
# caller can fall through to "Apply anyway" / "Re-verify" UX.

async def _quick_validate(rel: str, text: str) -> bool:
    try:
        from .runner.syntax import SyntaxRunner
    except Exception:
        return True  # syntax runner unavailable → accept (degrade open)

    runner = SyntaxRunner()
    diag = runner._parse_check(rel, text)
    return diag is None


async def _git_merge_file(base: str, ours: str, theirs: str) -> Optional[str]:
    with tempfile.TemporaryDirectory() as td:
        bp = Path(td) / "BASE"
        op = Path(td) / "OURS"
        tp = Path(td) / "THEIRS"
        bp.write_text(base, encoding="utf-8")
        op.write_text(ours, encoding="utf-8")
        tp.write_text(theirs, encoding="utf-8")
        proc = await asyncio.create_subprocess_exec(
            "git", "merge-file", "-p", "-L", "ours", "-L", "base", "-L", "theirs",
            str(op), str(bp), str(tp),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, _err = await proc.communicate()
        if proc.returncode == 0:
            return out.decode("utf-8", errors="replace")
        return None


# ---------------------------------------------------------------------------
# AI-rebase using the existing provider
# ---------------------------------------------------------------------------

from typing import Awaitable, Callable

AiRebaseFn = Callable[..., Awaitable[Optional[str]]]


async def gemini_ai_rebase(*, base: str, ours: str, theirs: str, path: str) -> Optional[str]:
    """Use the existing Gemini provider to resolve a 3-way conflict.

    Returns the merged file text on success, None on refuse/failure.
    """
    try:
        from llm.providers import get_provider
    except Exception as e:
        logger.warning("ai-rebase: provider import failed: %s", e)
        return None

    provider = get_provider()
    prompt = (
        "You are resolving a 3-way merge conflict for a single file.\n"
        "Combine the OURS edits (made by the user concurrently) with the THEIRS\n"
        "edits (a verified patch) on top of BASE. Preserve the user's intent.\n"
        "If the merge is impossible, output exactly the token REFUSE on a single line.\n"
        f"PATH: {path}\n\n"
        f"<BASE>\n{base}\n</BASE>\n\n"
        f"<OURS>\n{ours}\n</OURS>\n\n"
        f"<THEIRS>\n{theirs}\n</THEIRS>\n\n"
        "Output the final file content, nothing else."
    )
    try:
        text = await provider.ask_llm(code="", lang="text", prompt=prompt, mode="merge")
    except Exception as e:
        logger.warning("ai-rebase provider call failed: %s", e)
        return None
    if not text or text.strip() == "REFUSE":
        return None
    return text
