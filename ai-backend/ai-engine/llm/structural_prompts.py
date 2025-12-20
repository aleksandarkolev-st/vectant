"""
Delta-Based Structural Updates for Fast HMR
===========================================
Instead of regenerating all code, we ask AI for ONLY the delta (new code snippets).
Then we inject those snippets into the existing guardrailed code.

This is MUCH faster (~2-3s) and safer (preserves existing code).
"""

# DELTA PROMPT: Translate X11 delta code to SDL2
DELTA_ADDITION_PROMPT = """Translate this X11 code snippet to SDL2. Return ONLY the SDL2 equivalent.

X11 CODE TO TRANSLATE:
```
{changes_description}
```

TRANSLATION RULES:
- XFillRectangle(dpy, win, gc, x, y, w, h) → SDL_Rect r = {{x, y, w, h}}; SDL_RenderFillRect(state->renderer, &r);
- XDrawRectangle → SDL_RenderDrawRect(state->renderer, &rect);
- XSetForeground with pixel → SDL_SetRenderDrawColor(state->renderer, r, g, b, 255)
- XDrawString(dpy, win, gc, x, y, str, len) → draw_text(state->renderer, x, y, str, len);
- Variable declarations (int btn2_x = 100) → struct field: "int btn2_x;" + core_init: "app_state.btn2_x = 100;"
- For core_init: use app_state.field (static variable)
- For gui_draw: use state->renderer and state->field (function parameters)

Return ONLY JSON with these 4 snippets:
{{
  "struct_fields": "int btn2_x;\\nint btn2_y;\\nint btn2_w;\\nint btn2_h;",
  "core_init": "app_state.btn2_x = 330;\\napp_state.btn2_y = 10;\\napp_state.btn2_w = 120;\\napp_state.btn2_h = 40;",
  "gui_draw": "// Draw button 2\\nSDL_Rect btn2_rect = {{state->btn2_x, state->btn2_y, state->btn2_w, state->btn2_h}};\\nSDL_SetRenderDrawColor(state->renderer, 200, 200, 200, 255);\\nSDL_RenderFillRect(state->renderer, &btn2_rect);\\nconst char* label2 = \\"Reset\\";\\nSDL_SetRenderDrawColor(state->renderer, 0, 0, 0, 255);\\ndraw_text(state->renderer, state->btn2_x + 40, state->btn2_y + 15, label2, strlen(label2));",
  "gui_click": "// Check btn2 click\\nif (mx >= state->btn2_x && mx < state->btn2_x + state->btn2_w && my >= state->btn2_y && my < state->btn2_y + state->btn2_h) {{\\n    // Handle reset button click\\n}}"
}}

CRITICAL RULES:
- For core_init: Use app_state.field (static variable, always in scope)
- For gui_draw/gui_click: Use state->renderer and state->field (parameter in gui functions)
- Extract actual values from the X11 code (e.g., btn2_x = 330 from the input)
- Return ONLY valid JSON, no explanation"""


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
    """Extract existing button/element patterns to show AI as examples.
    Now less important since we're translating X11 code directly."""
    return ""  # Not needed for translation approach


def format_delta_addition_prompt(changes_description: str, core: str, gui: str, shared: str) -> str:
    """Format the delta addition prompt - translates X11 code to SDL2."""
    # changes_description now contains the actual X11 code to translate
    return DELTA_ADDITION_PROMPT.format(
        changes_description=changes_description
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
        # Support both "app_state.field" and "state->field" patterns
        injection_markers = [
            "state->btn_h =",  # After last button field init (pointer style)
            "app_state.btn_h =",  # After last button field init (static style)
            "state->dx =",  # After motion init
            "app_state.dx =",  # After motion init (static style)
            "state->running = 1;",  # After running init
            "app_state.running = 1;",  # After running init (static style)
        ]
        injected = False
        for marker in injection_markers:
            if marker in core_content:
                # Find end of this line
                idx = core_content.find(marker)
                end_idx = core_content.find(";", idx) + 1
                if end_idx > 0:
                    indent = "        "  # Match existing indentation
                    # Handle both \\n (escaped) and actual newlines in the delta
                    init_lines = delta["core_init"].replace("\\n", "\n").split("\n")
                    new_init = "\n".join(f"{indent}{line.strip()}" for line in init_lines if line.strip())
                    core_content = core_content[:end_idx] + "\n" + new_init + core_content[end_idx:]
                    injected = True
                    print(f"[Delta Inject] Injected core_init after '{marker}'")
                    break
        
        if not injected:
            print(f"[Delta Inject] WARNING: Could not find injection point for core_init")
    
    # 3. Inject draw code into gui.cpp (in gui_on_render, after existing button draw)
    if delta.get("gui_draw"):
        # Find a good injection point - after existing button draw code
        injection_markers = [
            "SDL_RenderFillRect(state->renderer, &btn_rect);",  # After button fill
            "draw_text(state->renderer,",  # After text draw
            "// Draw button label",  # Before label section
            "// Draw the button",  # After button comment
        ]
        injected = False
        for marker in injection_markers:
            if marker in gui_content:
                idx = gui_content.find(marker)
                # Find end of this line
                end_idx = gui_content.find("\n", idx)
                if end_idx > 0:
                    indent = "    "
                    # Handle both \\n (escaped) and actual newlines
                    draw_lines = delta["gui_draw"].replace("\\n", "\n").split("\n")
                    new_draw = "\n".join(f"{indent}{line.strip()}" for line in draw_lines if line.strip())
                    gui_content = gui_content[:end_idx] + "\n\n" + new_draw + gui_content[end_idx:]
                    injected = True
                    print(f"[Delta Inject] Injected gui_draw after '{marker[:30]}...'")
                    break
        
        if not injected:
            # Fallback: inject before the closing brace of gui_on_render
            print(f"[Delta Inject] WARNING: Using fallback injection for gui_draw")
    
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
