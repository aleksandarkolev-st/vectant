"""
Tree Navigator — Single-shot LLM-guided ToC tree traversal.

The core of micro-navigation (Step 3). Given the top-K documents
from macro-retrieval, the navigator presents the entire ToC tree of
each document to a fast LLM in a single call and asks it to select
the most relevant leaf sections.

DESIGN
------
- **Single-shot (one LLM call per document, not per depth-level)**:
  the previous BFS-with-routing-per-level architecture made 3-4 LLM
  calls per doc, blowing past the 10s total budget for trees with
  any non-trivial depth. Single-shot is dramatically faster and lets
  the LLM see the full structure instead of greedy local decisions.
- **Skip the LLM entirely on small ToCs**: if a doc has <= max_sections
  leaf nodes, just return them all — there is nothing to navigate.
- **Heuristic fallback**: if the LLM call fails or returns nothing
  parseable, fall back to keyword-overlap scoring on leaf nodes.
- **Strict leaves**: the routing prompt asks the model to drill to
  leaves; non-leaf selections are expanded to their leaf descendants.
"""

from __future__ import annotations

import json
import logging
import random
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

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
    action: str              # "select" | "skip_llm" | "fallback"
    reasoning: str = ""
    time_ms: float = 0.0


@dataclass
class NavigationResult:
    """Result of navigating a single document's ToC."""
    document_id: str
    selected_node_ids: List[str]
    steps: List[NavigationStep] = field(default_factory=list)
    total_routing_calls: int = 0
    time_ms: float = 0.0
    used_fallback: bool = False


