from __future__ import annotations

import json
import logging
import os
from typing import Dict

from ..core.types import EdgeType, SymbolEdge


logger = logging.getLogger("code_intel.lsp.importer")


def ingest_lsp_index(structural_index, lsp_index_path: str) -> int:
    """
    Ingest LSP-derived symbol references into the structural index.

    Expected format:
    {
      "edges": [
        {
          "source": "module.Class.method",
          "target": "module.Other.fn",
          "edge_type": "calls",
          "file_path": "path/to/file",
          "line": 123,
          "confidence": 1.0,
          "source_method": "lsp"
        }
      ]
    }
    """
    if not lsp_index_path or not os.path.exists(lsp_index_path):
        return 0

    try:
        with open(lsp_index_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        logger.error(f"Failed to load LSP index: {e}")
        return 0

    edges = data.get("edges", [])
    added = 0
    for e in edges:
        source = e.get("source")
        target = e.get("target")
        edge_type = e.get("edge_type")
        if not source or not target or not edge_type:
            continue
        if not structural_index.graph.get_node(source) or not structural_index.graph.get_node(target):
            continue

        try:
            edge = SymbolEdge(
                source=source,
                target=target,
                edge_type=EdgeType(edge_type),
                file_path=e.get("file_path", ""),
                line=int(e.get("line", 0) or 0),
                confidence=float(e.get("confidence", 1.0)),
                source_method=e.get("source_method", "lsp"),
            )
            structural_index.graph.add_edge(edge)
            added += 1
        except Exception:
            continue

    if added:
        logger.info(f"Ingested {added} LSP edges from {lsp_index_path}")
    return added
