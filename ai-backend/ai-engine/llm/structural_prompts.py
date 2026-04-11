"""
Delta-Based Structural Updates for Fast HMR
===========================================
Instead of regenerating all code, we ask AI for ONLY the delta (new code snippets).
Then we inject those snippets into the existing guardrailed code.

This is MUCH faster (~2-3s) and safer (preserves existing code).
"""

# DELTA PROMPT: Translate X11 delta code to SDL2
# This prompt dynamically handles ANY button number (btn2, btn3, btn4, etc.)
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
- Variable declarations (int btnN_x = 100) → struct field: "int btnN_x;" + core_init: "app_state.btnN_x = 100;"
- For core_init: use app_state.field (static variable)
- For gui_draw: use state->renderer and state->field (function parameters)

NAMING CONVENTION:
- EXTRACT the actual variable names from the X11 code (btn2, btn3, button2, etc.)
- DO NOT change the variable naming - if input has btn3_x, output must use btn3_x
- For new unnamed buttons, use the NEXT number (if btn2 exists, use btn3)

Return ONLY JSON with these 4 snippets (use ACTUAL variable names from input):
{{
  "struct_fields": "int btnN_x;\\nint btnN_y;\\nint btnN_w;\\nint btnN_h;",
  "core_init": "app_state.btnN_x = VALUE;\\napp_state.btnN_y = VALUE;\\napp_state.btnN_w = VALUE;\\napp_state.btnN_h = VALUE;",
  "gui_draw": "// Draw button N\\nSDL_Rect btnN_rect = {{state->btnN_x, state->btnN_y, state->btnN_w, state->btnN_h}};\\nSDL_SetRenderDrawColor(state->renderer, R, G, B, 255);\\nSDL_RenderFillRect(state->renderer, &btnN_rect);\\nconst char* labelN = \\"TEXT\\";\\nSDL_SetRenderDrawColor(state->renderer, 0, 0, 0, 255);\\ndraw_text(state->renderer, state->btnN_x + OFFSET, state->btnN_y + OFFSET, labelN, strlen(labelN));",
  "gui_click": "// Check btnN click\\nif (mx >= state->btnN_x && mx < state->btnN_x + state->btnN_w && my >= state->btnN_y && my < state->btnN_y + state->btnN_h) {{\\n    // Handle button N click\\n}}"
}}

CRITICAL RULES:
- Extract ACTUAL values from X11 code (x=330, y=10, w=120, h=40, etc.)
- Use the EXACT variable names from input (btn2, btn3, button_reset, etc.)
- For core_init: Use app_state.field (static variable, always in scope)
- For gui_draw/gui_click: Use state->renderer and state->field (parameter in gui functions)
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


def _extract_field_name(field_line: str) -> str | None:
    """
    Extract the field name from a C struct field declaration.
    E.g., "int btn2_x;" -> "btn2_x", "float* ptr;" -> "ptr"
    """
    import re
    # Remove trailing semicolon and whitespace
    line = field_line.rstrip().rstrip(';').strip()
    if not line:
        return None
    # Split by whitespace, take the last token (the variable name)
    # Handle pointers: "int* foo" or "int *foo" or "int * foo"
    parts = line.replace('*', ' * ').split()
    if not parts:
        return None
    name = parts[-1].lstrip('*')
    # Remove array brackets if present: "int arr[10]" -> "arr"
    if '[' in name:
        name = name.split('[')[0]
    return name if name else None


def _extract_assignment_var(line: str) -> str | None:
    """
    Extract the variable being assigned from an assignment statement.
    E.g., "app_state.btn2_x = 330;" -> "btn2_x"
          "state->btn2_x = 330;" -> "btn2_x"
    """
    import re
    # Match patterns like "app_state.VAR =" or "state->VAR ="
    match = re.search(r'(?:app_state\.|state->)(\w+)\s*=', line)
    if match:
        return match.group(1)
    return None


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


def _find_last_occurrence(content: str, patterns: list) -> tuple:
    """
    Find the LAST occurrence of any pattern in content.
    Returns (last_idx, end_of_line_idx, pattern_found) or (-1, -1, None) if not found.
    
    This enables injecting code after the LAST button/element, not just the first one.
    """
    last_idx = -1
    last_end_idx = -1
    last_pattern = None
    
    for pattern in patterns:
        # Find ALL occurrences of this pattern
        start = 0
        while True:
            idx = content.find(pattern, start)
            if idx == -1:
                break
            # Found one, update if it's the latest
            end_idx = content.find(";", idx)
            if end_idx == -1:
                end_idx = content.find("\n", idx)
            if end_idx > 0:
                end_idx += 1  # Include the semicolon/newline
            if idx > last_idx:
                last_idx = idx
                last_end_idx = end_idx
                last_pattern = pattern
            start = idx + 1
    
    return (last_idx, last_end_idx, last_pattern)


