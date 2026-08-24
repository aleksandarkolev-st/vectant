from pathlib import Path


def test_agent_image_copies_readonly_credentials_to_ephemeral_storage():
    root = Path(__file__).resolve().parents[2] / "agent-runner"
    dockerfile = (root / "Dockerfile").read_text(encoding="utf-8")
    entrypoint = (root / "entrypoint.sh").read_text(encoding="utf-8")

    assert "ENTRYPOINT [\"/usr/local/bin/agent-entrypoint\"]" in dockerfile
    assert "source_dir=\"/run/agent-credentials/${tool}\"" in entrypoint
    assert "target_dir=\"/tmp/${tool}\"" in entrypoint
    assert "exec \"$@\"" in entrypoint
