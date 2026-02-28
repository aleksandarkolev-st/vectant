"""
Tests for ai_policy.py — AISuppressionPolicy store.
Covers: suppress, unsuppress, idempotency, fingerprint-vs-rule modes,
TTL expiry, escalation, persistence round-trip, corruption recovery.
"""

import asyncio
import json
import os
import time

import pytest

from analyzer.proactive.healing.ai_policy import (
    AISuppressionPolicy,
    SuppressionEntry,
    get_suppression_policy,
)


@pytest.fixture
def tmp_dir(tmp_path):
    """Provide a temporary directory for JSON persistence."""
    return str(tmp_path)


@pytest.fixture
def policy(tmp_dir):
    """Fresh policy instance for each test."""
    return AISuppressionPolicy(persist_dir=tmp_dir, user_id="test_user")


# ── Suppress / unsuppress basics ─────────────────────────────────────


@pytest.mark.asyncio
async def test_suppress_creates_entry(policy):
    await policy.suppress("RULE_A")
    assert await policy.is_suppressed("RULE_A")


@pytest.mark.asyncio
async def test_unsuppress_removes_entry(policy):
    await policy.suppress("RULE_A")
    await policy.unsuppress("RULE_A")
    assert not await policy.is_suppressed("RULE_A")


@pytest.mark.asyncio
async def test_unsuppress_is_idempotent(policy):
    """Unsuppressing a rule that was never suppressed should not raise."""
    await policy.unsuppress("NONEXISTENT")
    assert not await policy.is_suppressed("NONEXISTENT")


@pytest.mark.asyncio
async def test_suppress_is_idempotent(policy):
    """Suppressing twice should not duplicate."""
    await policy.suppress("RULE_A")
    await policy.suppress("RULE_A")
    entries = await policy.list_entries()
    rule_a_entries = [e for e in entries if e.rule_id == "RULE_A"]
    assert len(rule_a_entries) == 1


# ── Fingerprint mode ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_fingerprint_mode_suppresses_specific_pattern(policy):
    await policy.suppress("RULE_B", fingerprint="fp_abc", mode="fingerprint")
    assert await policy.is_suppressed("RULE_B", fingerprint="fp_abc")
    # Different fingerprint should NOT be suppressed
    assert not await policy.is_suppressed("RULE_B", fingerprint="fp_xyz")


@pytest.mark.asyncio
async def test_rule_mode_suppresses_all_fingerprints(policy):
    await policy.suppress("RULE_C", mode="rule")
    assert await policy.is_suppressed("RULE_C", fingerprint="anything")
    assert await policy.is_suppressed("RULE_C")


@pytest.mark.asyncio
async def test_unsuppress_fingerprint_keeps_other_fingerprints(policy):
    await policy.suppress("RULE_D", fingerprint="fp_1", mode="fingerprint")
    await policy.suppress("RULE_D", fingerprint="fp_2", mode="fingerprint")
    await policy.unsuppress("RULE_D", fingerprint="fp_1")
    assert not await policy.is_suppressed("RULE_D", fingerprint="fp_1")
    assert await policy.is_suppressed("RULE_D", fingerprint="fp_2")


# ── TTL expiry ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_ttl_expiry(policy):
    """Entry with short TTL should expire."""
    await policy.suppress("RULE_TTL", ttl=0.1)  # 100ms
    assert await policy.is_suppressed("RULE_TTL")
    await asyncio.sleep(0.15)
    assert not await policy.is_suppressed("RULE_TTL")


# ── Escalation ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_escalation_after_threshold(policy):
    """Suppressing the same rule 5+ times should trigger escalation."""
    for _ in range(5):
        await policy.suppress("RULE_ESC")
    assert await policy.is_escalated("RULE_ESC")


@pytest.mark.asyncio
async def test_no_escalation_below_threshold(policy):
    for _ in range(4):
        await policy.suppress("RULE_NO_ESC")
    assert not await policy.is_escalated("RULE_NO_ESC")


# ── Persistence round-trip ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_persistence_survives_reload(tmp_dir):
    p1 = AISuppressionPolicy(persist_dir=tmp_dir, user_id="persist_user")
    await p1.suppress("RULE_P", reason="test reason")

    # Create a fresh instance from same directory
    p2 = AISuppressionPolicy(persist_dir=tmp_dir, user_id="persist_user")
    assert await p2.is_suppressed("RULE_P")

    entries = await p2.list_entries()
    assert any(e.rule_id == "RULE_P" and e.reason == "test reason" for e in entries)


# ── Corruption recovery ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_corrupted_json_recovers_gracefully(tmp_dir):
    user_id = "corrupt_user"
    filepath = os.path.join(tmp_dir, f"policy_{user_id}.json")

    # Write garbage
    with open(filepath, "w") as f:
        f.write("{{{invalid json")

    # Should not crash — starts with empty state
    p = AISuppressionPolicy(persist_dir=tmp_dir, user_id=user_id)
    entries = await p.list_entries()
    assert entries == []

    # Should be writable after recovery
    await p.suppress("RECOVERED_RULE")
    assert await p.is_suppressed("RECOVERED_RULE")


# ── Clear all ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_clear_removes_everything(policy):
    await policy.suppress("A")
    await policy.suppress("B")
    await policy.suppress("C")
    await policy.clear()
    entries = await policy.list_entries()
    assert entries == []


# ── Summary ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_summary_counts(policy):
    await policy.suppress("X")
    await policy.suppress("Y", fingerprint="fp", mode="fingerprint")
    summary = await policy.summary()
    assert summary["total"] == 2
    assert summary["by_mode"]["rule"] >= 1
    assert summary["by_mode"]["fingerprint"] >= 1


# ── Singleton factory ────────────────────────────────────────────────


def test_get_suppression_policy_returns_same_instance(tmp_dir):
    p1 = get_suppression_policy(tmp_dir, "singleton_user")
    p2 = get_suppression_policy(tmp_dir, "singleton_user")
    assert p1 is p2


def test_get_suppression_policy_different_users(tmp_dir):
    p1 = get_suppression_policy(tmp_dir, "user_a")
    p2 = get_suppression_policy(tmp_dir, "user_b")
    assert p1 is not p2
