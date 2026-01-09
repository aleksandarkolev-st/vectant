"""
Tool Registry - Tool definitions for LLM function calling.

Provides JSON Schema definitions for each exploration tool,
compatible with OpenAI/Anthropic function calling format.
"""

from __future__ import annotations

from typing import Dict, List, Any


# Tool definitions in OpenAI function calling format
TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": "List files and directories in a specified directory. Use this to explore the project structure and find relevant files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "directory": {
                        "type": "string",
                        "description": "The directory path relative to the project root. Use '.' for the root directory.",
                        "default": ".",
                    },
                    "pattern": {
                        "type": "string",
                        "description": "Optional glob pattern to filter files (e.g., '*.py' for Python files).",
                    },
                    "recursive": {
                        "type": "boolean",
                        "description": "Whether to list files recursively in subdirectories.",
                        "default": False,
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "open_file",
            "description": "Read the contents of a file. You can specify a line range to read only part of the file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "The file path relative to the project root.",
                    },
                    "start_line": {
                        "type": "integer",
                        "description": "The starting line number (1-indexed). If not specified, starts from the beginning.",
                    },
                    "end_line": {
                        "type": "integer",
                        "description": "The ending line number (inclusive). If not specified, reads up to 200 lines from start.",
                    },
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "open_symbol",
            "description": "Get the definition of a code symbol (function, class, method, variable). Use this when you know the exact name of a symbol you want to examine.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "The exact name of the symbol to look up.",
                    },
                    "file_hint": {
                        "type": "string",
                        "description": "Optional file path hint to narrow the search.",
                    },
                },
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_symbol",
            "description": "Search for symbols by name pattern. Use this when you're not sure of the exact symbol name or want to find related symbols.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search pattern for symbol names. Partial matches are supported.",
                    },
                    "symbol_type": {
                        "type": "string",
                        "enum": ["function", "class", "method", "variable", "constant", "interface", "type"],
                        "description": "Optional filter by symbol type.",
                    },
                    "file_pattern": {
                        "type": "string",
                        "description": "Optional filter by file path pattern.",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_callers",
            "description": "Find all code locations that call a specific function or method. Use this to understand how a symbol is used.",
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {
                        "type": "string",
                        "description": "The name of the function or method to find callers for.",
                    },
                },
                "required": ["symbol"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_callees",
            "description": "Find all functions or methods called by a specific function. Use this to understand what a function depends on.",
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {
                        "type": "string",
                        "description": "The name of the function or method to find callees for.",
                    },
                },
                "required": ["symbol"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_related",
            "description": "Find symbols related to a given symbol through imports, inheritance, or file co-location.",
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {
                        "type": "string",
                        "description": "The name of the symbol to find related symbols for.",
                    },
                },
                "required": ["symbol"],
            },
        },
    },
]


class ToolRegistry:
    """
    Registry of available exploration tools.
    
    Provides tool definitions and validation.
    """
    
    def __init__(self):
        self.tools: Dict[str, Dict] = {}
        
        # Register default tools
        for tool_def in TOOL_DEFINITIONS:
            self.register_tool(tool_def)
    
    def register_tool(self, tool_def: Dict) -> None:
        """Register a tool definition."""
        name = tool_def["function"]["name"]
        self.tools[name] = tool_def
    
    def get_tool(self, name: str) -> Dict:
        """Get a tool definition by name."""
        return self.tools.get(name)
    
    def get_all_tools(self) -> List[Dict]:
        """Get all tool definitions."""
        return list(self.tools.values())
    
    def get_tool_names(self) -> List[str]:
        """Get list of tool names."""
        return list(self.tools.keys())
    
    def validate_call(
        self,
        name: str,
        arguments: Dict[str, Any],
    ) -> tuple[bool, str]:
        """
        Validate a tool call.
        
        Args:
            name: Tool name
            arguments: Tool arguments
            
        Returns:
            Tuple of (is_valid, error_message)
        """
        tool = self.get_tool(name)
        if not tool:
            return False, f"Unknown tool: {name}"
        
        params = tool["function"]["parameters"]
        required = params.get("required", [])
        
        # Check required parameters
        for param in required:
            if param not in arguments:
                return False, f"Missing required parameter: {param}"
        
        # Check parameter types (basic validation)
        properties = params.get("properties", {})
        for key, value in arguments.items():
            if key not in properties:
                continue  # Allow extra parameters
            
            expected_type = properties[key].get("type")
            if expected_type == "string" and not isinstance(value, str):
                return False, f"Parameter {key} should be a string"
            elif expected_type == "integer" and not isinstance(value, int):
                return False, f"Parameter {key} should be an integer"
            elif expected_type == "boolean" and not isinstance(value, bool):
                return False, f"Parameter {key} should be a boolean"
        
        return True, ""
    
    def to_openai_format(self) -> List[Dict]:
        """Get tools in OpenAI function calling format."""
        return self.get_all_tools()
    
    def to_anthropic_format(self) -> List[Dict]:
        """Get tools in Anthropic format."""
        tools = []
        for tool_def in self.get_all_tools():
            tools.append({
                "name": tool_def["function"]["name"],
                "description": tool_def["function"]["description"],
                "input_schema": tool_def["function"]["parameters"],
            })
        return tools


# Global registry
_registry: ToolRegistry = None


def get_registry() -> ToolRegistry:
    """Get the global tool registry."""
    global _registry
    if _registry is None:
        _registry = ToolRegistry()
    return _registry


def tool_definitions(format: str = "openai") -> List[Dict]:
    """
    Get tool definitions in the specified format.
    
    Args:
        format: "openai" or "anthropic"
        
    Returns:
        List of tool definitions
    """
    registry = get_registry()
    
    if format == "anthropic":
        return registry.to_anthropic_format()
    else:
        return registry.to_openai_format()
