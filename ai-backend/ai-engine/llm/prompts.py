from typing import Any, Mapping, Optional, Sequence, Tuple


base_instructions = """
You are an expert developer, with much experience in the industry. When presented with a prompt, apply this methodology:

1) Prefer SOLID principles and clear separation of concerns.
2) Consult framework and language documentation when unsure.
3) Produce clean, maintainable and readable code suitable for a reviewer unfamiliar with the repository.
4) For low-level languages prefer safe, idiomatic performance optimizations; only trade readability for speed when explicitly requested.
5) Only perform changes the user requests. Do not add unrelated features or modify external systems (databases, external services) without explicit permission.
6) Ask clarifying questions when the intent is ambiguous.
7) Prefer simplicity; do not over-engineer.
8) Double-check generated code for correctness and follow-up with a short explanation when appropriate.
9) Assume production usage: be mindful of performance, security, and correctness.
10) When producing code patches, prefer minimal, well-documented changes.
"""

FILE_CONTEXT_MAX_CHARS = 3600
FILE_CONTEXT_HEAD_CHARS = 1800
FILE_CONTEXT_TAIL_CHARS = FILE_CONTEXT_MAX_CHARS - FILE_CONTEXT_HEAD_CHARS


def _coerce_mapping(entry: Any) -> Optional[Mapping[str, Any]]:
    if entry is None:
        return None
    if isinstance(entry, Mapping):
        return entry
    if hasattr(entry, "dict"):
        try:
            return entry.dict()
        except Exception:
            return None
    return None


def _trim_file_block(content: str, max_chars: int = FILE_CONTEXT_MAX_CHARS) -> str:
    if not content:
        return ""
    if len(content) <= max_chars:
        return content
    head = content[:FILE_CONTEXT_HEAD_CHARS]
    tail = content[-FILE_CONTEXT_TAIL_CHARS:]
    return f"{head}\n...\n{tail}"


def _format_files_context(
    files: Optional[Sequence[Mapping[str, Any]]],
) -> Tuple[str, Optional[str]]:
    if not files:
        return ("", None)

    segments = []
    focus_path = None
    for idx, raw in enumerate(files, start=1):
        data = _coerce_mapping(raw)
        if not data:
            continue
        content = _trim_file_block(str(data.get("content", "") or ""))
        if not content.strip():
            continue
        path = data.get("path") or data.get("name") or f"file-{idx}"
        if not focus_path:
            focus_path = path
        segments.append(
            f"==== FILE: {path} ====\n{content}\n==== END FILE: {path} ===="
        )

    return ("\n\n".join(segments).strip(), focus_path)


def _file_guidance(focus_path: Optional[str]) -> str:
    guidance = (
        "When referring to the provided files, always mention the file path so the user "
        "can identify the source. Only modify the active/primary file unless explicitly instructed."
    )
    if focus_path:
        guidance += f" Focus primarily on `{focus_path}` when making edits."
    return guidance


def _response_format_instructions(mode: str, focus_path: Optional[str]) -> str:
    focus_clause = (
        f"Focus edits on `{focus_path}` unless the user explicitly directs otherwise."
        if focus_path
        else "Focus on the files provided above and make only the requested changes."
    )
    base = (
        f"{focus_clause} Always identify the file you are updating by writing `FILE: <path>` "
        "before each code or diff section. If you know the affected line span, include a `LINES: start-end` line."
    )

    if mode == "patch":
        return (
            base
            + " Respond with unified diffs per file inside fenced `diff` code blocks. If no change is needed, write "
              "`FILE: <path>` followed by `NO_CHANGES`."
        )
    if mode == "fullfile":
        return (
            base
            + " After the metadata lines, provide the complete updated file contents inside a single fenced code "
              "block with the correct language tag. If no change is needed, write `FILE: <path>` followed by `NO_CHANGES`."
        )
    return (
        base
        + " When sharing code, still follow the `FILE: <path>` + fenced block pattern so the user knows which file "
          "to update."
    )