def _find_last_button_init(content: str) -> tuple:
    """
    Dynamically find the LAST button initialization in core.cpp.
    Handles btn_h, btn2_h, btn3_h, etc. as well as other naming patterns.
    """
    import re
    
    # Pattern matches: state->btnN_h = or app_state.btnN_h = (with optional digit N)
    # Also matches variations like btn_height, button_h, etc.
    patterns = [
        r"(state->btn\d*_h\s*=)",  # state->btn_h, state->btn2_h, etc.
        r"(app_state\.btn\d*_h\s*=)",  # app_state.btn_h, app_state.btn2_h, etc.
        r"(state->button\d*_h\s*=)",  # state->button_h, state->button2_h, etc.
        r"(app_state\.button\d*_h\s*=)",  # app_state.button_h, etc.
    ]
    
    last_idx = -1
    last_end_idx = -1
    
    for pattern in patterns:
        for match in re.finditer(pattern, content):
            idx = match.start()
            end_idx = content.find(";", idx) + 1
            if idx > last_idx:
                last_idx = idx
                last_end_idx = end_idx
    
    return (last_idx, last_end_idx)


def _find_last_button_draw(content: str) -> tuple:
    """
    Dynamically find the LAST button draw code in gui.cpp.
    Handles btn_rect, btn2_rect, btn3_rect, etc.
    """
    import re
    
    # Pattern matches SDL_RenderFillRect with any button rect variable
    patterns = [
        r"SDL_RenderFillRect\s*\(\s*state->renderer\s*,\s*&btn\d*_rect\s*\)",
        r"SDL_RenderFillRect\s*\(\s*state->renderer\s*,\s*&button\d*_rect\s*\)",
        r"// Draw button \d*",  # Comment markers
        r"draw_text\s*\(\s*state->renderer\s*,\s*state->btn\d*_x",  # Text draw for buttons
    ]
    
    last_idx = -1
    last_end_idx = -1
    
    for pattern in patterns:
        for match in re.finditer(pattern, content):
            idx = match.start()
            # Find end of line
            end_idx = content.find("\n", idx)
            if end_idx == -1:
                end_idx = len(content)
            if idx > last_idx:
                last_idx = idx
                last_end_idx = end_idx
    
    return (last_idx, last_end_idx)


def _find_last_button_click(content: str) -> tuple:
    """
    Dynamically find the LAST button click handler in gui.cpp.
    """
    import re
    
    # Pattern matches click checks for buttons: state->btnN_x, state->buttonN_x
    patterns = [
        r"if\s*\(\s*mx\s*>=\s*state->btn\d*_x",  # Click check for btnN
        r"if\s*\(\s*mx\s*>=\s*state->button\d*_x",  # Click check for buttonN
        r"// Check btn\d* click",  # Comment markers
        r"// Handle.*button.*click",  # Generic button click comments
    ]
    
    last_idx = -1
    last_end_idx = -1
    
    for pattern in patterns:
        for match in re.finditer(pattern, content):
            idx = match.start()
            # Find end of the if block - look for closing brace
            # This is a heuristic: find the matching closing brace
            brace_count = 0
            in_block = False
            end_idx = idx
            for i in range(idx, len(content)):
                if content[i] == '{':
                    brace_count += 1
                    in_block = True
                elif content[i] == '}':
                    brace_count -= 1
                    if in_block and brace_count == 0:
                        end_idx = i + 1
                        break
            if idx > last_idx:
                last_idx = idx
                last_end_idx = end_idx
    
    return (last_idx, last_end_idx)


