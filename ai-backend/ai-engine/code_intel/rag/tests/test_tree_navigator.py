"""Tests for tree navigator."""

import pytest
from unittest.mock import MagicMock, AsyncMock, patch
from ..types import ToCNode, ToCTree, ToCNodeType
from ..micro.tree_navigator import TreeNavigator, NavigationResult


class TestTreeNavigator:
    def setup_method(self):
        self.navigator = TreeNavigator(
            model_name="gemini-2.0-flash-lite",
            max_routing_calls=5,
            timeout_seconds=30.0,
        )
        # Build a simple tree: root → ch1 → ch1a, ch1b; root → ch2
        root = ToCNode(
            id="root", title="Root", node_type=ToCNodeType.DOCUMENT,
            level=0, start_line=1, end_line=100,
        )
        ch1 = ToCNode(
            id="ch1", title="Installation", node_type=ToCNodeType.HEADING,
            level=1, start_line=1, end_line=50,
        )
        ch1a = ToCNode(
            id="ch1a", title="Requirements", node_type=ToCNodeType.HEADING,
            level=2, start_line=1, end_line=25,
        )
        ch1b = ToCNode(
            id="ch1b", title="Steps", node_type=ToCNodeType.HEADING,
            level=2, start_line=26, end_line=50,
        )
        ch2 = ToCNode(
            id="ch2", title="Usage", node_type=ToCNodeType.HEADING,
            level=1, start_line=51, end_line=100,
        )
        root.children = [ch1, ch2]
        ch1.children = [ch1a, ch1b]

        self.tree = ToCTree(root=root, document_id="testdoc")

    def test_build_navigation_prompt(self):
        """Test that prompts are built correctly."""
        nodes = self.tree.root.children
        prompt = self.navigator._build_navigation_prompt(
            query="How to install?",
            nodes=nodes,
            depth=0,
        )
        assert "Installation" in prompt
        assert "Usage" in prompt
        assert "install" in prompt.lower()

    def test_heuristic_fallback(self):
        """Heuristic should pick best node by keyword overlap."""
        nodes = self.tree.root.children
        selected = self.navigator._heuristic_select(
            query="installation requirements",
            nodes=nodes,
        )
        assert selected is not None
        assert selected.title == "Installation"

    def test_heuristic_no_match(self):
        """Heuristic with no keyword overlap returns first node."""
        nodes = self.tree.root.children
        selected = self.navigator._heuristic_select(
            query="zzzzzzz qqqqqqq",
            nodes=nodes,
        )
        # Should still return something (first node as fallback)
        assert selected is not None

    def test_navigation_result_structure(self):
        result = NavigationResult(
            document_id="testdoc",
            selected_node_ids=["ch1", "ch1a"],
            navigation_steps=[],
            total_routing_calls=2,
        )
        assert result.document_id == "testdoc"
        assert len(result.selected_node_ids) == 2

    def test_empty_children(self):
        """Navigating a leaf node should return it directly."""
        leaf = ToCNode(
            id="leaf", title="Leaf", node_type=ToCNodeType.HEADING,
            level=3, start_line=1, end_line=10,
        )
        selected = self.navigator._heuristic_select(
            query="anything",
            nodes=[leaf],
        )
        assert selected.id == "leaf"
