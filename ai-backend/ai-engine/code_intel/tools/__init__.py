"""
Tool-driven Exploration Module

Exposes tools for the AI to request additional context during conversation.

Tools:
- list_files(dir): List files in a directory
- open_file(path, lines): Read specific lines from a file
- open_symbol(name): Get definition of a symbol
- search_symbol(query): Search for symbols by name/pattern
- get_callers(symbol): Find what calls this symbol
- get_callees(symbol): Find what this symbol calls
- get_related(symbol): Find related symbols (same file, imports, etc.)

Key principle: These tools let the AI request context it determines
is missing, rather than us guessing what it needs upfront.
"""

from .tools import (
    ExplorationTools,
    ToolResult,
    ToolError,
    list_files,
    open_file,
    open_symbol,
    search_symbol,
    get_callers,
    get_callees,
    get_related,
)
from .tool_registry import ToolRegistry, tool_definitions
from .tool_executor import ToolExecutor
from .separation import (
    ToolSeparator,
    ToolCategory,
    RateLimiter,
    ToolRefusal,
    READ_TOOLS,
    SEARCH_TOOLS,
    EDIT_TOOLS,
)


__all__ = [
    "ExplorationTools",
    "ToolResult",
    "ToolError",
    "list_files",
    "open_file",
    "open_symbol",
    "search_symbol",
    "get_callers",
    "get_callees",
    "get_related",
    "ToolRegistry",
    "tool_definitions",
    "ToolExecutor",
    # Tool Separation
    "ToolSeparator",
    "ToolCategory",
    "RateLimiter",
    "ToolRefusal",
    "READ_TOOLS",
    "SEARCH_TOOLS",
    "EDIT_TOOLS",
]