def inject_delta_into_code(
    cached_result: dict,
    delta: dict
) -> dict:
    """
    Inject AI-generated delta snippets into existing code.
    This preserves all the guardrailed code and only adds new lines.
    
    DYNAMIC INJECTION: Finds the LAST button/element and injects AFTER it,
    allowing for unlimited buttons (btn2, btn3, btn4, etc.).
    
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
    # IMPORTANT: Deduplicate to avoid re-adding fields that already exist (prevents hash churn)
    if delta.get("struct_fields"):
        # Find the AppState struct and add fields before the closing brace
        if "} AppState;" in shared_content or "}AppState;" in shared_content:
            marker = "} AppState;" if "} AppState;" in shared_content else "}AppState;"
            indent = "    "  # Standard indent
            # Filter out fields that already exist in shared_content
            new_field_lines = []
            for line in delta["struct_fields"].split("\\n"):
                line = line.strip()
                if not line:
                    continue
                # Extract the field name (e.g., "int btn2_x;" -> "btn2_x")
                field_name = _extract_field_name(line)
                if field_name and field_name in shared_content:
                    print(f"[Delta Inject] Skipping duplicate field: {field_name}")
                    continue
                new_field_lines.append(f"{indent}{line}")
            if new_field_lines:
                new_fields = "\n".join(new_field_lines)
                shared_content = shared_content.replace(marker, f"{new_fields}\n{marker}")
                print(f"[Delta Inject] Injected {len(new_field_lines)} struct_fields before '{marker}'")
        elif "} __attribute__" in shared_content:
            idx = shared_content.find("} __attribute__")
            if idx > 0:
                indent = "    "
                # Also deduplicate for __attribute__ case
                new_field_lines = []
                for line in delta["struct_fields"].split("\\n"):
                    line = line.strip()
                    if not line:
                        continue
                    field_name = _extract_field_name(line)
                    if field_name and field_name in shared_content:
                        print(f"[Delta Inject] Skipping duplicate field: {field_name}")
                        continue
                    new_field_lines.append(f"{indent}{line}")
                if new_field_lines:
                    new_fields = "\n".join(new_field_lines)
                    shared_content = shared_content[:idx] + new_fields + "\n" + shared_content[idx:]
                    print(f"[Delta Inject] Injected {len(new_field_lines)} struct_fields before __attribute__")
    
    # 2. Inject initialization into core.cpp (DYNAMICALLY find LAST button init)
    # Deduplicate: skip init lines that already appear EXACTLY in core_content
    # (Do NOT skip if variable exists but value is different - that's an update!)
    if delta.get("core_init"):
        # First, try dynamic detection of the LAST button
        last_idx, last_end_idx = _find_last_button_init(core_content)
        
        init_lines = delta["core_init"].replace("\\n", "\n").split("\n")
        # Filter out duplicate initializations
        new_init_lines = []
        for line in init_lines:
            line_stripped = line.strip()
            if not line_stripped:
                continue
            
            # Only skip if the EXACT line already exists (ignoring whitespace)
            # This allows updates (e.g. "x = 10;" -> "x = 20;") to proceed
            if line_stripped in core_content:
                 # Check if it's a real match (surrounded by whitespace/semicolons)
                 # Simple substring check is usually enough for "var = val;" lines
                 print(f"[Delta Inject] Skipping exact duplicate init line: {line_stripped}")
                 continue
                 
            new_init_lines.append(line_stripped)
        
        if new_init_lines:
            if last_idx >= 0 and last_end_idx > 0:
                indent = "        "  # Match existing indentation
                new_init = "\n".join(f"{indent}{line}" for line in new_init_lines)
                core_content = core_content[:last_end_idx] + "\n" + new_init + core_content[last_end_idx:]
                print(f"[Delta Inject] Injected {len(new_init_lines)} core_init after LAST button init")
            else:
                # Fallback to static markers
                fallback_markers = [
                    "state->dx =", "app_state.dx =",
                    "state->running = 1;", "app_state.running = 1;",
                ]
                _, end_idx, pattern = _find_last_occurrence(core_content, fallback_markers)
                if end_idx > 0:
                    indent = "        "
                    new_init = "\n".join(f"{indent}{line}" for line in new_init_lines)
                    core_content = core_content[:end_idx] + "\n" + new_init + core_content[end_idx:]
                    print(f"[Delta Inject] Injected {len(new_init_lines)} core_init after fallback '{pattern}'")
                else:
                    print(f"[Delta Inject] WARNING: Could not find injection point for core_init")
    
    # 3. Inject draw code into gui.cpp (DYNAMICALLY find LAST button draw)
    if delta.get("gui_draw"):
        # First, try dynamic detection of the LAST button draw
        last_idx, last_end_idx = _find_last_button_draw(gui_content)
        
        if last_idx >= 0 and last_end_idx > 0:
            indent = "    "
            draw_lines = delta["gui_draw"].replace("\\n", "\n").split("\n")
            new_draw = "\n".join(f"{indent}{line.strip()}" for line in draw_lines if line.strip())
            gui_content = gui_content[:last_end_idx] + "\n\n" + new_draw + gui_content[last_end_idx:]
            print(f"[Delta Inject] Injected gui_draw after LAST button draw (idx={last_idx})")
        else:
            # Fallback: inject before SDL_RenderPresent or at end of gui_on_render
            if "SDL_RenderPresent" in gui_content:
                idx = gui_content.find("SDL_RenderPresent")
                # Find the start of this line
                line_start = gui_content.rfind("\n", 0, idx) + 1
                indent = "    "
                draw_lines = delta["gui_draw"].replace("\\n", "\n").split("\n")
                new_draw = "\n".join(f"{indent}{line.strip()}" for line in draw_lines if line.strip())
                gui_content = gui_content[:line_start] + new_draw + "\n\n" + gui_content[line_start:]
                print(f"[Delta Inject] Injected gui_draw before SDL_RenderPresent (fallback)")
            else:
                print(f"[Delta Inject] WARNING: Could not find injection point for gui_draw")
    
    # 4. Inject click handling into gui.cpp (DYNAMICALLY find LAST button click)
    if delta.get("gui_click"):
        # First, try dynamic detection of the LAST button click handler
        last_idx, last_end_idx = _find_last_button_click(gui_content)
        
        if last_idx >= 0 and last_end_idx > 0:
            indent = "            "
            click_lines = delta["gui_click"].replace("\\n", "\n").split("\n")
            new_click = "\n".join(f"{indent}{line.strip()}" for line in click_lines if line.strip())
            gui_content = gui_content[:last_end_idx] + "\n" + new_click + gui_content[last_end_idx:]
            print(f"[Delta Inject] Injected gui_click after LAST button click (idx={last_idx})")
        else:
            # Fallback: inject after SDL_MOUSEBUTTONDOWN opening brace
            if "SDL_MOUSEBUTTONDOWN" in gui_content:
                idx = gui_content.find("SDL_MOUSEBUTTONDOWN")
                brace_idx = gui_content.find("{", idx)
                if brace_idx > 0:
                    indent = "            "
                    click_lines = delta["gui_click"].replace("\\n", "\n").split("\n")
                    new_click = "\n".join(f"{indent}{line.strip()}" for line in click_lines if line.strip())
                    insert_point = brace_idx + 1
                    gui_content = gui_content[:insert_point] + "\n" + new_click + gui_content[insert_point:]
                    print(f"[Delta Inject] Injected gui_click after SDL_MOUSEBUTTONDOWN (fallback)")
            else:
                print(f"[Delta Inject] WARNING: Could not find injection point for gui_click")
    
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


# ============================================================
# DIFF-PATCH PROMPT: Apply source diff to split modules
# ============================================================

DIFF_PATCH_PROMPT = """You are a code patcher for the Synthi HMR system.