def build_prompt(
    code: str,
    lang: str,
    user_prompt: str = None,
    files: Optional[Sequence[Mapping[str, Any]]] = None,
    focus: Optional[str] = None,
):
    """General analysis prompt. Returns a human-readable analysis or focused response.

    If `user_prompt` is provided, include it as the user's question. This prompt is intended
    for general code review and explanation tasks.
    """
    file_section, detected_focus = _format_files_context(files)
    focus_path = focus or detected_focus
    guidance = _file_guidance(focus_path) if (file_section or focus_path) else ""

    header_parts = [base_instructions.strip()]
    if guidance:
        header_parts.append(guidance)
    header_parts.append(f"Language: {lang}")
    if file_section:
        header_parts.append("FILES:\n" + file_section)
    header_parts.append(f"Active file code:\n```{lang}\n{code}\n```")
    header_parts.append(_response_format_instructions("general", focus_path))
    header = "\n\n".join(filter(bool, header_parts)) + "\n\n"

    if user_prompt and user_prompt.strip():
        return header + f"User's Question: {user_prompt}\n\nProvide a focused response explaining any issues, improvement suggestions, and a minimal example if helpful."

    return header + "Provide:\n- Where the user can improve the code\n- Where issues may arise\n- Refactor suggestions (with short example snippets if relevant)\n"


def build_fullfile_prompt(
    code: str,
    lang: str,
    user_prompt: str = '',
    files: Optional[Sequence[Mapping[str, Any]]] = None,
    focus: Optional[str] = None,
):
    """Build a strict instruction that asks the model to return only the updated full file contents.

    This function is used when the client expects the model to reply with a single fenced code
    block containing the complete file (no additional commentary). Use this when the client will
    parse and apply the returned file verbatim.
    """
    file_section, detected_focus = _format_files_context(files)
    focus_path = focus or detected_focus
    header = base_instructions + "\n\n"
    if file_section or focus_path:
        header += _file_guidance(focus_path) + "\n\n"
    if user_prompt and user_prompt.strip():
        header += f"User instruction: {user_prompt}\n\n"

    header += (
        "The code block below contains the CURRENT file contents. Return ONLY the UPDATED full file contents "
        "inside a single fenced code block (triple backticks) with the correct language tag. "
        "Do NOT include any other text, explanations, or metadata. If no changes are required, return the "
        "original file contents inside the same single fenced code block.\n\n"
    )

    header += (
        "IMPORTANT: Only perform the exact changes requested by the user. Prefer minimal edits: do not refactor, reorder, or rename unrelated symbols unless explicitly asked. "
        "If the user's instruction is focused (for example: \"rename variables foo->bar\"), make only those renames and every usage of those renames, and preserve all other code identical. "
        "If a minimal change can be represented as a unified diff and the client requested a patch, return a unified diff instead (see `patch` mode)."
    )

    if file_section:
        header += f"FILES:\n{file_section}\n\n"

    header += f"CURRENT FILE:\n```{lang}\n{code}\n```\n\n"
    header += _response_format_instructions("fullfile", focus_path)
    return header


def build_patch_prompt(
    code: str,
    lang: str,
    user_prompt: str = '',
    files: Optional[Sequence[Mapping[str, Any]]] = None,
    focus: Optional[str] = None,
):
    """Build a prompt that asks the model to return a unified diff describing minimal changes.

    The model should reply ONLY with a single fenced code block with the `diff`/`patch` content without
    using standard unified diff format (--- a/file, +++ b/file, @@ hunks @@). Do not include
    any explanatory text.
    """
    file_section, detected_focus = _format_files_context(files)
    focus_path = focus or detected_focus
    header = base_instructions + "\n\n"
    if file_section or focus_path:
        header += _file_guidance(focus_path) + "\n\n"
    if user_prompt and user_prompt.strip():
        header += f"User instruction: {user_prompt}\n\n"

    header += (
        "You are given the CURRENT file contents below. Produce ONLY the full updated file contents for the requested file. "
        "Do NOT use unified diff format. Do NOT include `+++`, `---`, `@@`, or leading `+`/`-` markers. "
        "Start with a brief (6-7 sentences) summary of the change. Then, for each file, precede the update with `FILE: <path>` (one per file) and wrap the updated file content in a single fenced code block. "
        "Do NOT add new files unless explicitly requested. Preserve every existing line outside the requested change; do not truncate, reorder includes, or refactor unrelated code. "
        "If the user names a specific file, update exactly that file path and no others. "
        "If the request is unclear or cannot be completed safely, reply with `FILE: <path>` followed by `NO_CHANGES` and a single clarifying question."
    )

    if file_section:
        header += f"\nFILES:\n{file_section}\n\n"

    header += f"CURRENT FILE:\n```{lang}\n{code}\n```\n\n"
    header += _response_format_instructions("patch", focus_path)
    return header
