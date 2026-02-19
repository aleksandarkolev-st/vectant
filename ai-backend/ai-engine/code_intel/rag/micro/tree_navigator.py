"""
Tree Navigator — Fast LLM-guided ToC tree traversal.

The core of micro-navigation (Step 3). Given the top-K documents
from macro-retrieval, the navigator:

1. Presents the ToC tree of each document to a fast LLM
2. The LLM reads the ToC and selects the most relevant branches
3. Drills deeper into selected branches
4. Returns IDs of the most relevant leaf sections

This is the "agentic" part — the fast LLM acts as a routing agent
that navigates the document structure intelligently.

DESIGN:
- Uses Gemini Flash Lite for sub-second routing decisions
- Falls back to heuristic keyword matching if LLM fails
- Limits total LLM calls to prevent runaway costs
- Respects timeout budgets
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

from ..config import MicroConfig, RAGConfig, get_rag_config
from ..types import ToCTree, ToCNode, ToCNodeType, RAGQuery
from ..exceptions import NavigationError, TreeNavigationError, RoutingModelError

logger = logging.getLogger("code_intel.rag.micro.tree_navigator")


@dataclass
class NavigationStep:
    """One step in the navigation path."""
    node_id: str
    node_title: str
    depth: int
    action: str              # "select", "drill", "skip", "fallback"
    reasoning: str = ""
    time_ms: float = 0.0


@dataclass
class NavigationResult:
    """Result of navigating a single document's ToC."""
    document_id: str
    selected_node_ids: List[str]         # Final selected section IDs
    steps: List[NavigationStep] = field(default_factory=list)
    total_routing_calls: int = 0
    time_ms: float = 0.0
    used_fallback: bool = False