The user edited their original source file. Below is the DIFF of what changed.
Below that are the current split module files (core.cpp, gui.cpp, shared.h)
that were produced by a previous AI split of the original source.

Your job: apply the user's changes to the correct module file(s).
Return the COMPLETE updated content of ONLY the files that changed.

## RULES
- Do NOT regenerate files from scratch — patch the existing content
- Do NOT add new boilerplate, stubs, or HMR callbacks
- Do NOT change function signatures (on_load, on_update, on_render, on_event)
- If the user changed a value (color, speed, position), find that value in the
  split files and update it
- If the user added new code, determine which module it belongs to:
  - SDL_Render*, SDL_SetRenderDrawColor → gui.cpp (inside gui_on_render)
  - State/logic updates → core.cpp (inside core_on_update)
  - New struct fields → shared.h (inside AppState)
- If the user removed code, remove it from the appropriate module
- Preserve ALL existing code that wasn't affected by the diff

## DIFF (what the user changed in their source)
```diff
{diff}
```

## CURRENT core.cpp
```cpp
{core}
```

## CURRENT gui.cpp
```cpp
{gui}
```

## CURRENT shared.h
```cpp
{shared}
```

## OUTPUT FORMAT
Return ONLY a JSON object with the files that changed. Omit unchanged files.
```json
{{
  "core": "... full updated core.cpp content ...",
  "gui": "... full updated gui.cpp content ...",
  "shared": "... full updated shared.h content ..."
}}
```

If only gui.cpp changed, return: {{"gui": "..."}}
If only a value in core.cpp changed, return: {{"core": "..."}}
Return ONLY the JSON. No explanation."""


def format_diff_patch_prompt(diff: str, core: str, gui: str, shared: str) -> str:
    """Format the diff-patch prompt with actual content."""
    return DIFF_PATCH_PROMPT.format(
        diff=diff,
        core=core,
        gui=gui,
        shared=shared,
    )
