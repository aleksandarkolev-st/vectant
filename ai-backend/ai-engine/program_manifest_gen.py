"""Generate a vectant.programs.json manifest from workspace context (Gemini).

Import-light (lazy get_provider) so unit tests with a fake provider need no
Gemini SDK. Fail-closed: any provider/parse failure returns {"error": ...} rather
than a partial/garbage manifest. The Next.js caller re-validates the result with
parseProgramManifest before ever offering or saving it.
"""

from __future__ import annotations

import json
import re
from typing import Any, Mapping, Optional

_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)
_OBJ_RE = re.compile(r"\{.*\}", re.DOTALL)

_PROMPT = """You author Vectant program manifests. Given a workspace's key files, emit ONE \
JSON object for `vectant.programs.json` describing how to run this project as a program.

Schema: {{"packageId": kebab-case id, "version": "x.y.z", "displayName": str, \
"description": str, "runtimeType": one of web|cli|tui|background|gui|container, \
"install": [shell commands], "launch": "shell command", "ports": [ints], \
"permissions": subset of ["program.launch","workspace.files.read","workspace.files.write","network.outbound","ports.expose"]}}.
Rules: infer runtimeType + ports from the files (a web dev server -> "web" + its port; a CLI -> "cli"). \
NEVER use --privileged, --cap-add, --security-opt, --device, or mount docker.sock / host paths. \
Return ONLY the JSON object, no prose.

Workspace: {name}
Files:
{files}
"""


def _build_prompt(payload: Mapping[str, Any]) -> str:
    files = payload.get("files") or {}
    blob = "\n\n".join(f"=== {n} ===\n{str(c)[:4000]}" for n, c in list(files.items())[:12])
    return _PROMPT.format(name=str(payload.get("workspace_name") or "workspace"), files=blob[:16000])


def _extract_json(text: str) -> Optional[dict]:
    if not isinstance(text, str):
        return None
    for rx in (_FENCE_RE, _OBJ_RE):
        m = rx.search(text)
        if m:
            try:
                obj = json.loads(m.group(1) if rx is _FENCE_RE else m.group(0))
                if isinstance(obj, dict):
                    return obj
            except (ValueError, TypeError):
                continue
    return None


async def generate_manifest(payload: Mapping[str, Any], provider: Optional[Any] = None) -> dict:
    """Draft a manifest from workspace files. Fail-closed on any provider/parse failure."""
    if provider is None:
        from llm.providers import get_provider  # lazy: avoid importing the Gemini SDK at module load
        provider = get_provider()
    try:
        reply = await provider.ask_llm(code="", lang="json", prompt=_build_prompt(payload), mode="rule_translate")
    except Exception:  # noqa: BLE001 — never raise into the caller; degrade to an error result
        return {"error": "generation_unavailable"}
    obj = _extract_json(reply)
    if obj is None:
        return {"error": "unparseable_manifest"}
    return {"manifest": obj}
