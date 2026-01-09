"""
Tool Separation - Clear distinction between read and edit tools.

Critical principle: The model must NOT be allowed to edit without explicit safeguards.

Read Tools (safe, no side effects):
- list_files
- read_file
- search_symbols
- find_usages
- get_definition
- get_file_summary
- search_codebase

Edit Tools (dangerous, require validation):
- create_file
- modify_file
- delete_file
- rename_file

All tools have:
- Rate limits
- Refusal paths (tool can say "need more context")
- Token cost tracking
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Set


logger = logging.getLogger("code_intel.tools.separation")


class ToolCategory(Enum):
    """Category of tool - determines safety constraints."""
    
    READ = "read"  # Safe, no side effects
    EDIT = "edit"  # Dangerous, requires validation
    SEARCH = "search"  # Read but potentially expensive


@dataclass
class RateLimitConfig:
    """Rate limit configuration for a tool."""
    
    max_calls_per_minute: int = 30
    max_calls_per_conversation: int = 100
    cooldown_seconds: float = 0.5  # Min time between calls


@dataclass 
class ToolRefusal:
    """Refusal from a tool - need more context."""
    
    reason: str
    suggestions: List[str] = field(default_factory=list)
    required_context: List[str] = field(default_factory=list)
    
    def to_message(self) -> str:
        """Format refusal for LLM."""
        lines = [f"❌ Tool refused: {self.reason}"]
        if self.suggestions:
            lines.append("Suggestions:")
            for s in self.suggestions:
                lines.append(f"  - {s}")
        if self.required_context:
            lines.append("Required context:")
            for c in self.required_context:
                lines.append(f"  - {c}")
        return "\n".join(lines)


@dataclass
class ToolDefinition:
    """Definition of a tool with safety constraints."""
    
    name: str
    description: str
    category: ToolCategory
    parameters: Dict[str, Any]  # JSON Schema
    
    # Rate limiting
    rate_limit: RateLimitConfig = field(default_factory=RateLimitConfig)
    
    # Validation
    requires_confirmation: bool = False  # For edit tools
    validate_before_execute: bool = True
    
    # Token cost
    max_output_tokens: int = 2000
    
    # Handler
    handler: Optional[Callable] = None


@dataclass
class ToolCall:
    """A call to a tool."""
    
    tool_name: str
    arguments: Dict[str, Any]
    call_id: str = ""
    timestamp: float = field(default_factory=time.time)


@dataclass
class ToolResponse:
    """Response from a tool."""
    
    success: bool
    data: Any = None
    error: Optional[str] = None
    refusal: Optional[ToolRefusal] = None
    
    # Metrics
    tokens_used: int = 0
    execution_time_ms: float = 0.0
    
    def to_message(self) -> str:
        """Format for LLM context."""
        if self.refusal:
            return self.refusal.to_message()
        if self.error:
            return f"❌ Error: {self.error}"
        if self.success:
            return str(self.data) if self.data else "✓ Success"
        return "Unknown response"


class RateLimiter:
    """Track and enforce rate limits per tool."""
    
    def __init__(self):
        # call_name -> list of timestamps
        self._calls: Dict[str, List[float]] = {}
        self._conversation_counts: Dict[str, int] = {}
    
    def check(
        self,
        tool_name: str,
        config: RateLimitConfig,
    ) -> Optional[str]:
        """
        Check if tool can be called.
        
        Returns error message if rate limited, None if OK.
        """
        now = time.time()
        
        # Check cooldown
        if tool_name in self._calls and self._calls[tool_name]:
            last_call = self._calls[tool_name][-1]
            if now - last_call < config.cooldown_seconds:
                wait = config.cooldown_seconds - (now - last_call)
                return f"Rate limited. Wait {wait:.1f}s"
        
        # Check per-minute limit
        if tool_name in self._calls:
            minute_ago = now - 60
            recent = [t for t in self._calls[tool_name] if t > minute_ago]
            if len(recent) >= config.max_calls_per_minute:
                return f"Rate limited. Max {config.max_calls_per_minute} calls/minute"
        
        # Check per-conversation limit
        if self._conversation_counts.get(tool_name, 0) >= config.max_calls_per_conversation:
            return f"Rate limited. Max {config.max_calls_per_conversation} calls per conversation"
        
        return None
    
    def record(self, tool_name: str) -> None:
        """Record a tool call."""
        now = time.time()
        
        if tool_name not in self._calls:
            self._calls[tool_name] = []
        self._calls[tool_name].append(now)
        
        # Trim old entries
        minute_ago = now - 60
        self._calls[tool_name] = [t for t in self._calls[tool_name] if t > minute_ago]
        
        self._conversation_counts[tool_name] = self._conversation_counts.get(tool_name, 0) + 1
    
    def reset_conversation(self) -> None:
        """Reset per-conversation counts."""
        self._conversation_counts.clear()


class ToolSeparator:
    """
    Manages tool separation between read and edit operations.
    
    Enforces:
    - Rate limits
    - Category-based restrictions
    - Refusal paths
    - Edit confirmation requirements
    """
    
    def __init__(self):
        self._tools: Dict[str, ToolDefinition] = {}
        self._rate_limiter = RateLimiter()
        
        # Edit tools require confirmation
        self._pending_edits: Dict[str, ToolCall] = {}
        
        # Track what context has been read
        self._read_context: Set[str] = set()
    
    def register(self, tool: ToolDefinition) -> None:
        """Register a tool."""
        self._tools[tool.name] = tool
    
    def get_read_tools(self) -> List[ToolDefinition]:
        """Get all read-safe tools."""
        return [t for t in self._tools.values() if t.category == ToolCategory.READ]
    
    def get_edit_tools(self) -> List[ToolDefinition]:
        """Get all edit tools."""
        return [t for t in self._tools.values() if t.category == ToolCategory.EDIT]
    
    def get_search_tools(self) -> List[ToolDefinition]:
        """Get all search tools."""
        return [t for t in self._tools.values() if t.category == ToolCategory.SEARCH]
    
    def can_execute(
        self,
        call: ToolCall,
    ) -> tuple[bool, Optional[str]]:
        """
        Check if a tool call can be executed.
        
        Returns (can_execute, error_message).
        """
        tool = self._tools.get(call.tool_name)
        if not tool:
            return False, f"Unknown tool: {call.tool_name}"
        
        # Check rate limit
        rate_error = self._rate_limiter.check(call.tool_name, tool.rate_limit)
        if rate_error:
            return False, rate_error
        
        # Edit tools require prior read
        if tool.category == ToolCategory.EDIT:
            # Check if file has been read
            file_path = call.arguments.get("file_path") or call.arguments.get("path")
            if file_path and file_path not in self._read_context:
                return False, f"Cannot edit {file_path} without reading it first"
        
        return True, None
    
    def execute(
        self,
        call: ToolCall,
        confirm_edits: bool = False,
    ) -> ToolResponse:
        """
        Execute a tool call with safety checks.
        
        Args:
            call: The tool call to execute
            confirm_edits: If True, edit tools proceed without confirmation
            
        Returns:
            ToolResponse
        """
        start_time = time.time()
        
        tool = self._tools.get(call.tool_name)
        if not tool:
            return ToolResponse(
                success=False,
                error=f"Unknown tool: {call.tool_name}",
            )
        
        # Check if allowed
        can_exec, error = self.can_execute(call)
        if not can_exec:
            return ToolResponse(
                success=False,
                refusal=ToolRefusal(
                    reason=error or "Execution not allowed",
                    suggestions=["Check rate limits", "Read file before editing"],
                ),
            )
        
        # Edit tools may require confirmation
        if tool.category == ToolCategory.EDIT and tool.requires_confirmation and not confirm_edits:
            self._pending_edits[call.call_id] = call
            return ToolResponse(
                success=False,
                refusal=ToolRefusal(
                    reason="Edit requires confirmation",
                    suggestions=["Confirm this edit to proceed"],
                ),
            )
        
        # Execute handler
        if not tool.handler:
            return ToolResponse(
                success=False,
                error="Tool handler not implemented",
            )
        
        try:
            result = tool.handler(**call.arguments)
            
            # Record the call
            self._rate_limiter.record(call.tool_name)
            
            # Track read context
            if tool.category in (ToolCategory.READ, ToolCategory.SEARCH):
                file_path = call.arguments.get("file_path") or call.arguments.get("path")
                if file_path:
                    self._read_context.add(file_path)
            
            execution_time = (time.time() - start_time) * 1000
            
            return ToolResponse(
                success=True,
                data=result,
                execution_time_ms=execution_time,
            )
        
        except Exception as e:
            logger.exception(f"Tool {call.tool_name} failed")
            return ToolResponse(
                success=False,
                error=str(e),
            )
    
    def confirm_edit(self, call_id: str) -> Optional[ToolResponse]:
        """Confirm a pending edit."""
        call = self._pending_edits.pop(call_id, None)
        if not call:
            return None
        return self.execute(call, confirm_edits=True)
    
    def reject_edit(self, call_id: str) -> bool:
        """Reject a pending edit."""
        return self._pending_edits.pop(call_id, None) is not None
    
    def get_pending_edits(self) -> List[ToolCall]:
        """Get all pending edit confirmations."""
        return list(self._pending_edits.values())
    
    def reset_conversation(self) -> None:
        """Reset per-conversation state."""
        self._rate_limiter.reset_conversation()
        self._read_context.clear()
        self._pending_edits.clear()
    
    def get_definitions_for_llm(
        self,
        format: str = "openai",
        include_edits: bool = True,
    ) -> List[Dict[str, Any]]:
        """
        Get tool definitions for LLM.
        
        Args:
            format: "openai" or "anthropic"
            include_edits: Whether to include edit tools
            
        Returns:
            Tool definitions in requested format
        """
        tools = []
        
        for tool in self._tools.values():
            if not include_edits and tool.category == ToolCategory.EDIT:
                continue
            
            if format == "openai":
                tools.append({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                    },
                })
            elif format == "anthropic":
                tools.append({
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.parameters,
                })
        
        return tools


# Pre-defined tool definitions

READ_TOOLS = [
    ToolDefinition(
        name="list_files",
        description="List files in a directory. Use to explore project structure.",
        category=ToolCategory.READ,
        parameters={
            "type": "object",
            "properties": {
                "directory": {
                    "type": "string",
                    "description": "Directory path relative to workspace root",
                },
                "pattern": {
                    "type": "string",
                    "description": "Glob pattern to filter files (e.g., '*.py')",
                },
                "recursive": {
                    "type": "boolean",
                    "description": "Whether to list recursively",
                    "default": False,
                },
            },
            "required": ["directory"],
        },
        rate_limit=RateLimitConfig(max_calls_per_minute=20),
    ),
    ToolDefinition(
        name="read_file",
        description="Read contents of a file. REQUIRED before editing any file.",
        category=ToolCategory.READ,
        parameters={
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Path to file relative to workspace root",
                },
                "start_line": {
                    "type": "integer",
                    "description": "Start line (1-indexed, optional)",
                },
                "end_line": {
                    "type": "integer",
                    "description": "End line (1-indexed, optional)",
                },
            },
            "required": ["file_path"],
        },
        rate_limit=RateLimitConfig(max_calls_per_minute=30),
        max_output_tokens=3000,
    ),
    ToolDefinition(
        name="get_definition",
        description="Get the definition of a symbol (function, class, variable).",
        category=ToolCategory.READ,
        parameters={
            "type": "object",
            "properties": {
                "symbol_name": {
                    "type": "string",
                    "description": "Name of the symbol to find",
                },
                "file_hint": {
                    "type": "string",
                    "description": "Optional file path hint to narrow search",
                },
            },
            "required": ["symbol_name"],
        },
        rate_limit=RateLimitConfig(max_calls_per_minute=20),
    ),
    ToolDefinition(
        name="find_usages",
        description="Find all usages/references of a symbol.",
        category=ToolCategory.READ,
        parameters={
            "type": "object",
            "properties": {
                "symbol_name": {
                    "type": "string",
                    "description": "Name of the symbol to search for",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum results to return",
                    "default": 15,
                },
            },
            "required": ["symbol_name"],
        },
        rate_limit=RateLimitConfig(max_calls_per_minute=15),
    ),
    ToolDefinition(
        name="get_file_summary",
        description="Get a summary of a file's purpose and contents.",
        category=ToolCategory.READ,
        parameters={
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Path to file",
                },
            },
            "required": ["file_path"],
        },
        rate_limit=RateLimitConfig(max_calls_per_minute=30),
        max_output_tokens=500,
    ),
]

SEARCH_TOOLS = [
    ToolDefinition(
        name="search_codebase",
        description="Semantic search across the codebase. Returns relevant code snippets.",
        category=ToolCategory.SEARCH,
        parameters={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Natural language search query",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum results",
                    "default": 10,
                },
                "language": {
                    "type": "string",
                    "description": "Filter by programming language",
                },
            },
            "required": ["query"],
        },
        rate_limit=RateLimitConfig(max_calls_per_minute=10, cooldown_seconds=2.0),
        max_output_tokens=4000,
    ),
    ToolDefinition(
        name="search_symbols",
        description="Search for symbols (functions, classes) by name pattern.",
        category=ToolCategory.SEARCH,
        parameters={
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Symbol name pattern (supports wildcards)",
                },
                "symbol_type": {
                    "type": "string",
                    "description": "Filter by type: function, class, method, etc.",
                },
            },
            "required": ["pattern"],
        },
        rate_limit=RateLimitConfig(max_calls_per_minute=15),
    ),
]

EDIT_TOOLS = [
    ToolDefinition(
        name="modify_file",
        description="Modify specific lines in a file. Requires reading the file first.",
        category=ToolCategory.EDIT,
        parameters={
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Path to file",
                },
                "changes": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "start_line": {"type": "integer"},
                            "end_line": {"type": "integer"},
                            "new_content": {"type": "string"},
                        },
                    },
                    "description": "List of changes to apply",
                },
            },
            "required": ["file_path", "changes"],
        },
        rate_limit=RateLimitConfig(max_calls_per_minute=10, max_calls_per_conversation=30),
        requires_confirmation=True,
    ),
    ToolDefinition(
        name="create_file",
        description="Create a new file with content.",
        category=ToolCategory.EDIT,
        parameters={
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Path for new file",
                },
                "content": {
                    "type": "string",
                    "description": "File content",
                },
            },
            "required": ["file_path", "content"],
        },
        rate_limit=RateLimitConfig(max_calls_per_minute=5, max_calls_per_conversation=20),
        requires_confirmation=True,
    ),
    ToolDefinition(
        name="delete_file",
        description="Delete a file. Requires reading the file first.",
        category=ToolCategory.EDIT,
        parameters={
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Path to file to delete",
                },
            },
            "required": ["file_path"],
        },
        rate_limit=RateLimitConfig(max_calls_per_minute=3, max_calls_per_conversation=10),
        requires_confirmation=True,
    ),
]


def create_tool_separator() -> ToolSeparator:
    """Create a tool separator with default tools registered."""
    separator = ToolSeparator()
    
    for tool in READ_TOOLS + SEARCH_TOOLS + EDIT_TOOLS:
        separator.register(tool)
    
    return separator
