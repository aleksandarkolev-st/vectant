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


def build_prompt(code: str, lang: str, user_prompt: str = None):
    """General analysis prompt. Returns a human-readable analysis or focused response.

    If `user_prompt` is provided, include it as the user's question. This prompt is intended
    for general code review and explanation tasks.
    """
    header = base_instructions + f"\n\nLanguage: {lang}\n\nCode:\n```{lang}\n{code}\n```\n\n"

    if user_prompt and user_prompt.strip():
        return header + f"User's Question: {user_prompt}\n\nProvide a focused response explaining any issues, improvement suggestions, and a minimal example if helpful."

    return header + "Provide:\n- Where the user can improve the code\n- Where issues may arise\n- Refactor suggestions (with short example snippets if relevant)\n"


def build_fullfile_prompt(code: str, lang: str, user_prompt: str = ''):
    """Build a strict instruction that asks the model to return only the updated full file contents.

    This function is used when the client expects the model to reply with a single fenced code
    block containing the complete file (no additional commentary). Use this when the client will
    parse and apply the returned file verbatim.
    """
    header = base_instructions + "\n\n"
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
        "If the user's instruction is focused (for example: \"rename variables foo->bar\"), make only those renames and preserve all other code identical. "
        "If a minimal change can be represented as a unified diff and the client requested a patch, return a unified diff instead (see `patch` mode)."
    )

    header += f"\n\nCURRENT FILE:\n```{lang}\n{code}\n```\n\n"
    header += "REPLY FORMAT: A single fenced code block only, containing the complete updated file."
    return header


def build_patch_prompt(code: str, lang: str, user_prompt: str = ''):
    """Build a prompt that asks the model to return a unified diff describing minimal changes.

    The model should reply ONLY with a single fenced code block with the `diff`/`patch` content
    using standard unified diff format (--- a/file, +++ b/file, @@ hunks @@). Do not include
    any explanatory text.
    """
    header = base_instructions + "\n\n"
    if user_prompt and user_prompt.strip():
        header += f"User instruction: {user_prompt}\n\n"

    header += (
        "You are given the CURRENT file contents below. Produce ONLY a unified diff (unified patch) that makes the minimal edits required to satisfy the user's instruction. "
        "Do NOT change unrelated code or perform broad refactors. The diff must be a valid unified diff that can be applied with the `patch` or `git apply` tools."
    )

    header += f"\n\nCURRENT FILE:\n```{lang}\n{code}\n```\n\n"
    header += "REPLY FORMAT: A single fenced code block containing a unified diff (use --- a/filename and +++ b/filename headers and @@ hunk markers)."
    return header