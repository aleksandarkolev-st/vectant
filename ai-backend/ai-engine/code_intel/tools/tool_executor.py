"""
Tool Executor - Execute tool calls from the LLM.

Handles:
- Parsing tool calls from LLM responses
- Validating tool arguments
- Executing tools safely
- Formatting results for injection back into context
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Union

from .tools import ExplorationTools, ToolResult, ToolError
from .tool_registry import ToolRegistry, get_registry


logger = logging.getLogger("code_intel.tools.executor")


@dataclass
class ToolCall:
    """A tool call from the LLM."""
    
    id: str
    name: str
    arguments: Dict[str, Any]


@dataclass 
class ToolCallResult:
    """Result of executing a tool call."""
    
    call_id: str
    tool_name: str
    result: ToolResult
    
    # Execution metadata
    execution_time_ms: float = 0.0


@dataclass
class ExecutionBatch:
    """A batch of tool call results."""
    
    results: List[ToolCallResult] = field(default_factory=list)
    total_tokens_used: int = 0
    total_time_ms: float = 0.0


class ToolExecutor:
    """
    Execute tool calls from LLM responses.
    
    Usage:
        executor = ToolExecutor(exploration_tools)
        
        # Execute a single call
        result = executor.execute("list_files", {"directory": "src"})
        
        # Execute multiple calls (from LLM response)
        batch = executor.execute_batch(tool_calls)
        
        # Format results for context injection
        context = executor.format_for_context(batch)
    """
    
    def __init__(
        self,
        tools: ExplorationTools,
        registry: Optional[ToolRegistry] = None,
        token_budget: int = 4000,
    ):
        self.tools = tools
        self.registry = registry or get_registry()
        self.token_budget = token_budget
        
        # Map tool names to methods
        self._tool_methods = {
            "list_files": self.tools.list_files,
            "open_file": self.tools.open_file,
            "open_symbol": self.tools.open_symbol,
            "search_symbol": self.tools.search_symbol,
            "get_callers": self.tools.get_callers,
            "get_callees": self.tools.get_callees,
            "get_related": self.tools.get_related,
        }
    
    def execute(
        self,
        name: str,
        arguments: Dict[str, Any],
        call_id: Optional[str] = None,
    ) -> ToolCallResult:
        """
        Execute a single tool call.
        
        Args:
            name: Tool name
            arguments: Tool arguments
            call_id: Optional ID for tracking
            
        Returns:
            ToolCallResult
        """
        import time
        start = time.time()
        
        call_id = call_id or f"call_{name}_{int(time.time() * 1000)}"
        
        # Validate
        is_valid, error_msg = self.registry.validate_call(name, arguments)
        if not is_valid:
            return ToolCallResult(
                call_id=call_id,
                tool_name=name,
                result=ToolResult(
                    success=False,
                    error=ToolError(
                        code="VALIDATION_ERROR",
                        message=error_msg,
                    ),
                ),
            )
        
        # Get method
        method = self._tool_methods.get(name)
        if not method:
            return ToolCallResult(
                call_id=call_id,
                tool_name=name,
                result=ToolResult(
                    success=False,
                    error=ToolError(
                        code="UNKNOWN_TOOL",
                        message=f"Unknown tool: {name}",
                    ),
                ),
            )
        
        # Execute
        try:
            result = method(**arguments)
        except Exception as e:
            logger.error(f"Tool execution error: {e}")
            result = ToolResult(
                success=False,
                error=ToolError(
                    code="EXECUTION_ERROR",
                    message=str(e),
                ),
            )
        
        execution_time = (time.time() - start) * 1000
        
        return ToolCallResult(
            call_id=call_id,
            tool_name=name,
            result=result,
            execution_time_ms=execution_time,
        )
    
    def execute_batch(
        self,
        tool_calls: List[ToolCall],
    ) -> ExecutionBatch:
        """
        Execute a batch of tool calls.
        
        Args:
            tool_calls: List of tool calls
            
        Returns:
            ExecutionBatch with all results
        """
        batch = ExecutionBatch()
        
        remaining_budget = self.token_budget
        
        for call in tool_calls:
            # Execute
            result = self.execute(
                call.name,
                call.arguments,
                call.id,
            )
            
            # Track tokens
            tokens = result.result.estimated_tokens
            
            # Check budget
            if remaining_budget - tokens < 0:
                # Budget exceeded - skip remaining calls
                result = ToolCallResult(
                    call_id=call.id,
                    tool_name=call.name,
                    result=ToolResult(
                        success=False,
                        error=ToolError(
                            code="BUDGET_EXCEEDED",
                            message="Tool call skipped due to token budget",
                        ),
                    ),
                )
            
            batch.results.append(result)
            batch.total_tokens_used += tokens
            batch.total_time_ms += result.execution_time_ms
            remaining_budget -= tokens
        
        return batch
    
    def parse_tool_calls(
        self,
        response: Union[str, Dict, List],
    ) -> List[ToolCall]:
        """
        Parse tool calls from LLM response.
        
        Handles multiple formats:
        - OpenAI function calling format
        - Anthropic tool use format
        - Raw JSON
        """
        tool_calls = []
        
        # Handle list of tool calls
        if isinstance(response, list):
            for item in response:
                parsed = self._parse_single_call(item)
                if parsed:
                    tool_calls.append(parsed)
        
        # Handle single tool call
        elif isinstance(response, dict):
            parsed = self._parse_single_call(response)
            if parsed:
                tool_calls.append(parsed)
        
        # Handle JSON string
        elif isinstance(response, str):
            try:
                data = json.loads(response)
                return self.parse_tool_calls(data)
            except json.JSONDecodeError:
                logger.warning("Failed to parse tool calls from string")
        
        return tool_calls
    
    def _parse_single_call(self, data: Dict) -> Optional[ToolCall]:
        """Parse a single tool call from various formats."""
        # OpenAI format
        if "function" in data:
            func = data["function"]
            return ToolCall(
                id=data.get("id", ""),
                name=func.get("name", ""),
                arguments=self._parse_arguments(func.get("arguments", {})),
            )
        
        # Anthropic format
        if "type" in data and data["type"] == "tool_use":
            return ToolCall(
                id=data.get("id", ""),
                name=data.get("name", ""),
                arguments=data.get("input", {}),
            )
        
        # Simple format
        if "name" in data:
            return ToolCall(
                id=data.get("id", ""),
                name=data["name"],
                arguments=data.get("arguments", data.get("input", {})),
            )
        
        return None
    
    def _parse_arguments(self, args: Union[str, Dict]) -> Dict:
        """Parse arguments from string or dict."""
        if isinstance(args, str):
            try:
                return json.loads(args)
            except json.JSONDecodeError:
                return {}
        return args
    
    def format_for_context(
        self,
        batch: ExecutionBatch,
    ) -> str:
        """
        Format execution results for injection into context.
        
        Returns a markdown-formatted string.
        """
        sections = []
        
        for result in batch.results:
            if result.result.success:
                content = self._format_result_data(
                    result.tool_name,
                    result.result.data,
                )
            else:
                error = result.result.error
                content = f"Error: {error.message if error else 'Unknown error'}"
            
            sections.append(f"### Tool: {result.tool_name}\n\n{content}")
        
        return "\n\n".join(sections)
    
    def _format_result_data(self, tool_name: str, data: Any) -> str:
        """Format result data based on tool type."""
        if data is None:
            return "No data"
        
        if tool_name == "list_files":
            files = data.get("files", [])
            if not files:
                return "No files found"
            result = "\n".join(f"- {f}" for f in files)
            if data.get("truncated"):
                result += "\n... (more files available)"
            return result
        
        if tool_name == "open_file":
            lang = data.get("language", "")
            content = data.get("content", "")
            path = data.get("path", "")
            start = data.get("start_line", 1)
            end = data.get("end_line", "?")
            return f"**{path}** (lines {start}-{end}):\n\n```{lang}\n{content}\n```"
        
        if tool_name == "open_symbol":
            name = data.get("name", "")
            stype = data.get("type", "")
            code = data.get("code", data.get("signature", ""))
            return f"**{stype}** `{name}`:\n\n```\n{code}\n```"
        
        if tool_name == "search_symbol":
            matches = data.get("matches", [])
            if not matches:
                return "No symbols found"
            lines = []
            for m in matches:
                lines.append(f"- `{m['name']}` ({m['type']}) in {m['file']}")
            return "\n".join(lines)
        
        if tool_name in ("get_callers", "get_callees"):
            related = data.get("related", [])
            if not related:
                return f"No {'callers' if tool_name == 'get_callers' else 'callees'} found"
            lines = []
            for r in related:
                lines.append(f"- `{r['name']}` in {r.get('file', 'unknown')}")
            return "\n".join(lines)
        
        if tool_name == "get_related":
            related = data.get("related", {})
            lines = []
            for category, symbols in related.items():
                if symbols:
                    lines.append(f"**{category}**: {', '.join(symbols[:5])}")
            return "\n".join(lines) if lines else "No related symbols found"
        
        # Default: JSON dump
        return json.dumps(data, indent=2)


def create_executor(
    workspace_root: str,
    vector_index=None,
    structural_index=None,
    token_budget: int = 4000,
) -> ToolExecutor:
    """Create a tool executor with default configuration."""
    tools = ExplorationTools(
        workspace_root=workspace_root,
        vector_index=vector_index,
        structural_index=structural_index,
    )
    return ToolExecutor(tools, token_budget=token_budget)
