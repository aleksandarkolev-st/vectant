"""
Delta-Based Structural Updates for Fast HMR
===========================================
Instead of regenerating all code, we ask AI for ONLY the delta (new code snippets).
Then we inject those snippets into the existing guardrailed code.

This is MUCH faster (~2-3s) and safer (preserves existing code).
"""

# DELTA PROMPT: Ask AI for ONLY the new code snippets to add
DELTA_ADDITION_PROMPT = """Generate ONLY the code snippets needed to add this element. Do NOT output full files.

WHAT TO ADD:
{changes_description}

EXISTING PATTERNS (copy these exactly):
{existing_patterns}

Return ONLY JSON with these 4 snippets:
{{
  "struct_fields": "int new_btn_x;\\nint new_btn_y;\\nint new_btn_w;\\nint new_btn_h;",
  "core_init": "app_state.new_btn_x = 100;\\napp_state.new_btn_y = 50;\\napp_state.new_btn_w = 80;\\napp_state.new_btn_h = 30;",
  "gui_draw": "// Draw new button\\nSDL_Rect new_btn = {{state->new_btn_x, state->new_btn_y, state->new_btn_w, state->new_btn_h}};\\nSDL_SetRenderDrawColor(renderer, 100, 100, 200, 255);\\nSDL_RenderFillRect(renderer, &new_btn);",
  "gui_click": "// Check new button click\\nif (x >= state->new_btn_x && x < state->new_btn_x + state->new_btn_w && y >= state->new_btn_y && y < state->new_btn_y + state->new_btn_h) {{\\n    // Handle new button click\\n}}"
}}

RULES:
1. Use variable names matching the element (e.g., reset_btn_x for reset button)
2. Copy the EXACT style from existing patterns
3. For gui code, use 'state->' to access fields (AppState* state)
4. Return ONLY the JSON, no explanation"""


# For deletions, return which patterns to comment out
DELTA_DELETION_PROMPT = """Identify ONLY the variable names/patterns to remove for this element.

WHAT TO REMOVE:
{deletion_description}

Return ONLY JSON:
{{
  "field_patterns": ["btn2_x", "btn2_y", "btn2_w", "btn2_h"],
  "comment_patterns": ["btn2", "button 2", "second button"]
}}"""


def extract_existing_patterns(shared: str, core: str, gui: str) -> str:
    """Extract existing button/element patterns to show AI as examples."""
    patterns = []
    
    # Find struct fields that look like button fields
    for line in shared.split('\n'):
        if 'btn_' in line and 'int ' in line:
            patterns.append(f"struct field: {line.strip()}")
            break  # Just one example
    
    # Find initialization pattern
    for line in core.split('\n'):
        if 'btn_x =' in line or 'btn_x=' in line:
            patterns.append(f"init: {line.strip()}")
            break
    
    # Find draw pattern (SDL_Rect for button)
    in_draw = False
    draw_lines = []
    for line in gui.split('\n'):
        if 'SDL_Rect' in line and 'btn' in line:
            in_draw = True
        if in_draw:
            draw_lines.append(line)
            if 'RenderFillRect' in line or 'RenderDrawRect' in line:
                break
    if draw_lines:
        patterns.append(f"draw: {' '.join(l.strip() for l in draw_lines[:3])}")
    
    return '\n'.join(patterns) if patterns else "No existing patterns found"


def format_delta_addition_prompt(changes_description: str, core: str, gui: str, shared: str) -> str:
    """Format the delta addition prompt - asks for ONLY snippets, not full files."""
    patterns = extract_existing_patterns(shared, core, gui)
    return DELTA_ADDITION_PROMPT.format(
        changes_description=changes_description,
        existing_patterns=patterns
    )


def format_delta_deletion_prompt(deletion_description: str) -> str:
    """Format the delta deletion prompt."""
    return DELTA_DELETION_PROMPT.format(deletion_description=deletion_description)


