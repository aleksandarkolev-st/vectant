from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shadow.codesite_agent_workspace import CodeSiteExecutionBinding
from shadow.codesite_control_plane import verify_codesite_authority


def _binding():
    return CodeSiteExecutionBinding(
        workspace_slug="demo", project_id="project-1", agent_session_id="agent-1",
        mutation_lease_id="lease-1", transaction_id="txn-1", base_commit="a" * 40,
    )


class _Response:
    status = 200

    def __init__(self, body):
        self.body = body

    def read(self):
        return json.dumps(self.body).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _context(**overrides):
    context = {
        "contextVersion": "synthi.codesite.agentContext.v1",
        "project": {"id": "project-1", "workspaceSlug": "demo"},
        "agent": {"id": "agent-1"},
        "transactions": [{"id": "txn-1", "status": "open", "mutationLeaseId": "lease-1", "baseSnapshot": "a" * 40}],
        "leases": [{"id": "lease-1", "status": "active", "route": {"allowedPaths": ["src/**"]}}],
    }
    context.update(overrides)
    return {"context": context}


def test_authority_verification_binds_token_response_to_run(monkeypatch):
    seen = {}

    def fake_open(request, **kwargs):
        seen["url"] = request.full_url
        seen["authorization"] = request.headers["Authorization"]
        return _Response(_context())

    monkeypatch.setattr("shadow.codesite_control_plane.urlopen", fake_open)
    authority = verify_codesite_authority(
        control_plane_url="https://codesite.example.test/",
        agent_access_token="csa_" + "a" * 32,
        binding=_binding(),
    )

    assert authority.allowed_paths == ("src/**",)
    assert seen["url"].endswith("/api/workspace/demo/codesite/agent-sessions/agent-1/relevant-context")
    assert seen["authorization"].startswith("Bearer csa_")


@pytest.mark.parametrize("context", [
    _context(transactions=[]),
    _context(transactions=[{"id": "txn-1", "status": "blocked", "mutationLeaseId": "lease-1", "baseSnapshot": "a" * 40}]),
    _context(leases=[{"id": "lease-1", "status": "holding", "route": {"allowedPaths": ["src/**"]}}]),
    _context(leases=[{"id": "lease-1", "status": "active", "route": {"allowedPaths": []}}]),
])
def test_authority_verification_fails_closed_for_nonwritable_context(monkeypatch, context):
    monkeypatch.setattr("shadow.codesite_control_plane.urlopen", lambda *args, **kwargs: _Response(context))
    with pytest.raises(PermissionError):
        verify_codesite_authority(
            control_plane_url="https://codesite.example.test",
            agent_access_token="csa_" + "a" * 32,
            binding=_binding(),
        )


@pytest.mark.parametrize("url", ["http://codesite.example.test", "https://user@codesite.example.test", "", "https://codesite.example.test/?x=1"])
def test_authority_verification_rejects_untrusted_control_plane_urls(url):
    with pytest.raises(ValueError):
        verify_codesite_authority(
            control_plane_url=url,
            agent_access_token="csa_" + "a" * 32,
            binding=_binding(),
        )