class TreeNavigator:
    """
    Navigate document ToC trees using a fast LLM in a single call.

    The navigator presents the entire tree (with depth indentation)
    to the LLM and asks it to pick relevant leaf sections by index.
    """

    def __init__(
        self,
        config: Optional[RAGConfig] = None,
        api_key: Optional[str] = None,
    ):
        self.config = config or get_rag_config()
        self._micro = self.config.micro
        self._api_key = api_key or self._micro.routing_api_key

        self._genai = None
        self._genai_lock = threading.Lock()
        self._total_calls = 0
        self._calls_lock = threading.Lock()
        # Per-query circuit breaker: once a routing call 504s, fall through
        # to the heuristic for the rest of the docs in this navigation pass.
        self._llm_disabled_for_query = False

    # =========================================================================
    # Public API
    # =========================================================================

    def navigate(
        self,
        query: RAGQuery,
        toc_trees: Dict[str, ToCTree],
    ) -> List[NavigationResult]:
        """Navigate multiple document ToC trees in parallel (one LLM call per doc)."""
        self._total_calls = 0
        self._llm_disabled_for_query = False
        t0 = time.time()
        deadline = t0 + (self._micro.total_timeout_ms / 1000)

        if not toc_trees:
            return []

        # Most docs hit the small-tree shortcut and don't make an LLM call,
        # so the parallelism cost is bounded by the few docs that do. Cap
        # concurrency so we don't slam Gemini on huge workspaces.
        max_workers = min(len(toc_trees), 8)

        ordered_ids = list(toc_trees.keys())
        results_by_id: Dict[str, NavigationResult] = {}

        with ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix="rag-tree-nav",
        ) as pool:
            future_to_id = {
                pool.submit(
                    self._navigate_single, query, doc_id, tree, deadline,
                ): doc_id
                for doc_id, tree in toc_trees.items()
            }

            for future in as_completed(future_to_id):
                doc_id = future_to_id[future]
                try:
                    results_by_id[doc_id] = future.result()
                except Exception as e:
                    logger.warning(
                        f"Navigation worker for {doc_id} crashed: {e}"
                    )
                    results_by_id[doc_id] = NavigationResult(
                        document_id=doc_id,
                        selected_node_ids=[],
                        used_fallback=True,
                    )

        # Preserve macro-retrieval ordering in the output
        results = [results_by_id[d] for d in ordered_ids if d in results_by_id]

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
        self._llm_disabled_for_query = False
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
        """Single-shot navigation of one document's ToC."""
        t0 = time.time()

        all_nodes = self._collect_all_nodes(tree)
        leaves = [n for n in all_nodes if n.is_leaf]

        if not leaves:
            return NavigationResult(
                document_id=document_id,
                selected_node_ids=[],
                time_ms=(time.time() - t0) * 1000,
            )

        max_sections = self._micro.max_sections_per_document

        # Optimization: small ToC → skip LLM, return everything.
        if len(leaves) <= max_sections:
            selected_ids = [n.id for n in leaves]
            return NavigationResult(
                document_id=document_id,
                selected_node_ids=selected_ids,
                steps=[NavigationStep(
                    node_id="",
                    node_title=f"small_tree ({len(leaves)} leaves)",
                    depth=0,
                    action="skip_llm",
                    reasoning=f"<= max_sections_per_document ({max_sections}) leaves",
                    time_ms=(time.time() - t0) * 1000,
                )],
                total_routing_calls=0,
                time_ms=(time.time() - t0) * 1000,
            )

        used_fallback = False
        try:
            if time.time() > deadline:
                raise NavigationError("Deadline reached before LLM call")
            selected_leaf_ids, reasoning = self._route_full_tree(
                query.text, tree, all_nodes, max_sections,
            )
            step_action = "select"
            step_title = f"single_shot ({len(all_nodes)} nodes)"
        except Exception as e:
            logger.warning(
                f"Single-shot navigation failed for {document_id}: {e}"
            )
            used_fallback = True
            selected_nodes = self._heuristic_select(
                query.text, leaves, max_selections=max_sections,
            )
            selected_leaf_ids = [n.id for n in selected_nodes]
            reasoning = f"LLM failed: {e}"
            step_action = "fallback"
            step_title = "heuristic_fallback"

        # Optionally include immediate siblings of selected leaves for context.
        if self._micro.include_sibling_context and selected_leaf_ids:
            selected_leaf_ids = self._add_sibling_context(
                selected_leaf_ids, tree,
            )

        elapsed = (time.time() - t0) * 1000
        return NavigationResult(
            document_id=document_id,
            selected_node_ids=selected_leaf_ids[:max_sections],
            steps=[NavigationStep(
                node_id="",
                node_title=step_title,
                depth=0,
                action=step_action,
                reasoning=reasoning,
                time_ms=elapsed,
            )],
            total_routing_calls=self._total_calls,
            time_ms=elapsed,
            used_fallback=used_fallback,
        )

    # =========================================================================
    # Internal: Tree Flattening + LLM Prompt
    # =========================================================================

    def _collect_all_nodes(self, tree: ToCTree) -> List[ToCNode]:
        """DFS-flatten the tree, skipping the synthetic root."""
        flat: List[ToCNode] = []

        def walk(node: ToCNode, depth: int) -> None:
            if depth > 0:  # skip root
                flat.append(node)
            for child in node.children:
                walk(child, depth + 1)

        walk(tree.root, 0)
        return flat

    def _format_tree_for_llm(
        self,
        all_nodes: List[ToCNode],
    ) -> str:
        """Render the flattened tree with indentation + index labels."""
        if not all_nodes:
            return ""
        # Normalise indentation so the shallowest visible node is column 0.
        base_depth = min(n.depth for n in all_nodes)
        lines: List[str] = []
        for i, node in enumerate(all_nodes, 1):
            indent = "  " * max(0, node.depth - base_depth)
            suffix_parts: List[str] = []
            if node.token_estimate:
                suffix_parts.append(f"~{node.token_estimate}t")
            if node.keywords:
                suffix_parts.append(
                    f"kw: {', '.join(node.keywords[:4])}"
                )
            if not node.is_leaf:
                suffix_parts.append(f"[{node.child_count} subs]")
            suffix = f"  ({'; '.join(suffix_parts)})" if suffix_parts else ""
            lines.append(f"[{i}] {indent}{node.title}{suffix}")
        return "\n".join(lines)

    def _build_full_tree_prompt(
        self,
        query_text: str,
        tree_text: str,
        doc_title: str,
        max_selections: int,
    ) -> str:
        return f"""You are navigating a document's table of contents to find sections relevant to a user's question.

QUESTION: {query_text}

DOCUMENT: {doc_title}

TABLE OF CONTENTS (each entry is `[index] title`; indentation shows hierarchy):
{tree_text}

INSTRUCTIONS:
- Pick up to {max_selections} sections most likely to contain the answer.
- Strongly prefer leaf sections (no `[N subs]` annotation) — drill down to specifics.
- Pick by INDEX number (the bracketed number on the left), not by title.
- If multiple subsections of the same parent are relevant, pick them all rather than the parent.
- If nothing seems relevant, return {{"selected": [], "reasoning": "explanation"}}.

Return ONLY valid JSON in this exact format:
{{"selected": [<index1>, <index2>], "reasoning": "brief"}}"""

    def _route_full_tree(
        self,
        query_text: str,
        tree: ToCTree,
        all_nodes: List[ToCNode],
        max_selections: int,
    ) -> Tuple[List[str], str]:
        """Single LLM call: present the whole tree, get selected leaf node IDs."""
        doc_title = ""
        # Best-effort doc title from any annotated node
        if all_nodes and all_nodes[0].depth > 0:
            doc_title = ""
        tree_text = self._format_tree_for_llm(all_nodes)
        prompt = self._build_full_tree_prompt(
            query_text, tree_text, doc_title, max_selections,
        )

        # Once a routing call has 504'd in this navigation pass, skip the
        # remaining LLM calls and rely on the heuristic — repeated 504s
        # against a flaky model just burn wall-clock with no payoff.
        if self._llm_disabled_for_query:
            raise RoutingModelError(
                "LLM routing disabled for this query after prior 504"
            )

        genai = self._get_genai()
        model = genai.GenerativeModel(
            self._micro.routing_model,
            # Note: response_mime_type=application/json is a Gemini preview
            # feature that intermittently returns 504s on the flash-lite
            # preview model. We parse JSON ourselves below to stay
            # compatible across models.
            generation_config=genai.GenerationConfig(
                temperature=0.1,
                max_output_tokens=256,
            ),
        )
        timeout_s = max(1.0, self._micro.routing_timeout_ms / 1000)

        # Retry with exponential backoff on 429/quota — these are transient
        # rate limits, not server-side bugs. 504 errors trip the circuit
        # breaker immediately (no point retrying a hung server).
        max_retries = 2
        response = None
        for attempt in range(max_retries + 1):
            try:
                response = model.generate_content(
                    prompt,
                    request_options={"timeout": timeout_s},
                )
                with self._calls_lock:
                    self._total_calls += 1
                break
            except Exception as e:
                err_str = str(e).lower()
                if "504" in err_str or "deadline" in err_str:
                    self._llm_disabled_for_query = True
                    raise RoutingModelError(
                        f"Fast LLM routing call failed: {e}"
                    ) from e
                is_rate_limit = (
                    "429" in err_str
                    or "resource" in err_str
                    or "quota" in err_str
                )
                if is_rate_limit and attempt < max_retries:
                    delay = (0.4 * (2 ** attempt)) + (random.random() * 0.3)
                    logger.warning(
                        f"Rate limited on routing, retry "
                        f"{attempt + 1}/{max_retries} after {delay:.2f}s"
                    )
                    time.sleep(delay)
                    continue
                raise RoutingModelError(
                    f"Fast LLM routing call failed: {e}"
                ) from e

        text = (response.text or "").strip()
        selected_indices, reasoning = self._parse_full_tree_response(
            text, len(all_nodes),
        )

        # Map indices → node IDs.
        selected_ids: List[str] = []
        for idx in selected_indices:
            if 1 <= idx <= len(all_nodes):
                selected_ids.append(all_nodes[idx - 1].id)

        # Strict leaves: expand any non-leaf picks into their leaf descendants.
        leaf_id_set = {n.id for n in all_nodes if n.is_leaf}
        leaf_ids: List[str] = []
        seen: set = set()
        for nid in selected_ids:
            if nid in leaf_id_set:
                if nid not in seen:
                    seen.add(nid)
                    leaf_ids.append(nid)
            else:
                node = tree.get_node(nid)
                if node:
                    for desc in self._collect_descendants(node, only_leaves=True):
                        if desc.id not in seen:
                            seen.add(desc.id)
                            leaf_ids.append(desc.id)

        # Final fallback: top-N leaves by token estimate (more content first).
        if not leaf_ids:
            leaves_sorted = sorted(
                [n for n in all_nodes if n.is_leaf],
                key=lambda n: -n.token_estimate,
            )
            leaf_ids = [n.id for n in leaves_sorted[:max_selections]]
            reasoning = (
                f"LLM returned no valid leaves; using top-{max_selections} "
                f"by token count"
            )

        return leaf_ids[:max_selections], reasoning

    def _parse_full_tree_response(
        self,
        text: str,
        max_index: int,
    ) -> Tuple[List[int], str]:
        """Parse the LLM JSON response into validated indices.

        Without response_mime_type=json, models occasionally wrap the JSON
        in code fences or precede it with prose. Strip fences, then fall
        back to greedy `{...}` extraction.
        """
        cleaned = re.sub(r"^```(?:json)?\s*", "", text)
        cleaned = re.sub(r"\s*```$", "", cleaned)

        parsed = None
        try:
            parsed = json.loads(cleaned)
        except (json.JSONDecodeError, KeyError):
            # Try to extract the first JSON object substring.
            match = re.search(r"\{[\s\S]*\}", cleaned)
            if match:
                try:
                    parsed = json.loads(match.group(0))
                except (json.JSONDecodeError, KeyError) as e2:
                    logger.warning(f"Failed to parse extracted JSON: {e2}")
                    logger.debug(f"Raw response: {text[:200]}")
                    return [], f"JSON parse error: {e2}"
            else:
                logger.warning(f"No JSON object found in response")
                logger.debug(f"Raw response: {text[:200]}")
                return [], "No JSON in response"

        if not isinstance(parsed, dict):
            return [], "Response is not a JSON object"

        raw_selected = parsed.get("selected", [])
        reasoning = parsed.get("reasoning", "")

        indices: List[int] = []
        for x in raw_selected:
            try:
                n = int(x)
            except (TypeError, ValueError):
                continue
            if 1 <= n <= max_index and n not in indices:
                indices.append(n)
        return indices, reasoning

    def _collect_descendants(
        self,
        node: ToCNode,
        only_leaves: bool = False,
    ) -> List[ToCNode]:
        """Return all descendants of `node`, optionally only leaves."""
        out: List[ToCNode] = []
        stack: List[ToCNode] = list(node.children)
        while stack:
            n = stack.pop()
            if only_leaves:
                if n.is_leaf:
                    out.append(n)
            else:
                out.append(n)
            stack.extend(n.children)
        return out

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
        Heuristic node selection when the LLM is unavailable.

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

        results = [n for n, s in scored[:max_selections] if s > 0]
        if not results and nodes:
            # Best-effort: top max_selections by token estimate.
            by_tokens = sorted(nodes, key=lambda n: -n.token_estimate)
            results = by_tokens[:max_selections]

        return results

    # =========================================================================
    # Internal: Sibling Context
    # =========================================================================

    def _add_sibling_context(
        self,
        selected_ids: List[str],
        tree: ToCTree,
    ) -> List[str]:
        """Add immediately-adjacent sibling sections for context."""
        enriched: List[str] = list(selected_ids)
        seen = set(selected_ids)
        max_sections = self._micro.max_sections_per_document

        for node_id in selected_ids:
            if len(enriched) >= max_sections:
                break

            node = tree.get_node(node_id)
            if not node or not node.parent_id:
                continue

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
                pid = parent.children[idx - 1].id
                if pid not in seen:
                    seen.add(pid)
                    enriched.append(pid)
            # Next sibling
            if idx < len(parent.children) - 1 and len(enriched) < max_sections:
                nid = parent.children[idx + 1].id
                if nid not in seen:
                    seen.add(nid)
                    enriched.append(nid)

        return enriched[:max_sections]

    # =========================================================================
    # Internal: GenAI Client
    # =========================================================================

    def _get_genai(self):
        """Lazy-load Google GenAI client (thread-safe)."""
        if self._genai is not None:
            return self._genai

        with self._genai_lock:
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
