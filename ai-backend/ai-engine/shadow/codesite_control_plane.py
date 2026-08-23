"""Minimal fail-closed authority checks for CodeSite-managed agent runs."""

from __future__ import annotations

import json
import ssl
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

from .codesite_agent_workspace import CodeSiteExecutionBinding


@dataclass(frozen=True)
class CodeSiteAuthority:
    binding: CodeSiteExecutionBinding
    allowed_paths: tuple[str, ...]


def verify_codesite_authority(
    *,
    control_plane_url: str,
    agent_access_token: str,
    binding: CodeSiteExecutionBinding,
    timeout_seconds: float = 10,
) -> CodeSiteAuthority:
    """Verify a scoped agent token and transaction binding with CodeSite.

    The API response is deliberately treated as untrusted until every identity
    field supplied to the runner has been matched.  Network or parse failures
    deny execution; CodeSite-managed runs never degrade to local-only mode.
    """
    base = _trusted_base_url(control_plane_url)
    token = str(agent_access_token or "").strip()
    if not token:
        raise PermissionError("CodeSite agent access token is required")
    endpoint = (
        f"{base}/api/workspace/{quote(binding.workspace_slug, safe='')}/codesite/agent-sessions/"
        f"{quote(binding.agent_session_id, safe='')}/relevant-context"
    )
    request = Request(endpoint, headers={
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
    }, method="GET")
    try:
        with urlopen(request, timeout=timeout_seconds, context=ssl.create_default_context()) as response:
            if response.status != 200:
                raise PermissionError("CodeSite authority rejected agent execution")
            payload: dict[str, Any] = json.loads(response.read().decode("utf-8"))
    except PermissionError:
        raise
    except Exception as error:
        raise PermissionError("CodeSite authority verification failed") from error
    context = payload.get("context", payload)
    if not isinstance(context, dict) or context.get("contextVersion") != "synthi.codesite.agentContext.v1":
        raise PermissionError("CodeSite authority returned an invalid context")
    project = context.get("project") or {}
    agent = context.get("agent") or {}
    if project.get("id") != binding.project_id or project.get("workspaceSlug") != binding.workspace_slug:
        raise PermissionError("CodeSite project binding mismatch")
    if agent.get("id") != binding.agent_session_id:
        raise PermissionError("CodeSite agent session binding mismatch")
    transaction = next((item for item in context.get("transactions") or [] if item.get("id") == binding.transaction_id), None)
    if not transaction or transaction.get("status") not in {"open", "prepared"}:
        raise PermissionError("CodeSite transaction is not writable")
    if transaction.get("mutationLeaseId") != binding.mutation_lease_id:
        raise PermissionError("CodeSite mutation lease binding mismatch")
    if transaction.get("baseSnapshot") != binding.base_commit:
        raise PermissionError("CodeSite base snapshot binding mismatch")
    lease = next((item for item in context.get("leases") or [] if item.get("id") == binding.mutation_lease_id), None)
    if not lease or lease.get("status") != "active":
        raise PermissionError("CodeSite mutation lease is not active")
    route = lease.get("route") or {}
    allowed_paths = tuple(str(path) for path in route.get("allowedPaths", route.get("route", [])) if isinstance(path, str) and path)
    if not allowed_paths:
        raise PermissionError("CodeSite mutation lease has no writable route")
    return CodeSiteAuthority(binding=binding, allowed_paths=allowed_paths)


def record_codesite_writes(*, control_plane_url: str, agent_access_token: str,
                           binding: CodeSiteExecutionBinding, paths: list[str]) -> None:
    base = _trusted_base_url(control_plane_url)
    for path in paths:
        request = Request(
            f"{base}/api/workspace/{quote(binding.workspace_slug, safe='')}/codesite/agent-sessions/"
            f"{quote(binding.agent_session_id, safe='')}/transactions/{quote(binding.transaction_id, safe='')}/record-write",
            data=json.dumps({"path": path, "tool": "agent_overlay"}).encode("utf-8"),
            headers={"Accept": "application/json", "Content-Type": "application/json", "Authorization": f"Bearer {agent_access_token}"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=10, context=ssl.create_default_context()) as response:
                if response.status not in {200, 201}: raise PermissionError("CodeSite rejected overlay write evidence")
        except PermissionError: raise
        except Exception as error: raise PermissionError("CodeSite write evidence recording failed") from error


def _trusted_base_url(value: str) -> str:
    parsed = urlparse(str(value or "").strip())
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("CodeSite control plane URL must be an HTTPS origin")
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path.rstrip('/')}"
