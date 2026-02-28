"""
Tests for ai_fix_utils.py — deduplication, grouping, sorting.
"""

import pytest
from dataclasses import dataclass
from typing import Optional

from analyzer.proactive.healing.ai_fix_utils import (
    deduplicate_fixes,
    merge_fix_lists,
    group_by_file,
    group_by_severity,
    sort_by_severity,
    sort_by_line,
    count_by_category,
    safe_fixes,
    unsafe_fixes,
    fixes_summary,
)


@dataclass
class MockFix:
    """Minimal fix-like object for testing."""
    line: int = 1
    end_line: int = 1
    category: str = "logic_error"
    confidence: float = 0.8
    severity: str = "moderate"
    is_safe: bool = False
    file_path: str = "test.py"
    description: str = "test fix"


class TestDeduplication:
    def test_removes_exact_dupes(self):
        f1 = MockFix(line=10, category="null_safety", confidence=0.7)
        f2 = MockFix(line=10, category="null_safety", confidence=0.9)
        result = deduplicate_fixes([f1, f2])
        assert len(result) == 1
        assert result[0].confidence == 0.9  # keeps higher confidence

    def test_keeps_different_lines(self):
        f1 = MockFix(line=10, category="null_safety")
        f2 = MockFix(line=20, category="null_safety")
        result = deduplicate_fixes([f1, f2])
        assert len(result) == 2

    def test_keeps_different_categories_same_line(self):
        f1 = MockFix(line=10, category="null_safety")
        f2 = MockFix(line=10, category="type_mismatch")
        result = deduplicate_fixes([f1, f2])
        assert len(result) == 2

    def test_empty_list(self):
        assert deduplicate_fixes([]) == []

    def test_single_item(self):
        f = MockFix()
        assert deduplicate_fixes([f]) == [f]


class TestMerge:
    def test_merge_two_lists(self):
        regex_fixes = [MockFix(line=5, category="null_safety", confidence=0.6)]
        ai_fixes = [MockFix(line=5, category="null_safety", confidence=0.85)]
        result = merge_fix_lists(regex_fixes, ai_fixes)
        assert len(result) == 1
        assert result[0].confidence == 0.85

    def test_merge_non_overlapping(self):
        list1 = [MockFix(line=1)]
        list2 = [MockFix(line=10)]
        result = merge_fix_lists(list1, list2)
        assert len(result) == 2

    def test_merge_with_empty(self):
        list1 = [MockFix(line=1)]
        result = merge_fix_lists(list1, [], None)
        assert len(result) == 1


class TestGrouping:
    def test_group_by_file(self):
        fixes = [
            MockFix(file_path="a.py"),
            MockFix(file_path="a.py"),
            MockFix(file_path="b.py"),
        ]
        groups = group_by_file(fixes)
        assert len(groups["a.py"]) == 2
        assert len(groups["b.py"]) == 1

    def test_group_by_severity(self):
        fixes = [
            MockFix(severity="critical"),
            MockFix(severity="low"),
            MockFix(severity="critical"),
        ]
        groups = group_by_severity(fixes)
        assert len(groups["critical"]) == 2
        assert len(groups["low"]) == 1


class TestSorting:
    def test_sort_by_severity_descending(self):
        fixes = [
            MockFix(severity="low"),
            MockFix(severity="critical"),
            MockFix(severity="moderate"),
        ]
        result = sort_by_severity(fixes)
        assert result[0].severity == "critical"
        assert result[1].severity == "moderate"
        assert result[2].severity == "low"

    def test_sort_by_severity_ascending(self):
        fixes = [
            MockFix(severity="critical"),
            MockFix(severity="low"),
        ]
        result = sort_by_severity(fixes, descending=False)
        assert result[0].severity == "low"

    def test_sort_by_line(self):
        fixes = [
            MockFix(line=30),
            MockFix(line=5),
            MockFix(line=15),
        ]
        result = sort_by_line(fixes)
        assert [f.line for f in result] == [5, 15, 30]


class TestFilters:
    def test_safe_fixes(self):
        fixes = [
            MockFix(is_safe=True),
            MockFix(is_safe=False),
            MockFix(is_safe=True),
        ]
        assert len(safe_fixes(fixes)) == 2
        assert len(unsafe_fixes(fixes)) == 1

    def test_count_by_category(self):
        fixes = [
            MockFix(category="null_safety"),
            MockFix(category="null_safety"),
            MockFix(category="type_mismatch"),
        ]
        counts = count_by_category(fixes)
        assert counts["null_safety"] == 2
        assert counts["type_mismatch"] == 1


class TestSummary:
    def test_summary(self):
        fixes = [
            MockFix(is_safe=True, severity="critical", category="null_safety", confidence=0.9),
            MockFix(is_safe=False, severity="low", category="type_mismatch", confidence=0.7),
        ]
        s = fixes_summary(fixes)
        assert s["total"] == 2
        assert s["safe"] == 1
        assert s["unsafe"] == 1
        assert s["avg_confidence"] == 0.8
        assert s["by_severity"]["critical"] == 1
        assert s["by_category"]["null_safety"] == 1

    def test_empty_summary(self):
        s = fixes_summary([])
        assert s["total"] == 0
        assert s["avg_confidence"] == 0
