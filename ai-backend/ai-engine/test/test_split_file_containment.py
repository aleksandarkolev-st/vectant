from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import main


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("AI_ENGINE_AUTH_DISABLED", "true")
    monkeypatch.setattr(main, "AI_ENGINE_AUTH_DISABLED", True)
    with TestClient(main.app) as test_client:
        yield test_client


@pytest.fixture
def temporary_directory():
    directory = Path(__file__).parent / ".split-file-test-workspaces"
    test_root = directory / f"{id(object())}"
    test_root.mkdir(parents=True)
    yield test_root


def test_rejects_caller_supplied_workspace_root(client):
    response = client.post(
        "/refactor/split_file",
        params={"file_path": "passwd", "workspace_root": "/etc"},
    )

    assert response.status_code in {400, 404}
    assert response.status_code != 200


def test_writes_split_modules_inside_workspace_root(
    temporary_directory, client, monkeypatch
):
    workspace = temporary_directory / "workspace"
    workspace.mkdir()
    (workspace / "source.py").write_text("value = 1\n", encoding="utf-8")

    class FakeResponse:
        ok = True

        def raise_for_status(self):
            return None

        def json(self):
            return {
                "result": '{"split_a": {"filename": "split_a.py", "content": "x = 1"}}'
            }

    calls = {}

    def fake_post(url, **kwargs):
        calls["url"] = url
        calls["json"] = kwargs.get("json")
        return FakeResponse()

    monkeypatch.setenv("SPLIT_WORKSPACE_ROOT", str(workspace))
    monkeypatch.setattr(main.requests, "post", fake_post)

    response = client.post(
        "/refactor/split_file",
        params={"file_path": "source.py"},
        json={"api_url": "http://attacker.invalid"},
    )

    assert response.status_code == 200, response.text
    assert calls["url"] == main.INTERNAL_SPLIT_URL
    assert calls["json"]["code"] == "value = 1\n"
    assert (workspace / "split_a.py").read_text(encoding="utf-8") == "x = 1"
    assert not (Path("etc") / "passwd").exists()
