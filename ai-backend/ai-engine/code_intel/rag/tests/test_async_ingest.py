"""Tests for async ingestion job tracking."""
from __future__ import annotations

import tempfile
import time
from pathlib import Path

import pytest

from code_intel.rag.pipeline import IngestJob, RAGPipeline


@pytest.fixture
def workspace():
    with tempfile.TemporaryDirectory() as d:
        (Path(d) / "doc.md").write_text("# Doc\n\nSome content.", encoding="utf-8")
        yield d


class TestIngestJobDataclass:
    def test_to_dict_contains_required_keys(self):
        job = IngestJob(
            job_id="abc",
            directory="/tmp",
            status="queued",
            started_at=1.0,
        )
        d = job.to_dict()
        for key in (
            "job_id", "directory", "status", "started_at",
            "finished_at", "elapsed_ms", "stats", "error",
            "force_reindex",
        ):
            assert key in d


class TestAsyncIngestion:
    def _wait_for_job(
        self,
        pipeline: RAGPipeline,
        job_id: str,
        *,
        timeout_s: float = 30.0,
    ):
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            job = pipeline.get_ingest_job(job_id)
            assert job is not None, "job vanished"
            if job["status"] in ("completed", "failed", "cancelled"):
                return job
            time.sleep(0.05)
        pytest.fail(f"job {job_id} did not finish within {timeout_s}s")

    def test_job_lifecycle(self, workspace):
        pipeline = RAGPipeline(workspace_root=workspace)
        pipeline.initialize()

        job_id = pipeline.ingest_directory_async(workspace)
        assert job_id and isinstance(job_id, str)

        # Job appears in list_ingest_jobs.
        jobs = pipeline.list_ingest_jobs()
        assert any(j["job_id"] == job_id for j in jobs)

        final = self._wait_for_job(pipeline, job_id)
        # Either succeeded or failed gracefully (e.g. no API key in CI).
        assert final["status"] in ("completed", "failed")
        assert final["finished_at"] is not None

    def test_unknown_job_returns_none(self, workspace):
        pipeline = RAGPipeline(workspace_root=workspace)
        pipeline.initialize()
        assert pipeline.get_ingest_job("does_not_exist") is None