class TreeNavigator:
    """
    Navigate document ToC trees using a fast LLM.

    The navigator presents the ToC to the LLM and asks it to select
    the branches most likely to contain the answer. Then it drills
    into those branches until it reaches leaf sections.
    """

    def __init__(
        self,
        config: Optional[RAGConfig] = None,
        api_key: Optional[str] = None,
    ):
        """
        Initialize tree navigator.

        Args:
            config: RAG configuration.
            api_key: Gemini API key override.
        """
        self.config = config or get_rag_config()
        self._micro = self.config.micro
        self._api_key = api_key or self._micro.routing_api_key

        self._genai = None
        self._total_calls = 0

    # =========================================================================
    # Public API
    # =========================================================================

    def navigate(
        self,
        query: RAGQuery,
        toc_trees: Dict[str, ToCTree],
    ) -> List[NavigationResult]:
        """
        Navigate multiple document ToC trees.

        Args:
            query: User query.
            toc_trees: Map of document_id → ToCTree.

        Returns:
            List of NavigationResult, one per document.
        """
        self._total_calls = 0
        t0 = time.time()
        deadline = t0 + (self._micro.total_timeout_ms / 1000)

        results: List[NavigationResult] = []

        for doc_id, tree in toc_trees.items():
            if time.time() > deadline:
                logger.warning("Total navigation timeout reached")
                break

            if self._total_calls >= self._micro.max_routing_calls:
                logger.warning("Max routing calls reached")
                break

            result = self._navigate_single(query, doc_id, tree, deadline)
            results.append(result)

        elapsed = (time.time() - t0) * 1000
        total_selected = sum(len(r.selected_node_ids) for r in results)
        logger.info(
            f"Tree navigation: {total_selected} sections from "
            f"{len(results)} docs in {elapsed:.1f}ms "
            f"({self._total_calls} LLM calls)"
        )

        return results

    def navigate_single(
        self,
        query: RAGQuery,
        document_id: str,
        toc_tree: ToCTree,
    ) -> NavigationResult:
        """Navigate a single document's ToC tree."""
        self._total_calls = 0
        deadline = time.time() + (self._micro.total_timeout_ms / 1000)
        return self._navigate_single(query, document_id, toc_tree, deadline)

    # =========================================================================
    # Internal: Single-Document Navigation
    # =========================================================================

    def _navigate_single(
        self,
        query: RAGQuery,
        document_id: str,
        tree: ToCTree,
        deadline: float,
    ) -> NavigationResult:
        """Navigate a single document's ToC tree."""
        t0 = time.time()
        steps: List[NavigationStep] = []
        selected_ids: Set[str] = set()
        used_fallback = False

        # Start from root children
        candidates = tree.root.children
        if not candidates:
            return NavigationResult(
                document_id=document_id,
                selected_node_ids=[],
                time_ms=(time.time() - t0) * 1000,
            )

        # BFS-style navigation with LLM routing
        depth = 0
        max_depth = min(
            self._micro.max_navigation_depth,
            tree.max_depth,
        )

        frontier = list(candidates)

        while frontier and depth <= max_depth:
            if time.time() > deadline:
                break
            if self._total_calls >= self._micro.max_routing_calls:
                break

            # Ask LLM to select relevant nodes from frontier
            try:
                selected_nodes, step = self._route_at_level(
                    query.text,
                    document_id,
                    frontier,
                    tree,
                    depth,
                )
                steps.append(step)
            except (NavigationError, Exception) as e:
                logger.warning(f"LLM routing failed at depth {depth}: {e}")
                used_fallback = True
                selected_nodes = self._heuristic_select(
                    query.text, frontier
                )
                steps.append(NavigationStep(
                    node_id="",
                    node_title="heuristic_fallback",
                    depth=depth,
                    action="fallback",
                    reasoning=str(e),
                ))

            # Collect leaf nodes and build next frontier from non-leaf
            next_frontier: List[ToCNode] = []
            for node in selected_nodes:
                if node.is_leaf:
                    selected_ids.add(node.id)
                else:
                    # Drill into children
                    next_frontier.extend(node.children)

            # If no more children to explore, select current nodes
            if not next_frontier:
                for node in selected_nodes:
                    selected_ids.add(node.id)
                break

            frontier = next_frontier
            depth += 1

        # Enforce max sections per document
        selected_list = list(selected_ids)[:self._micro.max_sections_per_document]

        # Include sibling context if configured
        if self._micro.include_sibling_context and selected_list:
            selected_list = self._add_sibling_context(
                selected_list, tree
            )

        elapsed = (time.time() - t0) * 1000
        return NavigationResult(
            document_id=document_id,
            selected_node_ids=selected_list,
            steps=steps,
            total_routing_calls=self._total_calls,
            time_ms=elapsed,
            used_fallback=used_fallback,
        )

    # =========================================================================
    # Internal: LLM Routing
    # =========================================================================

    def _route_at_level(
        self,
        query_text: str,
        document_id: str,
        nodes: List[ToCNode],
        tree: ToCTree,
        depth: int,
    ) -> Tuple[List[ToCNode], NavigationStep]:
        """
        Ask the fast LLM to select relevant nodes at this level.

        Returns:
            Tuple of (selected nodes, navigation step).
        """
        t0 = time.time()

        # Format nodes for LLM
        node_descriptions = self._format_nodes_for_llm(nodes)
        max_selections = min(
            self._micro.max_sections_per_document,
            len(nodes),
        )

        prompt = self._build_routing_prompt(
            query_text, node_descriptions, max_selections, depth
        )

        # Call fast LLM
        try:
            genai = self._get_genai()
            model = genai.GenerativeModel(
                self._micro.routing_model,
                generation_config=genai.GenerationConfig(
                    temperature=0.1,
                    max_output_tokens=512,
                ),
            )

            response = model.generate_content(prompt)
            self._total_calls += 1

            text = (response.text or "").strip()
            selected_titles, reasoning = self._parse_llm_response(
                text, nodes
            )

        except Exception as e:
            raise RoutingModelError(
                f"Fast LLM routing call failed: {e}"
            ) from e

        # Map titles back to nodes
        title_to_node = {n.title.lower(): n for n in nodes}
        selected_nodes = []
        for title in selected_titles:
            node = title_to_node.get(title.lower())
            if node:
                selected_nodes.append(node)

        # If LLM returned nothing, fallback to top nodes by token count
        if not selected_nodes:
            selected_nodes = sorted(
                nodes, key=lambda n: n.token_estimate, reverse=True
            )[:max_selections]
            reasoning = "LLM returned no valid selections; using token-count fallback"

        elapsed = (time.time() - t0) * 1000

        step = NavigationStep(
            node_id=nodes[0].id if nodes else "",
            node_title=f"Level {depth} ({len(nodes)} nodes)",
            depth=depth,
            action="select",
            reasoning=reasoning,
            time_ms=elapsed,
        )

        return selected_nodes, step

    def _build_routing_prompt(
        self,
        query_text: str,
        node_descriptions: str,
        max_selections: int,
        depth: int,
    ) -> str:
        """Build the routing prompt for the fast LLM."""
        return f"""You are navigating a document's Table of Contents to find sections relevant to a user's question.

QUESTION: {query_text}

Below are the sections at the current level of the document:

{node_descriptions}

INSTRUCTIONS:
- Select up to {max_selections} sections most likely to contain the answer.
- Consider both direct relevance and sections that provide important context.
- Return ONLY valid JSON in this exact format:
{{"selected": ["Section Title 1", "Section Title 2"], "reasoning": "brief explanation"}}
- Use the exact section titles from the list above.
- If none seem relevant, return {{"selected": [], "reasoning": "explanation"}}"""

    def _format_nodes_for_llm(self, nodes: List[ToCNode]) -> str:
        """Format nodes as a numbered list for LLM consumption."""
        lines: List[str] = []
        for i, node in enumerate(nodes, 1):
            parts = [f"{i}. {node.title}"]
            if node.preview:
                parts.append(f"   Preview: {node.preview[:120]}")
            if node.keywords:
                parts.append(f"   Keywords: {', '.join(node.keywords[:5])}")
            if node.token_estimate:
                parts.append(f"   (~{node.token_estimate} tokens)")
            if not node.is_leaf:
                parts.append(f"   [{node.child_count} subsections]")
            lines.append("\n".join(parts))
        return "\n\n".join(lines)

    def _parse_llm_response(
        self,
        text: str,
        nodes: List[ToCNode],
    ) -> Tuple[List[str], str]:
        """Parse LLM JSON response."""
        # Strip markdown code blocks
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)

        try:
            parsed = json.loads(text)
            selected = parsed.get("selected", [])
            reasoning = parsed.get("reasoning", "")

            # Validate titles against actual nodes
            valid_titles = {n.title.lower() for n in nodes}
            valid_selected = [
                s for s in selected
                if s.lower() in valid_titles
            ]

            return valid_selected, reasoning

        except (json.JSONDecodeError, KeyError) as e:
            logger.warning(f"Failed to parse LLM response: {e}")
            logger.debug(f"Raw response: {text[:200]}")
            return [], f"JSON parse error: {e}"

    # =========================================================================
    # Internal: Heuristic Fallback
    # =========================================================================

    def _heuristic_select(
        self,
        query_text: str,
        nodes: List[ToCNode],
        max_selections: int = 3,
    ) -> List[ToCNode]:
        """
        Heuristic node selection when LLM is unavailable.

        Scores by keyword overlap between query and node title/keywords.
        """
        query_words = set(query_text.lower().split())

        scored: List[Tuple[ToCNode, int]] = []
        for node in nodes:
            title_words = set(node.title.lower().split())
            kw_words = {kw.lower() for kw in node.keywords}

            score = len(query_words & title_words) * 3
            score += len(query_words & kw_words) * 2

            scored.append((node, score))

        scored.sort(key=lambda x: x[1], reverse=True)

        # Return top selections (at least 1 even if score=0)
        results = [node for node, score in scored[:max_selections] if score > 0]
        if not results and nodes:
            results = [nodes[0]]

        return results

    # =========================================================================
    # Internal: Sibling Context
    # =========================================================================

    def _add_sibling_context(
        self,
        selected_ids: List[str],
        tree: ToCTree,
    ) -> List[str]:
        """
        Add adjacent sibling sections for context.

        If we selected "2.3 OAuth Flow", also include "2.2 Authentication Overview"
        and "2.4 Token Refresh" as they likely provide useful context.
        """
        enriched: Set[str] = set(selected_ids)
        max_sections = self._micro.max_sections_per_document

        for node_id in selected_ids:
            if len(enriched) >= max_sections:
                break

            node = tree.get_node(node_id)
            if not node or not node.parent_id:
                continue

            siblings = tree.get_siblings(node_id)
            # Add immediately adjacent siblings
            parent = tree.get_node(node.parent_id)
            if not parent:
                continue

            idx = next(
                (i for i, c in enumerate(parent.children) if c.id == node_id),
                -1,
            )
            if idx < 0:
                continue

            # Previous sibling
            if idx > 0 and len(enriched) < max_sections:
                enriched.add(parent.children[idx - 1].id)

            # Next sibling
            if idx < len(parent.children) - 1 and len(enriched) < max_sections:
                enriched.add(parent.children[idx + 1].id)

        return list(enriched)[:max_sections]

    # =========================================================================
    # Internal: GenAI Client
    # =========================================================================

    def _get_genai(self):
        """Lazy-load Google GenAI client."""
        if self._genai is not None:
            return self._genai

        try:
            import google.generativeai as genai
            genai.configure(api_key=self._api_key)
            self._genai = genai
            return genai
        except ImportError:
            raise RoutingModelError(
                "google-generativeai package required for tree navigation"
            )
