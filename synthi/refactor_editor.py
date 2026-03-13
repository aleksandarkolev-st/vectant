import re
import os

target = r"src/app/workspace/[slug]/Editor/Editor.jsx"

with open(target, 'r', encoding='utf-8') as f:
    text = f.read()

# 1. Replace the selector
old_selector = r"const code = useAppSelector\(selectCurrentContent\);"
new_selector = r"const code = store.getState().workspace.currentContent;"
text = re.sub(old_selector, new_selector, text)

# 2. Update latestCodeRef to sync on render (since it won't sync on useEffect code change anymore because code won't change)
old_ref = r"""    const latestCodeRef = useRef\(code\);
    useEffect\(\(\) => \{
        latestCodeRef\.current = code;
    \}, \[code\]\);"""

new_ref = r"""    const latestCodeRef = useRef(code);
    const prevActiveFileRef = useRef(activeFile?.path);
    if (activeFile?.path !== prevActiveFileRef.current) {
        prevActiveFileRef.current = activeFile?.path;
        latestCodeRef.current = code;
    }"""
text = re.sub(old_ref, new_ref, text)

# 3. Inside onDidChangeModelContent, update latestCodeRef
old_did_change = r"""                const content = editorInstance\.getValue\(\);

                // Ignore edits that we just applied via self-healing or remote
                if \(isRemoteEdit\.current\) \{"""

new_did_change = r"""                const content = editorInstance.getValue();
                latestCodeRef.current = content;

                // Ignore edits that we just applied via self-healing or remote
                if (isRemoteEdit.current) {"""
text = text.replace(old_did_change, new_did_change)


# 4. Remove `code` from dependency arrays in useCallback/useEffect
# We will do this carefully for the specific ones.
def remove_code_from_deps(match):
    deps = match.group(1)
    deps_list = [d.strip() for d in deps.split(',')]
    if 'code' in deps_list:
        deps_list.remove('code')
    
    new_deps = ', '.join(deps_list)
    return f"}}, [{new_deps}]);"

text = re.sub(r"\}, \[([^\]]*\bcode\b[^\]]*)\]\);", remove_code_from_deps, text)


with open(target, 'w', encoding='utf-8') as f:
    f.write(text)

print("Done Editor.jsx")