"""
Query-time Context Assembly Module

The core retrieval pipeline that answers:
"Given user intent, which exact pieces of code matter right now?"

Pipeline:
1. Embed user request
2. Vector search top-k chunks (k=5-12)
3. Expand via dependency graph
4. Rank by relevance, call distance, file importance
5. Enforce hard token budget
6. Assemble context: repo summary → file summaries → code chunks → missing context note
"""

from .query_processor import QueryProcessor, ParsedQuery, QueryIntent, process_query
from .retriever import ContextRetriever, RetrievalCandidate, retrieve_context
from .graph_expander import GraphExpander, ExpansionRule, expand_via_graph
from .ranker import ContextRanker, RankingFactors, rank_chunks
from .budget_enforcer import BudgetEnforcer, BudgetAllocation, enforce_budget
from .context_assembler import ContextAssembler, AssembledContext, assemble_context
from .pipeline import RetrievalPipeline, RetrievalPipelineResult, create_pipeline


__all__ = [
    # Query Processing
    "QueryProcessor",
    "ParsedQuery",
    "QueryIntent",
    "process_query",
    
    # Retrieval
    "ContextRetriever",
    "RetrievalCandidate",
    "retrieve_context",
    
    # Graph Expansion
    "GraphExpander",
    "ExpansionRule",
    "expand_via_graph",
    
    # Ranking
    "ContextRanker",
    "RankingFactors",
    "rank_chunks",
    
    # Budget Enforcement
    "BudgetEnforcer",
    "BudgetAllocation",
    "enforce_budget",
    
    # Assembly
    "ContextAssembler",
    "AssembledContext",
    "assemble_context",
    
    # Pipeline
    "RetrievalPipeline",
    "RetrievalPipelineResult",
    "create_pipeline",
]