def inject_delta_into_code(
    cached_result: dict,
    delta: dict
) -> dict:
    """
    Inject AI-generated delta snippets into existing code.
    This preserves all the guardrailed code and only adds new lines.
    
    Args:
        cached_result: The existing split code {"core": {...}, "gui": {...}, "shared": {...}}
        delta: The snippets {"struct_fields": "...", "core_init": "...", "gui_draw": "...", "gui_click": "..."}
    
    Returns:
        Updated split code with injected delta
    """
    import copy
    result = copy.deepcopy(cached_result)
    
    core_content = result.get("core", {}).get("content", "")
    gui_content = result.get("gui", {}).get("content", "")
    shared_content = result.get("shared", {}).get("content", "")
    
    # 1. Inject struct fields into shared.h (before closing brace of AppState)
    if delta.get("struct_fields"):
        # Find the AppState struct and add fields before the closing brace
        if "} AppState;" in shared_content or "}AppState;" in shared_content:
            # Find last field before closing
            marker = "} AppState;" if "} AppState;" in shared_content else "}AppState;"
            indent = "    "  # Standard indent
            new_fields = "\n".join(f"{indent}{line}" for line in delta["struct_fields"].split("\\n") if line.strip())
            shared_content = shared_content.replace(marker, f"{new_fields}\n{marker}")
        elif "} __attribute__" in shared_content:
            # Handle packed structs
            idx = shared_content.find("} __attribute__")
            if idx > 0:
                indent = "    "
                new_fields = "\n".join(f"{indent}{line}" for line in delta["struct_fields"].split("\\n") if line.strip())
                shared_content = shared_content[:idx] + new_fields + "\n" + shared_content[idx:]
    
    # 2. Inject initialization into core.cpp (in on_load, after existing init)
    if delta.get("core_init"):
        # Find a good injection point - after existing btn init or at end of first-load block
        injection_markers = [
            "app_state.btn_h =",  # After last button field init
            "app_state.running = 1;",  # After running init
            "app_state.dx =",  # After motion init
        ]
        injected = False
        for marker in injection_markers:
            if marker in core_content:
                # Find end of this line
                idx = core_content.find(marker)
                end_idx = core_content.find(";", idx) + 1
                if end_idx > 0:
                    indent = "        "  # Match existing indentation
                    new_init = "\n".join(f"{indent}{line}" for line in delta["core_init"].split("\\n") if line.strip())
                    core_content = core_content[:end_idx] + "\n" + new_init + core_content[end_idx:]
                    injected = True
                    break
    
    # 3. Inject draw code into gui.cpp (in gui_on_render, before SDL_RenderPresent or at end)
    if delta.get("gui_draw"):
        # Find gui_on_render and add draw code
        injection_markers = [
            "// Draw button",  # Before existing button draw
            "SDL_RenderFillRect(renderer, &btn)",  # After existing button draw
            "SDL_SetRenderDrawColor(renderer, 0, 0, 0",  # After clear color
        ]
        for marker in injection_markers:
            if marker in gui_content:
                idx = gui_content.find(marker)
                # Find end of this statement
                end_idx = gui_content.find(";", idx) + 1
                if end_idx > 0:
                    indent = "    "
                    new_draw = "\n".join(f"{indent}{line}" for line in delta["gui_draw"].split("\\n") if line.strip())
                    gui_content = gui_content[:end_idx] + "\n\n" + new_draw + gui_content[end_idx:]
                    break
    
    # 4. Inject click handling into gui.cpp (in gui_on_event)
    if delta.get("gui_click"):
        # Find event handler and add click check
        if "SDL_MOUSEBUTTONDOWN" in gui_content:
            idx = gui_content.find("SDL_MOUSEBUTTONDOWN")
            # Find the block and add our click check
            brace_idx = gui_content.find("{", idx)
            if brace_idx > 0:
                indent = "            "
                new_click = "\n".join(f"{indent}{line}" for line in delta["gui_click"].split("\\n") if line.strip())
                # Insert after the opening brace
                insert_point = brace_idx + 1
                gui_content = gui_content[:insert_point] + "\n" + new_click + gui_content[insert_point:]
    
    # Update result
    if "core" in result:
        result["core"]["content"] = core_content
    if "gui" in result:
        result["gui"]["content"] = gui_content
    if "shared" in result:
        result["shared"]["content"] = shared_content
    
    return result


def apply_deletion_delta(cached_result: dict, delta: dict) -> dict:
    """
    Comment out code matching the deletion patterns.
    
    Args:
        cached_result: The existing split code
        delta: {"field_patterns": [...], "comment_patterns": [...]}
    """
    import copy
    result = copy.deepcopy(cached_result)
    
    field_patterns = delta.get("field_patterns", [])
    comment_patterns = delta.get("comment_patterns", [])
    
    for key in ["core", "gui", "shared"]:
        if key not in result:
            continue
        content = result[key].get("content", "")
        
        # Comment out lines containing any of the patterns
        new_lines = []
        for line in content.split('\n'):
            should_comment = False
            for pattern in field_patterns + comment_patterns:
                if pattern in line and not line.strip().startswith("//"):
                    should_comment = True
                    break
            
            if should_comment:
                new_lines.append(f"// REMOVED: {line}")
            else:
                new_lines.append(line)
        
        result[key]["content"] = '\n'.join(new_lines)
    
    return result
